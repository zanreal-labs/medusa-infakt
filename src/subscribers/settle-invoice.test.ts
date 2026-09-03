import type { SubscriberArgs } from "@medusajs/framework";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { settleOrderNow } from "../lib/invoicing/settlement-run";
import settleInvoiceSubscriber, { config } from "./settle-invoice";

// The run and its swallow-and-log discipline live in `settlement-run.ts`; the
// reconciliation rules live in `settle.ts` and `settlement.ts`, each with their
// own suite. What matters here is only which order this asks about, for which
// event.
vi.mock("../lib/invoicing/settlement-run", () => ({
  runSettlement: vi.fn(),
  settleOrderNow: vi.fn(),
}));

beforeEach(() => {
  vi.mocked(settleOrderNow).mockReset();
  vi.mocked(settleOrderNow).mockResolvedValue(undefined);
});

const harness = (orderId: string | null = "order_1") => {
  const graph = vi.fn().mockResolvedValue({
    data:
      orderId === null
        ? [{ id: "pay_1", payment_collection: null }]
        : [{ id: "pay_1", payment_collection: { order: { id: orderId } } }],
  });
  return {
    container: { resolve: vi.fn().mockReturnValue({ graph }) },
    graph,
  };
};

const fire = async (eventName: string, id: string, container: unknown) =>
  await settleInvoiceSubscriber({
    container,
    event: { data: { id }, name: eventName },
  } as unknown as SubscriberArgs<{ id: string }>);

describe("settle-invoice subscriber", () => {
  it("subscribes to the three events that can change a settlement", () => {
    // A refund is the only way a settled invoice becomes wrong after the fact,
    // and nothing else in this plugin notices one.
    expect(config.event).toEqual(["payment.captured", "payment.refunded", "order.canceled"]);
  });

  it("reconciles the order behind a captured payment", async () => {
    const { container, graph } = harness();
    await fire("payment.captured", "pay_1", container);

    expect(graph).toHaveBeenCalled();
    expect(settleOrderNow).toHaveBeenCalledWith(container, {
      orderId: "order_1",
      source: "medusa-infakt/settle-on-payment.captured",
    });
  });

  it("reconciles the order behind a refunded payment", async () => {
    const { container } = harness();
    await fire("payment.refunded", "pay_1", container);

    expect(settleOrderNow).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ orderId: "order_1" }),
    );
  });

  it("takes order.canceled's id as the order, with no graph hop", async () => {
    const { container, graph } = harness();
    await fire("order.canceled", "order_9", container);

    expect(graph).not.toHaveBeenCalled();
    expect(settleOrderNow).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ orderId: "order_9" }),
    );
  });

  it("does nothing for a payment with no order behind it", async () => {
    // A payment collection for a cart that never became an order is a real,
    // expected shape - not an error to reconcile or to throw over.
    const { container } = harness(null);
    await fire("payment.captured", "pay_1", container);

    expect(settleOrderNow).not.toHaveBeenCalled();
  });
});
