import { describe, expect, it } from "vitest";
import {
  collisionReason,
  findNumberCollision,
  normalizeInvoiceNumber,
} from "./invoice-number";

/**
 * These tests describe a credential-disclosure guard, not a bookkeeping one.
 * Downstream, the invoice number is the handle license keys are bought and
 * recovered under, and it has no uniqueness constraint there - so two orders
 * sharing a number means one buyer receives another's keys.
 */

const claim = (orderId: string, invoiceNumber: string | null) => ({ invoiceNumber, orderId });

describe("findNumberCollision", () => {
  it("finds another order holding the same number", () => {
    expect(
      findNumberCollision("1/08/2026", "order_b", [claim("order_a", "1/08/2026")]),
    ).toBe("order_a");
  });

  it("ignores the row's own previously recorded number", () => {
    expect(
      findNumberCollision("1/08/2026", "order_a", [claim("order_a", "1/08/2026")]),
    ).toBeNull();
  });

  it("catches a collision between a VAT series and an OSS series", () => {
    // The exact scenario OSS introduces: a second document family whose numbering
    // can legitimately restart at 1.
    const existing = [claim("order_vat", "1/08/2026"), claim("order_other", "2/08/2026")];
    expect(findNumberCollision("1/08/2026", "order_oss", existing)).toBe("order_vat");
  });

  it("compares case- and whitespace-insensitively", () => {
    const existing = [claim("order_a", "1/OSS/08/2026")];
    expect(findNumberCollision(" 1/oss/08/2026 ", "order_b", existing)).toBe("order_a");
    expect(findNumberCollision("1 / OSS / 08 / 2026", "order_b", existing)).toBe("order_a");
  });

  it("returns null when the number is free", () => {
    expect(
      findNumberCollision("3/08/2026", "order_b", [claim("order_a", "1/08/2026")]),
    ).toBeNull();
  });

  it("returns null when there is nothing to compare against", () => {
    expect(findNumberCollision("1/08/2026", "order_b", [])).toBeNull();
  });

  it("ignores rows with no number yet", () => {
    expect(
      findNumberCollision("1/08/2026", "order_b", [claim("order_a", null)]),
    ).toBeNull();
  });

  it("does not fire when this row has no number yet", () => {
    for (const value of [null, undefined, "", "   "]) {
      expect(findNumberCollision(value, "order_b", [claim("order_a", "1/08/2026")])).toBeNull();
    }
  });

  it("reports the first colliding order when several somehow match", () => {
    const existing = [claim("order_a", "1/08/2026"), claim("order_c", "1/08/2026")];
    expect(findNumberCollision("1/08/2026", "order_b", existing)).toBe("order_a");
  });
});

describe("normalizeInvoiceNumber", () => {
  it("uppercases and strips all whitespace", () => {
    expect(normalizeInvoiceNumber(" 1/oss/08/2026 ")).toBe("1/OSS/08/2026");
    expect(normalizeInvoiceNumber("1 / 08 / 2026")).toBe("1/08/2026");
  });

  it("treats blank values as absent", () => {
    expect(normalizeInvoiceNumber("")).toBeNull();
    expect(normalizeInvoiceNumber("   ")).toBeNull();
    expect(normalizeInvoiceNumber(null)).toBeNull();
    expect(normalizeInvoiceNumber(undefined)).toBeNull();
  });
});

describe("collisionReason", () => {
  it("names both orders and says why this is dangerous", () => {
    const reason = collisionReason("1/08/2026", "order_a");
    expect(reason).toContain("1/08/2026");
    expect(reason).toContain("order_a");
    expect(reason).toContain("license");
  });
});
