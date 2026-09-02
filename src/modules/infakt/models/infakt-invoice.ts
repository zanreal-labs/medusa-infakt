import { model } from "@medusajs/framework/utils";

/**
 * One row per order that this plugin will invoice. The row IS the state machine:
 * every step persists its result column before the next one starts, and the next
 * step is derived from which columns are still null (see
 * `src/lib/invoicing/state-machine.ts`, `nextStep`).
 *
 * That is what makes a crash recoverable at any instant - there is no in-memory
 * progress, and no step counter that can drift out of step with what inFakt
 * actually did.
 *
 * `order_id` is unique, which is the outermost idempotency layer: the trigger
 * subscriber and any manual enqueue can both fire for the same order without
 * ever starting a second pipeline for it.
 *
 * ## Nothing here is buyer data
 *
 * Deliberately: no name, no address, no NIP, no email. The invoice itself lives
 * in inFakt, which is the system of record for it, and this table is an
 * operational ledger that the admin UI renders. `is_company` is the only fact
 * about the buyer, and it is a boolean.
 */
const InfaktInvoice = model
  .define("infakt_invoice", {
    /**
     * Set when an operator adopted an existing inFakt invoice into this row via
     * the link-manually flow, rather than the plugin creating it. Kept as its own
     * column so an audit can tell a machine-issued invoice from an adopted one.
     */
    adopted_at: model.dateTime().nullable(),
    /**
     * Why the reconciliation believed this invoice belongs to this order: the
     * signal that identified the buyer, the gross total, how far the issue date
     * sat from the order, and whether same-day duplicate orders had to be told
     * apart by the order of the documents in time. JSON, and PII-free by
     * construction - signal KINDS and numbers, never an email or a name (see
     * `AdoptionEvidence` in `src/lib/invoicing/reconcile.ts`).
     *
     * Null for an invoice this plugin issued itself, and for a uuid an operator
     * pasted in by hand: in both cases nobody inferred anything that an audit
     * would need to re-check.
     */
    adopted_evidence: model.text().nullable(),
    /**
     * Number of failed attempts. Deliberately NOT bumped by a defer (inFakt
     * still processing, order not yet fully paid), so an order that sits unpaid
     * for a week still has its full retry budget when the money lands.
     */
    attempts: model.number().default(0),
    /** Terminal timestamp for `done` and `skipped` alike. */
    completed_at: model.dateTime().nullable(),
    /**
     * Set once `infakt.invoice.issued` has been emitted. An emission-idempotency
     * marker, not decoration: a re-run after a crash between the invoice landing
     * and the row completing would otherwise emit a second event, and a consumer
     * attaching a PDF to a marketplace order would attach it twice.
     */
    event_emitted_at: model.dateTime().nullable(),
    id: model.id().primaryKey(),
    /** inFakt's own invoice number, once known. Never generated here. */
    invoice_number: model.text().nullable(),
    /** inFakt's invoice UUID. Non-null means a real invoice exists. */
    invoice_uuid: model.text().nullable(),
    /** True when the buyer had a NIP, i.e. this is a B2B document. */
    is_company: model.boolean().default(false),
    /** Why `ksef_required` came out as it did. The audit trail. No PII. */
    ksef_decision_reason: model.text().nullable(),
    /** KSeF-assigned number. Non-null means the filing succeeded. */
    ksef_number: model.text().nullable(),
    /**
     * Whether this invoice must be filed to KSeF, decided once at build time and
     * then frozen. Reading the config live on every tick would mean a mid-flight
     * `ksef.mode` change silently reclassified invoices already in progress.
     */
    ksef_required: model.boolean().nullable(),
    /** Written BEFORE the KSeF submit; see the crash-window note on `submit_started_at`. */
    ksef_sent_at: model.dateTime().nullable(),
    /** Last KSeF status seen: "sent", "success" or "error". */
    ksef_status: model.text().nullable(),
    /**
     * The most recent failure, truncated to 300 characters. Rendered in the admin
     * UI, so it carries field names and amounts only - never buyer data.
     */
    last_error: model.text().nullable(),
    /**
     * What a deferred row is waiting for, truncated to 300 characters like
     * `last_error` and PII-free for the same reason: it is rendered in the admin
     * UI, so it carries field names only, never their values.
     *
     * A defer already writes `status: "processing"`, a `next_attempt_at` and a
     * null `last_error`, which the widget renders as "Awaiting" with no
     * explanation - a row waiting for the buyer's address to arrive and a row
     * waiting for inFakt to finish a task look identical. This says which.
     *
     * Set only on a data-wait defer and cleared the moment the row advances, so
     * a non-null value always means "still waiting, right now".
     */
    defer_reason: model.text().nullable(),
    /** Earliest time the worker may pick this row up again. */
    next_attempt_at: model.dateTime().nullable(),
    /**
     * When this pipeline FIRST asked inFakt to mark the invoice as paid.
     *
     * Written once, on the first attempt, and never rewritten - including when
     * the call itself failed. It is the start of the confirmation budget (see
     * `PAID_CONFIRM_WINDOW_MS`), so re-writing it on every re-mark would make a
     * marking that can never succeed retry forever.
     */
    paid_marked_at: model.dateTime().nullable(),
    /**
     * When a read-back of the invoice showed inFakt's `status` as "paid".
     *
     * The marking endpoint is asynchronous and the status it writes is a single
     * last-write-wins enum that any later action can overwrite, so having called
     * it is not evidence that it took - only reading it back is. Once this is
     * set the payment is never re-checked and never re-marked: a human later
     * downloading the PDF flips the inFakt status to "printed", and that must not
     * be read as a payment coming undone.
     *
     * Null against a non-null `paid_marked_at` is the visible defect state: the
     * invoice is issued but inFakt still shows it awaiting payment.
     */
    paid_confirmed_at: model.dateTime().nullable(),
    /** The Medusa order. Unique - one pipeline per order, ever. */
    order_id: model.text().unique(),
    /**
     * The VAT regime this invoice was issued under, frozen at build time for the
     * same reason `ksef_required` is: a later config change - enabling OSS,
     * flipping the VIES fallback - must not retroactively reinterpret a document
     * that has already been issued.
     *
     * Null on every row that existed before cross-border support, which is read
     * as "domestic". That is what makes this migration safe on a live store: no
     * backfill, and every historical Polish invoice keeps its meaning.
     *
     * It is also what tells a resumed pipeline which inFakt document family it is
     * polling - an OSS invoice is not created or read through the same endpoints.
     */
    vat_regime: model
      .enum(["domestic", "reverse_charge", "eu_b2c_domestic_rate", "oss", "export_services"])
      .nullable(),
    /** Destination country for a cross-border invoice. Null domestically. */
    vat_country: model.text().nullable(),
    /** The destination rate an OSS invoice charged, e.g. "19". Audit only. */
    vat_rate: model.text().nullable(),
    /**
     * Net taxable base, minor units, for an intra-EU B2C sale.
     *
     * Set only on the `eu_b2c_domestic_rate` regime, because that is the only
     * one that counts toward the OSS threshold. Storing it here rather than in a
     * separate ledger means the counter is derived from the invoices themselves:
     * one source of truth, auditable by reading the same rows an accountant
     * would, and incapable of drifting from what was actually issued.
     */
    vat_base_minor: model.bigNumber().nullable(),
    /** Currency of `vat_base_minor`. The threshold is evaluated per currency. */
    vat_currency: model.text().nullable(),
    /** Why this order was intentionally not invoiced (status `skipped`). */
    skip_reason: model.text().nullable(),
    status: model
      .enum(["pending", "processing", "done", "skipped", "needs_review"])
      .default("pending"),
    /**
     * Written BEFORE the inFakt create call, and the single most important column
     * here.
     *
     * inFakt's create endpoint has no idempotency key, so a retried POST issues a
     * SECOND real, numbered invoice. On resume, this being set with no
     * `task_reference` means the create may have reached inFakt: the row goes to
     * needs_review and the create is NEVER retried automatically. A human checks
     * inFakt and either adopts the stray invoice or clears the marker.
     */
    submit_started_at: model.dateTime().nullable(),
    /** inFakt's async task reference, returned by the create call. */
    task_reference: model.text().nullable(),
  })
  .indexes([
    // The worker's only hot query: rows due for work, oldest first.
    { on: ["status", "next_attempt_at"] },
    // The admin UI's needs_review filter, and the operator's landing view.
    { on: ["status"] },
  ]);

export default InfaktInvoice;
