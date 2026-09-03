import { describe, expect, it } from "vitest";
import {
  classifySettlement,
  isSettlementAutoFixable,
  parseSettledAt,
  SETTLEMENT_WINDOW_DAYS,
  settlementRecheckCutoff,
  settlementWindowStart,
  summarizeSettlement,
} from "./settlement";

/**
 * The settlement rules, pinned against the two production invoices that produced
 * them:
 *
 *  - `2/09/2026` - marked paid at 12:40:03, `paid_date` intact, `status` flipped
 *    to "sent" three seconds later by a PDF download. Settled.
 *  - `9/08/2026` - `status: "paid"` with `paid_price: 0` and no `paid_date`. Not
 *    settled, whatever the status says.
 */

const order = (overrides: Record<string, unknown> = {}) => ({
  payment_collections: [{ captured_amount: 123.45, status: "completed" }],
  total: 123.45,
  ...overrides,
});

describe("parseSettledAt", () => {
  it("reads a calendar date as UTC midnight of that day", () => {
    expect(parseSettledAt("2026-09-02")).toEqual(new Date("2026-09-02T00:00:00.000Z"));
  });

  it("refuses anything that is not a calendar date", () => {
    for (const value of [null, undefined, "", "wkrótce", "2026-09", "02/09/2026", "2026-13-01"]) {
      expect(parseSettledAt(value)).toBeNull();
    }
  });
});

describe("classifySettlement", () => {
  it("agrees when inFakt has a paid date and Medusa captured the whole total", () => {
    const verdict = classifySettlement({ order: order(), paidDate: "2026-09-02" });
    expect(verdict.drift).toBeNull();
    expect(verdict.settledAt).toEqual(new Date("2026-09-02T00:00:00.000Z"));
    expect(verdict.capturedMinor).toBe(12_345);
  });

  it("reads settlement off paid_date alone - the status is never consulted", () => {
    // Invoice 2/09/2026: the only field that survived the PDF download.
    const verdict = classifySettlement({ order: order(), paidDate: "2026-09-02" });
    expect(verdict.drift).toBeNull();
    // And the other direction: a "paid" status with no paid date is not settled.
    const unsettled = classifySettlement({ order: order(), paidDate: null });
    expect(unsettled.drift).toBe("unsettled");
    expect(unsettled.settledAt).toBeNull();
  });

  it("reports a fully captured order that inFakt has not settled as unsettled", () => {
    const verdict = classifySettlement({ order: order() });
    expect(verdict.drift).toBe("unsettled");
    expect(verdict.reason).toContain("no paid date in inFakt");
  });

  it("says nothing about an unpaid order with an unsettled invoice - the two agree", () => {
    const verdict = classifySettlement({
      order: order({ payment_collections: [{ captured_amount: 0, status: "pending" }] }),
    });
    expect(verdict.drift).toBeNull();
  });

  it("reports a refund against a settled invoice, and never tries to undo it", () => {
    const verdict = classifySettlement({
      order: order({
        payment_collections: [
          { captured_amount: 123.45, refunded_amount: 123.45, status: "completed" },
        ],
      }),
      paidDate: "2026-09-02",
    });
    expect(verdict.drift).toBe("refunded_but_settled");
    expect(verdict.refundedMinor).toBe(12_345);
    // Report only, forever: inFakt has no "un-mark", and the instrument for this
    // is a corrective invoice the plugin does not issue.
    expect(isSettlementAutoFixable(verdict.drift, { adopted: false })).toBe(false);
  });

  it("reports an invoice settled against an order that captured nothing", () => {
    const verdict = classifySettlement({
      order: order({ payment_collections: [] }),
      paidDate: "2026-09-02",
    });
    expect(verdict.drift).toBe("settled_without_capture");
  });

  it("reports a settled invoice against a part-captured order as an amount mismatch", () => {
    const verdict = classifySettlement({
      order: order({ payment_collections: [{ captured_amount: 50, status: "completed" }] }),
      paidDate: "2026-09-02",
    });
    expect(verdict.drift).toBe("amount_mismatch");
    expect(verdict.reason).toContain("5000 of 12345");
  });

  it("never derives a mismatch from inFakt's own amounts", () => {
    // Invoice 9/08/2026 carries `paid_price: 0` on a document its status calls
    // paid. Nothing here reads either number, so neither can produce a verdict.
    const verdict = classifySettlement({ order: order(), paidDate: "2026-08-09" });
    expect(verdict.drift).toBeNull();
  });

  it("calls an unreadable invoice unreadable rather than settled or unsettled", () => {
    const verdict = classifySettlement({ invoiceUnreadable: true, order: order() });
    expect(verdict.drift).toBe("unreadable");
  });

  it("calls an unreadable order unreadable rather than guessing", () => {
    expect(classifySettlement({ order: null, paidDate: "2026-09-02" }).drift).toBe("unreadable");
    expect(classifySettlement({ order: order({ total: undefined }) }).drift).toBe("unreadable");
  });

  it("treats a paid date it cannot parse as unreadable, not as unsettled", () => {
    const verdict = classifySettlement({ order: order(), paidDate: "wkrótce" });
    expect(verdict.drift).toBe("unreadable");
  });
});

describe("isSettlementAutoFixable", () => {
  it("is true for exactly one code, on an invoice this plugin issued", () => {
    expect(isSettlementAutoFixable("unsettled", { adopted: false })).toBe(true);
  });

  it("refuses an adopted invoice whatever its drift", () => {
    // 25 of the 30 rows this was designed against are adopted, so this refusal is
    // most of the table rather than an edge case.
    for (const drift of [
      "unsettled",
      "refunded_but_settled",
      "settled_without_capture",
      "amount_mismatch",
      "unreadable",
    ] as const) {
      expect(isSettlementAutoFixable(drift, { adopted: true })).toBe(false);
    }
  });

  it("refuses every other code, and agreement", () => {
    expect(isSettlementAutoFixable("refunded_but_settled", { adopted: false })).toBe(false);
    expect(isSettlementAutoFixable("settled_without_capture", { adopted: false })).toBe(false);
    expect(isSettlementAutoFixable("amount_mismatch", { adopted: false })).toBe(false);
    expect(isSettlementAutoFixable("unreadable", { adopted: false })).toBe(false);
    expect(isSettlementAutoFixable(null, { adopted: false })).toBe(false);
  });
});

describe("summarizeSettlement", () => {
  it("counts every drift code, including the ones with no rows", () => {
    const summary = summarizeSettlement([
      { adopted: false, drift: null, settledAt: "2026-09-02" },
      { adopted: false, drift: "unsettled", settledAt: null },
      { adopted: true, drift: "unsettled", settledAt: null },
      { adopted: true, drift: "refunded_but_settled", settledAt: "2026-09-01" },
    ]);

    expect(summary).toMatchObject({
      adopted_drift: 2,
      agreed: 1,
      auto_fixable: 1,
      checked: 4,
      settled: 2,
    });
    expect(summary.drift).toEqual({
      amount_mismatch: 0,
      refunded_but_settled: 1,
      settled_without_capture: 0,
      unreadable: 0,
      unsettled: 2,
    });
  });

  it("keeps every gauge present on an empty set, so none can go missing", () => {
    expect(summarizeSettlement([]).drift.unsettled).toBe(0);
  });
});

describe("the windows", () => {
  it("slides the backstop ninety days back by default", () => {
    const now = new Date("2026-09-03T12:00:00.000Z");
    expect(settlementWindowStart(now)).toEqual(new Date("2026-06-05T12:00:00.000Z"));
    expect(SETTLEMENT_WINDOW_DAYS).toBe(90);
  });

  it("leaves a row alone until the re-check interval has passed", () => {
    const now = new Date("2026-09-03T12:00:00.000Z");
    expect(settlementRecheckCutoff(now, 6 * 60 * 60_000)).toEqual(
      new Date("2026-09-03T06:00:00.000Z"),
    );
  });
});
