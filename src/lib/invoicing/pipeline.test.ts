import { describe, expect, it, vi } from "vitest";
import { InfaktApiError } from "../infakt/errors";
import { ADDRESS_INCOMPLETE_PREFIX } from "./builder";
import { resolveInfaktOptions } from "../options";
import type { InfaktPluginOptions } from "../options";
import { processInvoiceRow } from "./pipeline";
import type { InvoiceRow, PipelineDeps } from "./pipeline";
import { classifyOutcome, CRASH_WINDOW_MESSAGE, PipelineSignal } from "./state-machine";

const VALID_NIP = "5261040828";

const options = (overrides: Partial<InfaktPluginOptions> = {}) =>
  resolveInfaktOptions({ apiKey: "k", startDate: "2026-07-01", ...overrides });

const medusaOrder = (overrides: Record<string, unknown> = {}) => ({
  billing_address: {
    address_1: "Prosta 1",
    city: "Warszawa",
    country_code: "PL",
    first_name: "Jan",
    last_name: "Kowalski",
    postal_code: "00-001",
  },
  created_at: "2026-07-14T10:00:00Z",
  currency_code: "PLN",
  email: "jan@example.com",
  id: "order_01",
  items: [{ product_title: "Antywirus", quantity: 1, total: 123.45 }],
  payment_collections: [{ captured_amount: 123.45, status: "completed" }],
  shipping_methods: [],
  status: "pending",
  total: 123.45,
  ...overrides,
});

const row = (overrides: Partial<InvoiceRow> = {}): InvoiceRow => ({
  attempts: 0,
  id: "inv_01",
  order_id: "order_01",
  status: "pending",
  ...overrides,
});

interface Harness {
  deps: PipelineDeps;
  updates: Record<string, unknown>[];
  emitted: unknown[];
  client: Record<string, ReturnType<typeof vi.fn>>;
}

const harness = (config?: {
  order?: Record<string, unknown> | null;
  options?: Partial<InfaktPluginOptions>;
  client?: Record<string, unknown>;
  emitIssued?: () => Promise<void>;
  listIssuedNumbers?: () => Promise<{ orderId: string; invoiceNumber: string | null }[]>;
  listEuB2cSales?: () => Promise<{ baseMinor: number; currency: string; date: string }[]>;
  raiseAlert?: (message: string) => Promise<void>;
}): Harness => {
  const updates: Record<string, unknown>[] = [];
  const emitted: unknown[] = [];
  const client = {
    createInvoiceAsync: vi
      .fn()
      .mockResolvedValue({ invoiceTaskReferenceNumber: "ref-1", processingCode: 100 }),
    getInvoice: vi.fn().mockResolvedValue({ number: "1/07/2026", status: "paid", uuid: "u-1" }),
    getInvoiceTaskStatus: vi
      .fn()
      .mockResolvedValue({ done: true, failed: false, invoiceUuid: "u-1", processingCode: 201 }),
    getKsefStatus: vi.fn().mockResolvedValue({ ksefNumber: "K-1", status: "success" }),
    createOssInvoiceAsync: vi
      .fn()
      .mockResolvedValue({ invoiceTaskReferenceNumber: "ref-oss", processingCode: 100 }),
    listMossRates: vi.fn().mockResolvedValue([{ country: "DE", id: 9, reduced: false, value: 19 }]),
    markPaid: vi.fn().mockResolvedValue(null),
    sendInvoiceEmail: vi.fn().mockResolvedValue(null),
    sendToKsef: vi.fn().mockResolvedValue(null),
    ...config?.client,
  } as unknown as Record<string, ReturnType<typeof vi.fn>>;

  const orderData = config?.order === null ? null : (config?.order ?? medusaOrder());

  return {
    client,
    deps: {
      client: client as never,
      emitIssued:
        config?.emitIssued ??
        ((payload) => {
          emitted.push(payload);
          return Promise.resolve();
        }),
      listEuB2cSales: config?.listEuB2cSales ?? (() => Promise.resolve([])),
      listIssuedNumbers: config?.listIssuedNumbers ?? (() => Promise.resolve([])),
      logger: { warn: vi.fn() },
      options: options(config?.options),
      raiseAlert: config?.raiseAlert,
      readOrder: () => Promise.resolve(orderData),
      sleep: () => Promise.resolve(),
      update: (id, patch) => {
        updates.push({ id, ...patch });
        return Promise.resolve();
      },
    },
    emitted,
    updates,
  };
};

const signal = async (promise: Promise<unknown>): Promise<PipelineSignal> => {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PipelineSignal) {
      return error;
    }
    throw error;
  }
  throw new Error("expected the pipeline to throw a signal");
};

describe("processInvoiceRow: the happy path", () => {
  it("drives a consumer order to done in one pass", async () => {
    const { client, deps, updates } = harness();
    const target = row();
    await processInvoiceRow(target, deps);

    expect(target.status).toBe("done");
    expect(target.invoice_uuid).toBe("u-1");
    expect(target.invoice_number).toBe("1/07/2026");
    expect(client.createInvoiceAsync).toHaveBeenCalledTimes(1);
    // A consumer invoice is outside KSeF.
    expect(client.sendToKsef).not.toHaveBeenCalled();
    expect(target.ksef_required).toBe(false);
    expect(updates.at(-1)).toMatchObject({ status: "done" });
  });

  it("files a company order to KSeF and records the number", async () => {
    const { client, deps } = harness({
      order: medusaOrder({
        billing_address: {
          address_1: "Rynek 5",
          city: "Krakow",
          company: "ACME Sp. z o.o.",
          country_code: "PL",
          postal_code: "31-042",
        },
        metadata: { nip: VALID_NIP },
      }),
    });
    const target = row();
    await processInvoiceRow(target, deps);

    expect(target.is_company).toBe(true);
    expect(target.ksef_required).toBe(true);
    expect(target.ksef_number).toBe("K-1");
    expect(target.ksef_status).toBe("success");
    expect(target.status).toBe("done");
    expect(client.sendToKsef).toHaveBeenCalledWith("u-1");
  });

  it("records the KSeF decision reason for the audit trail", async () => {
    const { deps } = harness();
    const target = row();
    await processInvoiceRow(target, deps);
    // "tax id" rather than "NIP": the same branch now also covers foreign buyers,
    // and a German VAT number must not be described in the audit trail as a NIP.
    expect(target.ksef_decision_reason).toContain("no tax id");
  });

  it("emits infakt.invoice.issued exactly once, with the PDF marker", async () => {
    const { deps, emitted } = harness();
    const target = row();
    await processInvoiceRow(target, deps);
    expect(emitted).toEqual([
      {
        invoice_number: "1/07/2026",
        invoice_uuid: "u-1",
        ksef_number: null,
        order_id: "order_01",
        pdf_available: true,
      },
    ]);
    expect(target.event_emitted_at).toBeInstanceOf(Date);
  });

  it("does not emit when emitIssuedEvent is off", async () => {
    const { deps, emitted } = harness({ options: { emitIssuedEvent: false } });
    const target = row();
    await processInvoiceRow(target, deps);
    expect(emitted).toEqual([]);
    expect(target.status).toBe("done");
  });

  it("never re-emits for a row that already emitted", async () => {
    const { deps, emitted } = harness();
    await processInvoiceRow(
      row({
        event_emitted_at: new Date(),
        invoice_number: "1/07/2026",
        invoice_uuid: "u-1",
        ksef_required: false,
        status: "processing",
      }),
      deps,
    );
    expect(emitted).toEqual([]);
  });

  it("completes the invoice even when the event bus is down", async () => {
    // The legal document already exists; a message-bus hiccup must not leave a
    // correctly-issued invoice looking broken.
    const { deps } = harness({ emitIssued: () => Promise.reject(new Error("bus down")) });
    const target = row();
    await processInvoiceRow(target, deps);
    expect(target.status).toBe("done");
    expect(target.event_emitted_at).toBeInstanceOf(Date);
  });

  it("marks the invoice paid in inFakt, best-effort", async () => {
    const { client, deps } = harness();
    await processInvoiceRow(row(), deps);
    expect(client.markPaid).toHaveBeenCalledWith(
      "u-1",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
    );
  });

  it("still completes when mark-paid fails", async () => {
    const { deps } = harness({
      client: {
        markPaid: vi
          .fn()
          .mockRejectedValue(new InfaktApiError({ httpStatus: 422, message: "already paid" })),
      },
    });
    const target = row();
    await processInvoiceRow(target, deps);
    expect(target.status).toBe("done");
  });

  it("moves a pending row to processing before doing any work", async () => {
    const { deps, updates } = harness();
    await processInvoiceRow(row(), deps);
    expect(updates[0]).toMatchObject({ status: "processing" });
  });
});

describe("processInvoiceRow: the crash window", () => {
  it("writes submit_started_at BEFORE calling inFakt", async () => {
    // The single ordering that makes the whole design safe. If the create is
    // POSTed first, a crash between the POST and the write leaves no evidence that
    // an invoice may exist, and the next tick issues a second one.
    const seen: string[] = [];
    const { deps } = harness({
      client: {
        createInvoiceAsync: vi.fn().mockImplementation(() => {
          seen.push("create");
          return Promise.resolve({ invoiceTaskReferenceNumber: "ref-1" });
        }),
      },
    });
    const original = deps.update;
    deps.update = (id, patch) => {
      if ("submit_started_at" in patch) {
        seen.push("submit_started_at");
      }
      if ("task_reference" in patch) {
        seen.push("task_reference");
      }
      return original(id, patch);
    };

    await processInvoiceRow(row(), deps);
    expect(seen).toEqual(["submit_started_at", "create", "task_reference"]);
  });

  it("refuses a row whose create may have gone through, and never re-POSTs", async () => {
    const { client, deps } = harness();
    const stuck = row({ status: "processing", submit_started_at: new Date() });
    const thrown = await signal(processInvoiceRow(stuck, deps));

    expect(thrown.kind).toBe("review");
    expect(thrown.message).toBe(CRASH_WINDOW_MESSAGE);
    expect(client.createInvoiceAsync).not.toHaveBeenCalled();
  });

  it("classifies that refusal as needs_review, not as a retry", async () => {
    const { deps } = harness();
    const stuck = row({ status: "processing", submit_started_at: new Date() });
    const thrown = await signal(processInvoiceRow(stuck, deps));
    expect(classifyOutcome(thrown, stuck).kind).toBe("review");
  });

  it("resumes normally when the task reference did land", async () => {
    const { client, deps } = harness();
    const resumed = row({
      status: "processing",
      submit_started_at: new Date(),
      task_reference: "ref-1",
    });
    await processInvoiceRow(resumed, deps);
    expect(client.createInvoiceAsync).not.toHaveBeenCalled();
    expect(client.getInvoiceTaskStatus).toHaveBeenCalledWith("ref-1");
    expect(resumed.status).toBe("done");
  });

  it("resumes from a known invoice uuid without touching the create at all", async () => {
    const { client, deps } = harness();
    const resumed = row({
      invoice_uuid: "u-1",
      ksef_required: false,
      status: "processing",
      submit_started_at: new Date(),
      task_reference: "ref-1",
    });
    await processInvoiceRow(resumed, deps);
    expect(client.createInvoiceAsync).not.toHaveBeenCalled();
    expect(client.getInvoiceTaskStatus).not.toHaveBeenCalled();
    expect(resumed.status).toBe("done");
  });

  it("resumes a company row mid-KSeF without re-submitting the document", async () => {
    const { client, deps } = harness();
    const resumed = row({
      invoice_number: "1/07/2026",
      invoice_uuid: "u-1",
      is_company: true,
      ksef_required: true,
      ksef_sent_at: new Date(),
      status: "processing",
    });
    await processInvoiceRow(resumed, deps);
    expect(client.sendToKsef).not.toHaveBeenCalled();
    expect(resumed.ksef_number).toBe("K-1");
  });
});

describe("processInvoiceRow: skips", () => {
  it("skips an order placed before the start date", async () => {
    const { deps } = harness({ order: medusaOrder({ created_at: "2026-06-30T10:00:00Z" }) });
    const thrown = await signal(processInvoiceRow(row(), deps));
    expect(thrown.kind).toBe("skip");
    expect(thrown.message).toContain("before the 2026-07-01 start date");
  });

  it("compares the start date as a Warsaw calendar day", async () => {
    // 2026-06-30T23:00Z is 2026-07-01 01:00 in Warsaw, so it is ON the start date.
    const { deps } = harness({ order: medusaOrder({ created_at: "2026-06-30T23:00:00Z" }) });
    const target = row();
    await processInvoiceRow(target, deps);
    expect(target.status).toBe("done");
  });

  it("skips an order in another currency", async () => {
    const { deps } = harness({ order: medusaOrder({ currency_code: "EUR" }) });
    const thrown = await signal(processInvoiceRow(row(), deps));
    expect(thrown.kind).toBe("skip");
    expect(thrown.message).toContain("EUR");
    expect(thrown.message).toContain("PLN only");
  });

  it("skips an order canceled before it was invoiced", async () => {
    const { deps } = harness({
      order: medusaOrder({ canceled_at: "2026-07-15T10:00:00Z", status: "canceled" }),
    });
    const thrown = await signal(processInvoiceRow(row(), deps));
    expect(thrown.kind).toBe("skip");
    expect(thrown.message).toContain("canceled before");
  });

  it("invoices an order placed long ago when no startDate floor is configured", async () => {
    // Absent startDate is "no floor", not "disabled" - an order from well before
    // any start date this store might configure elsewhere is still invoiced.
    const { deps } = harness({
      options: { startDate: undefined },
      order: medusaOrder({ created_at: "2020-01-01T10:00:00Z" }),
    });
    const target = row();
    await processInvoiceRow(target, deps);
    expect(target.status).toBe("done");
  });

  it("skips an order already invoiced outside the pipeline (backfilled history)", async () => {
    // Orders migrated from the legacy system carry their already-issued invoice
    // number in metadata - there was no Medusa payment behind them for
    // payment.captured to ever have fired on, so this is the only signal this
    // pipeline has to recognize one.
    const { client, deps } = harness({
      order: medusaOrder({ metadata: { invoice_number: "FV/123/2025", invoice_source: "legacy" } }),
    });
    const thrown = await signal(processInvoiceRow(row(), deps));
    expect(thrown.kind).toBe("skip");
    expect(thrown.message).toBe("already invoiced outside the pipeline");
    expect(client.createInvoiceAsync).not.toHaveBeenCalled();
  });

  it("ignores a blank or non-string invoice_number in metadata", async () => {
    const { deps } = harness({
      order: medusaOrder({ metadata: { invoice_number: "   " } }),
    });
    const target = row();
    await processInvoiceRow(target, deps);
    expect(target.status).toBe("done");
  });

  it("reviews rather than skips when a row already invoiced by this pipeline conflicts with a legacy invoice_number", async () => {
    const { deps } = harness({
      order: medusaOrder({ metadata: { invoice_number: "FV/123/2025" } }),
    });
    const thrown = await signal(
      processInvoiceRow(row({ invoice_uuid: "u-1", status: "processing" }), deps),
    );
    expect(thrown.kind).toBe("review");
    expect(thrown.message).toContain("legacy invoice_number");
  });
});

describe("processInvoiceRow: defers", () => {
  it("defers an order that is not fully paid, without burning an attempt", async () => {
    const { client, deps } = harness({
      order: medusaOrder({ payment_collections: [{ captured_amount: 50 }] }),
    });
    const target = row({ attempts: 3 });
    const thrown = await signal(processInvoiceRow(target, deps));

    expect(thrown.kind).toBe("defer");
    expect(thrown.message).toContain("not fully paid yet");
    expect(client.createInvoiceAsync).not.toHaveBeenCalled();
    expect(classifyOutcome(thrown, target).attempts).toBe(3);
  });

  it("defers while inFakt is still processing the create task", async () => {
    const { deps } = harness({
      client: {
        getInvoiceTaskStatus: vi
          .fn()
          .mockResolvedValue({ done: false, failed: false, processingCode: 140 }),
      },
    });
    const thrown = await signal(processInvoiceRow(row(), deps));
    expect(thrown.kind).toBe("defer");
    expect(thrown.message).toContain("still processing");
  });

  it("defers while inFakt has not assigned a number yet", async () => {
    const { deps } = harness({
      client: {
        getInvoice: vi.fn().mockResolvedValue({ uuid: "u-1" }),
        getInvoiceTaskStatus: vi.fn().mockResolvedValue({
          done: true,
          failed: false,
          invoiceUuid: "u-1",
          processingCode: 201,
        }),
      },
    });
    const thrown = await signal(processInvoiceRow(row(), deps));
    expect(thrown.kind).toBe("defer");
    expect(thrown.message).toContain("not assigned an invoice number");
  });

  it("defers while KSeF is still processing, recording the interim status", async () => {
    const { deps } = harness({
      client: { getKsefStatus: vi.fn().mockResolvedValue({ status: "sent" }) },
      order: medusaOrder({
        billing_address: {
          address_1: "Rynek 5",
          city: "Krakow",
          company: "ACME",
          postal_code: "31-042",
        },
        metadata: { nip: VALID_NIP },
      }),
    });
    const target = row();
    const thrown = await signal(processInvoiceRow(target, deps));
    expect(thrown.kind).toBe("defer");
    expect(target.ksef_status).toBe("sent");
    expect(target.ksef_number).toBeUndefined();
  });
});

describe("processInvoiceRow: reviews", () => {
  it("reviews a build failure, with a PII-free reason", async () => {
    // Fully paid, but the lines do not add up to what was paid - a discount or a
    // credit line the mapper does not model. A human has to look at it.
    const { deps } = harness({
      order: medusaOrder({ items: [{ product_title: "Antywirus", quantity: 1, total: 100 }] }),
    });
    const thrown = await signal(processInvoiceRow(row(), deps));
    expect(thrown.kind).toBe("review");
    expect(thrown.message).toContain("does not match order total");
    expect(thrown.message).not.toContain("Kowalski");
    expect(thrown.message).not.toContain("Prosta 1");
  });

  it("reviews an inFakt rejection of the create task", async () => {
    const { deps } = harness({
      client: {
        getInvoiceTaskStatus: vi.fn().mockResolvedValue({
          done: false,
          failed: true,
          processingCode: 422,
          processingDescription: "Nie udalo sie stworzyc faktury",
        }),
      },
    });
    const thrown = await signal(processInvoiceRow(row(), deps));
    expect(thrown.kind).toBe("review");
    expect(thrown.message).toContain("Nie udalo sie stworzyc faktury");
  });

  it("reviews a KSeF rejection", async () => {
    const { deps } = harness({
      client: {
        getKsefStatus: vi
          .fn()
          .mockResolvedValue({ status: "error", statusDescription: "Blad walidacji" }),
      },
      order: medusaOrder({
        billing_address: {
          address_1: "Rynek 5",
          city: "Krakow",
          company: "ACME",
          postal_code: "31-042",
        },
        metadata: { nip: VALID_NIP },
      }),
    });
    const target = row();
    const thrown = await signal(processInvoiceRow(target, deps));
    expect(thrown.kind).toBe("review");
    expect(thrown.message).toContain("Blad walidacji");
    expect(target.ksef_status).toBe("error");
  });

  it("reviews an order that vanished", async () => {
    const { deps } = harness({ order: null });
    const thrown = await signal(processInvoiceRow(row(), deps));
    expect(thrown.kind).toBe("review");
    expect(thrown.message).toContain("no longer exists");
  });

  it("reviews a cancellation that happened AFTER the invoice was issued", async () => {
    const { deps } = harness({
      order: medusaOrder({ canceled_at: "2026-07-16T10:00:00Z", status: "canceled" }),
    });
    const thrown = await signal(
      processInvoiceRow(row({ invoice_uuid: "u-1", status: "processing" }), deps),
    );
    expect(thrown.kind).toBe("review");
    expect(thrown.message).toContain("corrective invoice may be required");
  });

  it("reviews a payment reversed AFTER the invoice was issued, rather than deferring forever", async () => {
    const { deps } = harness({
      order: medusaOrder({
        payment_collections: [{ captured_amount: 123.45, refunded_amount: 123.45 }],
      }),
    });
    const thrown = await signal(
      processInvoiceRow(row({ invoice_uuid: "u-1", status: "processing" }), deps),
    );
    expect(thrown.kind).toBe("review");
    expect(thrown.message).toContain("no longer fully paid");
  });
});

describe("processInvoiceRow: the KSeF 422 ambiguity", () => {
  const companyOrder = medusaOrder({
    billing_address: {
      address_1: "Rynek 5",
      city: "Krakow",
      company: "ACME",
      postal_code: "31-042",
    },
    metadata: { nip: VALID_NIP },
  });

  it("treats a 422 with a readable status as already-sent and carries on", async () => {
    // A crash between the submit and persisting ksef_sent_at lands here. The status
    // endpoint is what disambiguates "already sent" from "no integration".
    const { deps } = harness({
      client: {
        getKsefStatus: vi.fn().mockResolvedValue({ ksefNumber: "K-1", status: "success" }),
        sendToKsef: vi
          .fn()
          .mockRejectedValue(new InfaktApiError({ httpStatus: 422, message: "already sent" })),
      },
      order: companyOrder,
    });
    const target = row();
    await processInvoiceRow(target, deps);
    expect(target.ksef_number).toBe("K-1");
    expect(target.status).toBe("done");
  });

  it("reviews a 422 whose status cannot be read - almost always an inactive integration", async () => {
    const { deps } = harness({
      client: {
        getKsefStatus: vi
          .fn()
          .mockRejectedValue(new InfaktApiError({ httpStatus: 404, message: "not found" })),
        sendToKsef: vi.fn().mockRejectedValue(
          new InfaktApiError({
            httpStatus: 422,
            message: "Uzytkownik nie jest zintegrowany z KSeF.",
          }),
        ),
      },
      order: companyOrder,
    });
    const thrown = await signal(processInvoiceRow(row(), deps));
    expect(thrown.kind).toBe("review");
    expect(thrown.message).toContain("is the KSeF integration active");
  });

  it("does not swallow a non-422 submit failure", async () => {
    const { deps } = harness({
      client: {
        sendToKsef: vi
          .fn()
          .mockRejectedValue(new InfaktApiError({ httpStatus: 503, message: "unavailable" })),
      },
      order: companyOrder,
    });
    await expect(processInvoiceRow(row(), deps)).rejects.toMatchObject({ httpStatus: 503 });
  });

  it("lets a 503 retry with backoff rather than parking the row", async () => {
    const target = row();
    const cause = new InfaktApiError({ httpStatus: 503, message: "unavailable" });
    expect(classifyOutcome(cause, target).kind).toBe("retry");
  });
});

describe("processInvoiceRow: KSeF mode", () => {
  const companyOrder = medusaOrder({
    billing_address: {
      address_1: "Rynek 5",
      city: "Krakow",
      company: "ACME",
      postal_code: "31-042",
    },
    metadata: { nip: VALID_NIP },
  });

  it("files a consumer invoice under mode all", async () => {
    const { client, deps } = harness({ options: { ksef: { mode: "all" } } });
    const target = row();
    await processInvoiceRow(target, deps);
    expect(target.ksef_required).toBe(true);
    expect(client.sendToKsef).toHaveBeenCalled();
  });

  it("files nothing under mode never, not even a company invoice", async () => {
    const { client, deps } = harness({
      options: { ksef: { mode: "never" } },
      order: companyOrder,
    });
    const target = row();
    await processInvoiceRow(target, deps);
    expect(target.is_company).toBe(true);
    expect(target.ksef_required).toBe(false);
    expect(client.sendToKsef).not.toHaveBeenCalled();
    expect(target.status).toBe("done");
  });

  it("honours a custom predicate over the mode", async () => {
    const { client, deps } = harness({
      options: { ksef: { decide: (input) => input.isCompany === false, mode: "never" } },
    });
    const target = row();
    await processInvoiceRow(target, deps);
    expect(target.ksef_required).toBe(true);
    expect(target.ksef_decision_reason).toContain("custom ksef.decide predicate");
    expect(client.sendToKsef).toHaveBeenCalled();
  });

  it("freezes the decision on the row, so a later config change cannot reclassify it", async () => {
    // Resuming a row reads ksef_required from the row, never from live config.
    const { client, deps } = harness({ options: { ksef: { mode: "all" } } });
    await processInvoiceRow(
      row({
        invoice_number: "1/07/2026",
        invoice_uuid: "u-1",
        ksef_required: false,
        status: "processing",
      }),
      deps,
    );
    expect(client.sendToKsef).not.toHaveBeenCalled();
  });
});

describe("processInvoiceRow: the NIP extractor option", () => {
  it("uses a custom extractor to find the buyer's NIP", async () => {
    const { deps } = harness({
      options: { nipExtractor: () => VALID_NIP },
      order: medusaOrder({
        billing_address: {
          address_1: "Rynek 5",
          city: "Krakow",
          company: "ACME",
          postal_code: "31-042",
        },
      }),
    });
    const target = row();
    await processInvoiceRow(target, deps);
    expect(target.is_company).toBe(true);
    expect(target.ksef_required).toBe(true);
  });

  it("reviews when the extractor returns a NIP but the order has no company name", async () => {
    const { deps } = harness({ options: { nipExtractor: () => VALID_NIP } });
    const thrown = await signal(processInvoiceRow(row(), deps));
    expect(thrown.kind).toBe("review");
    expect(thrown.message).toBe("buyer has a NIP but no company name");
  });
});

describe("the currency gate", () => {
  it("skips a foreign currency when cross-border is off", async () => {
    const { deps } = harness({ order: medusaOrder({ currency_code: "EUR" }) });
    const outcome = await signal(processInvoiceRow(row(), deps));
    expect(classifyOutcome(outcome, row()).kind).toBe("skipped");
    expect(outcome.message).toContain("PLN only");
  });

  it("still skips a currency that was not opted in", async () => {
    const { deps } = harness({
      options: { crossBorder: { currencies: ["EUR"], enabled: true } },
      order: medusaOrder({ currency_code: "USD" }),
    });
    const outcome = await signal(processInvoiceRow(row(), deps));
    expect(classifyOutcome(outcome, row()).kind).toBe("skipped");
    expect(outcome.message).toContain("PLN, EUR");
  });

  it("lets an opted-in currency through the gate", async () => {
    const { deps } = harness({
      options: { crossBorder: { currencies: ["EUR"], enabled: true } },
      order: medusaOrder({
        billing_address: {
          address_1: "Hauptstrasse 1",
          city: "Berlin",
          company: "ACME GmbH",
          country_code: "DE",
          first_name: "Anna",
          last_name: "Schmidt",
          postal_code: "10115",
        },
        currency_code: "EUR",
        items: [
          {
            metadata: { tax_supply: "service" },
            product_title: "Antywirus",
            quantity: 1,
            total: 123.45,
          },
        ],
        metadata: { nip: "DE123456789", vies: "valid" },
      }),
    });
    const target = row();
    await processInvoiceRow(target, deps);
    expect(target.status).toBe("done");
  });
});

describe("the cross-border path", () => {
  const deOrder = (overrides: Record<string, unknown> = {}) =>
    medusaOrder({
      billing_address: {
        address_1: "Hauptstrasse 1",
        city: "Berlin",
        company: "ACME GmbH",
        country_code: "DE",
        first_name: "Anna",
        last_name: "Schmidt",
        postal_code: "10115",
      },
      currency_code: "EUR",
      items: [
        {
          metadata: { tax_supply: "service" },
          product_title: "Antywirus",
          quantity: 1,
          total: 123.45,
        },
      ],
      metadata: { nip: "DE123456789", vies: "valid" },
      ...overrides,
    });

  const crossBorder = { crossBorder: { currencies: ["EUR"], enabled: true } };

  it("records the regime on the row so a resume cannot reinterpret it", async () => {
    const { deps, updates } = harness({ options: crossBorder, order: deOrder() });
    await processInvoiceRow(row(), deps);
    const submit = updates.find((update) => update.vat_regime !== undefined);
    expect(submit).toMatchObject({ vat_country: "DE", vat_regime: "reverse_charge" });
  });

  it("sends np lines and the reverse-charge annotation to inFakt", async () => {
    const { client, deps } = harness({ options: crossBorder, order: deOrder() });
    await processInvoiceRow(row(), deps);
    const payload = client.createInvoiceAsync.mock.calls[0]?.[0];
    expect(payload.services.every((s: { tax_symbol: string }) => s.tax_symbol === "np")).toBe(true);
    expect(payload.notes).toContain("Reverse charge");
    expect(payload.client_tax_code).toBe("DE123456789");
  });

  it("files a foreign business invoice to KSeF and also emails it", async () => {
    const { client, deps, updates } = harness({ options: crossBorder, order: deOrder() });
    await processInvoiceRow(row(), deps);
    expect(client.sendToKsef).toHaveBeenCalled();
    expect(client.sendInvoiceEmail).toHaveBeenCalledWith("u-1");
    expect(updates.some((u) => String(u.ksef_decision_reason ?? "").includes("foreign"))).toBe(true);
  });

  it("does not email a domestic invoice", async () => {
    const { client, deps } = harness();
    await processInvoiceRow(row(), deps);
    expect(client.sendInvoiceEmail).not.toHaveBeenCalled();
  });

  it("parks when VIES never confirmed the buyer", async () => {
    const { deps } = harness({
      options: crossBorder,
      order: deOrder({ metadata: { nip: "DE123456789" } }),
    });
    const outcome = await signal(processInvoiceRow(row(), deps));
    expect(classifyOutcome(outcome, row()).kind).toBe("review");
    expect(outcome.message).toContain("VIES");
  });

  it("parks an unclassified product rather than assuming it is a service", async () => {
    const { deps } = harness({
      options: crossBorder,
      order: deOrder({
        items: [{ product_title: "DJI Mini 5 Pro", quantity: 1, total: 123.45 }],
      }),
    });
    const outcome = await signal(processInvoiceRow(row(), deps));
    expect(classifyOutcome(outcome, row()).kind).toBe("review");
    expect(outcome.message).toContain("DJI Mini 5 Pro");
  });

  it("charges an EU consumer the Polish rate while below the threshold", async () => {
    // Not registered for OSS and well under the limit: the place of supply stays
    // in Poland under art. 28k ust. 2, so 23% is correct BECAUSE of the threshold.
    const { client, deps, updates } = harness({
      options: crossBorder,
      order: deOrder({ metadata: {} }),
    });
    const target = row();
    await processInvoiceRow(target, deps);

    expect(target.status).toBe("done");
    const payload = client.createInvoiceAsync.mock.calls[0]?.[0];
    expect(payload.services.every((s: { tax_symbol: string }) => s.tax_symbol === "23")).toBe(true);
    expect(payload.notes).toBeUndefined();
    expect(client.createOssInvoiceAsync).not.toHaveBeenCalled();
    expect(updates.find((u) => u.vat_regime !== undefined)).toMatchObject({
      vat_country: "DE",
      vat_currency: "EUR",
      vat_regime: "eu_b2c_domestic_rate",
    });
  });

  it("records the taxable base so the threshold counter can be audited", async () => {
    const { deps, updates } = harness({
      options: crossBorder,
      order: deOrder({ metadata: {} }),
    });
    await processInvoiceRow(row(), deps);
    expect(updates.find((u) => u.vat_regime !== undefined)?.vat_base_minor).toBe(12_345);
  });

  it("parks an EU consumer once the threshold is crossed and OSS is not registered", async () => {
    const { deps } = harness({
      listEuB2cSales: () =>
        Promise.resolve([{ baseMinor: 999_000, currency: "EUR", date: "2026-07-01" }]),
      options: crossBorder,
      order: deOrder({ metadata: {} }),
    });
    const outcome = await signal(processInvoiceRow(row(), deps));
    expect(classifyOutcome(outcome, row()).kind).toBe("review");
    expect(outcome.message).toContain("threshold");
    expect(outcome.message).toContain("not registered for OSS");
  });

  it("raises an early alert before the threshold is reached", async () => {
    const alerts: string[] = [];
    const { deps } = harness({
      listEuB2cSales: () =>
        Promise.resolve([{ baseMinor: 850_000, currency: "EUR", date: "2026-07-01" }]),
      options: crossBorder,
      order: deOrder({ metadata: {} }),
      raiseAlert: (message) => {
        alerts.push(message);
        return Promise.resolve();
      },
    });
    const target = row();
    await processInvoiceRow(target, deps);
    // The sale still goes through - the alert exists to buy time, not to block.
    expect(target.status).toBe("done");
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("OSS threshold");
  });

  it("uses the destination rate once OSS registration is in place", async () => {
    const { client, deps } = harness({
      options: {
        crossBorder: { currencies: ["EUR"], enabled: true },
        oss: { enabled: true, registered: true },
      },
      order: deOrder({
        items: [
          {
            metadata: { tax_supply: "service" },
            product_title: "Antywirus",
            quantity: 1,
            total: 123.45,
          },
        ],
        metadata: {},
        tax_total: 19.71,
      }),
    });
    const target = row();
    await processInvoiceRow(target, deps);
    expect(client.createOssInvoiceAsync).toHaveBeenCalledTimes(1);
    expect(client.createInvoiceAsync).not.toHaveBeenCalled();
    const payload = client.createOssInvoiceAsync.mock.calls[0]?.[0];
    expect(payload.country).toBe("DE");
    expect(payload.services.every((s: { tax_rate: string }) => s.tax_rate === "19")).toBe(true);
    expect(target.status).toBe("done");
  });

  it("parks an OSS sale when checkout did not charge the destination rate", async () => {
    const { deps } = harness({
      options: {
        crossBorder: { currencies: ["EUR"], enabled: true },
        oss: { enabled: true, registered: true },
      },
      order: deOrder({ metadata: {}, tax_total: 0 }),
    });
    const outcome = await signal(processInvoiceRow(row(), deps));
    expect(classifyOutcome(outcome, row()).kind).toBe("review");
    expect(outcome.message).toContain("no VAT");
  });

  it("parks a UK consumer instead of inventing a treatment", async () => {
    const { deps } = harness({
      options: crossBorder,
      order: deOrder({
        billing_address: {
          address_1: "High Street 1",
          city: "London",
          country_code: "GB",
          first_name: "John",
          last_name: "Smith",
          postal_code: "SW1A 1AA",
        },
        metadata: {},
      }),
    });
    const outcome = await signal(processInvoiceRow(row(), deps));
    expect(classifyOutcome(outcome, row()).kind).toBe("review");
    expect(outcome.message).toContain("GB");
  });
});

describe("the invoice-number collision guard", () => {
  it("parks rather than announcing a number another order already holds", async () => {
    const { deps, emitted } = harness({
      listIssuedNumbers: () =>
        Promise.resolve([{ invoiceNumber: "1/07/2026", orderId: "order_other" }]),
    });
    const outcome = await signal(processInvoiceRow(row(), deps));
    expect(classifyOutcome(outcome, row()).kind).toBe("review");
    expect(outcome.message).toContain("order_other");
    expect(outcome.message).toContain("license");
    // The whole point: nothing downstream ever hears about this invoice.
    expect(emitted).toHaveLength(0);
  });

  it("announces normally when the number is unique", async () => {
    const { deps, emitted } = harness({
      listIssuedNumbers: () =>
        Promise.resolve([{ invoiceNumber: "9/07/2026", orderId: "order_other" }]),
    });
    await processInvoiceRow(row(), deps);
    expect(emitted).toHaveLength(1);
  });

  it("ignores the row's own number on a resume", async () => {
    const { deps, emitted } = harness({
      listIssuedNumbers: () =>
        Promise.resolve([{ invoiceNumber: "1/07/2026", orderId: "order_01" }]),
    });
    await processInvoiceRow(row(), deps);
    expect(emitted).toHaveLength(1);
  });
});

/**
 * The paid marking, and why "we called it" is not "it happened".
 *
 * inFakt's paid endpoint is asynchronous and the `status` it writes is a single
 * last-write-wins enum, so the marking has to be read back rather than assumed.
 * Production invoice 2/09/2026 is the case these pin: marked at 12:40:03 UTC,
 * and still `status: "sent"` afterwards.
 */
describe("processInvoiceRow: confirming the paid marking", () => {
  const issuedRow = (overrides: Partial<InvoiceRow> = {}): InvoiceRow =>
    row({
      event_emitted_at: new Date("2026-09-02T12:40:00Z"),
      invoice_number: "1/07/2026",
      invoice_uuid: "u-1",
      ksef_required: false,
      status: "processing",
      ...overrides,
    });

  it("marks the invoice paid and confirms it on the first read-back", async () => {
    const { client, deps } = harness();
    const target = row();
    await processInvoiceRow(target, deps);

    expect(client.markPaid).toHaveBeenCalledWith(
      "u-1",
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/u),
    );
    // No amount field is sent, and `allow_correction` is deliberately never set:
    // booking an accounting correction is the account owner's decision.
    expect(client.markPaid).toHaveBeenCalledTimes(1);
    expect(target.paid_marked_at).toBeInstanceOf(Date);
    expect(target.paid_confirmed_at).toBeInstanceOf(Date);
    expect(target.status).toBe("done");
  });

  it("completes the row even when inFakt still reports the invoice as sent", async () => {
    const { deps } = harness({
      client: { getInvoice: vi.fn().mockResolvedValue({ number: "1/07/2026", status: "sent" }) },
    });
    const target = row();

    // The regression this guards: an inconclusive read-back must not hold an
    // issued, KSeF-filed invoice out of `done`. Payment state is bookkeeping
    // inside inFakt, not part of the legal document.
    await processInvoiceRow(target, deps);

    expect(target.status).toBe("done");
    expect(target.completed_at).toBeInstanceOf(Date);
    expect(target.paid_marked_at).toBeInstanceOf(Date);
    expect(target.paid_confirmed_at).toBeUndefined();
    // The document itself is finished - only the bookkeeping is outstanding.
    expect(target.invoice_number).toBe("1/07/2026");
    expect(target.event_emitted_at).toBeInstanceOf(Date);
  });

  it("marks the invoice paid exactly once, never on a later pass", async () => {
    const client = {
      getInvoice: vi.fn().mockResolvedValue({ number: "1/07/2026", status: "printed" }),
    };
    const { deps } = harness({ client });
    const target = issuedRow();

    // "printed" is what a real PDF download leaves behind, and inFakt's status
    // is a single last-write-wins enum - so re-marking could never win that
    // race. It is sent once, read back once, and the row completes.
    await processInvoiceRow(target, deps);
    expect(target.status).toBe("done");
    expect(target.paid_confirmed_at).toBeUndefined();

    // A second visit to the same row - a re-run, a resumed worker - must not
    // send a second marking.
    await processInvoiceRow(target, deps);

    expect(deps.client.markPaid).toHaveBeenCalledTimes(1);
    expect(target.status).toBe("done");
  });

  it("completes the row with a warning once the confirmation budget is spent", async () => {
    const { deps } = harness({
      client: { getInvoice: vi.fn().mockResolvedValue({ number: "1/07/2026", status: "sent" }) },
    });
    const target = issuedRow({ paid_marked_at: new Date(Date.now() - 60 * 60_000) });

    await processInvoiceRow(target, deps);

    expect(target.status).toBe("done");
    expect(target.paid_confirmed_at).toBeUndefined();
    // Past the window the row is not even re-marked - it just completes, loudly.
    expect(deps.client.markPaid).not.toHaveBeenCalled();
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("never read back as paid"));
  });

  it("still completes the issuance when the mark-paid call itself throws", async () => {
    const { deps } = harness({
      client: {
        getInvoice: vi.fn().mockResolvedValue({ number: "1/07/2026", status: "paid" }),
        markPaid: vi
          .fn()
          .mockRejectedValue(new InfaktApiError({ httpStatus: 500, message: "inFakt is down" })),
      },
    });
    const target = row();

    await processInvoiceRow(target, deps);

    expect(target.status).toBe("done");
    expect(target.invoice_uuid).toBe("u-1");
    // The attempt is still recorded, so the budget starts even when the call fails.
    expect(target.paid_marked_at).toBeInstanceOf(Date);
    expect(deps.logger.warn).toHaveBeenCalledWith(expect.stringContaining("mark-paid failed"));
  });

  it("never re-marks a row whose payment was already confirmed", async () => {
    // A human downloading the PDF flips the inFakt status to "printed". That must
    // not be read as a payment coming undone, so a confirmed row is never re-read.
    const { deps } = harness({
      client: { getInvoice: vi.fn().mockResolvedValue({ number: "1/07/2026", status: "printed" }) },
    });
    const target = issuedRow({
      paid_confirmed_at: new Date("2026-09-02T12:41:00Z"),
      paid_marked_at: new Date("2026-09-02T12:40:00Z"),
    });

    await processInvoiceRow(target, deps);

    expect(deps.client.markPaid).not.toHaveBeenCalled();
    expect(deps.client.getInvoice).not.toHaveBeenCalled();
    expect(target.status).toBe("done");
  });

  it("never marks an adopted invoice paid - it is not this pipeline's document", async () => {
    const { deps } = harness();
    const target = issuedRow({ adopted_at: new Date("2026-09-01T10:00:00Z") });

    await processInvoiceRow(target, deps);

    expect(deps.client.markPaid).not.toHaveBeenCalled();
    expect(target.status).toBe("done");
  });

  it("re-enters a row that already has an invoice without creating a second one", async () => {
    // The idempotency floor: whatever else changes, a row carrying an
    // `invoice_uuid` must never reach the create call again.
    const { client, deps } = harness();
    const target = issuedRow({ paid_marked_at: new Date(Date.now() - 60_000) });

    await processInvoiceRow(target, deps);

    expect(client.createInvoiceAsync).not.toHaveBeenCalled();
    expect(client.createOssInvoiceAsync).not.toHaveBeenCalled();
    expect(target.status).toBe("done");
  });
});

/**
 * Waiting for data is not a review.
 *
 * Production, order `order_01M1H1PA8BHJMKFPBZWA78F5XQ`:
 *
 *     12:36:24  queued order ... for invoicing (payment.captured)
 *     12:36:25  needs review: buyer address is incomplete (missing: street, city, postal_code)
 *     12:36:41  (the Allegro drain writes the real billing address - 16 s later)
 */
describe("processInvoiceRow: an address that has not arrived yet", () => {
  const addressless = () =>
    medusaOrder({
      billing_address: { country_code: "PL", first_name: "Jan", last_name: "Kowalski" },
      shipping_address: null,
    });

  it("defers rather than parking while the row is young", async () => {
    const { client, deps } = harness({ order: addressless() });
    const target = row({ created_at: new Date() });

    const thrown = await signal(processInvoiceRow(target, deps));

    expect(thrown.kind).toBe("defer");
    expect(thrown.message).toContain(ADDRESS_INCOMPLETE_PREFIX);
    // Nothing reached inFakt: the gate still runs before any call.
    expect(client.createInvoiceAsync).not.toHaveBeenCalled();
  });

  it("says what it is waiting for, and burns no attempt doing it", async () => {
    const { deps } = harness({ order: addressless() });
    const target = row({ attempts: 3, created_at: new Date() });

    const outcome = classifyOutcome(await signal(processInvoiceRow(target, deps)), target);

    expect(outcome.kind).toBe("deferred");
    expect(outcome.deferReason).toContain(ADDRESS_INCOMPLETE_PREFIX);
    // Defers do not count, which is exactly why the window is a wall clock.
    expect(outcome.attempts).toBe(3);
  });

  it("parks for a human once the grace window has passed", async () => {
    const { deps } = harness({ order: addressless() });
    const target = row({ created_at: new Date(Date.now() - 2 * 60 * 60_000) });

    const thrown = await signal(processInvoiceRow(target, deps));

    expect(thrown.kind).toBe("review");
    expect(thrown.message).toContain(ADDRESS_INCOMPLETE_PREFIX);
    expect(thrown.message).toContain("still has no address");
  });

  it("parks a row whose created_at cannot be read - the safe direction", async () => {
    const { deps } = harness({ order: addressless() });
    expect((await signal(processInvoiceRow(row(), deps))).kind).toBe("review");
  });

  it("still parks every other build refusal immediately, window or not", async () => {
    // The regression guard. Only the address reason is deferrable. A buyer the
    // builder refuses for any other reason is a human's decision, today and after
    // this change - inside the grace window exactly as outside it.
    const nipWithoutCompany = harness({
      order: medusaOrder({
        billing_address: {
          address_1: "Rynek 5",
          city: "Krakow",
          country_code: "PL",
          postal_code: "31-042",
        },
        metadata: { nip: VALID_NIP },
      }),
    });
    const parked = await signal(
      processInvoiceRow(row({ created_at: new Date() }), nipWithoutCompany.deps),
    );
    expect(parked.kind).toBe("review");
    expect(parked.message).toContain("NIP but no company name");

    const namelessConsumer = harness({
      order: medusaOrder({
        billing_address: {
          address_1: "Prosta 1",
          city: "Warszawa",
          country_code: "PL",
          postal_code: "00-001",
        },
      }),
    });
    const alsoParked = await signal(
      processInvoiceRow(row({ created_at: new Date() }), namelessConsumer.deps),
    );
    expect(alsoParked.kind).toBe("review");
    expect(alsoParked.message).toContain("buyer name is missing");
  });

  it("clears the wait the moment the row advances", async () => {
    const { deps, updates } = harness();
    await processInvoiceRow(row({ created_at: new Date(), defer_reason: "waiting" }), deps);
    // Written in the same patch that freezes the claim, before the create POST.
    expect(updates.some((patch) => patch.defer_reason === null)).toBe(true);
  });
});

/**
 * KSeF settles in about 90 seconds. Polling once and deferring meant an invoice
 * accepted at 12:41:27 was only recorded at 12:45:09 - the 2-minute defer really
 * waits for the next 5-minute cron boundary.
 */
describe("processInvoiceRow: riding KSeF to completion", () => {
  const companyOrder = () =>
    medusaOrder({
      billing_address: {
        address_1: "Rynek 5",
        city: "Krakow",
        company: "ACME Sp. z o.o.",
        country_code: "PL",
        postal_code: "31-042",
      },
      metadata: { nip: VALID_NIP },
    });

  it("keeps polling inside the same run until KSeF settles", async () => {
    const getKsefStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: "sent" })
      .mockResolvedValueOnce({ status: "sent" })
      .mockResolvedValue({ ksefNumber: "K-1", status: "success" });
    const { deps } = harness({ client: { getKsefStatus }, order: companyOrder() });
    const target = row();

    await processInvoiceRow(target, deps);

    expect(getKsefStatus).toHaveBeenCalledTimes(3);
    expect(target.ksef_number).toBe("K-1");
    expect(target.status).toBe("done");
  });

  it("persists every status it sees, so a crash mid-ride resumes from reality", async () => {
    const getKsefStatus = vi
      .fn()
      .mockResolvedValueOnce({ status: "sent" })
      .mockResolvedValue({ ksefNumber: "K-1", status: "success" });
    const { deps, updates } = harness({ client: { getKsefStatus }, order: companyOrder() });

    await processInvoiceRow(row(), deps);

    expect(updates.filter((patch) => patch.ksef_status === "sent")).toHaveLength(1);
  });

  it("falls back to a defer when it never settles, without burning an attempt", async () => {
    const { deps } = harness({
      client: { getKsefStatus: vi.fn().mockResolvedValue({ status: "sent" }) },
      order: companyOrder(),
    });
    const target = row({ attempts: 2 });

    const thrown = await signal(processInvoiceRow(target, deps));

    expect(thrown.kind).toBe("defer");
    expect(thrown.message).toContain("KSeF is still processing");
    expect(classifyOutcome(thrown, target).attempts).toBe(2);
    expect(target.ksef_status).toBe("sent");
  });

  it("stops riding at the run's shared deadline, so a batch cannot hold the claim", async () => {
    // One deadline for the whole run: twenty rows race it rather than each
    // spending its own budget while the single-flight claim is held.
    const { deps } = harness({
      client: { getKsefStatus: vi.fn().mockResolvedValue({ status: "sent" }) },
      order: companyOrder(),
    });
    deps.rideUntil = new Date(Date.now() - 1);

    expect((await signal(processInvoiceRow(row(), deps))).kind).toBe("defer");
    expect(deps.client.getKsefStatus).toHaveBeenCalledTimes(1);
  });

  it("parks immediately when KSeF rejects the document - a ride is not a retry", async () => {
    const { deps } = harness({
      client: {
        getKsefStatus: vi
          .fn()
          .mockResolvedValue({ status: "error", statusDescription: "invalid NIP" }),
      },
      order: companyOrder(),
    });

    const thrown = await signal(processInvoiceRow(row(), deps));
    expect(thrown.kind).toBe("review");
    expect(deps.client.getKsefStatus).toHaveBeenCalledTimes(1);
  });
});
