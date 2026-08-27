import type {
  IEventBusModuleService,
  INotificationModuleService,
  Logger,
  MedusaContainer,
} from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { INFAKT_MODULE } from "../../modules/infakt";
import { runHealth } from "../../modules/infakt/claim-logic";
import type InfaktModuleService from "../../modules/infakt/service";
import { buildNeedsReviewNotification, buildThresholdAlertNotification } from "./notify";
import { processInvoiceRow } from "./pipeline";
import type { InvoiceRow, PipelineDeps } from "./pipeline";
import { warsawDate } from "./money";
import { MossRateCache } from "./resolve-regime";
import { classifyOutcome } from "./state-machine";

/**
 * One invoicing run, shared by both things that can start one.
 *
 * There are exactly two callers and they differ in ONE respect - which rows the
 * run drains:
 *
 *  - `src/subscribers/enqueue-invoice.ts` (the PRIMARY path) runs it for the
 *    single order whose payment just landed, microseconds after enqueueing it.
 *  - `src/jobs/infakt-invoicing.ts` (the SAFETY NET) runs it for the whole due
 *    queue on a cron, and recovers anything the subscriber could not finish.
 *
 * Everything else - the enablement gate, the single-flight claim, the KSeF
 * readiness gate, per-row processing, outcome classification, the needs_review
 * notification and the claim release - is identical and lives here exactly once.
 * Duplicating any of it into the subscriber would mean two implementations of
 * the guards that stand between one order and two real, numbered, legally-issued
 * invoices.
 */

/**
 * Rows advanced per run.
 *
 * Kept small and processed strictly sequentially. inFakt's documented limits are
 * 300 GET and 150 POST per 60 s per IP, and a row can make several calls, so 20
 * sequential rows leaves a comfortable margin - and a five-minute cron drains any
 * backlog within a few ticks anyway. Parallelising this would buy nothing and
 * would put the plugin's one destructive call under concurrency pressure.
 */
const BATCH_LIMIT = 20;

export interface InvoicingRunSummary {
  /** Set when the run did nothing at all (not configured, or already running). */
  skipped?: string;
  processed: number;
  completed: number;
  /** Rows intentionally not invoiced. */
  skippedRows: number;
  /** Rows waiting on inFakt, KSeF, or payment. Not failures. */
  deferred: number;
  /** Rows that will retry with backoff. */
  failed: number;
  /** Rows parked for a human. */
  review: number;
}

export const emptySummary = (): InvoicingRunSummary => ({
  completed: 0,
  deferred: 0,
  failed: 0,
  processed: 0,
  review: 0,
  skippedRows: 0,
});

export interface InvoicingRunInput {
  /**
   * Restrict the run to the queued row for this one order. Omitted means "every
   * row that is due", which is what the cron wants.
   *
   * Narrowing the rows is the ONLY thing this changes. The due-predicate itself
   * is identical (`listDueInvoicesForOrder` is `listDueInvoices` plus an
   * `order_id` filter), so a row that is done, skipped, parked for review or
   * deferred into the future is just as untouchable here as it is on the cron.
   */
  orderId?: string;
  /**
   * Log prefix, so a line can be traced to the run that wrote it. The cron keeps
   * the historical `infakt-invoicing` so existing log greps and alerts still
   * match.
   */
  source: string;
}

/**
 * Run the invoicing pipeline once.
 *
 * Throws when the run itself failed (a KSeF refusal, or an unexpected error in
 * the drain) - the cron wants that to surface as a failed job. The subscriber
 * catches it instead, because a throwing subscriber is retried by the event bus
 * with no bound and no visibility, and the cron is already the designed retry.
 */
export async function runInvoicing(
  container: MedusaContainer,
  input: InvoicingRunInput,
): Promise<InvoicingRunSummary> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const infakt = container.resolve<InfaktModuleService>(INFAKT_MODULE);
  const { source } = input;

  // Checked fresh every run, not just at boot: unlike `apiKey`, both the pause
  // switch and the environment force-off can change without a restart. Silent
  // rather than logged - "no apiKey" already had its one boot-time log, and
  // "paused"/"force-disabled" are runtime states an admin can see live on the
  // Invoicing page, not failures worth repeating every five minutes.
  const enablement = await infakt.getEffectiveEnablement();
  if (!enablement.effectiveEnabled) {
    return { ...emptySummary(), skipped: enablement.reason };
  }

  const claim = await infakt.claimRun();
  if (!(claim.acquired && claim.token)) {
    // The other runner holds the lock. This is the race guard doing its job, and
    // it is why neither caller needs one of its own: whichever of the cron tick
    // and the payment subscriber gets here second simply does not run, and the
    // row it wanted stays exactly as due as it was.
    logger.info(`[${source}] skipped: ${claim.reason}`);
    return { ...emptySummary(), skipped: claim.reason };
  }
  const { token } = claim;

  // Pessimistic default: if the run dies in a way that skips the assignment
  // below, the released state says "error", never a misleading "ok".
  let summary = emptySummary();
  let outcome = {
    lastError: "the invoicing run did not complete" as string | null,
    processed: 0,
    status: "error" as "ok" | "error",
  };

  try {
    await ensureKsefReady(container, infakt, logger, source);
    summary = await drainDueRows(container, infakt, logger, input);
    const health = runHealth(summary);
    outcome = { lastError: health.lastError, processed: summary.processed, status: health.status };
    logRunSummary(logger, summary, source);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[${source}] run failed: ${message}`);
    outcome = { lastError: message, processed: summary.processed, status: "error" };
    throw error;
  } finally {
    // Released with this run's own token: after a stale takeover two processes
    // believe they are running, and the loser must not clear the winner's claim.
    const released = await infakt.releaseRun(token, outcome);
    if (!released) {
      logger.warn(
        `[${source}] the claim was no longer ours at release time (taken over as stale) - left the current holder's state alone.`,
      );
    }
  }

  return summary;
}

/**
 * Verify, once per run, that the account's KSeF integration is live - and fail the
 * run loudly when `ksef.requireActive` is on and it is not.
 *
 * Failing the whole run rather than letting rows accumulate in needs_review is the
 * deliberate choice. An inactive integration makes every B2B submit fail with a
 * 422, which is a non-retryable status, so without this every company invoice
 * would silently park itself for a human while a legal deadline passed. A red run
 * state and an error in the log is the outcome an operator can actually notice.
 *
 * Consumer-only stores are unaffected: nothing here refuses to issue an invoice,
 * and a store whose orders never carry a NIP never reaches the KSeF step at all.
 * The check is skipped entirely when the configuration cannot ever need KSeF
 * (`mode: "never"` with no custom predicate).
 *
 * This gate is deliberately UNCHANGED by the payment-time path. A refusal is a
 * refusal whoever asked for the run: the order stays queued and the cron retries
 * it once the integration is fixed.
 */
async function ensureKsefReady(
  container: MedusaContainer,
  infakt: InfaktModuleService,
  logger: Logger,
  source: string,
): Promise<void> {
  // Effective, not boot-only: an admin-set `ksef.mode` override changes whether
  // this check applies at all, on the very next tick.
  const options = await infakt.getEffectiveOptions();
  if (!(options.ksefPossible && options.ksefRequireActive)) {
    return;
  }

  const state = await infakt.getRunState();
  const checkedAt = (state as { ksef_checked_at?: Date | string | null }).ksef_checked_at;
  const active = (state as { ksef_active?: boolean | null }).ksef_active;
  // Re-check hourly rather than every tick: it is an account-level fact that
  // changes rarely, and a per-tick check would spend a request from the GET limit
  // for nothing. A known-inactive integration is re-checked immediately, so
  // fixing it in inFakt takes effect on the next tick rather than in an hour.
  const stale =
    !checkedAt || Date.now() - new Date(checkedAt).getTime() > 60 * 60_000 || active !== true;
  const integration = stale ? await infakt.verifyKsefIntegration() : { active: true };

  if (integration.active) {
    return;
  }

  const detail =
    "error" in integration && integration.error
      ? `the check itself failed: ${integration.error}`
      : "inFakt reports the account has no active KSeF integration";
  logger.error(
    `[${source}] REFUSING TO RUN - KSeF is required but not ready (${detail}). ` +
      "Filing B2B invoices to KSeF has been mandatory in Poland since April 2026, so this is a legal exposure, not a sync failure. " +
      "Fix the KSeF integration in inFakt (Ustawienia -> KSeF), or set `ksef.requireActive: false` if you accept the consequences. " +
      "No invoice will be created until this is resolved.",
  );
  // Surfaced in the admin UI via the run state, which the finally block writes.
  // eslint-disable-next-line @medusajs/use-medusa-error-not-generic-error -- a scheduled job or an event handler, never a request; the message is the operator-facing artifact
  throw new Error(`KSeF is required but not ready: ${detail}`);
}

/** Advance every row this run is responsible for, sequentially. */
async function drainDueRows(
  container: MedusaContainer,
  infakt: InfaktModuleService,
  logger: Logger,
  input: InvoicingRunInput,
): Promise<InvoicingRunSummary> {
  const summary = emptySummary();
  const rows = (await (input.orderId
    ? infakt.listDueInvoicesForOrder(input.orderId)
    : infakt.listDueInvoices(BATCH_LIMIT))) as unknown as InvoiceRow[];
  if (rows.length === 0) {
    return summary;
  }
  const deps = await buildDeps(container, infakt, logger);

  for (const row of rows) {
    summary.processed += 1;
    try {
      // Sequential on purpose: keeps inFakt's rate limits flat and keeps the one
      // destructive call out from under any concurrency.
      await processInvoiceRow(row, deps);
      summary.completed += 1;
    } catch (error) {
      await recordOutcome(container, infakt, logger, summary, row, error, input.source);
    }
  }
  return summary;
}

/**
 * Raise a Medusa admin-feed notification for an order the pipeline parked for a
 * human. This is the operator's alert - the order-detail widget is where they act.
 *
 * Deliberately swallows every failure. A host that has not wired a notification
 * provider, or a transient failure in the module, must never turn a correctly
 * recorded needs_review row into a failed run. The row is already persisted before
 * this is called, so the worst case of a lost alert is a review that is found the
 * next time the order is opened rather than the moment it is parked.
 */
async function notifyNeedsReview(
  container: MedusaContainer,
  logger: Logger,
  source: string,
  input: { orderId: string; message: string; attempts: number },
): Promise<void> {
  try {
    const notifications = container.resolve<INotificationModuleService>(Modules.NOTIFICATION);
    await notifications.createNotifications(buildNeedsReviewNotification(input));
  } catch (error) {
    logger.warn(
      `[${source}] could not raise an admin notification for order ${input.orderId} ` +
        `(the row is still marked needs_review): ${
          error instanceof Error ? error.message : String(error)
        }`,
    );
  }
}

/** The columns the threshold reader selects off `infakt_invoice`. */
interface EuB2cRow {
  vat_base_minor: number | string | null;
  vat_currency: string | null;
  completed_at?: string | Date | null;
  created_at?: string | Date | null;
}

async function buildDeps(
  container: MedusaContainer,
  infakt: InfaktModuleService,
  logger: Logger,
): Promise<PipelineDeps> {
  // Effective, not boot-only: `currency`, `ksefMode` and the API client itself
  // all follow whatever an operator last saved on the Settings page.
  const [options, client] = await Promise.all([
    infakt.getEffectiveOptions(),
    infakt.getApiClient(),
  ]);
  return {
    client,
    async emitIssued(payload) {
      const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS);
      await eventBus.emit({ data: payload, name: "infakt.invoice.issued" });
    },
    /**
     * Every number this plugin has already recorded, for the collision guard.
     *
     * Read fresh per row rather than cached for the run: the guard exists to
     * catch a number two documents share, and a stale list is exactly the case
     * where it would miss one issued moments earlier in the same batch.
     */
    async listIssuedNumbers() {
      const rows = await infakt.listInfaktInvoices(
        {},
        { select: ["order_id", "invoice_number"], take: null },
      );
      return (rows as { order_id: string; invoice_number?: string | null }[]).map((entry) => ({
        invoiceNumber: entry.invoice_number ?? null,
        orderId: entry.order_id,
      }));
    },
    /**
     * The intra-EU B2C sales already on the books, for the OSS threshold.
     *
     * Derived from the invoices themselves rather than a separate counter: the
     * rows this reads ARE the documents that were issued, so the figure cannot
     * drift from reality, and an accountant can audit it by listing the same
     * rows. Only `eu_b2c_domestic_rate` invoices count - reverse-charge B2B and
     * non-EU sales are outside the threshold entirely.
     */
    async listEuB2cSales() {
      const rows = await infakt.listInfaktInvoices(
        { vat_regime: "eu_b2c_domestic_rate" },
        { select: ["vat_base_minor", "vat_currency", "completed_at", "created_at"], take: null },
      );
      return (rows as EuB2cRow[])
        .filter((entry) => entry.vat_base_minor !== null && entry.vat_currency)
        .map((entry) => ({
          baseMinor: Math.round(Number(entry.vat_base_minor)),
          currency: String(entry.vat_currency),
          date: warsawDate(entry.completed_at ?? entry.created_at ?? null),
        }));
    },
    logger,
    // One cache for the whole run, so a batch of twenty orders to Germany asks
    // inFakt for the rate once.
    mossRates: new MossRateCache(client),
    options,
    /**
     * Early warning that the OSS threshold is approaching.
     *
     * Routed through the same admin feed a parked invoice uses, so it lands where
     * an operator already looks rather than in a channel nobody watches.
     */
    async raiseAlert(message) {
      try {
        const notifications = container.resolve<INotificationModuleService>(Modules.NOTIFICATION);
        await notifications.createNotifications(
          buildThresholdAlertNotification({ day: warsawDate(), message }),
        );
      } catch (error) {
        // Same policy as every other alert here: never fail a run over a missing
        // notification provider. The warning still reaches the log.
        logger.warn(
          `[medusa-infakt] could not raise the OSS threshold alert: ${
            error instanceof Error ? error.message : String(error)
          } - ${message}`,
        );
      }
    },
    async readOrder(orderId) {
      const query = container.resolve<{
        graph: (input: {
          entity: string;
          fields: string[];
          filters?: Record<string, unknown>;
        }) => Promise<{ data?: unknown[] }>;
      }>(ContainerRegistrationKeys.QUERY);
      const { data } = await query.graph({
        entity: "order",
        fields: [
          "id",
          "display_id",
          "status",
          "currency_code",
          "total",
          "email",
          "created_at",
          "canceled_at",
          "metadata",
          // Read so the OSS path can check the VAT actually charged against the
          // destination country's rate. Unused on the domestic path.
          "tax_total",
          "items.*",
          // The VAT classification marker can live on any of the three, and
          // `items.*` is a column wildcard that does not pull relations.
          "items.variant.metadata",
          "items.product.metadata",
          "shipping_methods.*",
          "billing_address.*",
          "shipping_address.*",
          "payment_collections.*",
          "payment_collections.payments.*",
        ],
        filters: { id: orderId },
      });
      return (data ?? [])[0] ?? null;
    },
    async update(id, patch) {
      await infakt.updateInfaktInvoices({ id, ...patch });
    },
  };
}

/** Persist the classified outcome of one failed row. */
async function recordOutcome(
  container: MedusaContainer,
  infakt: InfaktModuleService,
  logger: Logger,
  summary: InvoicingRunSummary,
  row: InvoiceRow,
  cause: unknown,
  source: string,
): Promise<void> {
  const outcome = classifyOutcome(cause, row);
  const now = new Date();

  if (outcome.kind === "skipped") {
    summary.skippedRows += 1;
    await infakt.updateInfaktInvoices({
      completed_at: now,
      id: row.id,
      last_error: null,
      skip_reason: outcome.message,
      status: "skipped",
    });
    return;
  }

  if (outcome.kind === "deferred") {
    summary.deferred += 1;
    await infakt.updateInfaktInvoices({
      id: row.id,
      last_error: null,
      next_attempt_at: new Date(now.getTime() + (outcome.delayMs ?? 0)),
    });
    return;
  }

  if (outcome.kind === "review") {
    summary.review += 1;
    logger.error(
      `[${source}] invoice ${row.id} (order ${row.order_id}) needs review: ${outcome.message}`,
    );
    await infakt.updateInfaktInvoices({
      attempts: outcome.attempts,
      id: row.id,
      last_error: outcome.message,
      status: "needs_review",
    });
    // Alert the operator now, after the row is safely persisted. This is the
    // primary discovery path for a parked invoice - there is no bulk queue to
    // hunt through; the notification deep-links to the order-detail page.
    await notifyNeedsReview(container, logger, source, {
      attempts: outcome.attempts,
      message: outcome.message,
      orderId: row.order_id,
    });
    return;
  }

  summary.failed += 1;
  logger.warn(
    `[${source}] invoice ${row.id} (order ${row.order_id}) failed on attempt ${outcome.attempts}, retrying: ${outcome.message}`,
  );
  await infakt.updateInfaktInvoices({
    attempts: outcome.attempts,
    id: row.id,
    last_error: outcome.message,
    next_attempt_at: new Date(now.getTime() + (outcome.delayMs ?? 0)),
  });
}

function logRunSummary(logger: Logger, summary: InvoicingRunSummary, source: string): void {
  if (summary.processed === 0) {
    return;
  }
  logger.info(
    `[${source}] processed=${summary.processed} completed=${summary.completed} ` +
      `skipped=${summary.skippedRows} deferred=${summary.deferred} ` +
      `retrying=${summary.failed} needsReview=${summary.review}`,
  );
}
