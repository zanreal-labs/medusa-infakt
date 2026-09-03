import { describeError } from "../infakt/errors";
import type { InfaktClient } from "../infakt";
import type { PaidGateOrder } from "./paid";
import {
  classifySettlement,
  isSettlementAutoFixable,
  summarizeSettlement,
} from "./settlement";
import type { SettlementDrift, SettlementSummary } from "./settlement";

/**
 * One reconciliation pass over a set of ledger rows.
 *
 * Every dependency is injected, exactly as the issuing pipeline does it, so the
 * part with the ordering and failure rules is testable with no container, no
 * database and no live inFakt. `settlement-run.ts` supplies the real ones.
 *
 * ## What this is allowed to do
 *
 * Read `GET /invoices/{uuid}.json`, read the order, and write four columns on
 * its own ledger row. That is the entire authority of this module, and the
 * limits are deliberate:
 *
 *  - **It never marks anything paid in inFakt.** Not even the one drift code a
 *    fix would be safe for. Arming that is a separate change, behind a setting
 *    that defaults to off, after this has run read-only for long enough to know
 *    what it finds.
 *  - **It never writes payment state into Medusa.** Settlement flows one way:
 *    Medusa is the source of truth and inFakt is downstream. Propagating "somebody
 *    ticked paid in the inFakt panel" back into an order would turn an accounting
 *    panel into a payment gateway.
 *  - **It never fetches a PDF.** Downloading one flips inFakt's `status`, so a
 *    reconciliation that used the PDF endpoint would corrupt the very field whose
 *    unreliability it exists to work around.
 *  - **It never takes the invoicing claim.** It shares no columns with the
 *    issuing state machine, so it cannot park an invoice, cannot burn a retry
 *    budget, and cannot hold the single-flight lock while it reads. Two
 *    reconciliations racing each other write the same answer twice.
 */

/** The ledger columns this reconciliation reads. */
export interface SettlementRow {
  id: string;
  order_id: string;
  invoice_uuid?: string | null;
  invoice_number?: string | null;
  adopted_at?: Date | string | null;
  ksef_required?: boolean | null;
  ksef_number?: string | null;
  settled_at?: Date | string | null;
  settlement_drift?: string | null;
}

export interface SettlementDeps {
  /** Only the read. `markPaid` is deliberately not in this type. */
  client: Pick<InfaktClient, "getInvoice">;
  readOrder: (orderId: string) => Promise<unknown>;
  update: (id: string, patch: Record<string, unknown>) => Promise<void>;
  logger: { warn: (message: string) => void };
  /** Injected so a test can pin the checked-at timestamp. */
  now?: () => Date;
}

/** One row's verdict, as the report renders it. PII-free by construction. */
export interface SettlementEntry {
  order_id: string;
  invoice_uuid: string;
  invoice_number: string | null;
  adopted: boolean;
  settled_at: string | null;
  drift: SettlementDrift | null;
  reason: string;
  /** What a future auto-fix would touch. Nothing acts on it today. */
  auto_fixable: boolean;
  /** inFakt's `paid_price`, minor units. Evidence only - never a basis for anything. */
  paid_minor: number | null;
  captured_minor: number;
  total_minor: number | null;
}

/** A row the pass deliberately did not read, and why. */
export interface SettlementSkip {
  order_id: string;
  reason: string;
}

export interface SettlementRunResult {
  summary: SettlementSummary;
  entries: SettlementEntry[];
  skipped: SettlementSkip[];
}

/**
 * Why a row is not reconciled, or null when it is.
 *
 * Two refusals, both narrow:
 *
 *  - no invoice: there is no document to compare against.
 *  - required by KSeF but not yet filed: the document is still mid-flight in a
 *    process with a legal deadline, and its settlement is the least interesting
 *    thing about it. Reading it would report an unsettled invoice as a
 *    discrepancy every hour until KSeF answers.
 */
export function settlementSkipReason(row: SettlementRow): string | null {
  if (!row.invoice_uuid) {
    return "no invoice on this row";
  }
  if (row.ksef_required && !row.ksef_number) {
    return "still awaiting a KSeF number";
  }
  return null;
}

/**
 * Reconcile ONE row: read the invoice, read the order, compare, persist.
 *
 * Writes `settlement_checked_at` on every pass, including a failed one - the age
 * of that column is how an operator (and the exporter) tells "everything agrees"
 * apart from "nothing has run since Tuesday", and a check that only recorded
 * itself when it succeeded would make a broken reconciliation invisible.
 *
 * `settled_at` and `settlement_paid_minor` are left untouched when the read
 * failed. A network blip must not erase a settlement date that was true an hour
 * ago; `unreadable` says the read failed, and the previous evidence stays.
 */
export async function reconcileSettlementRow(
  row: SettlementRow,
  deps: SettlementDeps,
): Promise<SettlementEntry | null> {
  const skip = settlementSkipReason(row);
  if (skip || !row.invoice_uuid) {
    return null;
  }

  const now = (deps.now ?? (() => new Date()))();
  let invoiceUnreadable = false;
  let paidDate: string | null = null;
  let paidMinor: number | null = null;

  try {
    const invoice = await deps.client.getInvoice(row.invoice_uuid);
    paidDate = invoice.paidDate ?? null;
    paidMinor = invoice.paidPrice ?? null;
  } catch (error) {
    invoiceUnreadable = true;
    deps.logger.warn(
      `[medusa-infakt] could not read invoice ${row.invoice_uuid} (order ${row.order_id}) for settlement: ${describeError(error)}`,
    );
  }

  let order: PaidGateOrder | null = null;
  try {
    order = ((await deps.readOrder(row.order_id)) as PaidGateOrder | null) ?? null;
  } catch (error) {
    deps.logger.warn(
      `[medusa-infakt] could not read order ${row.order_id} for settlement: ${describeError(error)}`,
    );
  }

  const verdict = classifySettlement({
    adopted: Boolean(row.adopted_at),
    invoiceUnreadable,
    order,
    paidDate,
  });

  const patch: Record<string, unknown> = {
    settlement_checked_at: now,
    settlement_drift: verdict.drift,
  };
  if (!invoiceUnreadable) {
    patch.settled_at = verdict.settledAt;
    patch.settlement_paid_minor = paidMinor;
  }
  await deps.update(row.id, patch);

  return {
    adopted: verdict.adopted,
    auto_fixable: isSettlementAutoFixable(verdict.drift, { adopted: verdict.adopted }),
    captured_minor: verdict.capturedMinor,
    drift: verdict.drift,
    invoice_number: row.invoice_number ?? null,
    invoice_uuid: row.invoice_uuid,
    order_id: row.order_id,
    paid_minor: paidMinor,
    reason: verdict.reason,
    settled_at: verdict.settledAt ? verdict.settledAt.toISOString() : null,
    total_minor: verdict.totalMinor,
  };
}

/**
 * Reconcile a batch, sequentially.
 *
 * Sequential for the same reason the issuing worker is: it keeps inFakt's
 * documented rate limits flat, and there is nothing here worth parallelising -
 * the batch is tens of rows, once an hour.
 *
 * A row that throws is logged and skipped, never allowed to fail the pass. The
 * next row's discrepancy is not less important because this one's read blew up,
 * and the failed row is picked up again on the next tick with its
 * `settlement_checked_at` still stale.
 */
export async function reconcileSettlements(
  rows: SettlementRow[],
  deps: SettlementDeps,
): Promise<SettlementRunResult> {
  const entries: SettlementEntry[] = [];
  const skipped: SettlementSkip[] = [];

  for (const row of rows) {
    const skip = settlementSkipReason(row);
    if (skip) {
      skipped.push({ order_id: row.order_id, reason: skip });
      continue;
    }
    try {
      const entry = await reconcileSettlementRow(row, deps);
      if (entry) {
        entries.push(entry);
      }
    } catch (error) {
      const message = describeError(error);
      skipped.push({ order_id: row.order_id, reason: `reconciliation failed: ${message}` });
      deps.logger.warn(
        `[medusa-infakt] settlement reconciliation failed for order ${row.order_id}: ${message}`,
      );
    }
  }

  return {
    entries,
    skipped,
    summary: summarizeSettlement(
      entries.map((entry) => ({
        adopted: entry.adopted,
        drift: entry.drift,
        settledAt: entry.settled_at,
      })),
    ),
  };
}
