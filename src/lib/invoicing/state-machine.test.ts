import { describe, expect, it } from "vitest";
import { InfaktApiError } from "../infakt/errors";
import {
  BASE_RETRY_MS,
  backoffMs,
  classifyKsefStatus,
  classifyOutcome,
  deferSignal,
  MAX_ATTEMPTS,
  MAX_ERROR_LENGTH,
  MAX_RETRY_MS,
  nextStep,
  reviewSignal,
  skipSignal,
  truncateError,
  WAIT_RETRY_MS,
} from "./state-machine";
import type { InvoiceStateRow } from "./state-machine";

const row = (overrides: Partial<InvoiceStateRow> = {}): InvoiceStateRow => ({
  attempts: 0,
  status: "pending",
  ...overrides,
});

const apiError = (httpStatus: number, message = "boom"): InfaktApiError =>
  new InfaktApiError({ httpStatus, message });

describe("backoffMs", () => {
  it("doubles per attempt from a 10-minute first retry", () => {
    expect(backoffMs(1)).toBe(BASE_RETRY_MS * 2);
    expect(backoffMs(2)).toBe(BASE_RETRY_MS * 4);
    expect(backoffMs(3)).toBe(BASE_RETRY_MS * 8);
  });

  it("caps at six hours", () => {
    expect(backoffMs(10)).toBe(MAX_RETRY_MS);
    expect(backoffMs(1000)).toBe(MAX_RETRY_MS);
  });

  it("never exceeds the cap at any attempt within the budget", () => {
    for (let attempts = 1; attempts <= MAX_ATTEMPTS; attempts += 1) {
      expect(backoffMs(attempts)).toBeLessThanOrEqual(MAX_RETRY_MS);
    }
  });
});

describe("truncateError", () => {
  it("leaves a short message alone", () => {
    expect(truncateError("short")).toBe("short");
  });

  it("caps a long message and marks it as cut", () => {
    const truncated = truncateError("x".repeat(1000));
    expect(truncated).toHaveLength(MAX_ERROR_LENGTH + 3);
    expect(truncated.endsWith("...")).toBe(true);
  });
});

describe("classifyOutcome", () => {
  it("treats a skip signal as terminal without counting an attempt", () => {
    const outcome = classifyOutcome(skipSignal("order predates startDate"), row({ attempts: 3 }));
    expect(outcome).toMatchObject({
      attempts: 3,
      kind: "skipped",
      message: "order predates startDate",
    });
    expect(outcome.delayMs).toBeUndefined();
  });

  it("treats a defer signal as a re-check without counting an attempt", () => {
    const outcome = classifyOutcome(deferSignal("inFakt still processing"), row({ attempts: 5 }));
    expect(outcome).toMatchObject({ attempts: 5, delayMs: WAIT_RETRY_MS, kind: "deferred" });
  });

  it("honours a custom defer delay", () => {
    const outcome = classifyOutcome(deferSignal("not paid yet", 90_000), row());
    expect(outcome.delayMs).toBe(90_000);
  });

  it("never lets deferrals exhaust the retry budget", () => {
    // The property that matters: an order sitting unpaid for a week must still
    // have its full retry budget when it finally becomes payable.
    let current = row();
    for (let i = 0; i < 100; i += 1) {
      const outcome = classifyOutcome(deferSignal("still waiting"), current);
      current = row({ attempts: outcome.attempts });
    }
    expect(current.attempts).toBe(0);
  });

  it("sends a review signal straight to needs_review", () => {
    const outcome = classifyOutcome(reviewSignal("inFakt rejected the invoice"), row());
    expect(outcome).toMatchObject({ attempts: 1, kind: "review" });
    expect(outcome.delayMs).toBeUndefined();
  });

  it("retries an unknown error with backoff", () => {
    const outcome = classifyOutcome(new Error("ECONNRESET"), row({ attempts: 2 }));
    expect(outcome).toMatchObject({ attempts: 3, delayMs: backoffMs(3), kind: "retry" });
  });

  it("retries a network failure (httpStatus 0)", () => {
    expect(classifyOutcome(apiError(0), row()).kind).toBe("retry");
  });

  it("retries a rate limit and a server error", () => {
    for (const status of [429, 500, 502, 503, 504]) {
      expect(classifyOutcome(apiError(status), row()).kind).toBe("retry");
    }
  });

  it("sends the non-retryable statuses to needs_review immediately", () => {
    for (const status of [400, 403, 404, 405, 409, 422]) {
      expect(classifyOutcome(apiError(status), row()).kind).toBe("review");
    }
  });

  it("gives up and reviews once the attempt budget is exhausted", () => {
    const outcome = classifyOutcome(new Error("transient"), row({ attempts: MAX_ATTEMPTS - 1 }));
    expect(outcome).toMatchObject({ attempts: MAX_ATTEMPTS, kind: "review" });
  });

  it("still retries on the attempt just before the budget runs out", () => {
    const outcome = classifyOutcome(new Error("transient"), row({ attempts: MAX_ATTEMPTS - 2 }));
    expect(outcome.kind).toBe("retry");
  });

  it("truncates the persisted message", () => {
    const outcome = classifyOutcome(new Error("y".repeat(500)), row());
    expect(outcome.message).toHaveLength(MAX_ERROR_LENGTH + 3);
  });

  it("stringifies a non-Error throw rather than losing it", () => {
    expect(classifyOutcome("just a string", row()).message).toBe("just a string");
  });
});

describe("nextStep", () => {
  const options = { emitEvent: true };

  it("starts by submitting the create", () => {
    expect(nextStep(row(), options)).toEqual({ step: "submit-create" });
  });

  it("resolves an outstanding task when a reference was stored", () => {
    expect(nextStep(row({ task_reference: "ref-1" }), options)).toEqual({
      step: "resolve-create-task",
    });
  });

  it("flags the crash window: submit started, no task reference, no invoice", () => {
    // This is the core safety property. A row in this state may already have a
    // real invoice in inFakt, and inFakt has no idempotency key, so re-POSTing
    // would issue a second numbered document.
    expect(nextStep(row({ submit_started_at: new Date() }), options)).toEqual({
      crashWindow: true,
      step: "submit-create",
    });
  });

  it("does not flag the crash window once a task reference exists", () => {
    const result = nextStep(
      row({ submit_started_at: new Date(), task_reference: "ref-1" }),
      options,
    );
    expect(result.crashWindow).toBeUndefined();
    expect(result.step).toBe("resolve-create-task");
  });

  it("does not flag the crash window once the invoice uuid is known", () => {
    const result = nextStep(
      row({ invoice_number: "1/2026", invoice_uuid: "u-1", submit_started_at: new Date() }),
      { emitEvent: false },
    );
    expect(result.crashWindow).toBeUndefined();
  });

  it("fetches the invoice number when the uuid is known but the number is not", () => {
    expect(nextStep(row({ invoice_uuid: "u-1" }), options)).toEqual({
      step: "fetch-invoice-number",
    });
  });

  it("sends to KSeF when required and not yet sent", () => {
    expect(
      nextStep(
        row({ invoice_number: "1/2026", invoice_uuid: "u-1", ksef_required: true }),
        options,
      ),
    ).toEqual({ step: "send-to-ksef" });
  });

  it("polls KSeF once sent but with no number yet", () => {
    expect(
      nextStep(
        row({
          invoice_number: "1/2026",
          invoice_uuid: "u-1",
          ksef_required: true,
          ksef_sent_at: new Date(),
        }),
        options,
      ),
    ).toEqual({ step: "poll-ksef" });
  });

  it("skips KSeF entirely when it is not required", () => {
    expect(
      nextStep(
        row({ invoice_number: "1/2026", invoice_uuid: "u-1", ksef_required: false }),
        options,
      ),
    ).toEqual({ step: "emit-event" });
  });

  it("emits the event before completing, once", () => {
    const pending = row({
      invoice_number: "1/2026",
      invoice_uuid: "u-1",
      ksef_number: "K-1",
      ksef_required: true,
    });
    expect(nextStep(pending, options)).toEqual({ step: "emit-event" });
    expect(nextStep({ ...pending, event_emitted_at: new Date() }, options)).toEqual({
      step: "complete",
    });
  });

  it("goes straight to complete when event emission is disabled", () => {
    expect(
      nextStep(row({ invoice_number: "1/2026", invoice_uuid: "u-1" }), { emitEvent: false }),
    ).toEqual({ step: "complete" });
  });

  it("walks a company order through the full sequence, one step per call", () => {
    let current = row();
    const seen: string[] = [];
    const advance: Record<string, Partial<InvoiceStateRow>> = {
      "emit-event": { event_emitted_at: new Date() },
      "fetch-invoice-number": { invoice_number: "1/07/2026" },
      "poll-ksef": { ksef_number: "K-1", ksef_status: "success" },
      "resolve-create-task": { invoice_uuid: "u-1", ksef_required: true },
      "send-to-ksef": { ksef_sent_at: new Date() },
      "submit-create": { submit_started_at: new Date(), task_reference: "ref-1" },
    };
    for (let i = 0; i < 10; i += 1) {
      const { step } = nextStep(current, { emitEvent: true });
      seen.push(step);
      if (step === "complete") {
        break;
      }
      current = { ...current, ...advance[step] };
    }
    expect(seen).toEqual([
      "submit-create",
      "resolve-create-task",
      "fetch-invoice-number",
      "send-to-ksef",
      "poll-ksef",
      "emit-event",
      "complete",
    ]);
  });
});

describe("classifyKsefStatus", () => {
  it("reports success only with a KSeF number", () => {
    expect(classifyKsefStatus({ ksefNumber: "K-1", status: "success" })).toEqual({
      kind: "done",
      ksefNumber: "K-1",
    });
    // "success" with no number is not a filing we can record; keep waiting.
    expect(classifyKsefStatus({ status: "success" })).toEqual({ kind: "pending" });
  });

  it("reports an error with the KSeF description", () => {
    expect(
      classifyKsefStatus({ status: "error", statusDescription: "Blad walidacji XML" }),
    ).toEqual({ kind: "error", message: expect.stringContaining("Blad walidacji XML") });
  });

  it("names the missing description rather than saying undefined", () => {
    const result = classifyKsefStatus({ status: "error" });
    expect(result).toMatchObject({ kind: "error" });
    if (result.kind === "error") {
      expect(result.message).toContain("no description given");
    }
  });

  it("treats sent as pending", () => {
    expect(classifyKsefStatus({ status: "sent" })).toEqual({ kind: "pending" });
  });

  it("treats an unknown status as pending, not as an error", () => {
    // inFakt adding a new intermediate state must not park every B2B invoice in
    // needs_review; a genuinely stuck row still lands there via MAX_ATTEMPTS.
    expect(classifyKsefStatus({ status: "queued_for_retry" })).toEqual({ kind: "pending" });
  });
});
