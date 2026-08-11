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
    /** Earliest time the worker may pick this row up again. */
    next_attempt_at: model.dateTime().nullable(),
    /** The Medusa order. Unique - one pipeline per order, ever. */
    order_id: model.text().unique(),
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
