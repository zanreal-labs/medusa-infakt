import { describe, expect, it } from "vitest";
import { capturedMinorUnits, evaluatePaidGate } from "./paid";
import type { PaidGateOrder } from "./paid";

const order = (overrides: Partial<PaidGateOrder> = {}): PaidGateOrder => ({
  payment_collections: [{ amount: 133.44, captured_amount: 133.44, status: "completed" }],
  total: 133.44,
  ...overrides,
});

describe("capturedMinorUnits", () => {
  it("uses the collection's own captured_amount", () => {
    expect(capturedMinorUnits(order())).toBe(13_344);
  });

  it("sums several collections", () => {
    expect(
      capturedMinorUnits(
        order({
          payment_collections: [
            { captured_amount: 100, status: "completed" },
            { captured_amount: 33.44, status: "completed" },
          ],
        }),
      ),
    ).toBe(13_344);
  });

  it("falls back to summing the payments when the aggregate is absent", () => {
    expect(
      capturedMinorUnits(
        order({
          payment_collections: [
            { payments: [{ captured_amount: 100 }, { captured_amount: 33.44 }] },
          ],
        }),
      ),
    ).toBe(13_344);
  });

  it("subtracts refunds at the collection level", () => {
    expect(
      capturedMinorUnits(
        order({
          payment_collections: [
            { captured_amount: 133.44, refunded_amount: 33.44, status: "completed" },
          ],
        }),
      ),
    ).toBe(10_000);
  });

  it("subtracts refunds at the payment level", () => {
    expect(
      capturedMinorUnits(
        order({
          payment_collections: [
            { payments: [{ captured_amount: 133.44, refunded_amount: 33.44 }] },
          ],
        }),
      ),
    ).toBe(10_000);
  });

  it("skips canceled and failed collections", () => {
    expect(
      capturedMinorUnits(
        order({
          payment_collections: [
            { captured_amount: 100, status: "canceled" },
            { captured_amount: 50, status: "failed" },
            { captured_amount: 33.44, status: "completed" },
          ],
        }),
      ),
    ).toBe(3344);
  });

  it("skips a canceled payment whose captured amount is stale", () => {
    expect(
      capturedMinorUnits(
        order({
          payment_collections: [
            {
              payments: [
                { canceled_at: "2026-07-15T10:00:00Z", captured_amount: 100 },
                { captured_amount: 33.44 },
              ],
            },
          ],
        }),
      ),
    ).toBe(3344);
  });

  it("reads the raw { value } BigNumber shape", () => {
    expect(
      capturedMinorUnits(
        order({ payment_collections: [{ captured_amount: { value: "133.44" } }] }),
      ),
    ).toBe(13_344);
  });

  it("reports zero for an order with no payment collections", () => {
    expect(capturedMinorUnits(order({ payment_collections: [] }))).toBe(0);
    expect(capturedMinorUnits(order({ payment_collections: null }))).toBe(0);
    expect(capturedMinorUnits({ total: 10 })).toBe(0);
  });
});

describe("evaluatePaidGate", () => {
  it("passes a fully captured order", () => {
    const result = evaluatePaidGate(order());
    expect(result.fullyPaid).toBe(true);
    expect(result.capturedMinor).toBe(13_344);
    expect(result.totalMinor).toBe(13_344);
  });

  it("passes an over-captured order (a tip, or a rounding overpay)", () => {
    expect(
      evaluatePaidGate(order({ payment_collections: [{ captured_amount: 140 }] })).fullyPaid,
    ).toBe(true);
  });

  it("holds a partially captured order and says how far off it is", () => {
    const result = evaluatePaidGate(order({ payment_collections: [{ captured_amount: 100 }] }));
    expect(result.fullyPaid).toBe(false);
    expect(result.reason).toContain("10000 of 13344");
    expect(result.reason).toContain("not fully paid yet");
  });

  it("holds an authorized-but-uncaptured order", () => {
    expect(
      evaluatePaidGate(
        order({
          payment_collections: [{ authorized_amount: 133.44, status: "authorized" }],
        }),
      ).fullyPaid,
    ).toBe(false);
  });

  it("holds a fully refunded order", () => {
    expect(
      evaluatePaidGate(
        order({ payment_collections: [{ captured_amount: 133.44, refunded_amount: 133.44 }] }),
      ).fullyPaid,
    ).toBe(false);
  });

  it("compares in integer minor units, so no float drift can stall it", () => {
    // 0.1 + 0.2 as a captured amount is 0.30000000000000004; a decimal comparison
    // against a 0.3 total would read as short by 4e-17 and defer forever.
    const result = evaluatePaidGate({
      payment_collections: [{ captured_amount: 0.1 + 0.2 }],
      total: 0.3,
    });
    expect(result.fullyPaid).toBe(true);
  });

  it("passes a zero-total order rather than deferring it forever", () => {
    const result = evaluatePaidGate({ payment_collections: [], total: 0 });
    expect(result.fullyPaid).toBe(true);
    expect(result.reason).toContain("nothing to capture");
  });

  it("does NOT pass an unreadable total", () => {
    const result = evaluatePaidGate({ payment_collections: [], total: undefined });
    expect(result.fullyPaid).toBe(false);
    expect(result.totalMinor).toBeNull();
    expect(result.reason).toContain("unreadable");
  });
});
