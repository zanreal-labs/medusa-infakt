import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { isInCrashWindow } from "../../../lib/invoicing/operator-actions";
import type { InvoiceStateRow } from "../../../lib/invoicing/state-machine";
import { toPublicInfaktOptions } from "../../../lib/options";
import { INFAKT_MODULE } from "../../../modules/infakt";
import type InfaktModuleService from "../../../modules/infakt/service";

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

  const rows = invoices as unknown as (InvoiceStateRow & { status: string })[];
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
  });
}
