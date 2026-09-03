import type { MedusaContainer } from "@medusajs/framework/types";
import { runSettlement } from "../lib/invoicing/settlement-run";

const JOB_NAME = "infakt-settlement";

/**
 * The settlement reconciliation's BACKSTOP.
 *
 *   read the invoice from inFakt -> compare its `paid_date` with what Medusa
 *   captured -> record the verdict on the ledger row
 *
 * ## What this is, and what it is not
 *
 * It is not part of issuing. An invoice is a legal document with a deadline;
 * whether inFakt's copy of it is ticked as paid is bookkeeping, on a completely
 * different cycle, and wedging the two together is what produced the defect this
 * mechanism replaces - a paid-marking retry loop that held issued, KSeF-filed
 * invoices out of `done` for fifteen minutes at a time.
 *
 * So it runs on its own job, against its own columns, and it never takes the
 * invoicing claim. Nothing it does can park an invoice, burn a retry budget, or
 * delay a document.
 *
 * ## And this is the backstop, not the mechanism
 *
 * `src/subscribers/settle-invoice.ts` reconciles the one order a payment, a
 * refund or a cancellation just happened to, seconds after the event. This tick
 * exists for what no event can announce: a marking that inFakt accepted and then
 * lost, a payment settled by hand in the inFakt panel, an event that was never
 * delivered, and every row created before this mechanism existed.
 *
 * Hourly rather than every five minutes, because nothing waits for it and the
 * cost is real inFakt requests: a row that settles is never read again, so a
 * healthy estate costs a handful of GETs a day. See `SETTLEMENT_RECHECK_MS` for
 * the interval that bounds a drifting row's re-reads, and `settlementWindowStart`
 * for why the sliding window is bounded at ninety days.
 *
 * At :17 rather than :00 so it never lines up with the invoicing worker's
 * five-minute tick, the hour boundary every other cron on the host picks, or the
 * marketplace drains that run on the hour.
 */
export default async function infaktSettlementJob(container: MedusaContainer): Promise<void> {
  await runSettlement(container, { source: JOB_NAME });
}

export const config = {
  name: JOB_NAME,
  /**
   * Overridable by environment variable for the same reason the invoicing worker
   * is: Medusa evaluates `config.schedule` at plugin-load time, before the DI
   * container - and therefore this plugin's options - exists.
   */
  schedule: process.env.INFAKT_SETTLEMENT_CRON ?? "17 * * * *",
};
