import { describeError, InfaktApiError } from "../infakt/errors";

/**
 * The durable state machine's pure rules.
 *
 * The worker (`src/jobs/infakt-invoicing.ts`) is the I/O shell; everything that
 * decides WHAT happens next lives here, without a database or an HTTP client, so
 * the crash-safety properties are unit-testable.
 *
 * ## The pipeline
 *
 *     create invoice in inFakt -> (when required) file to KSeF -> done
 *
 * Each external interaction persists its result column before the next one
 * starts, and the next step is derived from which columns are still null. A
 * crash at any point resumes exactly where it stopped on the next tick. There is
 * no in-memory progress and no step counter to get out of sync with reality.
 *
 * ## The crash window, and why the create is never retried
 *
 * inFakt's invoice-create endpoint has NO idempotency key. A retried POST issues
 * a SECOND real, numbered invoice. So `submit_started_at` is written BEFORE the
 * create call, and on resume a row with `submit_started_at` set but no
 * `task_reference` means the create may have reached inFakt. Such a row goes to
 * needs_review and is never retried automatically: a human checks inFakt for a
 * stray invoice and either adopts it (link-manually) or clears the marker.
 *
 * Automatically retrying that create is the one failure mode this design refuses
 * to accept. Every other failure retries with backoff, because every other
 * failure is either idempotent or observable.
 */

/** Give up and page a human after this many failed attempts. */
export const MAX_ATTEMPTS = 8;
/** First retry delay; doubles per attempt. */
export const BASE_RETRY_MS = 5 * 60_000;
/** Retry-delay ceiling. */
export const MAX_RETRY_MS = 6 * 60 * 60_000;
/** Re-check cadence while inFakt or KSeF are still processing (not a failure). */
export const WAIT_RETRY_MS = 2 * 60_000;
/** Re-check cadence while an order is still being paid. */
export const UNPAID_RETRY_MS = 30 * 60_000;
/**
 * How long the pipeline keeps trying to see its own paid marking take effect.
 *
 * Measured from `paid_marked_at`, which is written once on the FIRST marking
 * attempt and never rewritten - so this window always terminates rather than
 * sliding forward with every re-mark.
 *
 * inFakt's paid endpoint is asynchronous (HTTP 201 means accepted, not applied)
 * and the invoice `status` it writes is a single last-write-wins enum, which any
 * later action on the document - including a plain PDF download - can overwrite.
 * Several actors in one estate touch a fresh invoice within seconds of each
 * other, so one marking is not evidence of a paid invoice. Fifteen minutes is
 * long enough to survive that opening burst and a couple of worker ticks, and
 * short enough that a document nothing can settle stops being retried the same
 * hour it was issued.
 */
export const PAID_CONFIRM_WINDOW_MS = 15 * 60_000;
/** `last_error` cap. An inFakt validation dump can be kilobytes long. */
export const MAX_ERROR_LENGTH = 300;

/**
 * HTTP statuses where retrying the identical request can never succeed.
 *
 * 409 is here because inFakt uses it for "this already happened", which a retry
 * cannot improve. 429 and 5xx are deliberately absent: those are exactly the
 * statuses that backoff exists for.
 */
export const NON_RETRYABLE_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 405, 409, 422]);

export type InvoiceStatus = "pending" | "processing" | "done" | "skipped" | "needs_review";

/** The persisted row, as the pure rules need to see it. */
export interface InvoiceStateRow {
  status: InvoiceStatus;
  is_company?: boolean | null;
  ksef_decision_reason?: string | null;
  submit_started_at?: Date | string | null;
  task_reference?: string | null;
  invoice_uuid?: string | null;
  invoice_number?: string | null;
  ksef_required?: boolean | null;
  ksef_sent_at?: Date | string | null;
  ksef_status?: string | null;
  ksef_number?: string | null;
  event_emitted_at?: Date | string | null;
  /** When the pipeline FIRST asked inFakt to mark the invoice paid. Never rewritten. */
  paid_marked_at?: Date | string | null;
  /** When a read-back of the invoice showed `status: "paid"`. Terminal. */
  paid_confirmed_at?: Date | string | null;
  attempts: number;
  /** Earliest time the worker may pick the row up again. */
  next_attempt_at?: Date | string | null;
  /** Last failure, truncated and PII-free. Rendered in the admin UI. */
  last_error?: string | null;
  skip_reason?: string | null;
  completed_at?: Date | string | null;
  adopted_at?: Date | string | null;
  /**
   * The VAT regime frozen at build time. Null on rows created before
   * cross-border support existed, and read as "domestic" everywhere.
   */
  vat_regime?: string | null;
  vat_country?: string | null;
  vat_rate?: string | null;
  /** Net taxable base for an intra-EU B2C sale. Feeds the OSS threshold counter. */
  vat_base_minor?: unknown;
  vat_currency?: string | null;
}

/**
 * Non-error control-flow signal a pipeline step throws to unwind with an outcome:
 *
 *  - `defer`: not done, not a failure (inFakt or KSeF still processing, order not
 *    fully paid yet). Retry after `delayMs`, and do NOT count an attempt - a slow
 *    external system must not burn the row's retry budget.
 *  - `review`: terminal, needs a human (a rejection, an ambiguity, the crash
 *    window). Never retried automatically.
 *  - `skip`: intentionally not invoiced (predates the start date, wrong currency,
 *    order canceled before invoicing). Completed with a reason.
 *
 * Real errors (a thrown `Error`, an `InfaktApiError`) fall through to
 * retry-with-backoff, except for the non-retryable statuses above.
 */
export class PipelineSignal extends Error {
  readonly kind: "defer" | "review" | "skip";
  readonly delayMs: number;

  constructor(kind: "defer" | "review" | "skip", message: string, delayMs = WAIT_RETRY_MS) {
    super(message);
    this.name = "PipelineSignal";
    this.kind = kind;
    this.delayMs = delayMs;
  }
}

export const deferSignal = (message: string, delayMs?: number): PipelineSignal =>
  new PipelineSignal("defer", message, delayMs);
export const reviewSignal = (message: string): PipelineSignal =>
  new PipelineSignal("review", message);
export const skipSignal = (message: string): PipelineSignal => new PipelineSignal("skip", message);

/** The operator-facing message for a row caught in the create crash window. */
export const CRASH_WINDOW_MESSAGE =
  "a previous inFakt create attempt may have gone through without a stored task reference - check inFakt for a stray invoice, then adopt it with link-manually or clear the row";

export function truncateError(message: string): string {
  return message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH)}...` : message;
}

/**
 * Retry delay for the Nth failed attempt (1-based), capped.
 *
 * `BASE * 2 ** attempts` rather than `2 ** (attempts - 1)`: the first retry
 * already waits 10 minutes, because the failures worth retrying at all
 * (rate limits, inFakt outages) do not clear in 5.
 */
export function backoffMs(attempts: number): number {
  return Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** attempts);
}

export type OutcomeKind = "skipped" | "deferred" | "retry" | "review";

export interface Outcome {
  kind: OutcomeKind;
  /** Attempt counter to persist. Unchanged for skip and defer. */
  attempts: number;
  /** When to next pick the row up; undefined for terminal outcomes. */
  delayMs?: number;
  /** Truncated, PII-free message for `last_error` or `skip_reason`. */
  message: string;
}

/**
 * Classify a thrown value into the outcome the worker must persist.
 *
 * The ordering matters:
 *  1. `skip` and `defer` signals are not failures, so they never touch
 *     `attempts`. A row deferred a hundred times has burned no retry budget.
 *  2. A `review` signal, or a non-retryable HTTP status, is terminal.
 *  3. Exhausting `MAX_ATTEMPTS` is also terminal - an infinite retry loop against
 *     a permanently broken row is indistinguishable from a working pipeline in
 *     every dashboard.
 *  4. Everything else retries with backoff.
 */
export function classifyOutcome(cause: unknown, row: Pick<InvoiceStateRow, "attempts">): Outcome {
  if (cause instanceof PipelineSignal && cause.kind === "skip") {
    return { attempts: row.attempts, kind: "skipped", message: truncateError(cause.message) };
  }
  if (cause instanceof PipelineSignal && cause.kind === "defer") {
    return {
      attempts: row.attempts,
      delayMs: cause.delayMs,
      kind: "deferred",
      message: truncateError(cause.message),
    };
  }

  const message = truncateError(describeError(cause));
  const httpStatus = cause instanceof InfaktApiError ? cause.httpStatus : null;
  const permanent =
    (cause instanceof PipelineSignal && cause.kind === "review") ||
    (httpStatus !== null && NON_RETRYABLE_STATUSES.has(httpStatus));
  const attempts = row.attempts + 1;

  if (permanent || attempts >= MAX_ATTEMPTS) {
    return { attempts, kind: "review", message };
  }
  return { attempts, delayMs: backoffMs(attempts), kind: "retry", message };
}

export type PipelineStep =
  | "submit-create"
  | "resolve-create-task"
  | "fetch-invoice-number"
  | "send-to-ksef"
  | "poll-ksef"
  | "emit-event"
  | "confirm-paid"
  | "complete";

/**
 * Whether the row still owes inFakt a paid marking, or a confirmation of one.
 *
 * Four refusals, in order, and each one matters:
 *
 *  - no invoice, nothing to mark;
 *  - an ADOPTED invoice is not this pipeline's document. It existed before the
 *    row did, its payment bookkeeping was whoever issued it's to do, and writing
 *    today's paid date onto it is a change to an accounting record nobody asked
 *    for. This is also exactly the scope the marking had before it moved: it ran
 *    only on an invoice this pipeline had just created.
 *  - `paid_confirmed_at` set means a read-back already showed "paid". It is never
 *    re-checked, so a human downloading the PDF later - which flips the inFakt
 *    status to "printed" - cannot un-confirm a payment that was confirmed.
 *  - past the window the row gives up and completes. An unconfirmed marking is
 *    bookkeeping, not the legal document, and it must never hold an issued
 *    invoice out of `done` indefinitely.
 */
export function paidConfirmationDue(row: InvoiceStateRow, now: number = Date.now()): boolean {
  if (!row.invoice_uuid) {
    return false;
  }
  if (row.adopted_at) {
    return false;
  }
  if (row.paid_confirmed_at) {
    return false;
  }
  if (!row.paid_marked_at) {
    return true;
  }
  const markedAt = new Date(row.paid_marked_at).getTime();
  // An unreadable timestamp is treated as exhausted rather than as "just now":
  // failing towards completing an already-issued invoice is the safe direction.
  if (Number.isNaN(markedAt)) {
    return false;
  }
  return now - markedAt < PAID_CONFIRM_WINDOW_MS;
}

/**
 * Which step a row is due for, derived purely from its persisted columns.
 *
 * This is the resume rule. Nothing else decides where a crashed run picks up,
 * and there is no state that exists only in memory - which is what makes a
 * crash at any instant recoverable.
 *
 * `crashWindow` is returned separately rather than as a step, because it is not
 * something to do: it is a refusal to do the thing the columns would otherwise
 * suggest.
 */
export function nextStep(
  row: InvoiceStateRow,
  options: { emitEvent: boolean },
): { step: PipelineStep; crashWindow?: true } {
  if (!row.invoice_uuid) {
    if (row.task_reference) {
      return { step: "resolve-create-task" };
    }
    if (row.submit_started_at) {
      return { crashWindow: true, step: "submit-create" };
    }
    return { step: "submit-create" };
  }
  if (!row.invoice_number) {
    return { step: "fetch-invoice-number" };
  }
  if (row.ksef_required && !row.ksef_number) {
    return row.ksef_sent_at ? { step: "poll-ksef" } : { step: "send-to-ksef" };
  }
  if (options.emitEvent && !row.event_emitted_at) {
    return { step: "emit-event" };
  }
  // Last, deliberately: the paid marking is the one thing whose result a LATER
  // action can overwrite, so nothing this pipeline does may follow it.
  if (paidConfirmationDue(row)) {
    return { step: "confirm-paid" };
  }
  return { step: "complete" };
}

/**
 * Map an inFakt KSeF document status to a pipeline outcome.
 *
 * Statuses are "sent" (accepted, processing), "success" (`ksefNumber` assigned)
 * and "error" (rejected, detail in `statusDescription`). An unknown status is
 * treated as still processing rather than as an error: inFakt adding a new
 * intermediate state must not park every B2B invoice in needs_review, and a
 * genuinely stuck row still lands there once it exhausts its attempts.
 */
export function classifyKsefStatus(status: {
  status: string;
  ksefNumber?: string;
  statusDescription?: string;
}):
  | { kind: "done"; ksefNumber: string }
  | { kind: "error"; message: string }
  | { kind: "pending" } {
  if (status.status === "error") {
    return {
      kind: "error",
      message: `KSeF rejected the invoice: ${status.statusDescription ?? "no description given"}`,
    };
  }
  if (status.status === "success" && status.ksefNumber) {
    return { kind: "done", ksefNumber: status.ksefNumber };
  }
  return { kind: "pending" };
}
