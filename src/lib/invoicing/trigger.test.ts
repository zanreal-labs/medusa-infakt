import { describe, expect, it, vi } from "vitest";
import { orderIdForPayment } from "./trigger";
import type { GraphQuery } from "./trigger";

const graphReturning = (data: unknown[]): GraphQuery & { graph: ReturnType<typeof vi.fn> } => {
  const graph = vi.fn().mockResolvedValue({ data });
  return { graph } as never;
};

describe("orderIdForPayment", () => {
  it("walks payment to payment_collection to order", async () => {
    const query = graphReturning([
      { id: "pay_1", payment_collection: { order: { id: "order_1" } } },
    ]);
    await expect(orderIdForPayment(query, "pay_1")).resolves.toBe("order_1");
    expect(query.graph).toHaveBeenCalledWith({
      entity: "payment",
      fields: ["id", "payment_collection.order.id"],
      filters: { id: "pay_1" },
    });
  });

  it("handles the array shape the hasMany link can produce", async () => {
    const query = graphReturning([
      { id: "pay_1", payment_collection: { order: [{ id: "order_1" }] } },
    ]);
    await expect(orderIdForPayment(query, "pay_1")).resolves.toBe("order_1");
  });

  it("returns null - not an error - when the payment has no order", async () => {
    // A payment collection on a cart that never became an order is a real, expected
    // shape. Throwing would make Medusa retry the event forever over a non-error.
    for (const payment of [
      { id: "pay_1", payment_collection: { order: null } },
      { id: "pay_1", payment_collection: null },
      { id: "pay_1" },
    ]) {
      await expect(orderIdForPayment(graphReturning([payment]), "pay_1")).resolves.toBeNull();
    }
  });

  it("returns null when the payment itself is not found", async () => {
    await expect(orderIdForPayment(graphReturning([]), "pay_1")).resolves.toBeNull();
    await expect(
      orderIdForPayment({ graph: vi.fn().mockResolvedValue({}) } as never, "pay_1"),
    ).resolves.toBeNull();
  });

  it("returns null for an empty linked-order array", async () => {
    const query = graphReturning([{ id: "pay_1", payment_collection: { order: [] } }]);
    await expect(orderIdForPayment(query, "pay_1")).resolves.toBeNull();
  });
});
