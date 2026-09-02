import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import type { Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { runInvoicingNow } from "../lib/invoicing/run";
import { orderIdForPayment } from "../lib/invoicing/trigger";
import type { GraphQuery } from "../lib/invoicing/trigger";
import { INFAKT_MODULE } from "../modules/infakt";
import type InfaktModuleService from "../modules/infakt/service";

/**
 * Admission to the invoicing queue - and, immediately afterwards, the run that
 * drains it. This is the PRIMARY path to an issued invoice; the cron in
 * `src/jobs/infakt-invoicing.ts` is the safety net behind it.
 *
 * The handler still does exactly one thing of its own: create a row saying "this
 * order will be invoiced". It never builds a payload, never calls inFakt, and
 * never decides whether the order is ready. What it does after enqueueing is ask
 * the shared runner (`src/lib/invoicing/run.ts`) to advance that one row now,
 * which is the same code the cron runs - not a second, faster implementation of
 * it.
 *
 * That division is the point. Event delivery is at-most-once and can arrive
 * early, late, or more than once; issuing an invoice is irreversible. So the
 * event only records intent, and the worker - which is idempotent, restartable and
 * re-reads live state on every run - owns every consequential decision:
 *
 *  - Whether the order is fully paid (`payment.captured` fires per capture, and an
 *    order can be captured in parts).
 *  - Whether it predates `startDate`.
 *  - Whether the currency is invoiceable.
 *  - Whether it should be filed to KSeF.
 *
 * This handler DOES make one enablement check of its own - whether invoicing is
 * effectively on at all (`apiKey` configured, not paused, not force-disabled by
 * the environment) - because there is no point creating a row the worker will
 * never pick up. That is a read of runtime state, not a business decision about
 * this particular order, so it stays here rather than moving into the worker.
 *
 * A duplicate event is harmless: `order_id` is unique, so `enqueueOrder` is a
 * no-op the second time. A missed event is recoverable: an operator can enqueue
 * the order from the admin UI.
 *
 * ## Which event
 *
 * Both supported triggers are subscribed here, and the one that is not configured
 * returns immediately. Medusa binds a subscriber's events from the static `config`
 * export, which is evaluated at module load - before the DI container exists - so
 * the plugin's `triggerEvent` option cannot narrow the subscription itself. It has
 * to be enforced inside the handler, where the module is resolvable.
 *
 * ## And one event that is not a trigger
 *
 * `allegro.order.billing_ready` fires the moment a marketplace order's billing
 * address is written, which on a marketplace order happens AFTER the payment: on
 * `order_01M1H1PA8BHJMKFPBZWA78F5XQ` the payment landed at 12:36:24 and the
 * address 16 seconds later. A row that deferred waiting for that address is
 * waiting for exactly this event, so it advances the row immediately instead of
 * leaving it to the next cron tick.
 *
 * It deliberately does NOT enqueue. A row created here, before any payment, would
 * hit the fully-paid gate and defer for 30 minutes - and the payment event that
 * follows could not shorten that wait, because only a data wait is due early
 * (see `listDueInvoicesForOrder`). The configured trigger still owns admission;
 * this event only says "the thing the row was waiting for is here now".
 */
/**
 * Emitted by `@zanreal/medusa-allegro` the moment a marketplace order's billing
 * address is written. Payload is `{ id: <medusa order id> }`, the same shape as
 * `order.placed`.
 */
const BILLING_READY_EVENT = "allegro.order.billing_ready";

export default async function enqueueInvoiceSubscriber({
  container,
  event,
}: SubscriberArgs<{ id: string }>): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const infakt = container.resolve<InfaktModuleService>(INFAKT_MODULE);
  // Effective, not boot-only: an operator can change `triggerEvent` from the
  // Settings page, and it must take effect on the very next event, not the next
  // restart.
  const options = await infakt.getEffectiveOptions();

  const billingReady = event.name === BILLING_READY_EVENT;
  if (!(billingReady || event.name === options.triggerEvent)) {
    return;
  }

  const enablement = await infakt.getEffectiveEnablement();
  if (!enablement.effectiveEnabled) {
    // No boot-time log covers "paused" or "force-disabled by the environment" -
    // both are runtime toggles, not boot-time facts - so this is deliberately
    // silent per event rather than noisy every time an order is placed. The
    // admin's Invoicing page is the place to see the current state.
    return;
  }

  const orderId = await resolveOrderId(container, event.name, event.data.id);
  if (!orderId) {
    logger.debug?.(
      `[medusa-infakt] ${event.name} ${event.data.id} has no order behind it - nothing to invoice.`,
    );
    return;
  }

  if (billingReady) {
    // Not a trigger: advance whatever is already queued for this order, and do
    // nothing at all if nothing is. See the note above on why this must not
    // enqueue.
    await runInvoicingNow(container, {
      orderId,
      source: "medusa-infakt/on-billing-ready",
    });
    return;
  }

  const { created } = await infakt.enqueueOrder(orderId);
  if (created) {
    logger.info(`[medusa-infakt] queued order ${orderId} for invoicing (${event.name}).`);
  } else {
    // Not a warning: a re-delivered event and a second capture on the same order
    // both land here, and both are the unique constraint doing its job.
    logger.debug?.(`[medusa-infakt] order ${orderId} is already queued for invoicing.`);
  }

  await runInvoicingNow(container, { orderId, source: "medusa-infakt/on-capture" });
}

async function resolveOrderId(
  container: SubscriberArgs["container"],
  eventName: string,
  id: string,
): Promise<string | null> {
  if (eventName === "order.placed" || eventName === BILLING_READY_EVENT) {
    return id;
  }
  const query = container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY);
  return orderIdForPayment(query, id);
}

/**
 * Both triggers are subscribed; the handler ignores the one that is not
 * configured. See the note above on why this cannot be narrowed here.
 *
 * `allegro.order.billing_ready` is subscribed too, and is not a trigger: it
 * carries `{ id: <medusa order id> }` and only wakes a row that is already
 * waiting for the address it announces.
 */
export const config: SubscriberConfig = {
  event: ["payment.captured", "order.placed", BILLING_READY_EVENT],
};
