import { describe, expect, it } from "vitest";
import { awaitingKsefStatus, classifyInfaktWebhook, ksefWebhookNudge } from "./ksef-webhook";
import type { InvoiceStateRow } from "./state-machine";

/** inFakt's documented `send_to_ksef_error` payload, verbatim. */
const ERROR_PAYLOAD = {
  event: {
    created_at: "2023-10-02T11:30:30.656+02:00",
    name: "send_to_ksef_error",
    retry_counter: 0,
    uuid: "432cc5fc-f7ca-4afa-9420-7d6410fc0940",
  },
  resource: {
    invoice_kind: "vat",
    invoice_uuid: "ee2484ce-052c-495a-9ce1-5bd3ae8314aa",
    ksef_number: null,
    request_uuid: "22e55c83-b43c-4de8-bd5f-914e8669b562",
    status: "error",
    status_description: "Wystapil problem podczas otwarcia sesji.",
    timestamps: {
      request_created_at: "2023-10-02 11:30:30 +0200",
      request_finished_at: "2023-10-02 11:30:30 +0200",
    },
  },
};

/** A row sitting exactly on the `poll-ksef` step. */
const pollingRow = (overrides: Partial<InvoiceStateRow> = {}): InvoiceStateRow => ({
  attempts: 0,
  invoice_number: "FV/2026/09/1",
  invoice_uuid: "ee2484ce-052c-495a-9ce1-5bd3ae8314aa",
  ksef_required: true,
  ksef_sent_at: new Date("2026-09-03T10:00:00Z"),
  status: "processing",
  ...overrides,
});

describe("classifyInfaktWebhook", () => {
  it("recognises the activation handshake before anything else", () => {
    expect(classifyInfaktWebhook({ verification_code: "3e18cd8c" })).toEqual({
      kind: "verification",
      verificationCode: "3e18cd8c",
    });
  });

  it("reads the invoice uuid out of inFakt's documented error payload", () => {
    expect(classifyInfaktWebhook(ERROR_PAYLOAD)).toEqual({
      event: "send_to_ksef_error",
      eventUuid: "432cc5fc-f7ca-4afa-9420-7d6410fc0940",
      invoiceUuid: "ee2484ce-052c-495a-9ce1-5bd3ae8314aa",
      kind: "ksef",
    });
  });

  it("accepts a success event the same way", () => {
    const result = classifyInfaktWebhook({
      event: { name: "send_to_ksef_success", uuid: "e-1" },
      resource: { invoice_uuid: "inv-1", ksef_number: "7343521162-20231004-47A70D8BD670-57" },
    });
    expect(result).toMatchObject({ event: "send_to_ksef_success", invoiceUuid: "inv-1" });
  });

  it("falls back to `resource.uuid`, which is all the redacted webhook mode sends", () => {
    const result = classifyInfaktWebhook({
      event: { name: "send_to_ksef_success", uuid: "e-2" },
      resource: { uuid: "inv-2" },
    });
    expect(result).toMatchObject({ invoiceUuid: "inv-2", kind: "ksef" });
  });

  it("carries nothing from the payload except the identifier - no status, no ksef number", () => {
    const result = classifyInfaktWebhook(ERROR_PAYLOAD);
    expect(Object.keys(result).sort()).toEqual(["event", "eventUuid", "invoiceUuid", "kind"]);
  });

  it("ignores every other event in inFakt's table rather than erroring on it", () => {
    for (const name of ["invoice_paid", "draft_invoice_created", "async_invoice_creation_success"]) {
      expect(classifyInfaktWebhook({ event: { name }, resource: { uuid: "x" } })).toMatchObject({
        kind: "ignored",
      });
    }
  });

  it("ignores a body that is not an object, carries no event, or names no invoice", () => {
    expect(classifyInfaktWebhook(null)).toMatchObject({ kind: "ignored" });
    expect(classifyInfaktWebhook("nope")).toMatchObject({ kind: "ignored" });
    expect(classifyInfaktWebhook([ERROR_PAYLOAD])).toMatchObject({ kind: "ignored" });
    expect(classifyInfaktWebhook({ event: {} })).toMatchObject({ kind: "ignored" });
    expect(
      classifyInfaktWebhook({ event: { name: "send_to_ksef_success" }, resource: {} }),
    ).toMatchObject({ kind: "ignored" });
  });
});

describe("awaitingKsefStatus", () => {
  it("is true for a row whose next step is the KSeF poll", () => {
    expect(awaitingKsefStatus(pollingRow(), true)).toBe(true);
  });

  it("is false once the KSeF number has landed - the duplicate-delivery case", () => {
    expect(awaitingKsefStatus(pollingRow({ ksef_number: "7343-2026-ABC" }), true)).toBe(false);
  });

  it("is false for every terminal status, so a webhook can never restart a parked row", () => {
    for (const status of ["done", "skipped", "needs_review"] as const) {
      expect(awaitingKsefStatus(pollingRow({ status }), true)).toBe(false);
    }
  });

  it("is false before the invoice has been submitted to KSeF", () => {
    expect(awaitingKsefStatus(pollingRow({ ksef_sent_at: null }), true)).toBe(false);
  });

  it("is false for a consumer invoice, which is never filed", () => {
    expect(awaitingKsefStatus(pollingRow({ ksef_required: false }), true)).toBe(false);
  });

  it("is false for a row still waiting on its invoice number", () => {
    expect(awaitingKsefStatus(pollingRow({ invoice_number: null }), true)).toBe(false);
  });
});

describe("ksefWebhookNudge", () => {
  it("clears a defer's `next_attempt_at`, which is what makes the row due now", () => {
    expect(ksefWebhookNudge(pollingRow({ next_attempt_at: new Date() }))).toEqual({
      next_attempt_at: null,
    });
  });

  it("writes nothing when the row is already due", () => {
    expect(ksefWebhookNudge(pollingRow())).toBeNull();
  });

  it("touches nothing else - not attempts, not the status, not the error", () => {
    const patch = ksefWebhookNudge(pollingRow({ attempts: 3, next_attempt_at: new Date() }));
    expect(Object.keys(patch ?? {})).toEqual(["next_attempt_at"]);
  });
});
