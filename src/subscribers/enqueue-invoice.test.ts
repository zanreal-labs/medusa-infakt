import type { SubscriberArgs } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEffectiveEnablement } from "../lib/invoicing/enablement";
import { runInvoicingNow } from "../lib/invoicing/run";
import { resolveInfaktOptions } from "../lib/options";
import type { InfaktPluginOptions } from "../lib/options";
import { INFAKT_MODULE } from "../modules/infakt";
import enqueueInvoiceSubscriber, { config } from "./enqueue-invoice";

// The runner and its swallow-and-log discipline have their own suite
// (`src/lib/invoicing/run.test.ts`). What matters here is only which run the
// subscriber asks for, and for which event.
vi.mock("../lib/invoicing/run", () => ({ runInvoicing: vi.fn(), runInvoicingNow: vi.fn() }));

beforeEach(() => {
  vi.mocked(runInvoicingNow).mockReset();
  vi.mocked(runInvoicingNow).mockResolvedValue(undefined);
});

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
  invoicingPaused?: boolean;
  envForceDisabled?: boolean;
}) => {
  const log = logger();
  const enqueueOrder = setup?.enqueue ?? vi.fn().mockResolvedValue({ created: true });
  const graph = vi.fn().mockResolvedValue({
    data:
      setup?.orderId === null
        ? [{ id: "pay_1", payment_collection: null }]
        : [{ id: "pay_1", payment_collection: { order: { id: setup?.orderId ?? "order_1" } } }],
  });
  const resolvedOptions = resolveInfaktOptions({
    apiKey: "k",
    startDate: "2026-07-01",
    ...setup?.options,
  });
  const infakt = {
    enqueueOrder,
    getEffectiveEnablement: vi.fn().mockResolvedValue(
      resolveEffectiveEnablement({
        apiKeyConfigured: resolvedOptions.enabled,
        envForceDisabled: setup?.envForceDisabled ?? false,
        invoicingPaused: setup?.invoicingPaused ?? false,
      }),
    ),
    getEffectiveOptions: vi.fn().mockResolvedValue(resolvedOptions),
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
    expect(config.event).toEqual([
      "payment.captured",
      "order.placed",
      "allegro.order.billing_ready",
    ]);
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

  it("does nothing while invoicing is paused, even with apiKey configured", async () => {
    const { container, enqueueOrder, graph } = harness({ invoicingPaused: true });
    await run(container, "payment.captured", "pay_1");
    expect(enqueueOrder).not.toHaveBeenCalled();
    expect(graph).not.toHaveBeenCalled();
  });

  it("does nothing when force-disabled by the environment, even if not paused", async () => {
    const { container, enqueueOrder } = harness({
      envForceDisabled: true,
      invoicingPaused: false,
    });
    await run(container, "payment.captured", "pay_1");
    expect(enqueueOrder).not.toHaveBeenCalled();
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

  it("records intent exactly once, however the invoice is then issued", async () => {
    // Event delivery is at-most-once and can arrive early, late or twice, while
    // issuing an invoice is irreversible - so the handler still only ever records
    // intent itself. Everything consequential happens inside the shared runner,
    // behind the atomic claim.
    const { container, enqueueOrder } = harness();
    await run(container, "payment.captured", "pay_1");
    expect(enqueueOrder).toHaveBeenCalledTimes(1);
  });
});

describe("enqueueInvoiceSubscriber: issuing the invoice the moment payment lands", () => {
  it("runs the invoicing pipeline for that one order, right after enqueueing it", async () => {
    const { container } = harness();
    await run(container, "payment.captured", "pay_1");
    expect(runInvoicingNow).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ orderId: "order_1" }),
    );
  });

  it("runs it for an order that was already queued, not just a fresh one", async () => {
    // A re-delivered event, or a second capture, still finds a pending row. The
    // due-predicate decides whether there is anything left to do - not this
    // handler, and not whether the enqueue happened to create the row.
    const { container } = harness({ enqueue: vi.fn().mockResolvedValue({ created: false }) });
    await run(container, "payment.captured", "pay_1");
    expect(runInvoicingNow).toHaveBeenCalledTimes(1);
  });

  it("never starts a run for an event it is ignoring", async () => {
    const { container } = harness();
    await run(container, "order.placed", "order_9");
    expect(runInvoicingNow).not.toHaveBeenCalled();
  });

  it("never starts a run while invoicing is paused", async () => {
    const { container } = harness({ invoicingPaused: true });
    await run(container, "payment.captured", "pay_1");
    expect(runInvoicingNow).not.toHaveBeenCalled();
  });

  it("never starts a run when the payment has no order behind it", async () => {
    const { container } = harness({ orderId: null });
    await run(container, "payment.captured", "pay_1");
    expect(runInvoicingNow).not.toHaveBeenCalled();
  });
});

/**
 * The billing address on a marketplace order arrives AFTER the payment - 16
 * seconds after it on `order_01M1H1PA8BHJMKFPBZWA78F5XQ`. A row that deferred
 * waiting for it is waiting for exactly this event.
 */
describe("enqueueInvoiceSubscriber: the billing-ready event", () => {
  it("advances the order's row the moment the address is written", async () => {
    const { container, graph } = harness();
    await run(container, "allegro.order.billing_ready", "order_1");
    expect(graph).not.toHaveBeenCalled();
    expect(runInvoicingNow).toHaveBeenCalledWith(
      container,
      expect.objectContaining({ orderId: "order_1" }),
    );
  });

  it("does not enqueue: admission stays with the configured trigger", async () => {
    // A row created here, before any payment, would hit the fully-paid gate and
    // defer for 30 minutes, and the payment event that follows could not shorten
    // that wait - only a data wait is due early.
    const { container, enqueueOrder } = harness();
    await run(container, "allegro.order.billing_ready", "order_1");
    expect(enqueueOrder).not.toHaveBeenCalled();
  });

  it("is handled whichever trigger event is configured", async () => {
    const { container } = harness({ options: { triggerEvent: "order.placed" } });
    await run(container, "allegro.order.billing_ready", "order_1");
    expect(runInvoicingNow).toHaveBeenCalledTimes(1);
  });

  it("does nothing while invoicing is off", async () => {
    const { container } = harness({ invoicingPaused: true });
    await run(container, "allegro.order.billing_ready", "order_1");
    expect(runInvoicingNow).not.toHaveBeenCalled();
  });
});
