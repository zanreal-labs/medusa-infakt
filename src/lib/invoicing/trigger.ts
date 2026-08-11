/**
 * Resolving the order behind a trigger event.
 *
 * The two supported triggers deliver different payloads:
 *
 *  - `order.placed` gives `{ id }` where `id` is the order.
 *  - `payment.captured` gives `{ id }` where `id` is a PAYMENT. Medusa links a
 *    payment to its collection, and the collection to the order, through the
 *    `order_payment_collection` link module - so getting from one to the other is
 *    a graph hop, not a column read.
 *
 * Split out of the subscriber so the hop and its failure modes are testable
 * without a container.
 */

/** The `query.graph` surface this module uses. */
export interface GraphQuery {
  graph: (input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
  }) => Promise<{ data?: unknown[] }>;
}

/**
 * The order id behind a captured payment, or null when it cannot be resolved.
 *
 * Returning null rather than throwing is deliberate. A payment with no order is a
 * real, expected shape - a payment collection created for a cart that never
 * became an order, or one attached to a claim or exchange rather than the order
 * itself. Throwing would make the subscriber fail and Medusa retry the event
 * forever over something that is not an error.
 */
export async function orderIdForPayment(
  query: GraphQuery,
  paymentId: string,
): Promise<string | null> {
  const { data } = await query.graph({
    entity: "payment",
    fields: ["id", "payment_collection.order.id"],
    filters: { id: paymentId },
  });
  const [payment] = (data ?? []) as {
    payment_collection?: { order?: { id?: string } | { id?: string }[] | null } | null;
  }[];
  const order = payment?.payment_collection?.order;
  if (!order) {
    return null;
  }
  // The link is declared `hasMany` from the collection side, so depending on the
  // read path `order` arrives as an object or a single-element array.
  const resolved = Array.isArray(order) ? order[0] : order;
  return resolved?.id ?? null;
}
