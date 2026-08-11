import type { MedusaRequest } from "@medusajs/framework/http";
import { describe, expect, it, vi } from "vitest";
import { mockResponse } from "../__tests__/mock-response";
import { GET } from "./route";

const service = (invoices: Record<string, unknown>[] = []) => ({
  listInfaktInvoices: vi.fn().mockResolvedValue(invoices),
});

const request = (svc: unknown, query: Record<string, unknown> = {}): MedusaRequest =>
  ({
    params: {},
    query,
    scope: { resolve: vi.fn().mockReturnValue(svc) },
  }) as unknown as MedusaRequest;

describe("GET /admin/infakt/invoices", () => {
  it("lists newest first with the default page size", async () => {
    const svc = service();
    await GET(request(svc), mockResponse());
    expect(svc.listInfaktInvoices).toHaveBeenCalledWith(
      {},
      { order: { created_at: "DESC" }, skip: 0, take: 50 },
    );
  });

  it("filters by a valid status", async () => {
    const svc = service();
    await GET(request(svc, { status: "needs_review" }), mockResponse());
    expect(svc.listInfaktInvoices).toHaveBeenCalledWith(
      { status: ["needs_review"] },
      expect.anything(),
    );
  });

  it("ignores an unknown status rather than returning nothing", async () => {
    const svc = service();
    await GET(request(svc, { status: "'; drop table --" }), mockResponse());
    expect(svc.listInfaktInvoices).toHaveBeenCalledWith({}, expect.anything());
  });

  it("honours limit and offset, and caps the limit", async () => {
    const svc = service();
    await GET(request(svc, { limit: "10", offset: "20" }), mockResponse());
    expect(svc.listInfaktInvoices).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ skip: 20, take: 10 }),
    );

    const capped = service();
    await GET(request(capped, { limit: "100000" }), mockResponse());
    expect(capped.listInfaktInvoices).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ take: 200 }),
    );
  });

  it("falls back to the defaults for junk paging values", async () => {
    const svc = service();
    await GET(request(svc, { limit: "abc", offset: "-5" }), mockResponse());
    expect(svc.listInfaktInvoices).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ skip: 0, take: 50 }),
    );
  });

  it("annotates each row with whether retry is unsafe", async () => {
    const res = mockResponse();
    await GET(
      request(
        service([
          {
            attempts: 1,
            id: "a",
            order_id: "o1",
            status: "needs_review",
            submit_started_at: new Date(),
          },
          { attempts: 1, id: "b", order_id: "o2", status: "needs_review", task_reference: "ref" },
        ]),
      ),
      res,
    );
    const { invoices } = res.json.mock.calls[0][0];
    expect(invoices[0].in_crash_window).toBe(true);
    expect(invoices[1].in_crash_window).toBe(false);
  });
});
