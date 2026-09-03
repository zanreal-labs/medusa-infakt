import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import { describe, expect, it, vi } from "vitest";
import { resolveEffectiveEnablement } from "./enablement";
import { resolveInfaktOptions } from "../options";
import { runSettlement, settleOrderNow } from "./settlement-run";
import { INFAKT_MODULE } from "../../modules/infakt";

const options = resolveInfaktOptions({ apiKey: "k", startDate: "2026-07-01" });

const logger = () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() });

const harness = (setup?: {
  candidates?: Record<string, unknown>[];
  named?: Record<string, unknown>[];
  invoicingPaused?: boolean;
  order?: Record<string, unknown> | null;
}) => {
  const log = logger();
  const infakt = {
    getApiClient: vi.fn().mockResolvedValue({
      getInvoice: vi.fn().mockResolvedValue({ paidDate: "2026-09-02", uuid: "u-1" }),
    }),
    getEffectiveEnablement: vi.fn().mockResolvedValue(
      resolveEffectiveEnablement({
        apiKeyConfigured: true,
        envForceDisabled: false,
        invoicingPaused: setup?.invoicingPaused ?? false,
      }),
    ),
    getEffectiveOptions: vi.fn().mockResolvedValue(options),
    listInfaktInvoices: vi.fn().mockResolvedValue(setup?.named ?? []),
    listSettlementCandidates: vi.fn().mockResolvedValue(setup?.candidates ?? []),
    updateInfaktInvoices: vi.fn().mockResolvedValue(undefined),
  };
  const graph = vi.fn().mockResolvedValue({
    data:
      setup?.order === null
        ? []
        : [
            setup?.order ?? {
              id: "order_01",
              payment_collections: [{ captured_amount: 100, status: "completed" }],
              total: 100,
            },
          ],
  });
  const container = {
    resolve: vi.fn((key: string) => {
      if (key === ContainerRegistrationKeys.LOGGER) {
        return log;
      }
      if (key === ContainerRegistrationKeys.QUERY) {
        return { graph };
      }
      return infakt;
    }),
  };
  return { container, graph, infakt, log };
};

const candidate = (overrides: Record<string, unknown> = {}) => ({
  id: "inv_01",
  invoice_uuid: "u-1",
  order_id: "order_01",
  ...overrides,
});

describe("runSettlement", () => {
  it("looks back ninety days by default and honours the re-check interval", async () => {
    const { container, infakt } = harness();
    await runSettlement(container as never, { source: "test" });

    const args = infakt.listSettlementCandidates.mock.calls[0][0];
    const windowDays = Math.round(
      (Date.now() - (args.createdAfter as Date).getTime()) / (24 * 60 * 60_000),
    );
    expect(windowDays).toBe(90);
    // Rows checked within the interval are left alone.
    expect((args.checkedBefore as Date).getTime()).toBeLessThan(Date.now() - 60_000);
  });

  it("drops the window entirely for a full pass, and the interval when forced", async () => {
    const { container, infakt } = harness();
    await runSettlement(container as never, { force: true, full: true, source: "test" });

    const args = infakt.listSettlementCandidates.mock.calls[0][0];
    expect(args.createdAfter).toBeNull();
    expect((args.checkedBefore as Date).getTime()).toBeGreaterThan(Date.now() - 5_000);
  });

  it("reads one named order directly, bypassing the window and the interval", async () => {
    const { container, infakt } = harness({ named: [candidate()] });
    const result = await runSettlement(container as never, { orderId: "order_01", source: "test" });

    expect(infakt.listSettlementCandidates).not.toHaveBeenCalled();
    expect(infakt.listInfaktInvoices).toHaveBeenCalledWith({ order_id: ["order_01"] }, { take: 1 });
    expect(result.summary).toMatchObject({ agreed: 1, checked: 1, settled: 1 });
  });

  it("records the verdict on the row and touches nothing else", async () => {
    const { container, infakt } = harness({ candidates: [candidate()] });
    await runSettlement(container as never, { source: "test" });

    expect(infakt.updateInfaktInvoices).toHaveBeenCalledWith(
      expect.objectContaining({
        id: "inv_01",
        settled_at: new Date("2026-09-02T00:00:00.000Z"),
        settlement_drift: null,
      }),
    );
  });

  it("does not run at all while invoicing is paused", async () => {
    // The job and the subscriber have no business calling inFakt on a plugin
    // somebody switched off. The admin endpoint is the one caller that may.
    const { container, infakt } = harness({ invoicingPaused: true });
    const result = await runSettlement(container as never, { source: "test" });

    expect(result.skippedRun).toBeTruthy();
    expect(infakt.listSettlementCandidates).not.toHaveBeenCalled();
  });

  it("runs while paused when the caller is an operator asking explicitly", async () => {
    const { container, infakt } = harness({ invoicingPaused: true });
    await runSettlement(container as never, { ignorePause: true, source: "test" });
    expect(infakt.listSettlementCandidates).toHaveBeenCalled();
  });

  it("resolves the infakt module", async () => {
    const { container } = harness();
    await runSettlement(container as never, { source: "test" });
    expect(container.resolve).toHaveBeenCalledWith(INFAKT_MODULE);
  });
});

describe("settleOrderNow", () => {
  it("never lets a failure reach its caller", async () => {
    // A throwing subscriber is retried by the event bus with no bound and no
    // visibility; the hourly job is the designed retry.
    const { container, infakt, log } = harness({ named: [candidate()] });
    infakt.getApiClient.mockRejectedValue(new Error("inFakt is unreachable"));

    await expect(
      settleOrderNow(container as never, { orderId: "order_01", source: "test" }),
    ).resolves.toBeUndefined();
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining("could not reconcile"));
  });
});
