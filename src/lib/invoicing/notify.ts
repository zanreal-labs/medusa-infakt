/**
 * The admin notification a parked invoice raises.
 *
 * The IA principle this plugin follows is that a `needs_review` invoice is a
 * FAILURE an operator must be told about - not a row to discover by opening a
 * table. So the moment the worker parks an order for a human, it raises a Medusa
 * admin-feed notification that names the order and says why. The operator sees it
 * in the dashboard's notification centre and clicks through to the order, where
 * the order-detail widget carries the state and the buttons to resolve it.
 *
 * This module is the pure, testable half: it builds the notification payload and
 * decides nothing about I/O. The worker (`src/jobs/infakt-invoicing.ts`) resolves
 * the Notification module and sends it, tolerating a host that has no notification
 * provider wired - a missing alert must never fail an invoicing run.
 *
 * The `feed` channel with the `admin-ui` template is Medusa's built-in mechanism
 * for in-app admin notifications, served by the Local Notification provider that
 * is registered by default. Verified against @medusajs 2.18.
 */

/** Medusa's built-in in-app admin notification channel. */
export const ADMIN_FEED_CHANNEL = "feed";
/** The template the default Local provider renders for the admin feed. */
export const ADMIN_FEED_TEMPLATE = "admin-ui";

/**
 * Shape accepted by `INotificationModuleService.createNotifications`. Declared
 * structurally rather than imported so this pure module pulls in no framework
 * type surface, and so the builder's output is asserted against a fixed contract
 * in tests.
 */
export interface AdminFeedNotification {
  to: string;
  channel: string;
  template: string;
  data: { title: string; description: string };
  resource_id: string;
  resource_type: string;
  trigger_type: string;
  idempotency_key: string;
}

/** Trigger identifier stamped on the notification, for anyone filtering the feed. */
export const NEEDS_REVIEW_TRIGGER = "infakt.invoice.needs_review";

/**
 * Build the admin-feed notification for an order the pipeline could not invoice
 * automatically.
 *
 * The description carries only the order id and the pipeline's already-truncated,
 * PII-free reason - the same string shown in `last_error` - so nothing about the
 * buyer leaves the pipeline through the notification either.
 *
 * `resource_id`/`resource_type` deep-link the notification to the order, so the
 * operator lands exactly on the page that can resolve it. `idempotency_key`
 * folds the attempt count in, so a row re-parked after an operator retry raises a
 * fresh alert while an accidental double-send within one transition does not.
 */
export function buildNeedsReviewNotification(input: {
  orderId: string;
  message: string;
  attempts: number;
}): AdminFeedNotification {
  const { orderId, message, attempts } = input;
  return {
    channel: ADMIN_FEED_CHANNEL,
    data: {
      description: `Order ${orderId} could not be invoiced automatically and needs a manual decision: ${message}`,
      title: "Invoice needs review",
    },
    idempotency_key: `infakt-needs-review-${orderId}-${attempts}`,
    resource_id: orderId,
    resource_type: "order",
    template: ADMIN_FEED_TEMPLATE,
    to: "",
    trigger_type: NEEDS_REVIEW_TRIGGER,
  };
}
