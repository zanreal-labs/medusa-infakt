import { InfaktApiError } from "../infakt/errors";
import type { InfaktClient } from "../infakt";
import type { InfaktInvoicePayload, InfaktOssInvoicePayload } from "../infakt/types";
import type { ResolvedInfaktOptions } from "../options";
import { buildInfaktInvoicePayload } from "./builder";
import type { InvoiceOrderInput } from "./builder";
import type { IssuedNumberClaim } from "./invoice-number";
import { collisionReason, findNumberCollision } from "./invoice-number";
import { decideKsef } from "./ksef";
import { buildOssInvoicePayload } from "./oss-builder";
import { toMinorUnits, warsawDate } from "./money";
import type { MedusaOrderLike } from "./order-mapper";
import { toInvoiceBuyerInput, toInvoiceOrderInput } from "./order-mapper";
import { evaluatePaidGate } from "./paid";
import type { VatRegime } from "./regime";
import { MossRateCache, resolveOrderRegime } from "./resolve-regime";
import type { EuB2cSale } from "./threshold";
import { alertMessage } from "./threshold";
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
    | "createOssInvoiceAsync"
    | "getInvoice"
    | "getInvoiceTaskStatus"
    | "getKsefStatus"
    | "listMossRates"
    | "markPaid"
    | "sendInvoiceEmail"
    | "sendToKsef"
  >;
  options: ResolvedInfaktOptions;
  logger: Pick<Console, "warn"> | { warn: (message: string) => void };
  readOrder: (orderId: string) => Promise<unknown>;
  update: (id: string, patch: Record<string, unknown>) => Promise<void>;
  emitIssued: (payload: IssuedEventPayload) => Promise<void>;
  /**
   * Every invoice number already recorded, for the collision guard.
   *
   * Optional so existing callers and tests keep working; when it is absent the
   * guard is skipped and a warning is logged rather than the pipeline failing.
   * See `invoice-number.ts` for why a collision matters.
   */
  listIssuedNumbers?: () => Promise<IssuedNumberClaim[]>;
  /**
   * Destination-rate cache, shared across a whole worker run when the caller
   * supplies one. Absent, each row builds its own, which is correct but chattier.
   */
  mossRates?: Pick<MossRateCache, "rateFor">;
  /**
   * The intra-EU B2C sales already invoiced, for the OSS threshold counter.
   *
   * Absent means "none on the books", which is only correct for a store that has
   * never made one. `run.ts` supplies the real reader; leaving it unwired would
   * silently under-count, so the option to omit it exists for tests only.
   */
  listEuB2cSales?: () => Promise<EuB2cSale[]>;
  /** Raise an operational alert. Optional; a missing channel logs instead. */
  raiseAlert?: (message: string) => Promise<void>;
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

/**
 * A non-blank string out of order metadata, or null.
 *
 * Guards against the value arriving as `null`, a number, or whitespace - none
 * of which is a real invoice number, and any of which would otherwise make an
 * ordinary order look backfilled.
 */
function readMetadataString(
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | null {
  const raw = metadata?.[key];
  if (typeof raw !== "string") {
    return null;
  }
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

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
  // Orders backfilled from the legacy system carry their already-issued invoice
  // number in metadata, not in this plugin's own ledger - there was no Medusa
  // payment behind them for `payment.captured` to ever have fired on. Reading
  // that metadata is the only way this pipeline can recognize one, whether it
  // was enqueued by an `order.placed` trigger at import time or manually via
  // the admin recovery endpoint.
  const backfilledInvoiceNumber = readMetadataString(order.metadata, "invoice_number");
  if (backfilledInvoiceNumber) {
    if (row.invoice_uuid) {
      // This row already has a real inFakt invoice from THIS pipeline, and the
      // order also carries a legacy invoice number - a state that should never
      // occur. A human resolves the conflict rather than the row silently
      // picking a side.
      throw reviewSignal(
        "this row already has an inFakt invoice from this pipeline, but the order's metadata also carries a legacy invoice_number - check for a conflict before doing anything else",
      );
    }
    throw skipSignal("already invoiced outside the pipeline");
  }

  const { startDate } = options;
  // Absent means no floor: every order the pipeline otherwise sees is invoiced.
  // Compared as Warsaw calendar days, matching how the date is written on the
  // invoice, when a floor IS configured - comparing raw timestamps would put an
  // order placed at 01:00 Warsaw on the start date on the wrong side of it.
  if (startDate !== null) {
    const placedDay = warsawDate(order.created_at ?? null);
    if (placedDay < startDate) {
      throw skipSignal(`order was placed on ${placedDay}, before the ${startDate} start date`);
    }
  }

  const currency = (order.currency_code ?? "").toUpperCase();
  if (currency && !invoiceableCurrency(currency, options)) {
    throw skipSignal(
      options.crossBorderEnabled
        ? `order is in ${currency}, and this plugin is configured to invoice ${[options.currency, ...options.crossBorderCurrencies].join(", ")}`
        : `order is in ${currency}, and this plugin is configured to invoice ${options.currency} only`,
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
  // The invoice is denominated in the order's own currency. Domestically that is
  // always `options.currency`; cross-border it is whatever the customer paid in,
  // already vetted by the currency gate in `guardOrderState`.
  const currency = (order.currency_code ?? deps.options.currency).toUpperCase();
  const buyer = toInvoiceBuyerInput(order, deps.options.nipExtractor);
  const orderInput = toInvoiceOrderInput(order, currency);

  const regime = await regimeFor(order, buyer.taxId ?? undefined, orderInput, deps);
  if (regime.kind === "blocked") {
    // A regime we cannot determine is never approximated. The reason names the
    // country and the missing evidence, and carries no buyer data.
    throw reviewSignal(regime.reason);
  }

  const built =
    regime.kind === "oss"
      ? buildOssInvoicePayload(orderInput, buyer, {
          country: regime.country,
          currency,
          rate: regime.rate,
          serviceType: deps.options.ossServiceType,
        })
      : buildInfaktInvoicePayload(orderInput, buyer, {
          currency,
          regime,
          taxSymbol: deps.options.taxSymbol,
        });
  if (!built.ok) {
    // Reasons are PII-free by construction; see builder.ts and oss-builder.ts.
    throw reviewSignal(built.reason);
  }

  // An OSS invoice is always a consumer document, so it is never a KSeF
  // candidate and never carries a tax id.
  const isCompany = "isCompany" in built ? built.isCompany : false;
  const nip = "nip" in built ? built.nip : undefined;

  const decision = decideKsef(
    { isCompany, nip, orderId: row.order_id },
    deps.options.ksefMode,
    deps.options.ksefDecide,
  );

  // The KSeF decision and the VAT regime are frozen here, alongside the claim.
  // Re-deriving either on a later tick would let a mid-flight config change
  // silently reclassify an invoice that has already been issued.
  await patch(row, deps, {
    is_company: isCompany,
    ksef_decision_reason: decision.reason,
    ksef_required: decision.file,
    submit_started_at: new Date(),
    vat_base_minor: regime.kind === "eu_b2c_domestic_rate" ? euB2cBaseMinor(orderInput) : null,
    vat_country: regime.kind === "domestic" ? null : regime.country,
    vat_currency: regime.kind === "eu_b2c_domestic_rate" ? currency : null,
    vat_rate: regime.kind === "oss" ? regime.rate : null,
    vat_regime: regime.kind,
  });

  // Warn while there is still time to register. The block at 100% is a backstop,
  // not the notification mechanism: by the time it fires, sales are already
  // being refused.
  if (regime.kind === "eu_b2c_domestic_rate" && regime.alert) {
    await raiseThresholdAlert(regime.usedRatio, deps);
  }

  const task =
    regime.kind === "oss"
      ? await deps.client.createOssInvoiceAsync(built.payload as InfaktOssInvoicePayload)
      : await deps.client.createInvoiceAsync(built.payload as InfaktInvoicePayload);
  await patch(row, deps, { task_reference: task.invoiceTaskReferenceNumber });

  // Try to ride the async task to completion in this run.
  await (deps.sleep ?? defaultSleep)(CREATE_SETTLE_MS);
}

/**
 * The regime for one order, or plain domestic when cross-border is off.
 *
 * Short-circuiting on `crossBorderEnabled` is what guarantees a store that has
 * not opted in behaves exactly as it did before: no classification, no VIES
 * read, no rate lookup, and a `domestic` regime that makes the builder emit the
 * identical payload it emitted before this feature existed.
 */
async function regimeFor(
  order: MedusaOrderLike,
  taxId: string | undefined,
  orderInput: InvoiceOrderInput,
  deps: PipelineDeps,
): Promise<VatRegime> {
  if (!deps.options.crossBorderEnabled) {
    return { kind: "domestic", taxSymbol: deps.options.taxSymbol };
  }
  const rates = deps.mossRates ?? new MossRateCache(deps.client);
  return resolveOrderRegime(
    order,
    taxId,
    {
      alertRatio: deps.options.ossAlertRatio,
      crossBorderEnabled: true,
      domesticTaxSymbol: deps.options.taxSymbol,
      ossEnabled: deps.options.ossEnabled,
      ossRegistered: deps.options.ossRegistered,
      thresholds: deps.options.ossThresholds,
      viesFallback: deps.options.viesFallback,
    },
    rates,
    deps.listEuB2cSales ?? (() => Promise.resolve([])),
    pendingEuB2cSale(orderInput, order),
  );
}

/**
 * This order expressed as a candidate intra-EU B2C sale.
 *
 * The taxable base is net, because the threshold is measured on net value. It is
 * derived as gross minus the tax the checkout charged; when the order reports no
 * tax at all the gross IS the net, which is the conservative reading - it counts
 * the larger number toward the limit rather than the smaller.
 */
function pendingEuB2cSale(orderInput: InvoiceOrderInput, order: MedusaOrderLike): EuB2cSale {
  const gross = toMinorUnits(orderInput.total) ?? 0;
  const tax = toMinorUnits(orderInput.taxTotal ?? null) ?? 0;
  return {
    baseMinor: Math.max(gross - tax, 0),
    currency: (order.currency_code ?? "").toUpperCase(),
    date: warsawDate(order.created_at ?? null),
  };
}

/** Whether this plugin invoices orders in the given currency at all. */
function invoiceableCurrency(currency: string, options: ResolvedInfaktOptions): boolean {
  if (currency === options.currency.toUpperCase()) {
    return true;
  }
  return options.crossBorderEnabled && options.crossBorderCurrencies.includes(currency);
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

  // The last checkpoint before the invoice number reaches anything that spends
  // money. Downstream license fulfilment treats the number as a globally unique
  // handle, and it is not one across inFakt's document families - so a duplicate
  // parks here rather than becoming one buyer receiving another's license keys.
  await guardNumberCollision(row, deps);

  // A foreign buyer cannot collect an invoice from KSeF, so filing it is not
  // delivering it. Best-effort on purpose: the invoice is already issued and a
  // bounced email must not undo it or park the row.
  await deliverCrossBorderInvoice(row, deps);

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

/**
 * Refuse to announce an invoice whose number another order already claimed.
 *
 * Parks rather than continues. The alternative - announcing anyway - hands a
 * non-unique reference to a system that buys and delivers license keys under it,
 * and the failure mode there is one customer receiving another's credentials,
 * which cannot be undone once the email is sent.
 *
 * When no lookup is wired the guard logs and continues, so this stays additive
 * for existing callers rather than a hard new requirement.
 */
async function guardNumberCollision(row: InvoiceRow, deps: PipelineDeps): Promise<void> {
  if (!deps.listIssuedNumbers) {
    deps.logger.warn(
      `[medusa-infakt] no invoice-number lookup wired; skipping the collision guard for order ${row.order_id}`,
    );
    return;
  }
  const number = row.invoice_number;
  if (!number) {
    return;
  }
  const existing = await deps.listIssuedNumbers();
  const other = findNumberCollision(number, row.order_id, existing);
  if (other) {
    throw reviewSignal(collisionReason(number, other));
  }
}

/**
 * Email a cross-border invoice to the buyer.
 *
 * Domestic invoices are deliberately untouched: a Polish B2B buyer collects
 * theirs from KSeF, and a Polish consumer's delivery is however the store
 * already handles it. Nothing about the existing path changes.
 */
async function deliverCrossBorderInvoice(row: InvoiceRow, deps: PipelineDeps): Promise<void> {
  if (!(deps.options.emailCrossBorderInvoice && isCrossBorderRegime(row.vat_regime))) {
    return;
  }
  if (!row.invoice_uuid) {
    return;
  }
  try {
    await deps.client.sendInvoiceEmail(row.invoice_uuid);
  } catch (error) {
    deps.logger.warn(
      `[medusa-infakt] could not email the cross-border invoice for order ${row.order_id}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/** Whether a persisted regime value describes a sale that left Poland. */
function isCrossBorderRegime(regime: string | null | undefined): boolean {
  return regime === "reverse_charge" || regime === "export_services" || regime === "oss";
}

/** The net taxable base this order contributes to the intra-EU B2C counter. */
function euB2cBaseMinor(orderInput: InvoiceOrderInput): number {
  const gross = toMinorUnits(orderInput.total) ?? 0;
  const tax = toMinorUnits(orderInput.taxTotal ?? null) ?? 0;
  return Math.max(gross - tax, 0);
}

/**
 * Tell someone the OSS threshold is approaching.
 *
 * Best-effort: an alert that cannot be delivered must not stop an invoice that is
 * otherwise correct. It degrades to a warning in the log, which is still visible,
 * rather than to silence.
 */
async function raiseThresholdAlert(usedRatio: number, deps: PipelineDeps): Promise<void> {
  const message = alertMessage(usedRatio);
  if (!deps.raiseAlert) {
    deps.logger.warn(`[medusa-infakt] ${message}`);
    return;
  }
  try {
    await deps.raiseAlert(message);
  } catch (error) {
    deps.logger.warn(
      `[medusa-infakt] could not raise the OSS threshold alert: ${
        error instanceof Error ? error.message : String(error)
      } - ${message}`,
    );
  }
}
