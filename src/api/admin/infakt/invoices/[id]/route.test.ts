import type { MedusaRequest } from "@medusajs/framework/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InfaktApiError } from "../../../../../lib/infakt";
import { mockResponse } from "../../__tests__/mock-response";
import { POST } from "./route";

// Hoisted so the static import of ./route below picks up the mock. The workflow
// itself is covered by its own tests; here the workflow is the boundary.
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../../../workflows/apply-invoice-action", () => ({
  applyInvoiceActionWorkflow: () => ({ run }),
}));

const service = (overrides: Record<string, unknown> = {}) => ({
  apiClient: { getInvoice: vi.fn().mockResolvedValue({ number: "7/07/2026", uuid: "u-9" }) },
  listInfaktInvoices: vi.fn().mockResolvedValue([{ id: "inv_1", status: "processing" }]),
  resolvedOptions: { emitIssuedEvent: true },
  ...overrides,
});

const request = (svc: unknown, body: Record<string, unknown>): MedusaRequest =>
  ({
    body,
    params: { id: "inv_1" },
    query: {},
    scope: { resolve: vi.fn().mockReturnValue(svc) },
  }) as unknown as MedusaRequest;

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ result: { applied: true, note: "queued for the next worker tick" } });
});

describe("POST /admin/infakt/invoices/:id", () => {
  it("rejects an unknown action before touching anything", async () => {
    await expect(POST(request(service(), { action: "nuke" }), mockResponse())).rejects.toThrow(
      /must be one of retry, adopt, clear, skip/u,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects a missing action", async () => {
    await expect(POST(request(service(), {}), mockResponse())).rejects.toThrow(/must be one of/u);
  });

  it("passes a retry through to the workflow and returns the updated row", async () => {
    const res = mockResponse();
    await POST(request(service(), { action: "retry" }), res);
    expect(run).toHaveBeenCalledWith({
      input: {
        action: "retry",
        confirmNoDuplicate: undefined,
        id: "inv_1",
        invoiceNumber: null,
        invoiceUuid: undefined,
        reason: undefined,
      },
    });
    expect(res.json).toHaveBeenCalledWith({
      invoice: { id: "inv_1", status: "processing" },
      note: "queued for the next worker tick",
    });
  });

  it("answers 409 for a refused action, with the operator-facing reason", async () => {
    // 409, not 400: the request was well-formed and it is the row's state that makes
    // the action impossible.
    run.mockResolvedValue({ result: { applied: false, refusal: "refusing to retry: ..." } });
    const res = mockResponse();
    await POST(request(service(), { action: "retry" }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: "refusing to retry: ...", id: "inv_1" });
  });

  it("reads the adopted invoice from inFakt BEFORE the link is written", async () => {
    const svc = service();
    const res = mockResponse();
    await POST(request(svc, { action: "adopt", invoice_uuid: " u-9 " }), res);
    expect(svc.apiClient.getInvoice).toHaveBeenCalledWith("u-9");
    expect(run.mock.calls[0][0].input.invoiceNumber).toBe("7/07/2026");
    // The order matters: a uuid that does not exist must never reach the write.
    expect(svc.apiClient.getInvoice.mock.invocationCallOrder[0]).toBeLessThan(
      run.mock.invocationCallOrder[0],
    );
  });

  it("requires a uuid to adopt", async () => {
    await expect(POST(request(service(), { action: "adopt" }), mockResponse())).rejects.toThrow(
      /`invoice_uuid` is required/u,
    );
    expect(run).not.toHaveBeenCalled();
  });

  it("reports a uuid inFakt does not know as invalid input, not a server error", async () => {
    const svc = service({
      apiClient: {
        getInvoice: vi
          .fn()
          .mockRejectedValue(new InfaktApiError({ httpStatus: 404, message: "not found" })),
      },
    });
    await expect(
      POST(request(svc, { action: "adopt", invoice_uuid: "u-nope" }), mockResponse()),
    ).rejects.toThrow(/inFakt has no invoice with uuid u-nope/u);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not swallow a non-404 failure while reading the adopted invoice", async () => {
    const svc = service({
      apiClient: {
        getInvoice: vi
          .fn()
          .mockRejectedValue(new InfaktApiError({ httpStatus: 503, message: "unavailable" })),
      },
    });
    await expect(
      POST(request(svc, { action: "adopt", invoice_uuid: "u-9" }), mockResponse()),
    ).rejects.toMatchObject({ httpStatus: 503 });
  });

  it("forwards the clear confirmation flag verbatim", async () => {
    await POST(request(service(), { action: "clear", confirm_no_duplicate: true }), mockResponse());
    expect(run.mock.calls[0][0].input.confirmNoDuplicate).toBe(true);
  });

  it("forwards a skip reason", async () => {
    await POST(request(service(), { action: "skip", reason: "test order" }), mockResponse());
    expect(run.mock.calls[0][0].input.reason).toBe("test order");
  });

  it("does not read inFakt for any action other than adopt", async () => {
    const svc = service();
    for (const action of ["retry", "clear", "skip"]) {
      await POST(request(svc, { action, confirm_no_duplicate: true, reason: "x" }), mockResponse());
    }
    expect(svc.apiClient.getInvoice).not.toHaveBeenCalled();
  });

  it("tolerates a missing body", async () => {
    const req = {
      params: { id: "inv_1" },
      query: {},
      scope: { resolve: vi.fn().mockReturnValue(service()) },
    } as unknown as MedusaRequest;
    await expect(POST(req, mockResponse())).rejects.toThrow(/must be one of/u);
  });
});
