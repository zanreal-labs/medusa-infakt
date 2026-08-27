import { describe, expect, it } from "vitest";
import { ADDRESS_INCOMPLETE_PREFIX } from "./builder";
import { hasCompleteAddress, isParkedOnMissingAddress, planAddressReArm } from "./re-arm";
import type { InvoiceStateRow } from "./state-machine";

const CONFIG = { emitEvent: false, ksefMode: "nip-only" as const };

const parked = (over: Partial<InvoiceStateRow> = {}): InvoiceStateRow =>
  ({
    attempts: 1,
    last_error: `${ADDRESS_INCOMPLETE_PREFIX} (missing: street, city, postal_code)`,
    status: "needs_review",
    ...over,
  }) as InvoiceStateRow;

const address = { city: "Zielonka", postalCode: "05-220", street: "Jagiellońska 4" };

describe("isParkedOnMissingAddress", () => {
  it("matches the message the builder's own gate writes", () => {
    // Anchored on the exported constant, so the gate and this matcher cannot
    // drift apart silently.
    expect(isParkedOnMissingAddress(parked())).toBe(true);
  });

  it("ignores a row parked for any other reason", () => {
    // The whole safety property. A collision or a VIES failure is a question
    // about which answer is right, and no machine may settle it.
    expect(
      isParkedOnMissingAddress(parked({ last_error: "invoice number 5/08/2026 is already used" })),
    ).toBe(false);
    expect(
      isParkedOnMissingAddress(
        parked({ last_error: "the buyer's DE VAT id could not be confirmed against VIES" }),
      ),
    ).toBe(false);
  });

  it("ignores rows that are not parked at all", () => {
    expect(isParkedOnMissingAddress(parked({ status: "done" }))).toBe(false);
    expect(isParkedOnMissingAddress(parked({ status: "pending" }))).toBe(false);
    expect(isParkedOnMissingAddress(parked({ last_error: null }))).toBe(false);
  });
});

describe("hasCompleteAddress", () => {
  it("wants all three fields the builder demands", () => {
    expect(hasCompleteAddress(address)).toBe(true);
    expect(hasCompleteAddress({ ...address, street: undefined })).toBe(false);
    expect(hasCompleteAddress({ ...address, city: undefined })).toBe(false);
    expect(hasCompleteAddress({ ...address, postalCode: undefined })).toBe(false);
  });

  it("treats whitespace as absent, exactly as the gate does", () => {
    expect(hasCompleteAddress({ ...address, city: "   " })).toBe(false);
  });

  it("is false for no buyer at all", () => {
    expect(hasCompleteAddress(null)).toBe(false);
    expect(hasCompleteAddress(undefined)).toBe(false);
  });
});

describe("planAddressReArm", () => {
  it("re-arms a row whose address has since arrived", () => {
    const plan = planAddressReArm(parked(), address, CONFIG);

    expect(plan?.ok).toBe(true);
    expect(plan && plan.ok && plan.patch).toMatchObject({
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      status: "processing",
    });
  });

  it("leaves the row alone while the address is still incomplete", () => {
    // Otherwise the row would be re-armed, fail the same gate, and park again -
    // an infinite loop that also re-notifies every tick.
    expect(planAddressReArm(parked(), { ...address, city: undefined }, CONFIG)).toBeNull();
  });

  it("never touches a row parked for a reason a human owns", () => {
    const collision = parked({ last_error: "invoice number 5/08/2026 is already used" });
    expect(planAddressReArm(collision, address, CONFIG)).toBeNull();
  });

  it("inherits the crash-window refusal rather than re-implementing it", () => {
    // A row that may already have reached inFakt must not be retried by anything,
    // human or automatic: the next step is the one call that can issue a second
    // real numbered invoice. This delegates to the operator action precisely so
    // that refusal cannot be forgotten here.
    // No uuid and no task reference, but a create was started: the row cannot
    // tell whether inFakt received it, which is the whole crash window.
    const inCrashWindow = parked({
      invoice_uuid: null,
      submit_started_at: new Date(),
      task_reference: null,
    });

    const plan = planAddressReArm(inCrashWindow, address, CONFIG);

    expect(plan?.ok).toBe(false);
    expect(plan && !plan.ok && plan.reason).toMatch(/refusing to retry/u);
  });
});
