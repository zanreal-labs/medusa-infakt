import { nextStep } from "./state-machine";
import type { InvoiceStateRow } from "./state-machine";

/**
 * The pure rules behind `POST /hooks/infakt/ksef`.
 *
 * inFakt's KSeF documentation asks for a webhook instead of polling
 * `status.json` ("Zachęcamy do skonfigurowania webhooka, który poinformuje o
 * zmianie statusu przetwarzania na końcowy"), and filing a B2B invoice has been
 * legally mandatory in Poland since April 2026 - it is the one transition in this
 * plugin with a statutory deadline behind it. So the status should arrive when
 * inFakt has it rather than when a timer next fires.
 *
 * ## The webhook is a nudge, never a fact
 *
 * Nothing here reads a KSeF status, a KSeF number or an error out of the payload,
 * and the route does not either. The body is used for exactly one thing: naming
 * which invoice to go and look at. The route then re-reads the status from
 * inFakt's own API through the same `poll-ksef` step the cron runs, so the
 * persisted columns advance through their normal code and stay the only source of
 * truth.
 *
 * That is what makes the endpoint safe by construction rather than safe by
 * signature alone. A forged or replayed delivery, if one ever got past the HMAC,
 * can at worst cause a status re-read that inFakt answers authoritatively - it
 * cannot write a KSeF number, cannot park an invoice for review, and cannot mark
 * an unfiled document as filed.
 *
 * ## What inFakt actually sends
 *
 *     {
 *       "event": { "name": "send_to_ksef_error", "uuid": "...",
 *                  "created_at": "...", "retry_counter": 0 },
 *       "resource": { "invoice_uuid": "...", "status": "error",
 *                     "ksef_number": null, "status_description": "..." }
 *     }
 *
 * There are exactly two KSeF events - `send_to_ksef_success` and
 * `send_to_ksef_error` - and nothing else in inFakt's supported-events table
 * concerns this pipeline. A webhook configured in the panel with "bez poufnych
 * informacji" reduces `resource` to `{ "uuid": "..." }`, which is why the
 * identifier is read from either field: with the payload treated as a trigger,
 * the redacted mode carries everything this needs.
 */

/** The two events in inFakt's table that concern the KSeF step. */
export const KSEF_WEBHOOK_EVENTS = ["send_to_ksef_success", "send_to_ksef_error"] as const;

export type KsefWebhookEvent = (typeof KSEF_WEBHOOK_EVENTS)[number];

export type InfaktWebhookRequest =
  /**
   * The activation handshake. inFakt POSTs a random `verification_code` when an
   * operator presses "Zweryfikuj" in the panel and requires the same string back
   * in the response body; a webhook that never answers it stays "Do weryfikacji"
   * and is never delivered to at all.
   */
  | { kind: "verification"; verificationCode: string }
  /** A KSeF event naming an invoice to go and re-read. */
  | { kind: "ksef"; event: KsefWebhookEvent; eventUuid: string | null; invoiceUuid: string }
  /** Well-formed, authentic, and nothing for this plugin to do. */
  | { kind: "ignored"; reason: string };

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

const asNonEmptyString = (value: unknown): string | null => {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
};

/**
 * Classify an already-authenticated delivery.
 *
 * Everything this cannot act on is `ignored` rather than an error, and that is a
 * deliberate reading of inFakt's retry policy: a delivery is retried until the
 * endpoint answers 200 or 201, an operator is emailed after six failures, and the
 * webhook is switched off automatically after ten. Answering an error to an event
 * this plugin simply does not care about - `invoice_paid`, say, or a future event
 * inFakt adds - would spend that budget on nothing and eventually disable the
 * delivery of the two events that do matter.
 *
 * The verification handshake is recognised before the event shape, because it is
 * the one body that carries no `event` object at all.
 */
export function classifyInfaktWebhook(body: unknown): InfaktWebhookRequest {
  const payload = asRecord(body);
  if (!payload) {
    return { kind: "ignored", reason: "the body was not a JSON object" };
  }

  const verificationCode = asNonEmptyString(payload.verification_code);
  if (verificationCode) {
    return { kind: "verification", verificationCode };
  }

  const event = asRecord(payload.event);
  const name = asNonEmptyString(event?.name);
  if (!name) {
    return { kind: "ignored", reason: "the body carried no event name" };
  }
  if (!(KSEF_WEBHOOK_EVENTS as readonly string[]).includes(name)) {
    return { kind: "ignored", reason: `${name} is not a KSeF event` };
  }

  const resource = asRecord(payload.resource);
  // `invoice_uuid` in the full payload, `uuid` in the "bez poufnych informacji"
  // one. Neither is trusted as anything but a lookup key.
  const invoiceUuid = asNonEmptyString(resource?.invoice_uuid) ?? asNonEmptyString(resource?.uuid);
  if (!invoiceUuid) {
    return { kind: "ignored", reason: `${name} named no invoice` };
  }

  return {
    event: name as KsefWebhookEvent,
    eventUuid: asNonEmptyString(event?.uuid),
    invoiceUuid,
    kind: "ksef",
  };
}

/**
 * Is this row actually waiting for a KSeF status right now?
 *
 * Deliberately answered by `nextStep`, the state machine's own resume rule,
 * rather than by a second reading of the same columns. There is one definition of
 * where a row stands, and a webhook that disagreed with it would be a way to
 * re-enter rows the pipeline had parked on purpose - a `needs_review` row above
 * all, whose entire point is that only an operator restarts it.
 *
 * This is also the idempotency boundary. inFakt retries a delivery until it is
 * answered, so the same event arrives more than once as a matter of course: the
 * first one advances the row to `done` (or parks it for review), and every later
 * one finds a row that is no longer due for `poll-ksef` and does nothing at all.
 */
export function awaitingKsefStatus(row: InvoiceStateRow, emitEvent: boolean): boolean {
  if (row.status !== "pending" && row.status !== "processing") {
    return false;
  }
  return nextStep(row, { emitEvent }).step === "poll-ksef";
}

/**
 * The patch that makes a KSeF-waiting row due immediately, or null when there is
 * nothing to clear.
 *
 * A `poll-ksef` defer is a plain defer: it writes `next_attempt_at` two minutes
 * out and leaves `defer_reason` null, so unlike the address wait it is NOT
 * already due to `listDueInvoicesForOrder`. Without this the webhook would arrive,
 * find nothing due, and the row would still wait for the timer it was supposed to
 * replace.
 *
 * Clearing `next_attempt_at` is the whole of it. Nothing else is touched - not
 * `attempts`, not `last_error`, not the status - because this is news that KSeF
 * finished, not an operator's decision to forgive a row's history.
 */
export function ksefWebhookNudge(row: InvoiceStateRow): { next_attempt_at: null } | null {
  return row.next_attempt_at ? { next_attempt_at: null } : null;
}
