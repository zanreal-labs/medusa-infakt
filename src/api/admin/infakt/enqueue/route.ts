import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { INFAKT_MODULE } from "../../../../modules/infakt";
import type InfaktModuleService from "../../../../modules/infakt/service";

/**
 * POST /admin/infakt/enqueue  { "order_id": "order_01..." }
 *
 * Manually queue an order for invoicing.
 *
 * Event delivery is at-most-once, so an order can be missed - the event bus was
 * down, the plugin was installed after the order was placed, or `startDate` was
 * raised and then lowered again. This is the recovery path, and it is safe by
 * construction: it only creates the ledger row, and the worker still applies every
 * gate (start date, currency, fully-paid, cancellation) before anything is issued.
 *
 * Queuing an order that is already queued is a no-op, not an error - the response
 * says which happened.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);
  const orderId = String((req.body as { order_id?: string } | undefined)?.order_id ?? "").trim();

  if (!orderId) {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, "`order_id` is required.");
  }
  if (infakt.resolvedOptions.startDate === null) {
    throw new MedusaError(
      MedusaError.Types.NOT_ALLOWED,
      "Invoicing is disabled: the plugin's `startDate` option is missing or is not a YYYY-MM-DD date. Set it before queuing orders.",
    );
  }

  const { created } = await infakt.enqueueOrder(orderId);
  res.json({
    created,
    note: created
      ? "queued; the worker will apply the start-date, currency and fully-paid gates on its next tick"
      : "this order was already queued - nothing changed",
    order_id: orderId,
  });
}
