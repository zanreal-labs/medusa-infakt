import type { MedusaContainer } from "@medusajs/framework/types";
import { runInvoicing } from "../lib/invoicing/run";

export type { InvoicingRunSummary } from "../lib/invoicing/run";

const JOB_NAME = "infakt-invoicing";

/**
 * The invoicing worker's SAFETY NET.
 *
 *   create the invoice in inFakt -> (when required) file it to KSeF -> emit
 *   `infakt.invoice.issued` -> done
 *
 * ## This is no longer the primary path
 *
 * A paid order is invoiced by `src/subscribers/enqueue-invoice.ts`, which enqueues
 * the order and then immediately runs this same pipeline for that one row - so the
 * invoice is issued seconds after `payment.captured`, not on the next tick of a
 * cron. See `src/lib/invoicing/run.ts`, which both callers share.
 *
 * What this job is for is everything that path cannot finish by itself:
 *
 *  - an event that was never delivered, or arrived while invoicing was paused;
 *  - a row deferred because the order was not fully paid yet, or because inFakt's
 *    async create task had not settled;
 *  - a row that failed transiently and is waiting out its backoff;
 *  - a run that lost the single-flight claim to a concurrent one;
 *  - a KSeF integration that was not ready at payment time and has since been fixed.
 *
 * That is a reconciliation loop, and it is why the five-minute default is still
 * the right interval even though nothing routine waits for it any more.
 *
 * Durable by construction: every external interaction persists its result column
 * before the next one starts, and `nextStep` derives where to resume purely from
 * which columns are still null. A crash at any instant resumes exactly where it
 * stopped on the next tick.
 *
 * Runs are single-flighted through the module's atomic claim. That is not
 * bookkeeping: two overlapping runs reading the same due row would both POST an
 * invoice create, and inFakt has no idempotency key, so that is two real numbered
 * invoices for one order with no way to withdraw either. It is also what makes the
 * subscriber and this job safe to race - the loser does not run.
 *
 * Buyer data is read transiently to build the payload and is never logged or
 * persisted by this plugin.
 */
export default async function infaktInvoicingJob(container: MedusaContainer): Promise<void> {
  await runInvoicing(container, { source: JOB_NAME });
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
   * Every five minutes, and deliberately no shorter.
   *
   * Everything here is event-driven; crons are safety nets, never the mechanism.
   * If a normal invoice only completes when this tick next fires, that is a
   * defect in the event path, not a reason to shorten the interval - shortening
   * it would hide the defect and spend inFakt requests for nothing. The payment
   * subscriber issues the invoice, the billing-ready event wakes a row that was
   * waiting for an address, the KSeF poll rides its own document to a terminal
   * state inside one run, and the admin actions run the pipeline as they are
   * clicked. This tick exists for what none of those could finish.
   */
  schedule: process.env.INFAKT_WORKER_CRON ?? "*/5 * * * *",
};
