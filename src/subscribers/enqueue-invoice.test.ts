import type { SubscriberArgs } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { describe, expect, it, vi } from "vitest";
import { resolveInfaktOptions } from "../lib/options";
import type { InfaktPluginOptions } from "../lib/options";
import { INFAKT_MODULE } from "../modules/infakt";
import enqueueInvoiceSubscriber, { config } from "./enqueue-invoice";

const logger = () => ({
  debug: vi.fn(),
  error: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
});

const harness = (setup?: {
  options?: Partial<InfaktPluginOptions>;
  orderId?: string | null;
  enqueue?: ReturnType<typeof vi.fn>;
}) => {
  const log = logger();
  const enqueueOrder = setup?.enqueue ?? vi.fn().mockResolvedValue({ created: true });
  const graph = vi.fn().mockResolvedValue({
    data:
      setup?.orderId === null
        ? [{ id: "pay_1", payment_collection: null }]
        : [{ id: "pay_1", payment_collection: { order: { id: setup?.orderId ?? "order_1" } } }],
  });
  const infakt = {
    enqueueOrder,
    resolvedOptions: resolveInfaktOptions({
      apiKey: "k",
      startDate: "2026-07-01",
      ...setup?.options,
    }),
  };

  const container = {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.LOGGER) {
        return log;
      }
      if (key === ContainerRegistrationKeys.QUERY) {
        return { graph };
      }
      if (key === INFAKT_MODULE) {
        return infakt;
      }
      throw new Error(`unexpected resolve(${key})`);
    },
  } as unknown as SubscriberArgs["container"];

  return { container, enqueueOrder, graph, log };
};

const run = (container: SubscriberArgs["container"], name: string, id: string): Promise<void> =>
  enqueueInvoiceSubscriber({
    container,
    event: { data: { id }, name },
    pluginOptions: {},
  } as unknown as SubscriberArgs<{ id: string }>);

describe("config", () => {
  it("subscribes to both supported triggers", () => {
    // Medusa binds a subscriber's events from this static export, evaluated before
    // the DI container exists, so the configured trigger cannot narrow it here. The
    // handler enforces the choice instead.
    expect(config.event).toEqual(["payment.captured", "order.placed"]);
  });
});

describe("enqueueInvoiceSubscriber", () => {
  it("enqueues the order behind a captured payment", async () => {
    const { container, enqueueOrder, graph } = harness();
    await run(container, "payment.captured", "pay_1");
    expect(graph).toHaveBeenCalled();
    expect(enqueueOrder).toHaveBeenCalledWith("order_1");
  });

  it("enqueues an order.placed id directly, with no graph hop", async () => {
    const { container, enqueueOrder, graph } = harness({
      options: { triggerEvent: "order.placed" },
    });
    await run(container, "order.placed", "order_9");
    expect(graph).not.toHaveBeenCalled();
    expect(enqueueOrder).toHaveBeenCalledWith("order_9");
  });

  it("ignores the event that is not configured", async () => {
    const { container, enqueueOrder } = harness();
    await run(container, "order.placed", "order_9");
    expect(enqueueOrder).not.toHaveBeenCalled();
  });

  it("ignores payment.captured when order.placed is configured", async () => {
    const { container, enqueueOrder } = harness({ options: { triggerEvent: "order.placed" } });
    await run(container, "payment.captured", "pay_1");
    expect(enqueueOrder).not.toHaveBeenCalled();
  });

  it("does nothing at all when the plugin is disabled (no apiKey)", async () => {
    const { container, enqueueOrder, graph } = harness({ options: { apiKey: undefined } });
    await run(container, "payment.captured", "pay_1");
    expect(enqueueOrder).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
  });

  it("still enqueues when startDate is unset - it is no longer an enable switch", async () => {
    const { container, enqueueOrder } = harness({ options: { startDate: undefined } });
    await run(container, "payment.captured", "pay_1");
    expect(enqueueOrder).toHaveBeenCalledWith("order_1");
  });

  it("does nothing when the payment has no order behind it", async () => {
    const { container, enqueueOrder } = harness({ orderId: null });
    await run(container, "payment.captured", "pay_1");
    expect(enqueueOrder).not.toHaveBeenCalled();
  });

  it("logs a first enqueue at info and a duplicate at debug", async () => {
    const first = harness();
    await run(first.container, "payment.captured", "pay_1");
    expect(first.log.info).toHaveBeenCalledWith(expect.stringContaining("queued order order_1"));

    const duplicate = harness({ enqueue: vi.fn().mockResolvedValue({ created: false }) });
    await run(duplicate.container, "payment.captured", "pay_1");
    // Not a warning: a re-delivered event and a second capture both land here, and
    // both are the unique constraint doing its job.
    expect(duplicate.log.info).not.toHaveBeenCalled();
    expect(duplicate.log.debug).toHaveBeenCalledWith(expect.stringContaining("already queued"));
  });

  it("never issues an invoice itself - it only ever enqueues", async () => {
    // The whole safety argument: event delivery is at-most-once and can arrive
    // early, late or twice, while issuing an invoice is irreversible. The only thing
    // this handler is allowed to do is record intent.
    const { container, enqueueOrder } = harness();
    await run(container, "payment.captured", "pay_1");
    expect(enqueueOrder).toHaveBeenCalledTimes(1);
  });
});
