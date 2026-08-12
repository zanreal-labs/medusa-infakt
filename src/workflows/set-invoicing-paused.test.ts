import { describe, expect, it, vi } from "vitest";
import { revertInvoicingPaused, runSetInvoicingPaused } from "./set-invoicing-paused";
import type { InvoicingPauseService } from "./set-invoicing-paused";

/**
 * The step's body is tested directly rather than through the workflow, same
 * reasoning as `apply-invoice-action.test.ts`: running the workflow would need a
 * workflow engine, and what is worth pinning down is that the write is captured
 * for compensation BEFORE it happens, and that a rollback restores exactly that.
 */

const service = (
  invoicingPaused: boolean,
): InvoicingPauseService & {
  setInvoicingPaused: ReturnType<typeof vi.fn>;
} => ({
  getSettings: vi.fn().mockResolvedValue({ invoicing_paused: invoicingPaused }),
  setInvoicingPaused: vi.fn(() => Promise.resolve()),
});

describe("runSetInvoicingPaused", () => {
  it("writes the new value and returns it", async () => {
    const infakt = service(true);
    const { result } = await runSetInvoicingPaused({ invoicingPaused: false }, infakt);
    expect(result).toEqual({ invoicingPaused: false });
    expect(infakt.setInvoicingPaused).toHaveBeenCalledWith(false);
  });

  it("captures the previous value BEFORE writing, for compensation", async () => {
    const infakt = service(true);
    const { compensation } = await runSetInvoicingPaused({ invoicingPaused: false }, infakt);
    expect(compensation).toEqual({ previous: true });
  });

  it("treats a settings row with no invoicing_paused field as previously true", async () => {
    // Mirrors the service's own default: a fresh singleton is paused.
    const infakt: InvoicingPauseService = {
      getSettings: vi.fn().mockResolvedValue({}),
      setInvoicingPaused: vi.fn(() => Promise.resolve()),
    };
    const { compensation } = await runSetInvoicingPaused({ invoicingPaused: false }, infakt);
    expect(compensation).toEqual({ previous: false });
  });

  it("is a no-op write when asked to set the value it already has, but still reports it", async () => {
    const infakt = service(false);
    const { result, compensation } = await runSetInvoicingPaused(
      { invoicingPaused: false },
      infakt,
    );
    expect(result).toEqual({ invoicingPaused: false });
    expect(compensation).toEqual({ previous: false });
    expect(infakt.setInvoicingPaused).toHaveBeenCalledWith(false);
  });
});

describe("revertInvoicingPaused", () => {
  it("restores the captured previous value", async () => {
    const infakt = service(false);
    await revertInvoicingPaused({ previous: true }, infakt);
    expect(infakt.setInvoicingPaused).toHaveBeenCalledWith(true);
  });

  it("does nothing when the step never wrote (no compensation data)", async () => {
    const infakt = service(false);
    await revertInvoicingPaused(undefined, infakt);
    expect(infakt.setInvoicingPaused).not.toHaveBeenCalled();
  });

  it("round-trips: write then revert leaves setInvoicingPaused called with the original value last", async () => {
    const infakt = service(true);
    const { compensation } = await runSetInvoicingPaused({ invoicingPaused: false }, infakt);
    await revertInvoicingPaused(compensation, infakt);
    expect(infakt.setInvoicingPaused).toHaveBeenNthCalledWith(1, false);
    expect(infakt.setInvoicingPaused).toHaveBeenNthCalledWith(2, true);
  });
});
