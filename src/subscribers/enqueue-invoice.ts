import type { SubscriberArgs, SubscriberConfig } from "@medusajs/framework";
import type { Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { orderIdForPayment } from "../lib/invoicing/trigger";
import type { GraphQuery } from "../lib/invoicing/trigger";
import { INFAKT_MODULE } from "../modules/infakt";
import type InfaktModuleService from "../modules/infakt/service";

/**
 * Admission to the invoicing queue.
 *
 * This subscriber does exactly one thing: create a row saying "this order will be
 * invoiced". It never builds a payload, never calls inFakt, and never decides
 * whether the order is ready.
 *
 * That division is the point. Event delivery is at-most-once and can arrive
 * early, late, or more than once; issuing an invoice is irreversible. So the
 * event only records intent, and the worker - which is idempotent, restartable and
 * re-reads live state on every tick - owns every consequential decision:
 *
 *  - Whether the order is fully paid (`payment.captured` fires per capture, and an
 *    order can be captured in parts).
 *  - Whether it predates `startDate`.
 *  - Whether the currency is invoiceable.
 *  - Whether it should be filed to KSeF.
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
 */
export default async function enqueueInvoiceSubscriber({
  container,
  event,
}: SubscriberArgs<{ id: string }>): Promise<void> {
  const logger = container.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const infakt = container.resolve<InfaktModuleService>(INFAKT_MODULE);
  const options = infakt.resolvedOptions;

  if (event.name !== options.triggerEvent) {
    return;
  }
  if (options.startDate === null) {
    // The loader already said this loudly at boot; do not repeat it per order.
    return;
  }

  const orderId = await resolveOrderId(container, event.name, event.data.id);
  if (!orderId) {
    logger.debug?.(
      `[medusa-infakt] ${event.name} ${event.data.id} has no order behind it - nothing to invoice.`,
    );
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
}

async function resolveOrderId(
  container: SubscriberArgs["container"],
  eventName: string,
  id: string,
): Promise<string | null> {
  if (eventName === "order.placed") {
    return id;
  }
  const query = container.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY);
  return orderIdForPayment(query, id);
}

/**
 * Both triggers are subscribed; the handler ignores the one that is not
 * configured. See the note above on why this cannot be narrowed here.
 */
export const config: SubscriberConfig = {
  event: ["payment.captured", "order.placed"],
};
