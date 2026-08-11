import type { IEventBusModuleService, Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { INFAKT_MODULE } from "../modules/infakt";
import { runHealth } from "../modules/infakt/claim-logic";
import type InfaktModuleService from "../modules/infakt/service";
import { processInvoiceRow } from "../lib/invoicing/pipeline";
import type { InvoiceRow, PipelineDeps } from "../lib/invoicing/pipeline";
import { classifyOutcome } from "../lib/invoicing/state-machine";

const JOB_NAME = "infakt-invoicing";

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

const emptySummary = (): InvoicingRunSummary => ({
  completed: 0,
  deferred: 0,
  failed: 0,
  processed: 0,
  review: 0,
  skippedRows: 0,
});

/**
 * The invoicing worker.
 *
 *   create the invoice in inFakt -> (when required) file it to KSeF -> emit
 *   `infakt.invoice.issued` -> done
 *
 * Durable by construction: every external interaction persists its result column
 * before the next one starts, and `nextStep` derives where to resume purely from
 * which columns are still null. A crash at any instant resumes exactly where it
 * stopped on the next tick.
 *
 * Runs are single-flighted through the module's atomic claim. That is not
 * bookkeeping: two overlapping runs reading the same due row would both POST an
 * invoice create, and inFakt has no idempotency key, so that is two real numbered
 * invoices for one order with no way to withdraw either.
 *
 * Buyer data is read transiently to build the payload and is never logged or
 * persisted by this plugin.
 */
export default async function infaktInvoicingJob(container: MedusaContainer): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const infakt = container.resolve<InfaktModuleService>(INFAKT_MODULE);
  const options = infakt.resolvedOptions;

  if (options.startDate === null) {
    // The loader already reported this at boot. Logging it every five minutes
    // would bury everything else.
    return;
  }

  const claim = await infakt.claimRun();
  if (!(claim.acquired && claim.token)) {
    logger.info(`[${JOB_NAME}] skipped: ${claim.reason}`);
    return;
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
    await ensureKsefReady(container, infakt, logger);
    summary = await drainDueRows(container, infakt, logger);
    const health = runHealth(summary);
    outcome = { lastError: health.lastError, processed: summary.processed, status: health.status };
    logRunSummary(logger, summary);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[${JOB_NAME}] run failed: ${message}`);
    outcome = { lastError: message, processed: summary.processed, status: "error" };
    throw error;
  } finally {
    // Released with this run's own token: after a stale takeover two processes
    // believe they are running, and the loser must not clear the winner's claim.
    const released = await infakt.releaseRun(token, outcome);
    if (!released) {
      logger.warn(
        `[${JOB_NAME}] the claim was no longer ours at release time (taken over as stale) - left the current holder's state alone.`,
      );
    }
  }
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
 */
async function ensureKsefReady(
  container: MedusaContainer,
  infakt: InfaktModuleService,
  logger: Logger,
): Promise<void> {
  const options = infakt.resolvedOptions;
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
    `[${JOB_NAME}] REFUSING TO RUN - KSeF is required but not ready (${detail}). ` +
      "Filing B2B invoices to KSeF has been mandatory in Poland since April 2026, so this is a legal exposure, not a sync failure. " +
      "Fix the KSeF integration in inFakt (Ustawienia -> KSeF), or set `ksef.requireActive: false` if you accept the consequences. " +
      "No invoice will be created until this is resolved.",
  );
  // Surfaced in the admin UI via the run state, which the finally block writes.
  // eslint-disable-next-line @medusajs/use-medusa-error-not-generic-error -- a scheduled job, never a request; the message is the operator-facing artifact
  throw new Error(`KSeF is required but not ready: ${detail}`);
}

/** Advance every row that is due, sequentially. */
async function drainDueRows(
  container: MedusaContainer,
  infakt: InfaktModuleService,
  logger: Logger,
): Promise<InvoicingRunSummary> {
  const summary = emptySummary();
  const rows = await listDueRows(infakt);
  const deps = buildDeps(container, infakt, logger);

  for (const row of rows) {
    summary.processed += 1;
    try {
      // Sequential on purpose: keeps inFakt's rate limits flat and keeps the one
      // destructive call out from under any concurrency.
      await processInvoiceRow(row, deps);
      summary.completed += 1;
    } catch (error) {
      await recordOutcome(infakt, logger, summary, row, error);
    }
  }
  return summary;
}

/**
 * Rows due for work: pending or processing, whose `next_attempt_at` has passed (or
 * was never set), oldest first.
 *
 * `done`, `skipped` and `needs_review` are terminal and are never picked up again
 * by the worker. Getting a needs_review row moving again is an explicit operator
 * action through the admin UI, which is the entire point of that state.
 */
async function listDueRows(infakt: InfaktModuleService): Promise<InvoiceRow[]> {
  const rows = (await infakt.listInfaktInvoices(
    { status: ["pending", "processing"] },
    { order: { created_at: "ASC" }, take: BATCH_LIMIT * 4 },
  )) as unknown as InvoiceRow[];
  const now = Date.now();
  return rows
    .filter((row) => !row.next_attempt_at || new Date(row.next_attempt_at).getTime() <= now)
    .slice(0, BATCH_LIMIT);
}

function buildDeps(
  container: MedusaContainer,
  infakt: InfaktModuleService,
  logger: Logger,
): PipelineDeps {
  const options = infakt.resolvedOptions;
  return {
    client: infakt.apiClient,
    async emitIssued(payload) {
      const eventBus = container.resolve<IEventBusModuleService>(Modules.EVENT_BUS);
      await eventBus.emit({ data: payload, name: "infakt.invoice.issued" });
    },
    logger,
    options,
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
          "items.*",
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
  infakt: InfaktModuleService,
  logger: Logger,
  summary: InvoicingRunSummary,
  row: InvoiceRow,
  cause: unknown,
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
      `[${JOB_NAME}] invoice ${row.id} (order ${row.order_id}) needs review: ${outcome.message}`,
    );
    await infakt.updateInfaktInvoices({
      attempts: outcome.attempts,
      id: row.id,
      last_error: outcome.message,
      status: "needs_review",
    });
    return;
  }

  summary.failed += 1;
  logger.warn(
    `[${JOB_NAME}] invoice ${row.id} (order ${row.order_id}) failed on attempt ${outcome.attempts}, retrying: ${outcome.message}`,
  );
  await infakt.updateInfaktInvoices({
    attempts: outcome.attempts,
    id: row.id,
    last_error: outcome.message,
    next_attempt_at: new Date(now.getTime() + (outcome.delayMs ?? 0)),
  });
}

function logRunSummary(logger: Logger, summary: InvoicingRunSummary): void {
  if (summary.processed === 0) {
    return;
  }
  logger.info(
    `[${JOB_NAME}] processed=${summary.processed} completed=${summary.completed} ` +
      `skipped=${summary.skippedRows} deferred=${summary.deferred} ` +
      `retrying=${summary.failed} needsReview=${summary.review}`,
  );
}

export const config = {
  name: JOB_NAME,
  /**
   * NOTE ON "why is this not a plugin option": Medusa evaluates a scheduled job's
   * `config.schedule` at plugin-load time, before the DI container - and therefore
   * this plugin's `medusa-config.ts` options - exists. There is no supported way
   * for a static config export to read a resolved module's options, so the cron is
   * controlled by the `INFAKT_WORKER_CRON` environment variable rather than by the
   * options object. Documented in the README where someone would look for the
   * option.
   *
   * Every five minutes: fast enough that a buyer's invoice arrives promptly, slow
   * enough that inFakt's async task usually settles between ticks.
   */
  schedule: process.env.INFAKT_WORKER_CRON ?? "*/5 * * * *",
};
