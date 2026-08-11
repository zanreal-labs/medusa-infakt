import { describe, expect, it, vi } from "vitest";
import { decideKsef, ksefPossible, resolveRequireActive } from "./ksef";
import type { KsefDecisionInput } from "./ksef";

const companyOrder: KsefDecisionInput = {
  isCompany: true,
  nip: "5261040828",
  orderId: "order_1",
};
const consumerOrder: KsefDecisionInput = { isCompany: false, orderId: "order_2" };

describe("decideKsef: nip-only (the default, and what Polish law requires)", () => {
  it("files an invoice with a NIP", () => {
    const decision = decideKsef(companyOrder, "nip-only");
    expect(decision.file).toBe(true);
    expect(decision.reason).toContain("NIP");
    expect(decision.reason).toContain("mandatory in KSeF");
  });

  it("does not file a consumer invoice", () => {
    const decision = decideKsef(consumerOrder, "nip-only");
    expect(decision.file).toBe(false);
    expect(decision.reason).toContain("outside KSeF");
  });

  it("records a reason that never contains the NIP itself", () => {
    for (const input of [companyOrder, consumerOrder]) {
      expect(decideKsef(input, "nip-only").reason).not.toContain("5261040828");
    }
  });
});

describe("decideKsef: all", () => {
  it("files both company and consumer invoices", () => {
    expect(decideKsef(companyOrder, "all").file).toBe(true);
    expect(decideKsef(consumerOrder, "all").file).toBe(true);
    expect(decideKsef(consumerOrder, "all").reason).toContain('"all"');
  });
});

describe("decideKsef: never", () => {
  it("files nothing, and says why", () => {
    expect(decideKsef(companyOrder, "never")).toEqual({
      file: false,
      reason: expect.stringContaining("filing disabled"),
    });
    expect(decideKsef(consumerOrder, "never").file).toBe(false);
  });
});

describe("decideKsef: custom predicate", () => {
  it("overrides the mode when it returns true", () => {
    const decide = vi.fn().mockReturnValue(true);
    const decision = decideKsef(consumerOrder, "nip-only", decide);
    expect(decision.file).toBe(true);
    expect(decision.reason).toContain("custom ksef.decide predicate");
    expect(decide).toHaveBeenCalledWith(consumerOrder);
  });

  it("overrides the mode when it returns false", () => {
    const decision = decideKsef(companyOrder, "all", () => false);
    expect(decision.file).toBe(false);
    expect(decision.reason).toContain("excluded");
  });

  it("overrides even never, and records that it was the predicate", () => {
    const decision = decideKsef(companyOrder, "never", () => true);
    expect(decision.file).toBe(true);
    expect(decision.reason).toContain("custom ksef.decide predicate");
  });

  it("treats a truthy non-boolean return as false rather than guessing", () => {
    // A predicate that returns a string has a bug; filing to KSeF on a bug is a
    // legal statement, so the strict comparison refuses to interpret it.
    const decision = decideKsef(companyOrder, "nip-only", (() => "yes") as never);
    expect(decision.file).toBe(false);
  });
});

describe("resolveRequireActive", () => {
  it("defaults to on in production and off in sandbox", () => {
    expect(resolveRequireActive(undefined, "production")).toBe(true);
    expect(resolveRequireActive(undefined, "sandbox")).toBe(false);
  });

  it("honours an explicit value in either environment", () => {
    expect(resolveRequireActive(false, "production")).toBe(false);
    expect(resolveRequireActive(true, "sandbox")).toBe(true);
  });
});

describe("ksefPossible", () => {
  it("is false only for never with no predicate", () => {
    expect(ksefPossible("never")).toBe(false);
    expect(ksefPossible("never", () => true)).toBe(true);
    expect(ksefPossible("nip-only")).toBe(true);
    expect(ksefPossible("all")).toBe(true);
  });
});
