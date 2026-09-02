import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INFAKT_MODULE } from "../../modules/infakt";
import { processInvoiceRow } from "./pipeline";
import { runInvoicing, runInvoicingNow } from "./run";
import { dataWaitSignal, deferSignal, reviewSignal } from "./state-machine";

vi.mock("./pipeline", () => ({ processInvoiceRow: vi.fn() }));

/**
 * The shared runner, exercised through the gates that both callers depend on.
 *
 * The point of these tests is that the payment-time path and the cron are the
 * SAME run: everything below holds regardless of which one started it, and the
 * two tests that differ are only about which rows get drained.
 */

const logger = () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() });

const harness = (setup?: {
  effectiveEnabled?: boolean;
  claim?: { acquired: boolean; token?: string; reason?: string };
  rows?: Record<string, unknown>[];
  ksef?: { possible: boolean; requireActive: boolean; active: boolean };
  released?: boolean;
}) => {
  const log = logger();
  const rows = setup?.rows ?? [];
  const infakt = {
    claimRun: vi
      .fn()
      .mockResolvedValue(setup?.claim ?? { acquired: true, token: "tok_1" }),
    getApiClient: vi.fn().mockResolvedValue({}),
    getEffectiveEnablement: vi.fn().mockResolvedValue({
      effectiveEnabled: setup?.effectiveEnabled ?? true,
      reason: setup?.effectiveEnabled === false ? "paused" : "active",
    }),
    getEffectiveOptions: vi.fn().mockResolvedValue({
      ksefPossible: setup?.ksef?.possible ?? false,
      ksefRequireActive: setup?.ksef?.requireActive ?? false,
    }),
    getRunState: vi.fn().mockResolvedValue({ ksef_active: null, ksef_checked_at: null }),
    listDueInvoices: vi.fn().mockResolvedValue(rows),
    listDueInvoicesForOrder: vi.fn().mockResolvedValue(rows),
    releaseRun: vi.fn().mockResolvedValue(setup?.released ?? true),
    updateInfaktInvoices: vi.fn().mockResolvedValue(undefined),
    verifyKsefIntegration: vi.fn().mockResolvedValue({ active: setup?.ksef?.active ?? true }),
  };
  const createNotifications = vi.fn();
  const container = {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.LOGGER) {
        return log;
      }
      if (key === INFAKT_MODULE) {
        return infakt;
      }
      if (key === ContainerRegistrationKeys.QUERY) {
        return { graph: vi.fn().mockResolvedValue({ data: [] }) };
      }
      if (key === Modules.EVENT_BUS) {
        return { emit: vi.fn() };
      }
      if (key === Modules.NOTIFICATION) {
        return { createNotifications };
      }
      throw new Error(`unexpected resolve(${key})`);
    },
  } as unknown as MedusaContainer;
  return { container, createNotifications, infakt, log };
};

beforeEach(() => {
  vi.mocked(processInvoiceRow).mockReset();
  vi.mocked(processInvoiceRow).mockResolvedValue(undefined);
});

describe("runInvoicing: the gates both callers share", () => {
  it("never claims the run when invoicing is not effectively enabled", async () => {
    const { container, infakt } = harness({ effectiveEnabled: false });
    const summary = await runInvoicing(container, { source: "test" });
    expect(infakt.claimRun).not.toHaveBeenCalled();
    expect(summary.skipped).toBe("paused");
  });

  it("releases the claim with its own token once the run is over", async () => {
    const { container, infakt } = harness();
    await runInvoicing(container, { source: "test" });
    expect(infakt.releaseRun).toHaveBeenCalledWith("tok_1", expect.objectContaining({ status: "ok" }));
  });

  it("still releases the claim when the run throws", async () => {
    const { container, infakt } = harness({
      ksef: { active: false, possible: true, requireActive: true },
    });
    await expect(runInvoicing(container, { source: "test" })).rejects.toThrow(/KSeF is required/u);
    expect(infakt.releaseRun).toHaveBeenCalledWith("tok_1", expect.objectContaining({ status: "error" }));
  });
});

describe("runInvoicing: racing the cron against the payment subscriber", () => {
  it("does not process anything when the claim was refused - the other runner has it", async () => {
    // The whole race guard. `claimRun` is one conditional UPDATE, so exactly one
    // of the two runs gets the lock; the loser must touch nothing at all.
    const { container, infakt } = harness({
      claim: { acquired: false, reason: "another invoicing run holds the lock" },
      rows: [{ id: "inv_1", order_id: "order_1", status: "pending" }],
    });
    const summary = await runInvoicing(container, { orderId: "order_1", source: "test" });
    expect(infakt.listDueInvoicesForOrder).not.toHaveBeenCalled();
    expect(infakt.listDueInvoices).not.toHaveBeenCalled();
    expect(processInvoiceRow).not.toHaveBeenCalled();
    expect(summary.skipped).toContain("holds the lock");
  });

  it("leaves the row alone when it is no longer due - a second run over the same order is a no-op", async () => {
    // The row was already carried to `done` (or parked in needs_review) by
    // whichever run got there first, so the due-predicate returns nothing.
    const { container, infakt } = harness({ rows: [] });
    const summary = await runInvoicing(container, { orderId: "order_1", source: "test" });
    expect(infakt.listDueInvoicesForOrder).toHaveBeenCalledWith("order_1");
    expect(processInvoiceRow).not.toHaveBeenCalled();
    expect(summary.processed).toBe(0);
  });
});

describe("runInvoicing: which rows a run drains", () => {
  it("drains only the named order's row when one is given (the payment path)", async () => {
    const { container, infakt } = harness({
      rows: [{ id: "inv_1", order_id: "order_1", status: "pending" }],
    });
    const summary = await runInvoicing(container, { orderId: "order_1", source: "test" });
    expect(infakt.listDueInvoicesForOrder).toHaveBeenCalledWith("order_1");
    expect(infakt.listDueInvoices).not.toHaveBeenCalled();
    expect(processInvoiceRow).toHaveBeenCalledTimes(1);
    expect(summary.completed).toBe(1);
  });

  it("drains the whole due queue when no order is named (the cron path)", async () => {
    const { container, infakt } = harness({
      rows: [
        { id: "inv_1", order_id: "order_1", status: "pending" },
        { id: "inv_2", order_id: "order_2", status: "pending" },
      ],
    });
    const summary = await runInvoicing(container, { source: "test" });
    expect(infakt.listDueInvoices).toHaveBeenCalledWith(20);
    expect(infakt.listDueInvoicesForOrder).not.toHaveBeenCalled();
    expect(summary.completed).toBe(2);
  });
});

describe("runInvoicing: the KSeF readiness gate is unchanged by the payment path", () => {
  it("refuses to issue anything for a single order when KSeF is required but not ready", async () => {
    const { container, infakt } = harness({
      ksef: { active: false, possible: true, requireActive: true },
      rows: [{ id: "inv_1", order_id: "order_1", status: "pending" }],
    });
    await expect(
      runInvoicing(container, { orderId: "order_1", source: "test" }),
    ).rejects.toThrow(/KSeF is required but not ready/u);
    // The refusal stands and the row is untouched, so the cron still has it.
    expect(processInvoiceRow).not.toHaveBeenCalled();
    expect(infakt.listDueInvoicesForOrder).not.toHaveBeenCalled();
  });

  it("does not check KSeF at all when the configuration can never need it", async () => {
    const { container, infakt } = harness({
      ksef: { active: false, possible: false, requireActive: true },
    });
    await runInvoicing(container, { source: "test" });
    expect(infakt.verifyKsefIntegration).not.toHaveBeenCalled();
  });
});

/**
 * The one-order run that every "make this happen now" caller shares: the payment
 * subscriber, the billing-ready subscriber, the manual enqueue endpoint and the
 * operator actions. Its entire contract is that it advances the row and cannot
 * fail its caller.
 */
describe("runInvoicingNow", () => {
  it("runs the pipeline for that one order", async () => {
    const { container, infakt } = harness({
      rows: [{ id: "inv_1", order_id: "order_1", status: "pending" }],
    });
    await runInvoicingNow(container, { orderId: "order_1", source: "test" });
    expect(infakt.listDueInvoicesForOrder).toHaveBeenCalledWith("order_1");
    expect(processInvoiceRow).toHaveBeenCalled();
  });

  it("swallows a KSeF refusal and leaves the row for the worker", async () => {
    // The gate is deliberately unchanged: if KSeF is not ready the refusal stands.
    // Throwing would hand the event bus an unbounded retry of a pipeline whose
    // safety rests on being re-entered deliberately - and would turn an admin
    // button into a 500 for a row that is merely queued.
    const { container, log } = harness({
      ksef: { active: false, possible: true, requireActive: true },
    });
    await expect(
      runInvoicingNow(container, { orderId: "order_1", source: "test" }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("stays queued"));
  });

  it("notes at debug when another run held the claim", async () => {
    const { container, log } = harness({
      claim: { acquired: false, reason: "another invoicing run holds the lock" },
    });
    await runInvoicingNow(container, { orderId: "order_1", source: "test" });
    expect(log.debug).toHaveBeenCalledWith(expect.stringContaining("holds the lock"));
  });
});

/**
 * A deferral is not a review request.
 *
 * The row that started this parked at 12:36:25 for an address that was written
 * 16 seconds later, and raised an admin notification for it.
 */
describe("runInvoicing: what a deferred row is allowed to cost", () => {
  const dueRow = [{ attempts: 0, id: "inv_1", order_id: "order_1", status: "processing" }];

  it("records what a data-wait defer is waiting for, and tells nobody", async () => {
    vi.mocked(processInvoiceRow).mockRejectedValue(
      dataWaitSignal("buyer address is incomplete (missing: street, city, postal_code)"),
    );
    const { container, createNotifications, infakt } = harness({ rows: dueRow });

    const summary = await runInvoicing(container, { orderId: "order_1", source: "test" });

    expect(summary.deferred).toBe(1);
    expect(summary.review).toBe(0);
    expect(infakt.updateInfaktInvoices).toHaveBeenCalledWith(
      expect.objectContaining({
        defer_reason: expect.stringContaining("buyer address is incomplete"),
        last_error: null,
      }),
    );
    // No admin feed entry, no alert: nothing here needs a human yet.
    expect(createNotifications).not.toHaveBeenCalled();
  });

  it("leaves defer_reason null for a defer that is not waiting on data", async () => {
    vi.mocked(processInvoiceRow).mockRejectedValue(deferSignal("KSeF is still processing"));
    const { container, infakt } = harness({ rows: dueRow });

    await runInvoicing(container, { source: "test" });

    expect(infakt.updateInfaktInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ defer_reason: null }),
    );
  });

  it("clears defer_reason and DOES notify when the row finally parks", async () => {
    vi.mocked(processInvoiceRow).mockRejectedValue(
      reviewSignal("buyer address is incomplete (missing: street) - the order still has no address"),
    );
    const { container, createNotifications, infakt } = harness({ rows: dueRow });

    const summary = await runInvoicing(container, { source: "test" });

    expect(summary.review).toBe(1);
    expect(infakt.updateInfaktInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ defer_reason: null, status: "needs_review" }),
    );
    expect(createNotifications).toHaveBeenCalled();
  });

  it("gives the whole run one KSeF ride budget, not one per row", async () => {
    const { container } = harness({ rows: dueRow });
    await runInvoicing(container, { source: "test" });
    const [, deps] = vi.mocked(processInvoiceRow).mock.calls[0];
    expect((deps as { rideUntil?: Date }).rideUntil).toBeInstanceOf(Date);
  });
});
