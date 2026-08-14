import type { MedusaRequest } from "@medusajs/framework/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockResponse } from "../__tests__/mock-response";
import { GET, POST } from "./route";

// Hoisted so the static import of ./route picks up the mock. The workflow has its
// own tests; here it is the boundary, and what matters is what reaches it.
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../../workflows/adopt-invoices", () => ({
  adoptInvoicesWorkflow: () => ({ run }),
}));

const ORDER = {
  billing_address: { first_name: "Jan", last_name: "Kowalski" },
  created_at: "2026-08-10T11:05:00Z",
  currency_code: "pln",
  display_id: 112,
  email: "buyer-synthetic@allegromail.pl",
  id: "order_112",
  items: [{ product_title: "Dysk SSD 1TB", quantity: 1 }],
  total: 149,
};

const INVOICE = {
  clientEmail: "buyer-synthetic@allegromail.pl",
  clientFirstName: "Jan",
  clientLastName: "Kowalski",
  currency: "PLN",
  grossPrice: 14_900,
  invoiceDate: "2026-08-10",
  number: "ZR-009009",
  services: [{ name: "Dysk SSD 1TB", quantity: 1 }],
  uuid: "uuid-1",
};

interface Fakes {
  orders?: Record<string, unknown>[];
  invoices?: Record<string, unknown>[];
  ledger?: Record<string, unknown>[];
  enabled?: boolean;
  ksefMode?: "nip-only" | "all" | "never";
}

const getInvoice = vi.fn().mockResolvedValue(INVOICE);

const service = (fakes: Fakes = {}) => {
  const listInvoices = vi
    .fn()
    .mockResolvedValue(fakes.invoices ?? ([INVOICE] as Record<string, unknown>[]));
  return {
    getApiClient: vi.fn().mockResolvedValue({
      getInvoice,
      listInvoices,
    }),
    getEffectiveOptions: vi.fn().mockResolvedValue({
      currency: "PLN",
      enabled: fakes.enabled ?? true,
      ksefMode: fakes.ksefMode ?? "nip-only",
      nipExtractor: () => undefined,
    }),
    listInfaktInvoices: vi.fn().mockResolvedValue(fakes.ledger ?? []),
    listInvoices,
  };
};

const request = (
  svc: ReturnType<typeof service>,
  payload: { query?: Record<string, unknown>; body?: Record<string, unknown>; orders?: unknown[] },
): MedusaRequest =>
  ({
    body: payload.body ?? {},
    params: {},
    query: payload.query ?? {},
    scope: {
      resolve: vi.fn().mockImplementation((key: string) =>
        key === "query"
          ? { graph: vi.fn().mockResolvedValue({ data: payload.orders ?? [ORDER] }) }
          : svc,
      ),
    },
  }) as unknown as MedusaRequest;

const WINDOW = { from: "2026-08-01", to: "2026-08-12" };

beforeEach(() => {
  run.mockReset();
  getInvoice.mockClear();
  run.mockResolvedValue({ result: { adopted: [], skipped: [] } });
});

describe("GET /admin/infakt/reconcile", () => {
  it("reports the one invoice that matches, and writes nothing", async () => {
    const svc = service();
    const res = mockResponse();
    await GET(request(svc, { query: WINDOW }), res);

    const body = res.json.mock.calls[0][0];
    expect(body.applied).toBe(false);
    expect(body.summary).toMatchObject({ adopt: 1, ambiguous: 0, no_match: 0, scanned: 1 });
    expect(body.entries[0]).toMatchObject({
      confidence: "high",
      decision: "adopt",
      displayId: 112,
      orderId: "order_112",
    });
    expect(body.entries[0].invoice.number).toBe("ZR-009009");
    expect(run).not.toHaveBeenCalled();
  });

  it("reads the list endpoint only - nothing needs an invoice's line positions now", async () => {
    const svc = service();
    await GET(request(svc, { query: WINDOW }), mockResponse());
    expect(svc.listInvoices).toHaveBeenCalled();
    expect(getInvoice).not.toHaveBeenCalled();
  });

  it("asks inFakt only for the window, padded by the tolerance", async () => {
    const svc = service();
    await GET(request(svc, { query: { ...WINDOW, tolerance_days: 3 } }), mockResponse());
    expect(svc.listInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ issuedFrom: "2026-07-29", issuedTo: "2026-08-15" }),
    );
  });

  it("leaves an order that already has an invoice record out of scope entirely", async () => {
    const svc = service({ ledger: [{ order_id: "order_112" }] });
    const res = mockResponse();
    await GET(request(svc, { query: WINDOW }), res);
    expect(res.json.mock.calls[0][0].summary).toMatchObject({ adopt: 0, scanned: 0 });
  });

  it("refuses a window that is not a pair of calendar dates", async () => {
    await expect(
      GET(request(service(), { query: { from: "sierpien", to: "2026-08-12" } }), mockResponse()),
    ).rejects.toThrow(/`from` must be a calendar date/u);
  });

  it("answers 409 rather than throwing when no apiKey is configured", async () => {
    const res = mockResponse();
    await GET(request(service({ enabled: false }), { query: WINDOW }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json.mock.calls[0][0].error).toContain("disabled");
  });

  it("reports an ambiguous order and proposes nothing for it", async () => {
    const svc = service({ invoices: [INVOICE, { ...INVOICE, number: "ZR-009010", uuid: "uuid-2" }] });
    const res = mockResponse();
    await GET(request(svc, { query: WINDOW }), res);
    const body = res.json.mock.calls[0][0];
    expect(body.summary).toMatchObject({ adopt: 0, ambiguous: 1 });
    expect(body.entries[0].invoice).toBeUndefined();
    expect(body.entries[0].candidates).toHaveLength(2);
  });

  it("refuses an invoice that is already recorded on another order", async () => {
    const svc = service({ ledger: [{ invoice_number: "ZR-009009", order_id: "order_1" }] });
    // The ledger lookup answers for both the order-id and the invoice-number query,
    // so the order itself stays in scope only because its id does not match.
    svc.listInfaktInvoices
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ invoice_uuid: "uuid-1" }]);
    const res = mockResponse();
    await GET(request(svc, { query: WINDOW }), res);
    expect(res.json.mock.calls[0][0].entries[0].decision).toBe("ambiguous");
  });
});

describe("POST /admin/infakt/reconcile", () => {
  it("is a dry run unless `apply` is explicitly true", async () => {
    const res = mockResponse();
    await POST(request(service(), { body: { ...WINDOW } }), res);
    expect(res.json.mock.calls[0][0].applied).toBe(false);
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses to apply without an explicit list of orders", async () => {
    await expect(
      POST(request(service(), { body: { ...WINDOW, apply: true } }), mockResponse()),
    ).rejects.toThrow(/`order_ids` must name the orders/u);
    expect(run).not.toHaveBeenCalled();
  });

  it("adopts only the named orders, with the KSeF decision frozen from the document", async () => {
    const res = mockResponse();
    await POST(
      request(service(), { body: { ...WINDOW, apply: true, order_ids: ["order_112"] } }),
      res,
    );
    expect(run).toHaveBeenCalledTimes(1);
    const [{ adoptions }] = [run.mock.calls[0][0].input];
    expect(adoptions).toHaveLength(1);
    expect(adoptions[0]).toMatchObject({
      invoiceDate: "2026-08-10",
      invoiceNumber: "ZR-009009",
      invoiceUuid: "uuid-1",
      isCompany: false,
      ksefRequired: false,
      orderId: "order_112",
    });
    expect(JSON.parse(adoptions[0].evidence)).toMatchObject({
      identity: "email",
      source: "infakt-reconcile",
    });
    expect(res.json.mock.calls[0][0].applied).toBe(true);
  });

  it("files an adopted B2B document under KSeF, from the invoice's own tax code", async () => {
    const svc = service({ invoices: [{ ...INVOICE, clientTaxCode: "5261040828" }] });
    svc.getEffectiveOptions.mockResolvedValue({
      currency: "PLN",
      enabled: true,
      ksefMode: "nip-only",
      nipExtractor: () => "5261040828",
    });
    await POST(
      request(svc, { body: { ...WINDOW, apply: true, order_ids: ["order_112"] } }),
      mockResponse(),
    );
    expect(run.mock.calls[0][0].input.adoptions[0]).toMatchObject({
      isCompany: true,
      ksefRequired: true,
    });
  });

  it("reports a named order whose match no longer holds instead of writing it", async () => {
    const svc = service({ invoices: [] });
    const res = mockResponse();
    await POST(
      request(svc, { body: { ...WINDOW, apply: true, order_ids: ["order_112"] } }),
      res,
    );
    expect(run.mock.calls[0][0].input.adoptions).toEqual([]);
    expect(res.json.mock.calls[0][0].refused).toEqual(["order_112"]);
  });

  it("never applies an ambiguous order, even when it is named", async () => {
    const svc = service({ invoices: [INVOICE, { ...INVOICE, uuid: "uuid-2" }] });
    await POST(
      request(svc, { body: { ...WINDOW, apply: true, order_ids: ["order_112"] } }),
      mockResponse(),
    );
    expect(run.mock.calls[0][0].input.adoptions).toEqual([]);
  });
});
