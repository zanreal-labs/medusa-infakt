import type { MedusaRequest } from "@medusajs/framework/http";
import { describe, expect, it, vi } from "vitest";
import { mockResponse } from "../../../__tests__/mock-response";
import { GET } from "./route";

const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);

const service = (overrides: Record<string, unknown> = {}) => ({
  getApiClient: vi.fn().mockResolvedValue({
    findInvoiceByNumber: vi.fn().mockResolvedValue(undefined),
    getInvoicePdf: vi.fn().mockResolvedValue(pdfBytes),
  }),
  getEffectiveOptions: vi.fn().mockResolvedValue({ enabled: true }),
  listInfaktInvoices: vi.fn().mockResolvedValue([{ id: "inv_1", invoice_uuid: "u-1" }]),
  ...overrides,
});

const request = (svc: unknown): MedusaRequest =>
  ({
    params: { id: "inv_1" },
    query: {},
    scope: { resolve: vi.fn().mockReturnValue(svc) },
  }) as unknown as MedusaRequest;

describe("GET /admin/infakt/invoices/:id/pdf", () => {
  it("fetches the PDF directly when invoice_uuid is known", async () => {
    const getInvoicePdf = vi.fn().mockResolvedValue(pdfBytes);
    const svc = service({
      getApiClient: vi.fn().mockResolvedValue({ getInvoicePdf }),
      listInfaktInvoices: vi
        .fn()
        .mockResolvedValue([{ id: "inv_1", invoice_number: "1/09/2026", invoice_uuid: "u-1" }]),
    });
    const res = mockResponse();
    await GET(request(svc), res);
    expect(getInvoicePdf).toHaveBeenCalledWith("u-1");
    expect(res.setHeader).toHaveBeenCalledWith("Content-Type", "application/pdf");
    expect(res.setHeader).toHaveBeenCalledWith(
      "Content-Disposition",
      expect.stringContaining("1-09-2026.pdf"),
    );
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("resolves the uuid by number when invoice_uuid is null - the 24 backfilled rows' shape", async () => {
    const findInvoiceByNumber = vi.fn().mockResolvedValue({ number: "3/03/2026", uuid: "u-resolved" });
    const getInvoicePdf = vi.fn().mockResolvedValue(pdfBytes);
    const svc = service({
      getApiClient: vi.fn().mockResolvedValue({ findInvoiceByNumber, getInvoicePdf }),
      listInfaktInvoices: vi
        .fn()
        .mockResolvedValue([{ id: "inv_1", invoice_number: "3/03/2026", invoice_uuid: null }]),
    });
    const res = mockResponse();
    await GET(request(svc), res);
    expect(findInvoiceByNumber).toHaveBeenCalledWith("3/03/2026");
    expect(getInvoicePdf).toHaveBeenCalledWith("u-resolved");
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("404s when the row has neither invoice_uuid nor invoice_number", async () => {
    const svc = service({
      listInfaktInvoices: vi
        .fn()
        .mockResolvedValue([{ id: "inv_1", invoice_number: null, invoice_uuid: null }]),
    });
    await expect(GET(request(svc), mockResponse())).rejects.toThrow(
      /neither an inFakt uuid nor an invoice number/u,
    );
  });

  it("404s when no ledger row exists for the id", async () => {
    const svc = service({ listInfaktInvoices: vi.fn().mockResolvedValue([]) });
    await expect(GET(request(svc), mockResponse())).rejects.toThrow(/No invoice row/u);
  });

  it("404s when inFakt has no invoice matching the number - never a link that just 404s later", async () => {
    const svc = service({
      getApiClient: vi.fn().mockResolvedValue({
        findInvoiceByNumber: vi.fn().mockResolvedValue(undefined),
      }),
      listInfaktInvoices: vi
        .fn()
        .mockResolvedValue([{ id: "inv_1", invoice_number: "9/99/2026", invoice_uuid: null }]),
    });
    await expect(GET(request(svc), mockResponse())).rejects.toThrow(
      /inFakt has no invoice numbered 9\/99\/2026/u,
    );
  });

  it("answers 409 when the plugin is disabled, rather than reaching for a client that would throw", async () => {
    const getApiClient = vi.fn();
    const svc = service({
      getApiClient,
      getEffectiveOptions: vi.fn().mockResolvedValue({ enabled: false }),
    });
    const res = mockResponse();
    await GET(request(svc), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({
      error: expect.stringContaining("plugin is disabled"),
      id: "inv_1",
    });
    expect(getApiClient).not.toHaveBeenCalled();
  });
});
