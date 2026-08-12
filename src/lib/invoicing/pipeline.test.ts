import { describe, expect, it, vi } from "vitest";
import { InfaktApiError } from "../infakt/errors";
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
}): Harness => {
  const updates: Record<string, unknown>[] = [];
  const emitted: unknown[] = [];
  const client = {
    createInvoiceAsync: vi
      .fn()
      .mockResolvedValue({ invoiceTaskReferenceNumber: "ref-1", processingCode: 100 }),
    getInvoice: vi.fn().mockResolvedValue({ number: "1/07/2026", uuid: "u-1" }),
    getInvoiceTaskStatus: vi
      .fn()
      .mockResolvedValue({ done: true, failed: false, invoiceUuid: "u-1", processingCode: 201 }),
    getKsefStatus: vi.fn().mockResolvedValue({ ksefNumber: "K-1", status: "success" }),
    markPaid: vi.fn().mockResolvedValue(null),
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
      logger: { warn: vi.fn() },
      options: options(config?.options),
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
    expect(target.ksef_decision_reason).toContain("no NIP");
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
