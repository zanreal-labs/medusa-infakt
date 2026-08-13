import { afterEach, describe, expect, it, vi } from "vitest";
import { InfaktClient } from "./client";
import { InfaktApiError } from "./errors";

type FetchMock = ReturnType<typeof vi.fn>;

const apiJson = (status: number, body: unknown): Response =>
  Response.json(body, {
    headers: { "content-type": "application/json; charset=utf-8" },
    status,
  });

const stubFetch = (impl: (url: string, init?: RequestInit) => Response | Promise<Response>) => {
  const fetchImpl: FetchMock = vi.fn(impl);
  vi.stubGlobal("fetch", fetchImpl);
  return fetchImpl;
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("InfaktClient", () => {
  it("requires an API key", () => {
    expect(() => new InfaktClient({ apiKey: "" })).toThrow(/apiKey is required/u);
  });

  it("sends the X-inFakt-ApiKey header against the production base URL", async () => {
    const fetchImpl = stubFetch(() =>
      apiJson(200, { currency: "PLN", gross_price: 12_300, uuid: "u-1" }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    await client.getInvoice("u-1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.infakt.pl/api/v3/invoices/u-1.json",
    );
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.headers).toMatchObject({
      Accept: "application/json",
      "X-inFakt-ApiKey": "KEY",
    });
    expect(init?.method).toBe("GET");
  });

  it("uses the sandbox base URL", async () => {
    const fetchImpl = stubFetch(() => apiJson(200, { uuid: "u-1" }));
    const client = new InfaktClient({ apiKey: "KEY", environment: "sandbox" });
    await client.getInvoice("u-1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("https://api.sandbox-infakt.pl/api/v3");
  });

  it("createInvoiceAsync wraps the payload in { invoice } and maps the task", async () => {
    const fetchImpl = stubFetch(() =>
      apiJson(201, {
        invoice_task_reference_number: "ref-123",
        processing_code: 100,
        processing_description: "Zlecenie przyjete",
        timestamps: { task_created_at: "2024-01-15 10:21:25 +0100" },
      }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    const task = await client.createInvoiceAsync({
      payment_method: "transfer",
      services: [{ gross_price: 12_300, name: "Usluga", quantity: 1, tax_symbol: "23" }],
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/async/invoices.json");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(init?.headers).toMatchObject({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init?.body))).toEqual({
      invoice: {
        payment_method: "transfer",
        services: [{ gross_price: 12_300, name: "Usluga", quantity: 1, tax_symbol: "23" }],
      },
    });
    expect(task).toEqual({
      invoiceTaskReferenceNumber: "ref-123",
      processingCode: 100,
      processingDescription: "Zlecenie przyjete",
    });
  });

  it("getInvoiceTaskStatus reports a pending task (processing_code 140)", async () => {
    const fetchImpl = stubFetch(() =>
      apiJson(200, {
        invoice_task_reference_number: "ref-123",
        processing_code: 140,
        processing_description: "Zlecenie jest w trakcie przetwarzania",
      }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    const status = await client.getInvoiceTaskStatus("ref-123");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/async/invoices/status/ref-123.json");
    expect(status.processingCode).toBe(140);
    expect(status.done).toBe(false);
    expect(status.failed).toBe(false);
    expect(status.invoiceUuid).toBeUndefined();
  });

  it("getInvoiceTaskStatus treats 100 and 120 as pending too", async () => {
    for (const code of [100, 120]) {
      stubFetch(() => apiJson(200, { processing_code: code }));
      const status = await new InfaktClient({ apiKey: "KEY" }).getInvoiceTaskStatus("ref");
      expect(status.done).toBe(false);
      expect(status.failed).toBe(false);
    }
  });

  it("getInvoiceTaskStatus reports a created invoice (processing_code 201)", async () => {
    stubFetch(() =>
      apiJson(200, {
        invoice_task_reference_number: "ref-123",
        invoice_uuid: "1ba43eaf-4b29-41e5-a629-48e345e4c675",
        processing_code: 201,
        processing_description: "Faktura stworzona",
      }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    const status = await client.getInvoiceTaskStatus("ref-123");
    expect(status.done).toBe(true);
    expect(status.failed).toBe(false);
    expect(status.invoiceUuid).toBe("1ba43eaf-4b29-41e5-a629-48e345e4c675");
  });

  it("getInvoiceTaskStatus reports a failed task (processing_code 422)", async () => {
    stubFetch(() =>
      apiJson(200, {
        invoice_errors: { payment_method: ["Prosze wybrac odpowiedni sposob platnosci."] },
        invoice_task_reference_number: "ref-123",
        processing_code: 422,
        processing_description: "Nie udalo sie stworzyc faktury",
      }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    const status = await client.getInvoiceTaskStatus("ref-123");
    expect(status.done).toBe(false);
    expect(status.failed).toBe(true);
    expect(status.processingDescription).toBe("Nie udalo sie stworzyc faktury");
  });

  it("getInvoice maps snake_case fields, including positions, to camelCase", async () => {
    stubFetch(() =>
      apiJson(200, {
        client_company_name: "ACME Sp. z o.o.",
        client_tax_code: "5261040828",
        currency: "PLN",
        gross_price: 615_000,
        invoice_date: "2026-07-15",
        number: "1/07/2026",
        services: [{ gross_price: 615_000, name: "Usluga", quantity: "2" }],
        status: "paid",
        uuid: "u-1",
      }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    const invoice = await client.getInvoice("u-1");
    expect(invoice).toEqual({
      clientCompanyName: "ACME Sp. z o.o.",
      clientEmail: undefined,
      clientFirstName: undefined,
      clientLastName: undefined,
      clientTaxCode: "5261040828",
      currency: "PLN",
      grossPrice: 615_000,
      invoiceDate: "2026-07-15",
      number: "1/07/2026",
      services: [{ grossPrice: 615_000, name: "Usluga", quantity: 2 }],
      status: "paid",
      uuid: "u-1",
    });
  });

  it("listInvoices maps the paged entities envelope", async () => {
    const fetchImpl = stubFetch(() =>
      apiJson(200, {
        entities: [{ gross_price: 100, uuid: "u-1" }, { uuid: "u-2" }],
        metainfo: { count: 2, total_count: 2 },
      }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    const invoices = await client.listInvoices({ limit: 100, offset: 200 });
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("/invoices.json?");
    expect(url).toContain("limit=100");
    expect(url).toContain("offset=200");
    expect(invoices.map((invoice) => invoice.uuid)).toEqual(["u-1", "u-2"]);
  });

  it("listInvoices narrows an issue-date range with inFakt's own query filters", async () => {
    // The reconciliation reads a window rather than the whole history, and this is
    // the only server-side narrowing inFakt offers that helps: there is no filter
    // for the gross total and none for the buyer's email.
    const fetchImpl = stubFetch(() => apiJson(200, { entities: [] }));
    await new InfaktClient({ apiKey: "KEY" }).listInvoices({
      issuedFrom: "2026-07-01",
      issuedTo: "2026-08-12",
      order: "invoice_date asc",
      taxCode: "5261040828",
    });
    const url = decodeURIComponent(String(fetchImpl.mock.calls[0]?.[0]));
    expect(url).toContain("q[invoice_date_gteq]=2026-07-01");
    expect(url).toContain("q[invoice_date_lteq]=2026-08-12");
    expect(url).toContain("q[clean_client_nip_eq]=5261040828");
    // `+` for the space, which is how a query string spells one.
    expect(url).toContain("order=invoice_date+asc");
  });

  it("listInvoices sends no filter parameters when none were asked for", async () => {
    const fetchImpl = stubFetch(() => apiJson(200, { entities: [] }));
    await new InfaktClient({ apiKey: "KEY" }).listInvoices({ limit: 100 });
    expect(String(fetchImpl.mock.calls[0]?.[0])).not.toContain("q%5B");
  });

  it("listInvoices returns an empty array when the envelope has no entities", async () => {
    stubFetch(() => apiJson(200, { metainfo: { total_count: 0 } }));
    await expect(new InfaktClient({ apiKey: "KEY" }).listInvoices()).resolves.toEqual([]);
  });

  it("getInvoicePdf returns the binary body as Uint8Array", async () => {
    // "%PDF" magic bytes
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]);
    const fetchImpl = stubFetch(
      () => new Response(bytes, { headers: { "content-type": "application/pdf" }, status: 200 }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    const pdf = await client.getInvoicePdf("u-1");
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("/invoices/u-1/pdf.json");
    expect(url).toContain("document_type=original");
    expect(url).toContain("locale=pl");
    expect(pdf).toBeInstanceOf(Uint8Array);
    expect([...pdf]).toEqual([0x25, 0x50, 0x44, 0x46]);
  });

  it("getInvoicePdf forwards documentType and locale overrides", async () => {
    const fetchImpl = stubFetch(
      () => new Response(new Uint8Array([1]), { headers: { "content-type": "application/pdf" } }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    await client.getInvoicePdf("u-1", { documentType: "duplicate", locale: "en" });
    const url = String(fetchImpl.mock.calls[0]?.[0]);
    expect(url).toContain("document_type=duplicate");
    expect(url).toContain("locale=en");
  });

  it("getInvoicePdf throws InfaktApiError on a non-2xx response", async () => {
    stubFetch(() => apiJson(404, { error: "Zasob nie zostal znaleziony." }));
    await expect(new InfaktClient({ apiKey: "KEY" }).getInvoicePdf("u-1")).rejects.toMatchObject({
      httpStatus: 404,
      name: "InfaktApiError",
    });
  });

  it("sendToKsef POSTs with an empty body", async () => {
    const fetchImpl = stubFetch(() => apiJson(200, { status: "sent" }));
    const client = new InfaktClient({ apiKey: "KEY" });
    await client.sendToKsef("u-1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/invoices/u-1/send_to_ksef.json");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBeUndefined();
  });

  it("getKsefStatus maps the KSeF document status", async () => {
    const fetchImpl = stubFetch(() =>
      apiJson(200, {
        invoice_kind: "vat",
        invoice_uuid: "u-1",
        ksef_number: "7343521162-20231004-47A70D8BD670-57",
        request_uuid: "d34279dc-b1a1-4852-b475-eb36c335992f",
        status: "success",
        status_description: "Faktura zostala przetworzona.",
      }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    const status = await client.getKsefStatus("u-1");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/ksef/documents/u-1/status.json");
    expect(status).toEqual({
      ksefNumber: "7343521162-20231004-47A70D8BD670-57",
      requestUuid: "d34279dc-b1a1-4852-b475-eb36c335992f",
      status: "success",
      statusDescription: "Faktura zostala przetworzona.",
    });
  });

  it("getKsefStatus maps a null ksef_number to undefined while pending", async () => {
    stubFetch(() =>
      apiJson(200, {
        ksef_number: null,
        request_uuid: "req-1",
        status: "sent",
        status_description: "Faktura zostala wyslana do przetworzenia w KSeF.",
      }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    const status = await client.getKsefStatus("u-1");
    expect(status.status).toBe("sent");
    expect(status.ksefNumber).toBeUndefined();
  });

  it("getKsefIntegration reads the legacy /ksef/ namespace", async () => {
    const fetchImpl = stubFetch(() =>
      apiJson(200, {
        active: true,
        costs_last_fetched_at: null,
        incomes_last_fetched_at: "2024-12-01T10:00:00+01:00",
      }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    await expect(client.getKsefIntegration()).resolves.toEqual({
      active: true,
      costsLastFetchedAt: undefined,
      incomesLastFetchedAt: "2024-12-01T10:00:00+01:00",
    });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/ksef/integration.json");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("getKsefIntegration falls back to /ksef2/ when the legacy scope is refused", async () => {
    const fetchImpl = stubFetch((url) =>
      String(url).includes("/ksef2/")
        ? apiJson(200, { active: true })
        : apiJson(403, { error: "Brak uprawnien." }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    await expect(client.getKsefIntegration()).resolves.toMatchObject({ active: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(String(fetchImpl.mock.calls[1]?.[0])).toContain("/ksef2/integration.json");
  });

  it("getKsefIntegration does not fall back on a non-scope failure", async () => {
    const fetchImpl = stubFetch(() => apiJson(500, { error: "Blad serwera." }));
    await expect(new InfaktClient({ apiKey: "KEY" }).getKsefIntegration()).rejects.toMatchObject({
      httpStatus: 500,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("getKsefIntegration reports inactive rather than guessing when active is absent", async () => {
    stubFetch(() => apiJson(200, {}));
    await expect(new InfaktClient({ apiKey: "KEY" }).getKsefIntegration()).resolves.toMatchObject({
      active: false,
    });
  });

  it("markPaid POSTs the paid_date body", async () => {
    const fetchImpl = stubFetch(() => apiJson(201, { processing_code: 100 }));
    const client = new InfaktClient({ apiKey: "KEY" });
    await client.markPaid("u-1", "2026-07-15");
    expect(String(fetchImpl.mock.calls[0]?.[0])).toContain("/async/invoices/u-1/paid.json");
    const init = fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ paid_date: "2026-07-15" }));
  });

  it("markPaid sends an empty JSON object when no paidDate is given", async () => {
    const fetchImpl = stubFetch(() => apiJson(201, { processing_code: 100 }));
    const client = new InfaktClient({ apiKey: "KEY" });
    await client.markPaid("u-1");
    expect((fetchImpl.mock.calls[0]?.[1] as RequestInit | undefined)?.body).toBe("{}");
  });

  it("throws InfaktApiError with the { error } message and status", async () => {
    stubFetch(() => apiJson(422, { error: "Uzytkownik nie jest zintegrowany z KSeF." }));
    const client = new InfaktClient({ apiKey: "KEY" });
    try {
      await client.sendToKsef("u-1");
      expect.fail("should throw");
    } catch (error) {
      expect(error).toBeInstanceOf(InfaktApiError);
      expect((error as InfaktApiError).httpStatus).toBe(422);
      expect((error as InfaktApiError).message).toBe("Uzytkownik nie jest zintegrowany z KSeF.");
      expect((error as InfaktApiError).body).toEqual({
        error: "Uzytkownik nie jest zintegrowany z KSeF.",
      });
    }
  });

  it("throws InfaktApiError with a message built from field errors", async () => {
    stubFetch(() =>
      apiJson(422, { errors: { payment_method: ["Prosze wybrac sposob platnosci."] } }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    await expect(client.createInvoiceAsync({ services: [] })).rejects.toMatchObject({
      httpStatus: 422,
      message: "payment_method: Prosze wybrac sposob platnosci.",
      name: "InfaktApiError",
    });
  });

  it("caps a multi-field validation message at three fields", async () => {
    stubFetch(() =>
      apiJson(422, {
        errors: { a: ["1"], b: ["2"], c: ["3"], d: ["4"] },
      }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    await expect(client.createInvoiceAsync({ services: [] })).rejects.toMatchObject({
      message: "a: 1; b: 2; c: 3",
    });
  });

  it("falls back to a status message for non-JSON error bodies", async () => {
    stubFetch(
      () =>
        new Response("Service Unavailable", {
          headers: { "content-type": "text/plain" },
          status: 503,
          statusText: "Service Unavailable",
        }),
    );
    const client = new InfaktClient({ apiKey: "KEY" });
    await expect(client.getInvoice("u-1")).rejects.toMatchObject({
      httpStatus: 503,
      message: "inFakt HTTP 503 Service Unavailable",
    });
  });

  it("wraps network failures in InfaktApiError with httpStatus 0", async () => {
    stubFetch(() => Promise.reject(new Error("socket hang up")));
    const client = new InfaktClient({ apiKey: "KEY" });
    await expect(client.getInvoice("u-1")).rejects.toMatchObject({
      httpStatus: 0,
      message: "inFakt request failed: socket hang up",
    });
  });

  it("aborts a request that outlives timeoutMs", async () => {
    stubFetch(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("The operation was aborted")),
          );
        }),
    );
    const client = new InfaktClient({ apiKey: "KEY", timeoutMs: 5 });
    await expect(client.getInvoice("u-1")).rejects.toMatchObject({ httpStatus: 0 });
  });
});
