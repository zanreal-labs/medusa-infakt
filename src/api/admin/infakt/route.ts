import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { isInCrashWindow } from "../../../lib/invoicing/operator-actions";
import { summarizeSettlement } from "../../../lib/invoicing/settlement";
import type { SettlementDrift, SettlementSummary } from "../../../lib/invoicing/settlement";
import type { InvoiceStateRow } from "../../../lib/invoicing/state-machine";
import { toPublicInfaktOptions } from "../../../lib/options";
import { INFAKT_MODULE } from "../../../modules/infakt";
import type InfaktModuleService from "../../../modules/infakt/service";

interface SettlementCountableRow extends InvoiceStateRow {
  adopted_at?: Date | string | null;
  invoice_uuid?: string | null;
  settled_at?: Date | string | null;
  settlement_checked_at?: Date | string | null;
  settlement_drift?: string | null;
}

/**
 * The settlement numbers, folded into the overview the page already fetches.
 *
 * Here rather than on a route of its own because the rows are already in hand -
 * it costs no extra query - and because a monitoring exporter reading this
 * endpoint should not have to make a second call to learn whether the
 * reconciliation is still running. That last part is the one worth watching:
 * `oldest_checked_age_seconds` growing without bound is what a stopped
 * reconciler looks like, and it is indistinguishable from a healthy estate if
 * nobody measures it. Counting only invoiced rows keeps the denominator honest -
 * an order with no invoice has no settlement to reconcile.
 */
function settlementMetrics(
  rows: SettlementCountableRow[],
): SettlementSummary & { never_checked: number; oldest_checked_age_seconds: number | null } {
  const now = Date.now();
  const invoiced = rows.filter((row) => Boolean(row.invoice_uuid));
  let neverChecked = 0;
  let oldest: number | null = null;

  for (const row of invoiced) {
    if (!row.settlement_checked_at) {
      neverChecked += 1;
      continue;
    }
    const age = Math.max(0, Math.round((now - new Date(row.settlement_checked_at).getTime()) / 1000));
    if (oldest === null || age > oldest) {
      oldest = age;
    }
  }

  return {
    ...summarizeSettlement(
      invoiced.map((row) => ({
        adopted: Boolean(row.adopted_at),
        drift: (row.settlement_drift ?? null) as SettlementDrift | null,
        settledAt: row.settled_at ?? null,
      })),
    ),
    never_checked: neverChecked,
    oldest_checked_age_seconds: oldest,
  };
}

/**
 * GET /admin/infakt
 *
 * Everything the Invoicing page needs in one round trip: the EFFECTIVE
 * configuration (boot options, overridden by whatever an operator has since
 * saved on the Settings page), the worker's run state (including the KSeF
 * integration's health), and a count per invoice status.
 *
 * No secret material is returned - the configuration goes through
 * `toPublicInfaktOptions`, which does not carry `apiKey`.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);

  const [runState, invoices, effectiveOptions] = await Promise.all([
    infakt.getRunState(),
    infakt.listInfaktInvoices({}, { take: 10_000 }),
    infakt.getEffectiveOptions(),
  ]);

  const rows = invoices as unknown as SettlementCountableRow[];
  const counts = { done: 0, needs_review: 0, pending: 0, processing: 0, skipped: 0 };
  let crashWindow = 0;
  for (const row of rows) {
    if (row.status in counts) {
      counts[row.status as keyof typeof counts] += 1;
    }
    // Surfaced separately because it is the one state an operator must not resolve
    // with a retry, and the count tells them whether any exist at all.
    if (row.status === "needs_review" && isInCrashWindow(row, true)) {
      crashWindow += 1;
    }
  }

  res.json({
    config: toPublicInfaktOptions(effectiveOptions),
    counts,
    crash_window_count: crashWindow,
    run_state: runState,
    settlement: settlementMetrics(rows),
  });
}
