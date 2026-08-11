import { describe, expect, it } from "vitest";
import { isInCrashWindow, planOperatorAction } from "./operator-actions";
import type { OperatorActionInput } from "./operator-actions";
import type { InvoiceStateRow } from "./state-machine";

const row = (overrides: Partial<InvoiceStateRow> = {}): InvoiceStateRow => ({
  attempts: 3,
  status: "needs_review",
  ...overrides,
});

const plan = (target: InvoiceStateRow, input: OperatorActionInput, emitEvent = true) =>
  planOperatorAction(target, input, { emitEvent });

const crashed = row({ status: "needs_review", submit_started_at: new Date() });

describe("isInCrashWindow", () => {
  it("is true for a submitted create with no task reference and no invoice", () => {
    expect(isInCrashWindow(crashed, true)).toBe(true);
  });

  it("is false once a task reference or an invoice exists", () => {
    expect(
      isInCrashWindow(row({ submit_started_at: new Date(), task_reference: "ref" }), true),
    ).toBe(false);
    expect(isInCrashWindow(row({ invoice_uuid: "u-1", submit_started_at: new Date() }), true)).toBe(
      false,
    );
  });

  it("is false for a row that never started a create", () => {
    expect(isInCrashWindow(row(), true)).toBe(false);
  });
});

describe("retry", () => {
  it("re-queues a row and resets its attempt budget", () => {
    const result = plan(row({ last_error: "inFakt timed out" }), { action: "retry" });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.patch).toMatchObject({
        attempts: 0,
        last_error: null,
        next_attempt_at: null,
        status: "processing",
      });
    }
  });

  it("REFUSES a row in the create crash window", () => {
    // The single most important guard in the operator surface: retrying here can
    // issue a second real numbered invoice, because inFakt has no idempotency key.
    const result = plan(crashed, { action: "retry" });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain("refusing to retry");
      expect(result.reason).toContain("stray invoice");
      expect(result.reason).toContain("adopt");
    }
  });

  it("never clears submit_started_at or task_reference", () => {
    // A retry that reset those markers would silently turn itself into a `clear`.
    const result = plan(row({ submit_started_at: new Date(), task_reference: "ref" }), {
      action: "retry",
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.patch).not.toHaveProperty("submit_started_at");
      expect(result.patch).not.toHaveProperty("task_reference");
      expect(result.patch).not.toHaveProperty("invoice_uuid");
    }
  });

  it("refuses a row that is already done", () => {
    const result = plan(row({ invoice_uuid: "u-1", status: "done" }), { action: "retry" });
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("already issued") });
  });

  it("allows a retry of a row stuck mid-KSeF", () => {
    const result = plan(
      row({
        invoice_number: "1/07/2026",
        invoice_uuid: "u-1",
        ksef_required: true,
        ksef_sent_at: new Date(),
        status: "needs_review",
      }),
      { action: "retry" },
    );
    expect(result.ok).toBe(true);
  });
});

describe("adopt", () => {
  it("takes over an existing inFakt invoice and records that it was adopted", () => {
    const result = plan(crashed, {
      action: "adopt",
      invoiceNumber: "7/07/2026",
      invoiceUuid: "u-9",
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.patch).toMatchObject({
        attempts: 0,
        invoice_number: "7/07/2026",
        invoice_uuid: "u-9",
        status: "processing",
      });
      expect(result.patch.adopted_at).toBeInstanceOf(Date);
    }
  });

  it("writes a task reference so the row cannot fall back into the crash window", () => {
    const result = plan(crashed, { action: "adopt", invoiceUuid: "u-9" });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.patch.task_reference).toBe("adopted:u-9");
      // Prove it: the resulting row is no longer in the window.
      expect(isInCrashWindow({ ...crashed, ...result.patch } as InvoiceStateRow, true)).toBe(false);
    }
  });

  it("keeps a real task reference when one already exists", () => {
    const result = plan(row({ task_reference: "ref-1" }), {
      action: "adopt",
      invoiceUuid: "u-9",
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.patch.task_reference).toBe("ref-1");
    }
  });

  it("requires a uuid", () => {
    for (const invoiceUuid of [undefined, "", "   "]) {
      expect(plan(crashed, { action: "adopt", invoiceUuid })).toMatchObject({
        ok: false,
        reason: expect.stringContaining("uuid is required"),
      });
    }
  });

  it("refuses to re-point a row that is already linked to a different invoice", () => {
    // Both documents exist in inFakt; re-pointing would orphan the first while the
    // ledger claimed the second invoiced the order.
    const result = plan(row({ invoice_uuid: "u-1" }), { action: "adopt", invoiceUuid: "u-2" });
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain("already linked to invoice u-1");
      expect(result.reason).toContain("orphan");
    }
  });

  it("is idempotent when re-adopting the same invoice", () => {
    expect(plan(row({ invoice_uuid: "u-1" }), { action: "adopt", invoiceUuid: "u-1" }).ok).toBe(
      true,
    );
  });
});

describe("clear", () => {
  it("clears the crash-window markers when the operator confirms there is no duplicate", () => {
    const result = plan(crashed, { action: "clear", confirmNoDuplicate: true });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.patch).toMatchObject({
        attempts: 0,
        status: "processing",
        submit_started_at: null,
        task_reference: null,
      });
      expect(isInCrashWindow({ ...crashed, ...result.patch } as InvoiceStateRow, true)).toBe(false);
    }
  });

  it("refuses without the explicit confirmation", () => {
    for (const confirmNoDuplicate of [undefined, false, "true" as never]) {
      const result = plan(crashed, { action: "clear", confirmNoDuplicate });
      expect(result).toMatchObject({ ok: false });
      if (!result.ok) {
        expect(result.reason).toContain("Confirm explicitly");
      }
    }
  });

  it("refuses when the row already has an invoice - that would issue a second one", () => {
    const result = plan(row({ invoice_uuid: "u-1" }), {
      action: "clear",
      confirmNoDuplicate: true,
    });
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("already has invoice u-1"),
    });
  });
});

describe("skip", () => {
  it("marks the row skipped with the operator's reason on the record", () => {
    const result = plan(row(), { action: "skip", reason: "test order, not a real sale" });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.patch).toMatchObject({
        skip_reason: "skipped by an operator: test order, not a real sale",
        status: "skipped",
      });
      expect(result.patch.completed_at).toBeInstanceOf(Date);
    }
  });

  it("requires a reason - skipping is a decision not to issue a legal document", () => {
    for (const reason of [undefined, "", "   "]) {
      expect(plan(row(), { action: "skip", reason })).toMatchObject({
        ok: false,
        reason: "a reason is required to skip an order",
      });
    }
  });

  it("never touches an invoice that already exists in inFakt", () => {
    const result = plan(row({ invoice_uuid: "u-1" }), {
      action: "skip",
      reason: "duplicate order",
    });
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.patch).not.toHaveProperty("invoice_uuid");
      expect(result.patch).not.toHaveProperty("invoice_number");
    }
  });
});

describe("unknown actions", () => {
  it("are refused rather than silently ignored", () => {
    expect(plan(row(), { action: "delete" as never })).toMatchObject({ ok: false });
  });
});
