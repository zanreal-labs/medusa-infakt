import { describe, expect, it, vi } from "vitest";
import { InfaktApiError } from "../infakt/errors";
import { reconcileSettlementRow, reconcileSettlements, settlementSkipReason } from "./settle";
import type { SettlementDeps, SettlementRow } from "./settle";

const paidOrder = (overrides: Record<string, unknown> = {}) => ({
  id: "order_01",
  payment_collections: [{ captured_amount: 123.45, status: "completed" }],
  total: 123.45,
  ...overrides,
});

const row = (overrides: Partial<SettlementRow> = {}): SettlementRow => ({
  id: "inv_01",
  invoice_number: "1/09/2026",
  invoice_uuid: "u-1",
  order_id: "order_01",
  ...overrides,
});

interface Harness {
  deps: SettlementDeps;
  updates: Record<string, unknown>[];
  client: Record<string, ReturnType<typeof vi.fn>>;
}

const harness = (config?: {
  invoice?: Record<string, unknown> | Error;
  order?: Record<string, unknown> | null;
}): Harness => {
  const updates: Record<string, unknown>[] = [];
  const invoice = config?.invoice ?? { paidDate: "2026-09-02", uuid: "u-1" };
  const client = {
    getInvoice:
      invoice instanceof Error
        ? vi.fn().mockRejectedValue(invoice)
        : vi.fn().mockResolvedValue(invoice),
  };
  const order = config?.order === null ? null : (config?.order ?? paidOrder());

  return {
    client,
    deps: {
      client: client as never,
      logger: { warn: vi.fn() },
      now: () => new Date("2026-09-03T12:00:00.000Z"),
      readOrder: () => Promise.resolve(order),
      update: (id, patch) => {
        updates.push({ id, ...patch });
        return Promise.resolve();
      },
    },
    updates,
  };
};

describe("settlementSkipReason", () => {
  it("skips a row with no invoice - there is nothing to compare", () => {
    expect(settlementSkipReason(row({ invoice_uuid: null }))).toBe("no invoice on this row");
  });

  it("skips an invoice still waiting for its KSeF number", () => {
    // Mid-flight in a process with a legal deadline. Reading it would report an
    // unsettled invoice as a discrepancy every hour until KSeF answers.
    expect(settlementSkipReason(row({ ksef_number: null, ksef_required: true }))).toBe(
      "still awaiting a KSeF number",
    );
    expect(settlementSkipReason(row({ ksef_number: "K-1", ksef_required: true }))).toBeNull();
  });
});

describe("reconcileSettlementRow", () => {
  it("records inFakt's paid date, the check, and no drift when the two agree", async () => {
    const { deps, updates } = harness();
    const entry = await reconcileSettlementRow(row(), deps);

    expect(updates[0]).toEqual({
      id: "inv_01",
      settled_at: new Date("2026-09-02T00:00:00.000Z"),
      settlement_checked_at: new Date("2026-09-03T12:00:00.000Z"),
      settlement_drift: null,
      settlement_paid_minor: null,
    });
    expect(entry).toMatchObject({ auto_fixable: false, drift: null, order_id: "order_01" });
  });

  it("records the drift when Medusa has the money and inFakt has no paid date", async () => {
    const { deps, updates } = harness({ invoice: { uuid: "u-1" } });
    const entry = await reconcileSettlementRow(row(), deps);

    expect(updates[0]).toMatchObject({ settled_at: null, settlement_drift: "unsettled" });
    expect(entry?.auto_fixable).toBe(true);
  });

  it("never proposes a fix on an adopted invoice", async () => {
    const { deps } = harness({ invoice: { uuid: "u-1" } });
    const entry = await reconcileSettlementRow(row({ adopted_at: new Date() }), deps);

    expect(entry).toMatchObject({ adopted: true, auto_fixable: false, drift: "unsettled" });
  });

  it("records inFakt's paid price as evidence and never decides on it", async () => {
    // Invoice 9/08/2026: `paid_price: 0` on a document inFakt calls paid.
    const { deps, updates } = harness({ invoice: { paidDate: "2026-08-09", paidPrice: 0 } });
    const entry = await reconcileSettlementRow(row(), deps);

    expect(updates[0].settlement_paid_minor).toBe(0);
    expect(entry?.drift).toBeNull();
  });

  it("stamps the check but keeps the previous evidence when the read fails", async () => {
    const { deps, updates } = harness({
      invoice: new InfaktApiError({ httpStatus: 500, message: "inFakt is down" }),
    });
    const entry = await reconcileSettlementRow(row({ settled_at: new Date("2026-09-02") }), deps);

    // A network blip must not erase a settlement date that was true an hour ago.
    expect(Object.keys(updates[0]).sort()).toEqual([
      "id",
      "settlement_checked_at",
      "settlement_drift",
    ]);
    expect(entry?.drift).toBe("unreadable");
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("could not read invoice"));
  });

  it("records the check even when the order cannot be read", async () => {
    const { deps, updates } = harness({ order: null });
    const entry = await reconcileSettlementRow(row(), deps);

    expect(entry?.drift).toBe("unreadable");
    expect(updates[0].settlement_checked_at).toEqual(new Date("2026-09-03T12:00:00.000Z"));
  });

  it("never fetches a PDF and never marks anything paid", async () => {
    // The PDF endpoint is what corrupts inFakt's status in the first place, and
    // marking is not this mechanism's authority. Neither is even on the client
    // type - this asserts the wiring agrees.
    const { client, deps } = harness();
    await reconcileSettlementRow(row(), deps);

    expect(Object.keys(client)).toEqual(["getInvoice"]);
    expect(client.getInvoice).toHaveBeenCalledWith("u-1");
  });
});

describe("reconcileSettlements", () => {
  it("summarizes a batch and reports what it skipped", async () => {
    const { deps } = harness({ invoice: { uuid: "u-1" } });
    const result = await reconcileSettlements(
      [
        row(),
        row({ id: "inv_02", invoice_uuid: null, order_id: "order_02" }),
        row({ id: "inv_03", ksef_required: true, order_id: "order_03" }),
      ],
      deps,
    );

    expect(result.entries).toHaveLength(1);
    expect(result.skipped).toEqual([
      { order_id: "order_02", reason: "no invoice on this row" },
      { order_id: "order_03", reason: "still awaiting a KSeF number" },
    ]);
    expect(result.summary).toMatchObject({ auto_fixable: 1, checked: 1, settled: 0 });
  });

  it("keeps going when one row blows up", async () => {
    const { deps } = harness();
    const failing: SettlementDeps = {
      ...deps,
      update: (id) =>
        id === "inv_01" ? Promise.reject(new Error("write failed")) : Promise.resolve(),
    };

    const result = await reconcileSettlements([row(), row({ id: "inv_02", order_id: "o2" })], failing);

    expect(result.entries).toHaveLength(1);
    expect(result.skipped[0].reason).toContain("reconciliation failed");
  });
});
