import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { settleOrderNow } from "../lib/invoicing/settlement-run";
import { orderIdForPayment } from "../lib/invoicing/trigger";
import type { GraphQuery } from "../lib/invoicing/trigger";

/**
 * Keep the settlement ledger current for the order something just happened to.
 *
 * This is the PRIMARY path of the settlement reconciliation; the hourly job in
 * `src/jobs/infakt-settlement.ts` is the backstop behind it. Same division as
 * invoicing, for the same reason: an event is the cheapest possible signal that
 * a specific row is worth re-reading, and a cron that re-reads everything on the
 * chance that one row moved is a waste of somebody's API quota.
 *
 * ## Which events, and why exactly these three
 *
 * - `payment.captured` - the money landed. If the invoice for this order is
 *   already issued, its settlement is now checkable; if it is not, this is a
 *   no-op and the row is checked after it completes.
 * - `payment.refunded` - money went BACK, which is the one way a settled invoice
 *   can become wrong after the fact. Nothing else in this plugin notices a
 *   refund at all.
 * - `order.canceled` - the same question from the other direction: an invoice
 *   inFakt has settled against a canceled order is a discrepancy a human has to
 *   resolve.
 *
 * ## And what it does NOT do
 *
 * It does not enqueue anything, does not issue anything, does not mark anything
 * paid, and does not write payment state back into Medusa. It reads one invoice
 * from inFakt, compares, and records the verdict on the ledger row. A refund
 * therefore produces a REPORT, never an automatic correction: inFakt has no
 * "un-mark", the correct instrument is a corrective invoice, and issuing one is
 * not a decision a subscriber gets to make.
 *
 * Every failure is swallowed one layer down (`settleOrderNow`): a throwing
 * subscriber is retried by the event bus with no bound and no visibility, and
 * the hourly job is the designed retry.
 */

const PAYMENT_EVENTS = new Set(["payment.captured", "payment.refunded"]);

export default async function settleInvoiceSubscriber({
  container,
  event,
}: SubscriberArgs<{ id: string }>): Promise<void> {
  const orderId = await resolveOrderId(container, event.name, event.data.id);
  if (!orderId) {
    return;
  }
  await settleOrderNow(container, {
    orderId,
    source: `medusa-infakt/settle-on-${event.name}`,
  });
}

/**
 * `order.canceled` carries the order; both payment events carry a PAYMENT, which
 * reaches its order through the link module - the same hop the invoicing trigger
 * makes, through the same helper, so the two paths cannot disagree about which
 * order a payment belongs to.
 */
async function resolveOrderId(
  container: SubscriberArgs["container"],
  eventName: string,
  id: string,
): Promise<string | null> {
  if (!PAYMENT_EVENTS.has(eventName)) {
    return id;
  }
  const query = container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY);
  return orderIdForPayment(query, id);
}

export const config: SubscriberConfig = {
  event: ["payment.captured", "payment.refunded", "order.canceled"],
};
