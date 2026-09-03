import { describeError, InfaktApiError } from "../infakt/errors";
import type { InfaktClient } from "../infakt";
import type { InfaktInvoicePayload, InfaktOssInvoicePayload } from "../infakt/types";
import type { ResolvedInfaktOptions } from "../options";
import { ADDRESS_INCOMPLETE_PREFIX, buildInfaktInvoicePayload } from "./builder";
import type { InvoiceOrderInput } from "./builder";
import type { IssuedNumberClaim } from "./invoice-number";
import { collisionReason, findNumberCollision } from "./invoice-number";
import { decideKsef } from "./ksef";
import { buildOssInvoicePayload } from "./oss-builder";
import { toMinorUnits, warsawDate } from "./money";
import type { MedusaOrderLike } from "./order-mapper";
import { toInvoiceBuyerInput, toInvoiceOrderInput } from "./order-mapper";
import { evaluatePaidGate } from "./paid";
import { parseSettledAt } from "./settlement";
import type { VatRegime } from "./regime";
import { MossRateCache, resolveOrderRegime } from "./resolve-regime";
import type { EuB2cSale } from "./threshold";
import { alertMessage } from "./threshold";
import {
  CRASH_WINDOW_MESSAGE,
  classifyKsefStatus,
  dataWaitSignal,
  deferSignal,
  KSEF_RIDE_BUDGET_MS,
  KSEF_RIDE_FIRST_DELAY_MS,
  KSEF_RIDE_MAX_DELAY_MS,
  nextStep,
  PAID_SETTLE_MS,
  reviewSignal,
  skipSignal,
  truncateError,
  UNPAID_RETRY_MS,
  withinDataWaitGrace,
} from "./state-machine";
import type { InvoiceStateRow, PipelineSignal, PipelineStep } from "./state-machine";

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
  /**
   * The wall clock at which THIS RUN stops riding external work to completion.
   *
   * One deadline for the whole run, created once by the caller, rather than one
   * budget per row. That is what bounds how long a batch can hold the
   * single-flight claim: twenty rows cannot each ride for two and a half
   * minutes, because they are all racing the same deadline, and once it passes
   * every remaining row simply defers to the cron - which is what the cron is
   * for. Absent, each row falls back to its own `KSEF_RIDE_BUDGET_MS`.
   */
  rideUntil?: Date;
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

/**
 * How long to wait before reading back a freshly marked-paid invoice.
 *
 * The same ride as `CREATE_SETTLE_MS`, for the same reason and with the same
 * budget: `POST /async/invoices/{uuid}/paid.json` is asynchronous, so HTTP 201
 * means the task was accepted, not that the invoice is paid. Reading the status
 * back in the same breath as the write would prove nothing. If it has not
 * settled, the read-back is simply inconclusive and the row completes with the
 * payment unconfirmed - the wait is an optimisation, never a correctness
 * requirement.
 */

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
  // exactly where its persisted columns say it is. The bound is the number of
  // steps plus headroom: it exists to turn a step that fails to advance the row
  // into a stalled row rather than a hot loop, not to limit real progress.
  for (let guard = 0; guard < 12; guard += 1) {
    const { step, crashWindow } = nextStep(row, { emitEvent: deps.options.emitIssuedEvent });
    if (crashWindow) {
      // inFakt has no idempotency key: re-POSTing the create would issue a SECOND
      // real numbered invoice. A human checks inFakt and either adopts the stray
      // invoice or clears the marker. Never automatic.
      throw reviewSignal(CRASH_WINDOW_MESSAGE);
    }
    if (step === "complete") {
      warnUnconfirmedPayment(row, deps);
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
      await resolveCreateTask(row, deps);
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
    case "confirm-paid": {
      await confirmPaid(row, deps);
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
    throw buildFailureSignal(built.reason, row);
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
    // The row has stopped waiting for data - whatever it was waiting for is here.
    defer_reason: null,
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
 * What a refused payload means: a human's problem, or data that has not landed.
 *
 * Almost every build failure is a decision only a person can make - a company
 * name that would reach a legal document mangled, a VAT id that could not be
 * confirmed - and every one of those still parks the row exactly as before.
 *
 * One reason is different. The buyer's billing details arrive WITH the payment
 * on a marketplace order, so the first attempt can genuinely run before they
 * exist: on `order_01M1H1PA8BHJMKFPBZWA78F5XQ` the row was queued at 12:36:24,
 * parked at 12:36:25 for a missing street, city and postal code, and the real
 * address was written 16 seconds later. Parking that - terminal, with an admin
 * notification - is a review request for something that resolves itself.
 *
 * So the address-incomplete reason, and only that reason, defers while the row
 * is young. Matched on the constant the gate itself exports, so re-wording the
 * message moves both together instead of silently ceasing to match. Past the
 * grace window it becomes the same `needs_review` it always was, with the same
 * message plus what the wait proved.
 */
function buildFailureSignal(reason: string, row: InvoiceRow): PipelineSignal {
  if (!reason.startsWith(ADDRESS_INCOMPLETE_PREFIX)) {
    return reviewSignal(reason);
  }
  if (withinDataWaitGrace(row)) {
    return dataWaitSignal(reason);
  }
  return reviewSignal(`${reason} - the order still has no address an hour after it was queued`);
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
async function resolveCreateTask(row: InvoiceRow, deps: PipelineDeps): Promise<void> {
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

/**
 * Step 5: ride KSeF to a terminal state, then record what it decided.
 *
 * KSeF settles in about 90 seconds (84 s and 64 s on the two orders measured),
 * so polling once and deferring meant an invoice that was accepted at 12:41:27
 * was only recorded as done at 12:45:09 - the 2-minute defer really waits for
 * the next 5-minute cron boundary. Nothing about the invoice needed those
 * minutes; the plugin was simply waiting for a sweep, and a sweep is a safety
 * net, not the mechanism.
 *
 * So this rides the poll on a growing backoff inside the same run, exactly as
 * `CREATE_SETTLE_MS` already rides the create task, and falls back to the
 * ordinary defer when it does not settle - the cron still catches it.
 *
 * Two bounds, both deliberate:
 *
 *  - `ksef_status` is persisted BEFORE every subsequent call, so a crash mid-ride
 *    resumes from what was actually last seen rather than from memory.
 *  - the ride is capped by wall clock, and by a deadline SHARED across the whole
 *    run when the caller supplies one (`deps.rideUntil`). A batch of twenty rows
 *    therefore cannot each hold the single-flight claim for minutes: they race
 *    one budget, and whatever is left over defers.
 */
async function pollKsef(row: InvoiceRow, deps: PipelineDeps): Promise<void> {
  if (!row.invoice_uuid) {
    throw reviewSignal("no invoice uuid to poll KSeF for");
  }

  const rideUntil = deps.rideUntil?.getTime() ?? Date.now() + KSEF_RIDE_BUDGET_MS;
  let waited = 0;
  let delay = KSEF_RIDE_FIRST_DELAY_MS;

  for (;;) {
    const status = await deps.client.getKsefStatus(row.invoice_uuid);
    const classified = classifyKsefStatus(status);

    if (classified.kind === "error") {
      await patch(row, deps, { ksef_status: status.status });
      throw reviewSignal(classified.message);
    }
    if (classified.kind === "done") {
      await patch(row, deps, { ksef_number: classified.ksefNumber, ksef_status: status.status });
      return;
    }

    // Persisted before the next call, and before the sleep, so nothing about this
    // ride lives only in memory.
    await patch(row, deps, { ksef_status: status.status });

    // Both clocks are checked: `waited` bounds this row on its own, and
    // `rideUntil` bounds every row in the run together.
    if (waited + delay > KSEF_RIDE_BUDGET_MS || Date.now() + delay > rideUntil) {
      throw deferSignal("KSeF is still processing the invoice");
    }
    await (deps.sleep ?? defaultSleep)(delay);
    waited += delay;
    delay = Math.min(delay * 2, KSEF_RIDE_MAX_DELAY_MS);
  }
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
      `[medusa-infakt] could not emit infakt.invoice.issued for order ${row.order_id}: ${describeError(error)}`,
    );
  }
  await patch(row, deps, { event_emitted_at: new Date() });
}

/**
 * Step 7, and the last thing this pipeline does: tell inFakt the invoice is
 * paid, then read the invoice back and prove the marking took.
 *
 * ## Why a marking is not evidence
 *
 * `POST /async/invoices/{uuid}/paid.json` is asynchronous - HTTP 201 means the
 * task was accepted, not that the invoice is paid - and the `status` it
 * eventually writes is a single last-write-wins enum (`draft`, `sent`,
 * `printed`, `paid`). Any later action on the document overwrites it, including
 * a plain PDF download (see the docblock on `getInvoicePdf` in
 * `src/lib/infakt/client.ts`). In one estate several actors touch a fresh
 * invoice within seconds of it being issued, so firing the marking and moving on
 * leaves the invoice showing as awaiting payment with nobody the wiser. That is
 * what this step exists to stop.
 *
 * ## What is read back, and why it is not `status`
 *
 * `paid_date` - the day inFakt has the document settled on - and nothing else.
 * It is written by the paid endpoint and SURVIVES every later action on the
 * document, which is precisely what `status` does not do. Production invoice
 * 2/09/2026 is the proof: marked at 12:40:03, `paid_date` intact, `status`
 * flipped to `sent` three seconds later by our own Allegro attachment fetching
 * the PDF. A read-back against `status` measures who touched the document last,
 * not whether the marking took, and reported perfectly good invoices as
 * unconfirmed.
 *
 * `paid_price` and `left_to_pay` are not the signal either, in the other
 * direction: invoice 9/08/2026 carries `status: "paid"` together with
 * `paid_price: 0`. Neither amount is read here.
 *
 * ## Why it does not re-mark
 *
 * Losing that race is the expected outcome, not a broken request - so re-marking
 * until the read-back agrees cannot work: whatever overwrote `status` the first
 * time will overwrite it again. An earlier version tried anyway, deferring the
 * row between attempts for fifteen minutes, and the only thing it reliably
 * achieved was holding an issued, KSeF-filed invoice out of `done`.
 *
 * So the marking is sent once and read back once, for evidence. If the evidence
 * is inconclusive the row completes anyway, an operator is told, and the
 * settlement reconciliation (`src/lib/invoicing/settle.ts`) picks the row up on
 * its own schedule - a row that completes without a `settled_at` is exactly what
 * that mechanism exists to find. Not a retry loop wedged into the issuing
 * pipeline.
 *
 * `allow_correction` is deliberately NOT sent. It permits inFakt to book an
 * accounting correction, which is the account owner's decision and not this
 * plugin's to make on their behalf.
 *
 * Still best-effort in the sense that matters: the invoice is already issued,
 * already numbered and already filed to KSeF by the time this runs, and nothing
 * here can fail or park it. The worst outcome is a row that completes with the
 * payment unconfirmed, which is warned about and shown in the admin widget.
 */
async function confirmPaid(row: InvoiceRow, deps: PipelineDeps): Promise<void> {
  const uuid = row.invoice_uuid;
  if (!uuid) {
    // Unreachable: `paidConfirmationDue` refuses a row with no invoice.
    return;
  }

  const firstMarking = !row.paid_marked_at;
  try {
    // The paid date must not precede the invoice date, and the invoice is dated
    // today in Warsaw - so today is the only always-valid value. An order paid
    // last week is still recorded as settled, just not back-dated.
    await deps.client.markPaid(uuid, warsawDate());
  } catch (error) {
    deps.logger.warn(
      `[medusa-infakt] mark-paid failed for invoice ${uuid} (order ${row.order_id}): ${describeError(error)}`,
    );
  }
  if (firstMarking) {
    // Written even when the call above threw, and never rewritten afterwards.
    // It is what bounds the retry window, so a marking that can never succeed
    // has to start the clock rather than reset it on every pass.
    await patch(row, deps, { paid_marked_at: new Date() });
  }

  let settledAt: Date | null = null;
  try {
    await (deps.sleep ?? defaultSleep)(PAID_SETTLE_MS);
    const invoice = await deps.client.getInvoice(uuid);
    settledAt = parseSettledAt(invoice.paidDate);
  } catch (error) {
    deps.logger.warn(
      `[medusa-infakt] could not read back the paid date of invoice ${uuid} (order ${row.order_id}): ${describeError(error)}`,
    );
  }

  if (settledAt) {
    // Three columns, three different facts: our marking was seen to take
    // (`paid_confirmed_at`), inFakt has the document settled on this day
    // (`settled_at`), and somebody has looked (`settlement_checked_at`). The
    // last one is what keeps the reconciliation from re-reading, minutes later,
    // an invoice this run just read.
    const now = new Date();
    await patch(row, deps, {
      paid_confirmed_at: now,
      settled_at: settledAt,
      settlement_checked_at: now,
      settlement_drift: null,
    });
    return;
  }
  // Inconclusive, and that is the end of it. Say nothing here: the row is about
  // to complete, and `warnUnconfirmedPayment` reports it there exactly once.
}

/**
 * Say out loud that an issued invoice is completing with its payment unconfirmed.
 *
 * At completion rather than at the last retry, because that is the one moment
 * that happens exactly once per row whichever way the budget ran out. Carries the
 * invoice uuid and the order id and nothing else - no buyer data, as everywhere
 * else in this file.
 */
function warnUnconfirmedPayment(row: InvoiceRow, deps: PipelineDeps): void {
  if (!(row.paid_marked_at && row.invoice_uuid) || row.paid_confirmed_at) {
    return;
  }
  deps.logger.warn(
    `[medusa-infakt] invoice ${row.invoice_uuid} (order ${row.order_id}) was marked paid in inFakt but read back with no paid date - inFakt still shows it awaiting payment. The settlement reconciliation will re-check it; settle it in inFakt by hand if it stays that way`,
  );
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
      `[medusa-infakt] could not email the cross-border invoice for order ${row.order_id}: ${describeError(error)}`,
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
      `[medusa-infakt] could not raise the OSS threshold alert: ${describeError(error)} - ${message}`,
    );
  }
}
