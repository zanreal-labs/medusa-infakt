import { InfaktApiError } from "../infakt/errors";
import type { InfaktClient } from "../infakt";
import type { ResolvedInfaktOptions } from "../options";
import { buildInfaktInvoicePayload } from "./builder";
import { decideKsef } from "./ksef";
import { warsawDate } from "./money";
import type { MedusaOrderLike } from "./order-mapper";
import { toInvoiceBuyerInput, toInvoiceOrderInput } from "./order-mapper";
import { evaluatePaidGate } from "./paid";
import {
  CRASH_WINDOW_MESSAGE,
  classifyKsefStatus,
  deferSignal,
  nextStep,
  reviewSignal,
  skipSignal,
  truncateError,
  UNPAID_RETRY_MS,
} from "./state-machine";
import type { InvoiceStateRow, PipelineStep } from "./state-machine";

/**
 * One row's journey to completion.
 *
 * Every dependency is injected, so this - the part with all the ordering
 * constraints - is testable without a Medusa container, a database or a live
 * inFakt. The job in `src/jobs/infakt-invoicing.ts` supplies the real ones.
 *
 * The contract with the caller is narrow and deliberate: this function either
 * returns (the row is `done`) or throws. What it throws is either a
 * `PipelineSignal` (skip, defer, review) or a real error, and
 * `classifyOutcome` turns that into the row's next persisted state. Nothing here
 * decides retry policy, and nothing here writes a terminal status.
 */

export interface InvoiceRow extends InvoiceStateRow {
  id: string;
  order_id: string;
}

export interface IssuedEventPayload {
  order_id: string;
  invoice_uuid: string;
  invoice_number: string | null;
  ksef_number: string | null;
  /** A PDF can be fetched from inFakt for this invoice. Always true here. */
  pdf_available: true;
}

export interface PipelineDeps {
  client: Pick<
    InfaktClient,
    | "createInvoiceAsync"
    | "getInvoice"
    | "getInvoiceTaskStatus"
    | "getKsefStatus"
    | "markPaid"
    | "sendToKsef"
  >;
  options: ResolvedInfaktOptions;
  logger: Pick<Console, "warn"> | { warn: (message: string) => void };
  readOrder: (orderId: string) => Promise<unknown>;
  update: (id: string, patch: Record<string, unknown>) => Promise<void>;
  emitIssued: (payload: IssuedEventPayload) => Promise<void>;
  /** Injected so the "ride the async task to completion" pause is instant in tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * How long to wait before polling a freshly submitted create task.
 *
 * inFakt usually settles a create in seconds, so riding it to completion inside
 * the same run means the whole pipeline needs one tick rather than three. If it has
 * not settled, the poll simply defers and the next tick picks it up - the wait is
 * an optimisation, never a correctness requirement.
 */
const CREATE_SETTLE_MS = 1500;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export async function processInvoiceRow(row: InvoiceRow, deps: PipelineDeps): Promise<void> {
  const order = (await deps.readOrder(row.order_id)) as MedusaOrderLike | null;
  if (!order) {
    // The order was hard-deleted, or the id never existed. Not retryable, and not
    // something to silently skip either - a queued invoice with no order is a data
    // problem worth a human's attention.
    throw reviewSignal("the order behind this invoice no longer exists");
  }

  guardOrderState(row, order, deps.options);

  if (row.status === "pending") {
    await patch(row, deps, { status: "processing" });
  }

  // Each pass advances exactly one step, so a step that throws leaves the row
  // exactly where its persisted columns say it is.
  for (let guard = 0; guard < 8; guard += 1) {
    const { step, crashWindow } = nextStep(row, { emitEvent: deps.options.emitIssuedEvent });
    if (crashWindow) {
      // inFakt has no idempotency key: re-POSTing the create would issue a SECOND
      // real numbered invoice. A human checks inFakt and either adopts the stray
      // invoice or clears the marker. Never automatic.
      throw reviewSignal(CRASH_WINDOW_MESSAGE);
    }
    if (step === "complete") {
      await patch(row, deps, { completed_at: new Date(), last_error: null, status: "done" });
      return;
    }
    await runStep(step, row, order, deps);
  }

  // Unreachable unless a step silently fails to advance the row; defer rather than
  // spin, so a logic bug shows up as a stalled row instead of a hot loop.
  throw deferSignal("the invoice pipeline did not advance - re-checking next tick");
}

/** Orders that must not, or must no longer, be invoiced. */
function guardOrderState(
  row: InvoiceRow,
  order: MedusaOrderLike,
  options: ResolvedInfaktOptions,
): void {
  const {startDate} = options;
  if (startDate === null) {
    throw skipSignal("invoicing is disabled (no valid startDate configured)");
  }

  // Compared as Warsaw calendar days, matching how the date is written on the
  // invoice. Comparing raw timestamps would put an order placed at 01:00 Warsaw on
  // the start date on the wrong side of the floor.
  const placedDay = warsawDate(order.created_at ?? null);
  if (placedDay < startDate) {
    throw skipSignal(`order was placed on ${placedDay}, before the ${startDate} start date`);
  }

  const currency = (order.currency_code ?? "").toUpperCase();
  if (currency && currency !== options.currency) {
    throw skipSignal(
      `order is in ${currency}, and this plugin is configured to invoice ${options.currency} only`,
    );
  }

  if (order.canceled_at || order.status === "canceled") {
    if (row.invoice_uuid) {
      // A corrective invoice is a legal document with its own rules; the plugin
      // does not issue one on its own.
      throw reviewSignal(
        "the order was canceled after its invoice was issued - a corrective invoice may be required",
      );
    }
    throw skipSignal("the order was canceled before it was invoiced");
  }

  const paid = evaluatePaidGate(order);
  if (!paid.fullyPaid) {
    if (row.invoice_uuid) {
      // Payment was reversed after the invoice was issued. Do not loop forever
      // waiting for re-payment; a human decides on a correction.
      throw reviewSignal(
        `the order is no longer fully paid after its invoice was issued (${paid.reason})`,
      );
    }
    throw deferSignal(paid.reason, UNPAID_RETRY_MS);
  }
}

async function runStep(
  step: Exclude<PipelineStep, "complete">,
  row: InvoiceRow,
  order: MedusaOrderLike,
  deps: PipelineDeps,
): Promise<void> {
  switch (step) {
    case "submit-create": {
      await submitCreate(row, order, deps);
      return;
    }
    case "resolve-create-task": {
      await resolveCreateTask(row, order, deps);
      return;
    }
    case "fetch-invoice-number": {
      await fetchInvoiceNumber(row, deps);
      return;
    }
    case "send-to-ksef": {
      await sendToKsef(row, deps);
      return;
    }
    case "poll-ksef": {
      await pollKsef(row, deps);
      return;
    }
    case "emit-event": {
      await emitIssued(row, deps);
      return;
    }
    default: {
      const exhaustive: never = step;
      throw reviewSignal(`unknown pipeline step ${String(exhaustive)}`);
    }
  }
}

/**
 * Step 1: create the invoice in inFakt.
 *
 * `submit_started_at` is persisted BEFORE the call. That single ordering is what
 * makes the whole pipeline safe: on resume, a row with that marker set and no task
 * reference is refused rather than retried (see `nextStep`), because the create may
 * already have issued a real invoice.
 */
async function submitCreate(
  row: InvoiceRow,
  order: MedusaOrderLike,
  deps: PipelineDeps,
): Promise<void> {
  const built = buildInfaktInvoicePayload(
    toInvoiceOrderInput(order, deps.options.currency),
    toInvoiceBuyerInput(order, deps.options.nipExtractor),
    { currency: deps.options.currency, taxSymbol: deps.options.taxSymbol },
  );
  if (!built.ok) {
    // Reasons are PII-free by construction; see builder.ts.
    throw reviewSignal(built.reason);
  }

  const decision = decideKsef(
    { isCompany: built.isCompany, nip: built.nip, orderId: row.order_id },
    deps.options.ksefMode,
    deps.options.ksefDecide,
  );

  // The KSeF decision is frozen here, alongside the claim. Re-deriving it on a
  // later tick would let a mid-flight config change silently reclassify an invoice
  // that has already been issued.
  await patch(row, deps, {
    is_company: built.isCompany,
    ksef_decision_reason: decision.reason,
    ksef_required: decision.file,
    submit_started_at: new Date(),
  });

  const task = await deps.client.createInvoiceAsync(built.payload);
  await patch(row, deps, { task_reference: task.invoiceTaskReferenceNumber });

  // Try to ride the async task to completion in this run.
  await (deps.sleep ?? defaultSleep)(CREATE_SETTLE_MS);
}

/** Step 2: turn the accepted task into a known invoice uuid. */
async function resolveCreateTask(
  row: InvoiceRow,
  order: MedusaOrderLike,
  deps: PipelineDeps,
): Promise<void> {
  if (!row.task_reference) {
    throw reviewSignal("the create task reference is missing - cannot resolve the invoice");
  }
  const status = await deps.client.getInvoiceTaskStatus(row.task_reference);
  if (status.failed) {
    throw reviewSignal(
      `inFakt rejected the invoice: ${status.processingDescription ?? `processing code ${status.processingCode}`}`,
    );
  }
  if (!(status.done && status.invoiceUuid)) {
    throw deferSignal("inFakt is still processing the invoice create task");
  }
  await patch(row, deps, {
    invoice_number: status.invoiceNumber ?? null,
    invoice_uuid: status.invoiceUuid,
  });
  await markPaidBestEffort(row, order, deps);
}

/** Step 3: read the number inFakt assigned. */
async function fetchInvoiceNumber(row: InvoiceRow, deps: PipelineDeps): Promise<void> {
  if (!row.invoice_uuid) {
    throw reviewSignal("no invoice uuid to read a number from");
  }
  const invoice = await deps.client.getInvoice(row.invoice_uuid);
  if (!invoice.number) {
    // inFakt assigns the number when the invoice leaves draft. Wait rather than
    // fabricating one - numbering is entirely inFakt's job.
    throw deferSignal("inFakt has not assigned an invoice number yet");
  }
  await patch(row, deps, { invoice_number: invoice.number });
}

/**
 * Step 4: file the invoice to KSeF.
 *
 * `ksef_sent_at` is persisted after the submit rather than before, because unlike
 * the create this call IS recoverable: a 422 can mean "already sent", and the
 * status endpoint disambiguates. A 422 with no readable status is a real
 * configuration problem - almost always an inactive KSeF integration.
 */
async function sendToKsef(row: InvoiceRow, deps: PipelineDeps): Promise<void> {
  if (!row.invoice_uuid) {
    throw reviewSignal("no invoice uuid to file to KSeF");
  }
  try {
    await deps.client.sendToKsef(row.invoice_uuid);
  } catch (error) {
    if (!(error instanceof InfaktApiError && error.httpStatus === 422)) {
      throw error;
    }
    const existing = await ksefStatusOrNull(row.invoice_uuid, deps);
    if (!existing) {
      throw reviewSignal(
        `KSeF submission rejected (${truncateError(error.message)}) - is the KSeF integration active on the inFakt account?`,
      );
    }
    // A status exists, so the submission did land; the 422 was "already sent".
  }
  await patch(row, deps, { ksef_sent_at: new Date() });
}

/** Step 5: poll KSeF until it assigns a number or rejects the document. */
async function pollKsef(row: InvoiceRow, deps: PipelineDeps): Promise<void> {
  if (!row.invoice_uuid) {
    throw reviewSignal("no invoice uuid to poll KSeF for");
  }
  const status = await deps.client.getKsefStatus(row.invoice_uuid);
  const classified = classifyKsefStatus(status);

  if (classified.kind === "error") {
    await patch(row, deps, { ksef_status: status.status });
    throw reviewSignal(classified.message);
  }
  if (classified.kind === "pending") {
    await patch(row, deps, { ksef_status: status.status });
    throw deferSignal("KSeF is still processing the invoice");
  }
  await patch(row, deps, { ksef_number: classified.ksefNumber, ksef_status: status.status });
}

/**
 * Step 6: announce the issued invoice.
 *
 * A plain event with no hard dependency in either direction, so another plugin can
 * react (e.g. attach the PDF to a marketplace order) without this one knowing it
 * exists. `event_emitted_at` is persisted so a crash between the invoice landing
 * and the row completing cannot emit twice - a consumer attaching a PDF would
 * otherwise attach it twice.
 *
 * An emission failure is never fatal to the invoice. The legal document already
 * exists; refusing to complete the row over a message bus hiccup would leave a
 * correctly-issued invoice looking broken.
 */
async function emitIssued(row: InvoiceRow, deps: PipelineDeps): Promise<void> {
  if (!row.invoice_uuid) {
    throw reviewSignal("no invoice uuid to announce");
  }
  try {
    await deps.emitIssued({
      invoice_number: row.invoice_number ?? null,
      invoice_uuid: row.invoice_uuid,
      ksef_number: row.ksef_number ?? null,
      order_id: row.order_id,
      pdf_available: true,
    });
  } catch (error) {
    deps.logger.warn(
      `[medusa-infakt] could not emit infakt.invoice.issued for order ${row.order_id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  await patch(row, deps, { event_emitted_at: new Date() });
}

/**
 * Tell inFakt the invoice is paid. Best-effort by design.
 *
 * Payment state is bookkeeping inside inFakt, not part of the legal document, so
 * this never blocks the pipeline. A re-run after a crash may hit "already paid",
 * which is fine.
 */
async function markPaidBestEffort(
  row: InvoiceRow,
  order: MedusaOrderLike,
  deps: PipelineDeps,
): Promise<void> {
  if (!row.invoice_uuid) {
    return;
  }
  try {
    // The paid date must not precede the invoice date, and the invoice is dated
    // today in Warsaw - so today is the only always-valid value. An order paid
    // last week is still recorded as settled, just not back-dated.
    await deps.client.markPaid(row.invoice_uuid, warsawDate());
  } catch (error) {
    deps.logger.warn(
      `[medusa-infakt] mark-paid failed for invoice ${row.invoice_uuid} (order ${order.id}): ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

async function ksefStatusOrNull(uuid: string, deps: PipelineDeps) {
  try {
    return await deps.client.getKsefStatus(uuid);
  } catch {
    return null;
  }
}

/** Persist a patch and mirror it onto the in-memory row so later steps see it. */
async function patch(
  row: InvoiceRow,
  deps: PipelineDeps,
  changes: Record<string, unknown>,
): Promise<void> {
  await deps.update(row.id, changes);
  Object.assign(row, changes);
}
