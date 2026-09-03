import type { Logger, MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { describeError } from "../infakt/errors";
import { INFAKT_MODULE } from "../../modules/infakt";
import type InfaktModuleService from "../../modules/infakt/service";
import { reconcileSettlements } from "./settle";
import type { SettlementDeps, SettlementRow, SettlementRunResult } from "./settle";
import {
  SETTLEMENT_BATCH_LIMIT,
  SETTLEMENT_WINDOW_DAYS,
  settlementRecheckCutoff,
  settlementWindowStart,
  summarizeSettlement,
} from "./settlement";

/**
 * One settlement reconciliation run, shared by everything that can start one:
 * the hourly job, the payment/refund subscriber, and the admin endpoint.
 *
 * The same division of labour as `run.ts`: the callers differ only in WHICH rows
 * the pass covers, and every rule about how a row is compared lives one layer
 * down in `settle.ts` and `settlement.ts`, unit-tested without a container.
 *
 * ## Why this does not take the invoicing claim
 *
 * The single-flight claim exists because two runs advancing the same row would
 * both POST an invoice create, and inFakt has no idempotency key - two real,
 * numbered, legally-issued documents for one order. Nothing here creates
 * anything: it reads an invoice, reads an order, and writes four columns the
 * issuing state machine never looks at. Two reconciliations racing write the same
 * answer twice.
 *
 * Taking the claim would also be actively harmful. It would put a read-only
 * hourly job in the way of the payment subscriber's issuing run, so an invoice
 * would wait for a reconciliation to finish - a settlement report delaying a
 * legal document is exactly backwards.
 */

export interface SettlementRunInput {
  /** Log prefix, so a line can be traced to the run that wrote it. */
  source: string;
  /** Restrict the pass to one order (the subscriber's case). */
  orderId?: string;
  /** Restrict the pass to named orders (the admin endpoint's case). */
  orderIds?: string[];
  /** Ignore the sliding window and consider the whole ledger. On demand only. */
  full?: boolean;
  /** Override the sliding window, in days. */
  windowDays?: number;
  /** Rows read from inFakt in this pass. */
  limit?: number;
  /**
   * Ignore the re-check interval. For an operator who has just fixed something
   * in inFakt and wants the answer now rather than within six hours.
   */
  force?: boolean;
  /**
   * Run even while invoicing is paused. True for an operator asking explicitly:
   * a store reconciling its books very plausibly has issuing turned off, and
   * this reads. False (the default) for the job and the subscriber, which have
   * no business calling inFakt on a plugin somebody switched off.
   */
  ignorePause?: boolean;
}

export interface SettlementRunSummary extends SettlementRunResult {
  /** Set when the run did nothing at all, with the reason. */
  skippedRun?: string;
}

const emptyRun = (): SettlementRunResult => ({
  entries: [],
  skipped: [],
  summary: summarizeSettlement([]),
});

/**
 * Just enough of an order to answer "how much of this was captured, and did any
 * of it come back?".
 *
 * Four fields and two relations, deliberately: this runs on every reconciled row
 * and needs no buyer data at all. Nothing read here is logged or persisted.
 */
async function readOrderPayments(container: MedusaContainer, orderId: string): Promise<unknown> {
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
      "total",
      "canceled_at",
      "payment_collections.*",
      "payment_collections.payments.*",
    ],
    filters: { id: orderId },
  });
  return (data ?? [])[0] ?? null;
}

/** The rows this pass covers. */
async function selectRows(
  infakt: InfaktModuleService,
  input: SettlementRunInput,
  now: Date,
): Promise<SettlementRow[]> {
  const named = input.orderIds ?? (input.orderId ? [input.orderId] : []);
  if (named.length > 0) {
    // Named orders bypass the window and the re-check interval on purpose: the
    // caller is an event about THIS order, or an operator who asked for it.
    return (await infakt.listInfaktInvoices(
      { order_id: named },
      { take: named.length },
    )) as unknown as SettlementRow[];
  }
  return (await infakt.listSettlementCandidates({
    checkedBefore: input.force ? now : settlementRecheckCutoff(now),
    createdAfter: input.full
      ? null
      : settlementWindowStart(now, input.windowDays ?? SETTLEMENT_WINDOW_DAYS),
    limit: input.limit ?? SETTLEMENT_BATCH_LIMIT,
  })) as unknown as SettlementRow[];
}

/**
 * Run the settlement reconciliation once.
 *
 * Never throws for a row-level problem - those are counted and reported. It can
 * still throw if the module or the API client cannot be resolved at all, which
 * is what the cron should surface as a failed job.
 */
export async function runSettlement(
  container: MedusaContainer,
  input: SettlementRunInput,
): Promise<SettlementRunSummary> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const infakt = container.resolve<InfaktModuleService>(INFAKT_MODULE);

  if (input.ignorePause) {
    const options = await infakt.getEffectiveOptions();
    if (!options.enabled) {
      return { ...emptyRun(), skippedRun: "no `apiKey` is configured" };
    }
  } else {
    const enablement = await infakt.getEffectiveEnablement();
    if (!enablement.effectiveEnabled) {
      return { ...emptyRun(), skippedRun: enablement.reason };
    }
  }

  const now = new Date();
  const rows = await selectRows(infakt, input, now);
  if (rows.length === 0) {
    return emptyRun();
  }

  const deps: SettlementDeps = {
    client: await infakt.getApiClient(),
    logger,
    now: () => new Date(),
    readOrder: (orderId) => readOrderPayments(container, orderId),
    update: async (id, patch) => {
      await infakt.updateInfaktInvoices({ id, ...patch });
    },
  };

  const result = await reconcileSettlements(rows, deps);
  logRun(logger, result, input.source);
  return result;
}

/**
 * Reconcile ONE order's settlement now, and never let it fail its caller.
 *
 * The subscriber's entry point. Everything is swallowed for the same reason the
 * issuing fast path swallows: a throwing subscriber is retried by the event bus
 * with no bound and no visibility, and the hourly job is already the designed
 * retry - a row that could not be read keeps its stale `settlement_checked_at`
 * and comes back around on its own.
 */
export async function settleOrderNow(
  container: MedusaContainer,
  input: { orderId: string; source: string },
): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  try {
    await runSettlement(container, { orderId: input.orderId, source: input.source });
  } catch (error) {
    logger.warn(
      `[${input.source}] could not reconcile the settlement for order ${input.orderId}: ${describeError(error)}. The hourly reconciliation will pick it up.`,
    );
  }
}

/**
 * One line per pass, and only when something was actually read.
 *
 * Silence on an empty pass is deliberate: this job runs every hour on a store
 * where the expected outcome is "nothing to do", and a log line saying so every
 * hour trains everyone to ignore the one that matters.
 */
function logRun(logger: Logger, result: SettlementRunResult, source: string): void {
  if (result.entries.length === 0 && result.skipped.length === 0) {
    return;
  }
  const { summary } = result;
  const drift = Object.entries(summary.drift)
    .filter(([, count]) => count > 0)
    .map(([code, count]) => `${code}=${count}`)
    .join(" ");
  logger.info(
    `[${source}] settlement checked=${summary.checked} settled=${summary.settled} ` +
      `agreed=${summary.agreed} skipped=${result.skipped.length}${drift ? ` ${drift}` : ""}`,
  );
  if (summary.auto_fixable > 0) {
    logger.warn(
      `[${source}] ${summary.auto_fixable} invoice(s) this plugin issued are captured in full in Medusa but carry no paid date in inFakt. ` +
        "Nothing is fixed automatically - settle them in inFakt by hand, or see the settlement report in the admin.",
    );
  }
}
