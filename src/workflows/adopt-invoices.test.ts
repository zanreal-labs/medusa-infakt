import { describe, expect, it, vi } from "vitest";
import { adoptInvoices, revertAdoptInvoices } from "./adopt-invoices";
import type { AdoptInvoiceInput, AdoptInvoicesService } from "./adopt-invoices";

/**
 * The step's body is tested directly, as `apply-invoice-action.test.ts` does: what
 * is worth pinning down is that an order which already has a row is left completely
 * alone, that the written row is terminal (so nothing can issue or file anything for
 * it), and that compensation removes exactly what was created.
 */

const adoption = (overrides: Partial<AdoptInvoiceInput> = {}): AdoptInvoiceInput => ({
  evidence: '{"source":"infakt-reconcile"}',
  invoiceDate: "2026-08-10",
  invoiceNumber: "ZR-009009",
  invoiceUuid: "uuid-1",
  isCompany: false,
  ksefDecisionReason: "buyer has no NIP - consumer invoice, outside KSeF",
  ksefRequired: false,
  orderId: "order_112",
  ...overrides,
});

const service = (existing: { order_id: string }[] = []) => {
  let created = 0;
  return {
    createInfaktInvoices: vi.fn().mockImplementation(() => {
      created += 1;
      return Promise.resolve({ id: `inv_${created}` });
    }),
    deleteInfaktInvoices: vi.fn().mockResolvedValue(undefined),
    listInfaktInvoices: vi.fn().mockResolvedValue(existing),
  } satisfies AdoptInvoicesService & Record<string, ReturnType<typeof vi.fn>>;
};

describe("adoptInvoices", () => {
  it("writes a terminal, already-issued row - nothing left for the worker to do", async () => {
    const infakt = service();
    const { result } = await adoptInvoices({ adoptions: [adoption()] }, infakt);

    expect(result.adopted).toEqual([
      { invoice_number: "ZR-009009", invoice_uuid: "uuid-1", order_id: "order_112" },
    ]);
    const written = infakt.createInfaktInvoices.mock.calls[0][0] as Record<string, unknown>;
    expect(written).toMatchObject({
      invoice_number: "ZR-009009",
      invoice_uuid: "uuid-1",
      order_id: "order_112",
      // `done` is what keeps this row out of `listDueInvoices` forever: no create,
      // no KSeF filing, no issued event.
      status: "done",
    });
    expect(written.completed_at).toEqual(new Date("2026-08-10T00:00:00.000Z"));
    expect(written.adopted_at).toBeInstanceOf(Date);
    expect(written.adopted_evidence).toBe('{"source":"infakt-reconcile"}');
    expect(written).not.toHaveProperty("event_emitted_at");
    expect(written).not.toHaveProperty("submit_started_at");
  });

  it("records the KSeF decision for a company buyer without acting on it", async () => {
    const infakt = service();
    await adoptInvoices(
      {
        adoptions: [
          adoption({
            isCompany: true,
            ksefDecisionReason: "buyer has a NIP - B2B invoice, mandatory in KSeF",
            ksefRequired: true,
          }),
        ],
      },
      infakt,
    );
    expect(infakt.createInfaktInvoices.mock.calls[0][0]).toMatchObject({
      is_company: true,
      ksef_required: true,
      status: "done",
    });
  });

  it("SKIPS an order that already has an invoice record, and writes nothing for it", async () => {
    const infakt = service([{ order_id: "order_112" }]);
    const { result } = await adoptInvoices({ adoptions: [adoption()] }, infakt);
    expect(result.adopted).toEqual([]);
    expect(result.skipped).toEqual([
      { order_id: "order_112", reason: "this order already has an invoice record - left untouched" },
    ]);
    expect(infakt.createInfaktInvoices).not.toHaveBeenCalled();
  });

  it("adopts the rest of the batch when one order is already ledgered", async () => {
    const infakt = service([{ order_id: "order_112" }]);
    const { result } = await adoptInvoices(
      { adoptions: [adoption(), adoption({ orderId: "order_113", invoiceUuid: "uuid-2" })] },
      infakt,
    );
    expect(result.adopted.map((row) => row.order_id)).toEqual(["order_113"]);
    expect(result.skipped.map((row) => row.order_id)).toEqual(["order_112"]);
  });

  it("reports a lost race on the unique order_id instead of failing the batch", async () => {
    const infakt = service();
    infakt.createInfaktInvoices.mockRejectedValueOnce(new Error("duplicate key"));
    const { result } = await adoptInvoices(
      { adoptions: [adoption(), adoption({ orderId: "order_113", invoiceUuid: "uuid-2" })] },
      infakt,
    );
    expect(result.skipped[0]).toMatchObject({ order_id: "order_112" });
    expect(result.adopted.map((row) => row.order_id)).toEqual(["order_113"]);
  });

  it("falls back to now when inFakt gave no issue date", async () => {
    const infakt = service();
    await adoptInvoices({ adoptions: [adoption({ invoiceDate: null })] }, infakt);
    expect(infakt.createInfaktInvoices.mock.calls[0][0].completed_at).toBeInstanceOf(Date);
  });
});

describe("revertAdoptInvoices", () => {
  it("removes exactly the rows the step created", async () => {
    const infakt = service();
    const { compensation } = await adoptInvoices(
      { adoptions: [adoption(), adoption({ orderId: "order_113", invoiceUuid: "uuid-2" })] },
      infakt,
    );
    await revertAdoptInvoices(compensation, infakt);
    expect(infakt.deleteInfaktInvoices).toHaveBeenCalledWith(["inv_1", "inv_2"]);
  });

  it("does nothing when nothing was created", async () => {
    const infakt = service();
    await revertAdoptInvoices({ ids: [] }, infakt);
    await revertAdoptInvoices(undefined, infakt);
    expect(infakt.deleteInfaktInvoices).not.toHaveBeenCalled();
  });
});
