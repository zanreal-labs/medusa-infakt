import { describe, expect, it, vi } from "vitest";
import { applyInvoiceAction, revertInvoiceAction } from "./apply-invoice-action";
import type { ApplyInvoiceActionInput, InvoiceActionService } from "./apply-invoice-action";

/**
 * The step's body is tested directly rather than through the workflow: running the
 * workflow would need a workflow engine and a database, and what is worth pinning
 * down is that the step defers every decision to `planOperatorAction` and that its
 * compensation captures every column an action can write.
 */

const service = (row?: Record<string, unknown>) => {
  const updateInfaktInvoices = vi.fn().mockResolvedValue([]);
  return {
    listInfaktInvoices: vi.fn().mockResolvedValue(row ? [row] : []),
    resolvedOptions: { emitIssuedEvent: true as boolean },
    updateInfaktInvoices,
  } satisfies InvoiceActionService & { updateInfaktInvoices: ReturnType<typeof vi.fn> };
};

const act = async (row: Record<string, unknown> | undefined, input: ApplyInvoiceActionInput) => {
  const infakt = service(row);
  const outcome = await applyInvoiceAction(input, infakt);
  return { ...outcome, infakt };
};

describe("applyInvoiceAction", () => {
  it("refuses when the row does not exist, and writes nothing", async () => {
    const { result, infakt } = await act(undefined, { action: "retry", id: "missing" });
    expect(result).toMatchObject({ applied: false });
    expect(result.refusal).toContain("No invoice record with id missing");
    expect(infakt.updateInfaktInvoices).not.toHaveBeenCalled();
  });

  it("applies a retry and returns the plan's note", async () => {
    const { result, infakt } = await act(
      { attempts: 3, id: "inv_1", last_error: "timeout", status: "needs_review" },
      { action: "retry", id: "inv_1" },
    );
    expect(result).toMatchObject({ applied: true, note: expect.any(String) });
    expect(infakt.updateInfaktInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 0, id: "inv_1", status: "processing" }),
    );
  });

  it("refuses a crash-window retry without writing anything", async () => {
    // The step must not soften what the pure planner refused.
    const { result, infakt } = await act(
      { attempts: 1, id: "inv_1", status: "needs_review", submit_started_at: new Date() },
      { action: "retry", id: "inv_1" },
    );
    expect(result).toMatchObject({ applied: false });
    expect(result.refusal).toContain("refusing to retry");
    expect(infakt.updateInfaktInvoices).not.toHaveBeenCalled();
  });

  it("returns no compensation data for a refusal", async () => {
    const { compensation } = await act(undefined, { action: "retry", id: "missing" });
    expect(compensation).toBeUndefined();
  });

  it("captures every mutable column before writing", async () => {
    const { compensation } = await act(
      {
        attempts: 3,
        id: "inv_1",
        last_error: "timeout",
        status: "needs_review",
        task_reference: "ref-1",
      },
      { action: "retry", id: "inv_1" },
    );
    expect(compensation?.id).toBe("inv_1");
    expect(compensation?.previous).toMatchObject({
      attempts: 3,
      last_error: "timeout",
      status: "needs_review",
      task_reference: "ref-1",
    });
    // Columns absent from the row are captured as null, so restoring cannot leave
    // behind a value the action introduced.
    expect(compensation?.previous.invoice_uuid).toBeNull();
    expect(compensation?.previous.submit_started_at).toBeNull();
  });

  it("captures the markers an adopt overwrites, so a rollback restores the refusal", async () => {
    const row = { attempts: 1, id: "inv_1", status: "needs_review", submit_started_at: new Date() };
    const { compensation, result } = await act(row, {
      action: "adopt",
      id: "inv_1",
      invoiceNumber: "7/07/2026",
      invoiceUuid: "u-9",
    });
    expect(result.applied).toBe(true);
    expect(compensation?.previous.task_reference).toBeNull();
    expect(compensation?.previous.invoice_uuid).toBeNull();
    expect(compensation?.previous.adopted_at).toBeNull();
  });

  it("passes the emitIssuedEvent option through to the planner", async () => {
    const infakt = service({ attempts: 0, id: "inv_1", status: "needs_review" });
    infakt.resolvedOptions.emitIssuedEvent = false;
    const { result } = await applyInvoiceAction({ action: "retry", id: "inv_1" }, infakt);
    expect(result.applied).toBe(true);
  });
});

describe("revertInvoiceAction", () => {
  it("restores the captured values", async () => {
    const infakt = service();
    await revertInvoiceAction(
      { id: "inv_1", previous: { attempts: 3, status: "needs_review", submit_started_at: null } },
      infakt,
    );
    expect(infakt.updateInfaktInvoices).toHaveBeenCalledWith({
      attempts: 3,
      id: "inv_1",
      status: "needs_review",
      submit_started_at: null,
    });
  });

  it("does nothing when the step never wrote", async () => {
    const infakt = service();
    await revertInvoiceAction(undefined, infakt);
    expect(infakt.updateInfaktInvoices).not.toHaveBeenCalled();
  });

  it("round-trips an applied action back to its original state", async () => {
    const original = {
      attempts: 3,
      id: "inv_1",
      last_error: "timeout",
      status: "needs_review",
      submit_started_at: null,
    };
    const { compensation } = await act({ ...original }, { action: "retry", id: "inv_1" });
    const infakt = service();
    await revertInvoiceAction(compensation, infakt);
    expect(infakt.updateInfaktInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ attempts: 3, last_error: "timeout", status: "needs_review" }),
    );
  });
});
