import type { SubscriberArgs } from "@medusajs/framework";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveEffectiveEnablement } from "../lib/invoicing/enablement";
import { runInvoicing } from "../lib/invoicing/run";
import { resolveInfaktOptions } from "../lib/options";
import type { InfaktPluginOptions } from "../lib/options";
import { INFAKT_MODULE } from "../modules/infakt";
import enqueueInvoiceSubscriber, { config } from "./enqueue-invoice";

// The runner has its own suite (`src/lib/invoicing/run.test.ts`). What matters
// here is only that the subscriber asks for the right run and survives it
// failing.
vi.mock("../lib/invoicing/run", () => ({ runInvoicing: vi.fn() }));

beforeEach(() => {
  vi.mocked(runInvoicing).mockReset();
  vi.mocked(runInvoicing).mockResolvedValue({
    completed: 1,
    deferred: 0,
    failed: 0,
    processed: 1,
    reArmed: 0,
    review: 0,
    skippedRows: 0,
  });
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
    expect(runInvoicing).toHaveBeenCalledWith(
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
    expect(runInvoicing).toHaveBeenCalledTimes(1);
  });

  it("never starts a run for an event it is ignoring", async () => {
    const { container } = harness();
    await run(container, "order.placed", "order_9");
    expect(runInvoicing).not.toHaveBeenCalled();
  });

  it("never starts a run while invoicing is paused", async () => {
    const { container } = harness({ invoicingPaused: true });
    await run(container, "payment.captured", "pay_1");
    expect(runInvoicing).not.toHaveBeenCalled();
  });

  it("never starts a run when the payment has no order behind it", async () => {
    const { container } = harness({ orderId: null });
    await run(container, "payment.captured", "pay_1");
    expect(runInvoicing).not.toHaveBeenCalled();
  });

  it("swallows a KSeF refusal and leaves the row for the worker", async () => {
    // The gate is deliberately unchanged: if KSeF is not ready the refusal stands.
    // Throwing here would hand the event bus an unbounded retry of a pipeline whose
    // safety rests on being re-entered deliberately, and the cron is already the
    // designed retry.
    vi.mocked(runInvoicing).mockRejectedValue(
      new Error("KSeF is required but not ready: inFakt reports no active integration"),
    );
    const { container, log } = harness();
    await expect(run(container, "payment.captured", "pay_1")).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("stays queued"));
  });

  it("swallows any other failure too, and says the worker will retry", async () => {
    vi.mocked(runInvoicing).mockRejectedValue(new Error("connection reset"));
    const { container, log } = harness();
    await expect(run(container, "payment.captured", "pay_1")).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("connection reset"));
  });

  it("notes at debug when the run was skipped because another run held the claim", async () => {
    vi.mocked(runInvoicing).mockResolvedValue({
      completed: 0,
      deferred: 0,
      failed: 0,
      processed: 0,
      reArmed: 0,
      review: 0,
      skipped: "another invoicing run holds the lock",
      skippedRows: 0,
    });
    const { container, log } = harness();
    await run(container, "payment.captured", "pay_1");
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("holds the lock"));
  });
});
