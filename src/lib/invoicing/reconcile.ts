import {
  filterByIdentity,
  filterByTotal,
  normalizeEmail,
  normalizeName,
  normalizeTaxId,
} from "./matching";
import type { MatchInvoiceCandidate, MatchOrderInput } from "./matching";
import { bigNumberToMinorUnits, warsawDate } from "./money";
import { normalizeNip } from "./nip";
import type { NipExtractorOrder } from "./nip";
import type { MedusaOrderLike } from "./order-mapper";

/**
 * Adoption of invoices that already exist in inFakt, planned from ORDER DATA.
 *
 * ## What this is for
 *
 * A store arrives with history: orders that were invoiced before this plugin
 * existed, invoiced by another system, or invoiced correctly while whatever export
 * produced the ledger lost the number. The invoice is real, it is filed, it is in
 * inFakt - only this plugin's ledger does not know about it. This module decides,
 * from the order alone, WHICH inFakt invoice belongs to WHICH order.
 *
 * inFakt is the only source consulted. No legacy system is read, and nothing here
 * knows one ever existed - an adopted row is derived from the order and from the
 * document inFakt holds, and from nothing else.
 *
 * ## The signals: person, date, amount - and chronology only to separate twins
 *
 * Every gate below is a hard requirement. A candidate that fails any one of them is
 * out; there is no score to trade one signal off against another.
 *
 *  1. **Date window.** `invoice_date` must sit within `dateToleranceDays` calendar
 *     days of the order's Warsaw calendar day. An invoice with no date cannot clear
 *     this and is dropped. This is the gate that keeps a repeat customer's later
 *     order from matching an earlier invoice for the same basket.
 *  2. **Buyer identity** (`filterByIdentity`). A B2B order (a NIP on the order)
 *     requires an exact normalized NIP match. A B2C order requires an exact email
 *     match OR an exact normalized full-name match.
 *  3. **Gross total** (`filterByTotal`). Grosz-for-grosz integer equality, no
 *     tolerance, with the currency agreeing when both sides state one.
 *
 * What an invoice CALLS its lines is not a signal, at any strength. The two systems
 * name a line their own way for legitimate documents, so a name check can only ever
 * report a correct match as weaker than it is. See the note in `matching.ts`.
 *
 * ## Unambiguous, or chronological, or nothing
 *
 * A unique survivor is adopted. Several survivors are AMBIGUOUS and reported for a
 * human - never narrowed by picking the nearest date or the prettiest candidate.
 *
 * The one exception is the case the nearest-date rule could never settle honestly:
 * the same buyer placing SEVERAL orders on one day for the SAME amount, invoiced
 * with several documents that are equally identical. There nothing but chronology
 * separates them, so `pairDuplicatesByChronology` orders those orders by the moment
 * they were placed, orders the invoices by their number within their shared issue
 * date, and pairs them off one to one. It engages only when the two sides are
 * mutually indistinguishable AND equal in number; anything else (an odd count, a
 * differing issue date, an unreadable number series, an invoice another order also
 * wants) refuses the whole group and says why per order.
 *
 * Two orders that resolve to the SAME invoice both become ambiguous
 * (`rejectContestedInvoices`), because one document cannot settle two orders.
 *
 * ## Nothing here writes, and nothing here issues
 *
 * This module returns a plan. It has no I/O, no clock beyond the dates it is given,
 * and no way to reach inFakt. Adoption records a document that already exists: no
 * invoice is created, none is filed to KSeF, and no `infakt.invoice.issued` event
 * is emitted for it.
 */

/** How many candidate pages the caller should read before giving up. */
export const MAX_INVOICE_PAGES = 20;
/** inFakt caps a list page at 100. */
export const INVOICE_PAGE_SIZE = 100;
/** Default `invoice_date` tolerance, in calendar days, either side of the order. */
export const DEFAULT_DATE_TOLERANCE_DAYS = 7;
/** Upper bound an operator may ask for. Beyond a month the date gate stops gating. */
export const MAX_DATE_TOLERANCE_DAYS = 31;

export type AdoptionDecision = "adopt" | "ambiguous" | "no_match";
export type AdoptionConfidence = "high" | "medium";
export type IdentitySignal = "nip" | "email" | "name";
/** How the one surviving candidate was arrived at. */
export type TieBreaker = "none" | "chronological";

/** One order, reduced to exactly the facts the rules above read. */
export interface ReconcileOrder extends MatchOrderInput {
  displayId?: number | string | null;
  /** The order's Warsaw calendar day, YYYY-MM-DD. */
  orderDay: string;
  /**
   * An invoice number the order itself already names
   * (`order.metadata.invoice_number`, the same key the pipeline's
   * already-invoiced-elsewhere guard reads).
   *
   * When present it is treated as a hard gate, not a hint: the matched invoice must
   * BE that one. An order that names an invoice and matches a different one by
   * amount and buyer is not a discovery, it is a warning.
   */
  declaredInvoiceNumber?: string;
}

/**
 * What matched, in a form that is safe to persist on the ledger row.
 *
 * Deliberately signal KINDS and numbers only - `identity: "email"`, never the email
 * itself. The `infakt_invoice` table holds no buyer data (see the model), and an
 * audit trail is not a reason to start.
 */
export interface AdoptionEvidence {
  source: "infakt-reconcile";
  invoice_uuid: string;
  invoice_number: string | null;
  invoice_date: string | null;
  confidence: AdoptionConfidence;
  identity: IdentitySignal;
  gross_total_minor: number;
  currency: string | null;
  /** Signed offset in calendar days, invoice date minus order day. */
  date_offset_days: number;
  /** Whether the order itself already named this invoice number. */
  declared_by_order: boolean;
  /** Invoices that cleared the date window before identity and total narrowed it. */
  candidates_in_window: number;
  /**
   * `"chronological"` when this order was one of several same-day duplicates from
   * one buyer and only the order of the documents in time told them apart.
   */
  tie_breaker: TieBreaker;
  /** 1-based place of this order among the duplicates. Only when tie-broken. */
  duplicate_index?: number;
  /** How many duplicate orders were paired together. Only when tie-broken. */
  duplicate_count?: number;
}

export interface AdoptionCandidateSummary {
  uuid: string;
  number: string | null;
  invoiceDate: string | null;
  grossPrice: number | null;
}

export interface AdoptionPlanEntry {
  orderId: string;
  displayId?: number | string | null;
  decision: AdoptionDecision;
  /** Present only for `adopt`. */
  invoice?: AdoptionCandidateSummary;
  /** Present only for `adopt`. */
  confidence?: AdoptionConfidence;
  /** Present only for `adopt`. Persisted verbatim on the adopted row. */
  evidence?: AdoptionEvidence;
  /** The NIP on the matched invoice, when it carries one. Decides KSeF. */
  invoiceTaxCode?: string;
  /** Everything that survived every gate. One entry for `adopt`, several for `ambiguous`. */
  candidates: AdoptionCandidateSummary[];
  /** Written for the operator reading the dry run. */
  reasons: string[];
}

export interface ReconcileOptions {
  dateToleranceDays: number;
}

// --- Date window ---

/** Midnight UTC of a YYYY-MM-DD day, as a fixed reference instant. */
function dayTime(day: string): number {
  return new Date(`${day.slice(0, 10)}T00:00:00.000Z`).getTime();
}

/**
 * Signed distance in calendar days from the order's day to the invoice's date, or
 * null when either side is missing or unparseable. Null is a refusal, never a zero:
 * an undated invoice must not look like a same-day one.
 */
export function dateOffsetDays(orderDay: string, invoiceDate?: string): number | null {
  if (!invoiceDate) {
    return null;
  }
  const orderTime = dayTime(orderDay);
  const invoiceTime = dayTime(invoiceDate);
  if (Number.isNaN(orderTime) || Number.isNaN(invoiceTime)) {
    return null;
  }
  return Math.round((invoiceTime - orderTime) / 86_400_000);
}

export function filterByDateWindow(
  order: ReconcileOrder,
  candidates: MatchInvoiceCandidate[],
  toleranceDays: number,
): MatchInvoiceCandidate[] {
  return candidates.filter((candidate) => {
    const offset = dateOffsetDays(order.orderDay, candidate.invoiceDate);
    return offset !== null && Math.abs(offset) <= toleranceDays;
  });
}

/** Clamp an operator-supplied tolerance into the supported range. */
export function resolveDateTolerance(requested: unknown): number {
  const value = Number.parseInt(String(requested ?? ""), 10);
  if (!Number.isFinite(value) || value < 0) {
    return DEFAULT_DATE_TOLERANCE_DAYS;
  }
  return Math.min(value, MAX_DATE_TOLERANCE_DAYS);
}

// --- Mapping ---

/**
 * A non-blank string out of order metadata, or undefined. Mirrors the pipeline's
 * own reader: a `null`, a number or whitespace is not an invoice number, and any of
 * them would otherwise gate an ordinary order on nothing.
 */
const metadataString = (
  metadata: Record<string, unknown> | null | undefined,
  key: string,
): string | undefined => {
  const raw = metadata?.[key];
  if (typeof raw !== "string") {
    return undefined;
  }
  return raw.trim() || undefined;
};

/**
 * The order's creation instant as a plain ISO string, or undefined when there is
 * none to read. Undefined is a refusal: an order with no readable placement time
 * cannot take part in a chronological pairing, and defaulting it to "now" would
 * put every such order last in a sequence it has no business being sorted into.
 */
const placedAtIso = (value?: string | Date | null): string | undefined => {
  if (!value) {
    return undefined;
  }
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
};

const fullNameOf = (order: MedusaOrderLike): string | undefined => {
  const address = order.billing_address ?? order.shipping_address ?? null;
  const name = [address?.first_name, address?.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");
  return name || undefined;
};

/**
 * Map a Medusa order onto the facts the rules read.
 *
 * The order's day is its WARSAW calendar day, because that is the day an invoice
 * for it would be dated - an order placed at 23:30 UTC belongs to the next Polish
 * day, and comparing raw timestamps would put it a day away from its own invoice.
 *
 * `orderDate` keeps the raw creation instant alongside it. The day is what every
 * gate compares; the instant is read by nothing except the chronological pairing of
 * same-day duplicates, where the whole question is which of two orders came first.
 *
 * Line items are deliberately NOT carried over. Nothing downstream may look at what
 * a line is called, and the surest way to keep it that way is not to hand the names
 * to the rules at all.
 */
export function toReconcileOrder(
  order: MedusaOrderLike,
  nipExtractor: (order: NipExtractorOrder) => string | undefined,
  fallbackCurrency: string,
): ReconcileOrder {
  const taxId = nipExtractor(order);
  return {
    currency: (order.currency_code ?? fallbackCurrency).toUpperCase(),
    declaredInvoiceNumber: metadataString(order.metadata, "invoice_number"),
    displayId: order.display_id ?? null,
    email: order.email ?? undefined,
    fullName: fullNameOf(order),
    // Never `?? 0`. An unreadable total is a fact about the read, not a fact
    // about the order, and defaulting it here is what made every order compare
    // as worth nothing - matching an invoice on amount then could never succeed.
    grossTotal: bigNumberToMinorUnits(order.total),
    isCompany: Boolean(taxId),
    orderDate: placedAtIso(order.created_at),
    orderDay: warsawDate(order.created_at ?? null),
    orderId: order.id,
    taxId,
  };
}

const summarize = (candidate: MatchInvoiceCandidate): AdoptionCandidateSummary => ({
  grossPrice: candidate.grossPrice ?? null,
  invoiceDate: candidate.invoiceDate ?? null,
  number: candidate.number ?? null,
  uuid: candidate.uuid,
});

/** Which identity signal carried the match, for the audit trail. */
function identitySignal(order: ReconcileOrder, candidate: MatchInvoiceCandidate): IdentitySignal {
  if (order.isCompany) {
    return "nip";
  }
  const orderEmail = order.email?.trim().toLowerCase();
  const candidateEmail = candidate.clientEmail?.trim().toLowerCase();
  return orderEmail && candidateEmail && orderEmail === candidateEmail ? "email" : "name";
}

// --- Confidence ---

const IDENTITY_LABEL: Record<IdentitySignal, string> = {
  email: "the buyer's email address",
  name: "the buyer's full name",
  nip: "the buyer's NIP",
};

/** How far the issue date sat from the order, in words an operator can read. */
function offsetPhrase(offset: number): string {
  if (offset === 0) {
    return "issued on the order's own day";
  }
  const days = Math.abs(offset);
  return offset > 0
    ? `issued ${days} day(s) after the order`
    : `issued ${days} day(s) before the order`;
}

/**
 * What separates a match a human need not look at from one they should.
 *
 * With item names gone, four facts are left, and only three of them say anything
 * about how strongly this document is tied to this order:
 *
 *  - **Which identity signal carried it.** A NIP and an email address are keys: two
 *    different buyers do not share them. A full name is not - "Jan Kowalski" is
 *    thousands of people, and a name-only match plus a same-day, same-amount
 *    coincidence is precisely the near-miss a human catches and a rule cannot.
 *  - **How far the issue date sat from the order.** Same day or next day is the
 *    ordinary rhythm of invoicing. Anything further is still inside the window an
 *    operator asked for, but it is no longer the obvious document.
 *  - **Whether chronology had to settle it.** A tie-broken match is correct only if
 *    the assumption behind it holds - that duplicate orders were invoiced in the
 *    order they were placed. That is a sound default and a bad thing to auto-apply
 *    unseen, so it never grades `high`.
 *
 * An order that NAMES its invoice number outranks all of that: the match is then not
 * an inference at all, it is the order's own claim confirmed against the document.
 *
 * The fourth fact, how many invoices were in the date window, is recorded as
 * evidence but deliberately does NOT grade. It measures how busy the window was, not
 * how good this match is: candidates that lost on identity or on amount lost on a
 * hard gate, and letting their number darken a survivor would mark every match in a
 * busy week as weaker than the same match in a quiet one.
 */
export function gradeConfidence(input: {
  identity: IdentitySignal;
  dateOffsetDays: number;
  tieBreaker: TieBreaker;
  declaredByOrder: boolean;
}): { confidence: AdoptionConfidence; reason: string } {
  if (input.tieBreaker === "chronological") {
    return {
      confidence: "medium",
      reason:
        "Confidence medium: this order and its invoice were told apart from same-day duplicates by their order in time alone. Check the pairing before approving it.",
    };
  }
  if (input.declaredByOrder) {
    return {
      confidence: "high",
      reason:
        "Confidence high: the order names this invoice number itself, and the document matches it on buyer, amount and issue date.",
    };
  }
  if (input.identity === "name") {
    return {
      confidence: "medium",
      reason:
        "Confidence medium: the buyer was matched on a full name, which two different people can share. Amount and issue date agree, but no NIP or email confirmed who this is.",
    };
  }
  if (Math.abs(input.dateOffsetDays) > 1) {
    return {
      confidence: "medium",
      reason: `Confidence medium: the buyer and the amount are exact, but the invoice was ${offsetPhrase(input.dateOffsetDays)}, which is inside the window rather than the obvious same-day document.`,
    };
  }
  return {
    confidence: "high",
    reason: `Confidence high: the buyer was matched on ${IDENTITY_LABEL[input.identity]}, the gross total is exact to the grosz, and the invoice was ${offsetPhrase(input.dateOffsetDays)}.`,
  };
}

// --- The plan ---

/** One order, its surviving candidates, and the reason lines built so far. */
interface OrderPlan {
  order: ReconcileOrder;
  entry: AdoptionPlanEntry;
  /** Candidates that cleared the window, identity, total and declared-number gates. */
  survivors: MatchInvoiceCandidate[];
  /** Invoices in the date window, before identity and total narrowed them. */
  inWindowCount: number;
  /** The reason lines before any decision-specific line was appended. */
  baseReasons: string[];
  declared?: string;
}

/** Build the `adopt` entry for one order and one invoice, with its evidence. */
function adoptEntry(
  plan: Pick<OrderPlan, "order" | "inWindowCount" | "baseReasons" | "declared">,
  invoice: MatchInvoiceCandidate,
  tie: { breaker: TieBreaker; index?: number; count?: number; reason?: string },
): AdoptionPlanEntry {
  const { order } = plan;
  const identity = identitySignal(order, invoice);
  const offset = dateOffsetDays(order.orderDay, invoice.invoiceDate) ?? 0;
  const grade = gradeConfidence({
    dateOffsetDays: offset,
    declaredByOrder: Boolean(plan.declared),
    identity,
    tieBreaker: tie.breaker,
  });

  const reasons = [...plan.baseReasons];
  if (tie.reason) {
    reasons.push(tie.reason);
  }
  reasons.push(
    `Matched on ${IDENTITY_LABEL[identity]}, a gross total equal to the grosz, and an invoice ${offsetPhrase(offset)}.`,
    grade.reason,
  );

  return {
    candidates: [summarize(invoice)],
    confidence: grade.confidence,
    decision: "adopt",
    displayId: order.displayId,
    evidence: {
      candidates_in_window: plan.inWindowCount,
      confidence: grade.confidence,
      currency: invoice.currency ?? order.currency ?? null,
      date_offset_days: offset,
      declared_by_order: Boolean(plan.declared),
      duplicate_count: tie.count,
      duplicate_index: tie.index,
      // Never actually null here: `planOne` returns a refusal before any candidate
      // is considered when the total could not be read, and the pairing skips such
      // orders. The fallback only satisfies the type.
      gross_total_minor: order.grossTotal ?? 0,
      identity,
      invoice_date: invoice.invoiceDate ?? null,
      invoice_number: invoice.number ?? null,
      invoice_uuid: invoice.uuid,
      source: "infakt-reconcile",
      tie_breaker: tie.breaker,
    },
    invoice: summarize(invoice),
    invoiceTaxCode: invoice.clientTaxCode,
    orderId: order.orderId,
    reasons,
  };
}

function planOne(
  order: ReconcileOrder,
  invoices: MatchInvoiceCandidate[],
  options: ReconcileOptions,
): OrderPlan {
  // An order whose total could not be read cannot clear the amount gate, and
  // must not be silently compared against 0. Say so instead of reporting the
  // ordinary "nothing matched the gross total 0", which reads like a genuine
  // absence of candidates while actually being a data problem on this side.
  if (order.grossTotal === null) {
    const reasons = [
      "The order's gross total could not be read, so no invoice can be matched on amount. Refusing rather than comparing every candidate against 0.",
    ];
    return {
      baseReasons: reasons,
      entry: {
        candidates: [],
        decision: "no_match",
        displayId: order.displayId,
        orderId: order.orderId,
        reasons,
      },
      inWindowCount: 0,
      order,
      survivors: [],
    };
  }

  const inWindow = filterByDateWindow(order, invoices, options.dateToleranceDays);
  const byIdentity = filterByIdentity(order, inWindow);
  const byTotal = filterByTotal(order, byIdentity);
  const declared = order.declaredInvoiceNumber?.trim();
  const survivors = declared
    ? byTotal.filter((candidate) => candidate.number?.trim() === declared)
    : byTotal;

  const baseReasons = [
    `${inWindow.length} invoice(s) dated within ${options.dateToleranceDays} day(s) of ${order.orderDay}, ${byIdentity.length} of those were issued to this buyer, ${byTotal.length} of those matched the gross total ${order.grossTotal} to the grosz.`,
  ];
  if (declared) {
    baseReasons.push(
      survivors.length > 0
        ? `The order already names invoice ${declared}, and that is the one that matched.`
        : `The order names invoice ${declared}, which is NOT among the invoices that matched - refusing rather than adopting a different document.`,
    );
  }

  const context = { baseReasons, declared, inWindowCount: inWindow.length, order, survivors };

  if (survivors.length === 0) {
    return {
      ...context,
      entry: {
        candidates: [],
        decision: "no_match",
        displayId: order.displayId,
        orderId: order.orderId,
        reasons: baseReasons,
      },
    };
  }

  if (survivors.length > 1) {
    // Left ambiguous here; `pairDuplicatesByChronology` may still settle it when
    // this order turns out to be one of several same-day duplicates whose invoices
    // can be paired off one to one.
    return {
      ...context,
      entry: {
        candidates: survivors.map(summarize),
        decision: "ambiguous",
        displayId: order.displayId,
        orderId: order.orderId,
        reasons: [
          ...baseReasons,
          `Ambiguous - refusing to guess between ${survivors.map((candidate) => candidate.number ?? candidate.uuid).join(", ")}.`,
        ],
      },
    };
  }

  return { ...context, entry: adoptEntry(context, survivors[0], { breaker: "none" }) };
}

// --- Chronological pairing of same-day duplicate orders ---

/**
 * The digit runs in an invoice number, and the number with each of them blanked.
 *
 * "3/08/2031" reads as `#/#/#` with [3, 8, 2026]; "ZR-009009" as `ZR-#` with
 * [9009]. Comparing the skeletons first is what keeps two DIFFERENT numbering
 * series from being sorted against each other as if they were one sequence.
 */
function numberParts(value: string): { skeleton: string; values: number[] } | null {
  const runs = value.match(/\d+/gu);
  if (!runs) {
    return null;
  }
  return {
    skeleton: value.replaceAll(/\d+/gu, "#"),
    values: runs.map((run) => Number.parseInt(run, 10)),
  };
}

/**
 * Put invoices in the order they were issued, or refuse.
 *
 * inFakt's list response carries a `number`, an `invoice_date` and a `uuid` -
 * nothing else that counts. The uuid is opaque and says nothing about sequence, and
 * these candidates already share an issue date (the caller checks that), so the
 * number is the only thing left that records the order of issue.
 *
 * Rather than assume where the counter sits in a number - inFakt's default is
 * "3/08/2031", a store on custom numbering may issue "ZR-009009", and picking "the
 * first digits" would read the year out of "2026/08/3" - the sequence is DERIVED:
 * every number must share one skeleton, and exactly one digit position may vary
 * across them. That varying position is the counter, whatever the format, and it
 * sorts the documents.
 *
 * Returns null whenever that is not unambiguously true: a missing or digit-less
 * number, two different formats, more than one varying position (nothing says which
 * is the counter), or a repeated counter value. Null means refuse, never guess.
 */
export function orderInvoicesBySequence(
  invoices: MatchInvoiceCandidate[],
): MatchInvoiceCandidate[] | null {
  if (invoices.length < 2) {
    return null;
  }
  const parsed: { invoice: MatchInvoiceCandidate; skeleton: string; values: number[] }[] = [];
  for (const invoice of invoices) {
    const number = invoice.number?.trim();
    const parts = number ? numberParts(number) : null;
    if (!parts || parts.values.length === 0 || parts.values.some((value) => Number.isNaN(value))) {
      return null;
    }
    parsed.push({ invoice, skeleton: parts.skeleton, values: parts.values });
  }
  // One skeleton means one numbering series, and (having the same count of blanks)
  // the same digit positions to compare.
  if (parsed.some((entry) => entry.skeleton !== parsed[0].skeleton)) {
    return null;
  }

  const width = parsed[0].values.length;
  const varying = [...Array.from({ length: width }).keys()].filter(
    (index) => new Set(parsed.map((entry) => entry.values[index])).size > 1,
  );
  if (varying.length !== 1) {
    return null;
  }
  const counter = varying[0];
  const counters = parsed.map((entry) => entry.values[counter]);
  if (new Set(counters).size !== counters.length) {
    return null;
  }
  return [...parsed]
    .sort((a, b) => a.values[counter] - b.values[counter])
    .map((entry) => entry.invoice);
}

/** Orders oldest first, or null when any two cannot be told apart in time. */
function orderOrdersByPlacement(orders: ReconcileOrder[]): ReconcileOrder[] | null {
  const stamped: { order: ReconcileOrder; time: number }[] = [];
  for (const order of orders) {
    const time = order.orderDate ? Date.parse(order.orderDate) : Number.NaN;
    if (Number.isNaN(time)) {
      return null;
    }
    stamped.push({ order, time });
  }
  if (new Set(stamped.map((entry) => entry.time)).size !== stamped.length) {
    return null;
  }
  return [...stamped].sort((a, b) => a.time - b.time).map((entry) => entry.order);
}

/** The buyer, as the identity gate sees them. Two orders share it or they do not. */
function buyerKey(order: ReconcileOrder): string {
  if (order.isCompany) {
    return `nip:${normalizeTaxId(order.taxId ?? "")}`;
  }
  return `b2c:${normalizeEmail(order.email ?? "")}|${normalizeName(order.fullName ?? "")}`;
}

/**
 * The group an order belongs to for pairing: same buyer, same day, same amount and
 * the very same set of surviving invoices. Anything that differs in any of those is
 * a different question and is decided on its own.
 */
function duplicateGroupKey(plan: OrderPlan): string {
  const uuids = plan.survivors
    .map((candidate) => candidate.uuid)
    .sort((a, b) => a.localeCompare(b))
    .join(",");
  return [
    buyerKey(plan.order),
    plan.order.orderDay,
    String(plan.order.grossTotal),
    plan.order.currency ?? "",
    uuids,
  ].join("|");
}

/** Turn a group's entries into refusals carrying one shared explanation. */
function refuseGroup(plans: OrderPlan[], reason: string): void {
  for (const plan of plans) {
    plan.entry = {
      candidates: plan.survivors.map(summarize),
      decision: "ambiguous",
      displayId: plan.order.displayId,
      orderId: plan.order.orderId,
      reasons: [...plan.baseReasons, reason],
    };
  }
}

/**
 * Settle same-day duplicate orders by the order of the documents in time.
 *
 * This is the one place chronology decides anything here, and it is fenced in hard.
 * A group qualifies only when EVERY other signal is equal across it: the same buyer,
 * the same Warsaw day, the same gross total, and the very same set of candidate
 * invoices, which must themselves agree on issue date, amount and currency. Then the
 * orders are sorted by when they were placed, the invoices by their number within
 * that shared issue date, and the two lists are zipped.
 *
 * Every other shape refuses, per order and with the reason:
 *
 *  - **Counts differ.** Three orders facing two identical invoices leaves every
 *    order in doubt, not just the last one: any two of the three could be the
 *    invoiced ones. There is nothing to pair unambiguously, so nothing is paired.
 *  - **A single order facing several candidates.** Chronology needs duplicate ORDERS
 *    to line up against; one order and two documents means the other document
 *    belongs to something outside this scan.
 *  - **The invoices are not twins** (different issue dates), so something other than
 *    chronology separates them and the nearest-date guess is exactly what this
 *    module refuses to make.
 *  - **The numbers do not form one readable sequence**, so their order of issue is
 *    not established.
 *  - **Two orders share a placement instant**, or one has none, so they cannot be
 *    put in order.
 *  - **An order outside the group also matches one of these invoices**, so pairing
 *    could hand over a document that belongs elsewhere.
 */
function pairDuplicatesByChronology(plans: OrderPlan[]): void {
  // Only orders still in play: an unreadable total or a declared invoice number has
  // already had its say, and a declared number is a stronger claim than any
  // ordering could be.
  const eligible = plans.filter(
    (plan) => plan.survivors.length > 0 && !plan.declared && plan.order.grossTotal !== null,
  );

  const claimants = new Map<string, Set<string>>();
  for (const plan of eligible) {
    for (const candidate of plan.survivors) {
      const orders = claimants.get(candidate.uuid) ?? new Set<string>();
      orders.add(plan.order.orderId);
      claimants.set(candidate.uuid, orders);
    }
  }

  const groups = new Map<string, OrderPlan[]>();
  for (const plan of eligible) {
    const key = duplicateGroupKey(plan);
    groups.set(key, [...(groups.get(key) ?? []), plan]);
  }

  for (const group of groups.values()) {
    const invoices = group[0].survivors;
    if (group.length === 1) {
      if (invoices.length > 1) {
        group[0].entry.reasons = [
          ...group[0].entry.reasons,
          `Only one order from this buyer on ${group[0].order.orderDay} for this amount, so there is nothing to pair the ${invoices.length} candidate invoices against - the others belong to something outside this scan.`,
        ];
      }
      continue;
    }

    const buyerDay = `${group.length} order(s) from this buyer on ${group[0].order.orderDay} for the same gross total`;

    const memberIds = new Set(group.map((plan) => plan.order.orderId));
    const contested = invoices.find((candidate) =>
      [...(claimants.get(candidate.uuid) ?? [])].some((orderId) => !memberIds.has(orderId)),
    );
    if (contested) {
      refuseGroup(
        group,
        `${buyerDay} could be paired by their order in time, but invoice ${contested.number ?? contested.uuid} is also matched by an order outside this group - refusing rather than handing over a document that may belong elsewhere.`,
      );
      continue;
    }

    const issueDates = new Set(invoices.map((candidate) => candidate.invoiceDate ?? ""));
    if (issueDates.size !== 1 || issueDates.has("")) {
      refuseGroup(
        group,
        `${buyerDay} face invoices that do NOT share one issue date (${[...issueDates].join(", ")}), so their dates, not just their order in time, tell them apart - refusing rather than picking by the nearest date.`,
      );
      continue;
    }

    if (group.length !== invoices.length) {
      refuseGroup(
        group,
        `${buyerDay} face ${invoices.length} invoice(s) that are identical on buyer, issue date and amount. The counts differ, so there is no way to tell which order went uninvoiced - refusing all of them rather than pairing some and guessing at the rest.`,
      );
      continue;
    }

    const sequenced = orderInvoicesBySequence(invoices);
    if (!sequenced) {
      refuseGroup(
        group,
        `${buyerDay} face invoices whose numbers (${invoices.map((candidate) => candidate.number ?? candidate.uuid).join(", ")}) do not form one readable sequence, so the order in which they were issued cannot be established - refusing.`,
      );
      continue;
    }

    const byPlacement = orderOrdersByPlacement(group.map((plan) => plan.order));
    if (!byPlacement) {
      refuseGroup(
        group,
        `${buyerDay} cannot be put in order: two of them carry the same placement time, or one carries none - refusing rather than pairing on an arbitrary order.`,
      );
      continue;
    }

    const planByOrderId = new Map(group.map((plan) => [plan.order.orderId, plan]));
    byPlacement.forEach((order, index) => {
      const plan = planByOrderId.get(order.orderId);
      const invoice = sequenced[index];
      if (!plan) {
        return;
      }
      plan.entry = adoptEntry(plan, invoice, {
        breaker: "chronological",
        count: group.length,
        index: index + 1,
        reason: `${buyerDay} were invoiced with ${sequenced.length} documents issued on ${invoice.invoiceDate ?? ""}, identical on buyer, date and amount. Paired by chronology: this order is number ${index + 1} of ${group.length} by the time it was placed (${order.orderDate ?? ""}), and takes invoice ${invoice.number ?? invoice.uuid}, number ${index + 1} of ${sequenced.length} by invoice number.`,
      });
    });
  }
}

/**
 * Downgrade every adoption whose invoice is claimed more than once.
 *
 * One inFakt document settles exactly one order. Two orders resolving to the same
 * invoice means at least one of them is wrong, and there is no way to tell which
 * from here - so both go to a human.
 */
export function rejectContestedInvoices(entries: AdoptionPlanEntry[]): AdoptionPlanEntry[] {
  const claims = new Map<string, number>();
  for (const entry of entries) {
    if (entry.decision === "adopt" && entry.invoice) {
      claims.set(entry.invoice.uuid, (claims.get(entry.invoice.uuid) ?? 0) + 1);
    }
  }
  return entries.map((entry) => {
    if (entry.decision !== "adopt" || !entry.invoice) {
      return entry;
    }
    if ((claims.get(entry.invoice.uuid) ?? 0) < 2) {
      return entry;
    }
    return {
      ...entry,
      confidence: undefined,
      decision: "ambiguous",
      evidence: undefined,
      invoice: undefined,
      invoiceTaxCode: undefined,
      reasons: [
        ...entry.reasons,
        `Refused: invoice ${entry.invoice.number ?? entry.invoice.uuid} matched more than one order, and one invoice can only settle one order.`,
      ],
    };
  });
}

/**
 * Downgrade every adoption whose invoice is already recorded on some other ledger
 * row, by uuid or by number.
 *
 * The number check matters as much as the uuid one: a row imported as an
 * already-issued document may carry only the number, and adopting that same
 * document onto a second order would report one invoice for two orders.
 */
export function rejectAlreadyLinked(
  entries: AdoptionPlanEntry[],
  linked: { uuids?: Iterable<string>; numbers?: Iterable<string> },
): AdoptionPlanEntry[] {
  const uuids = new Set(linked.uuids ?? []);
  const numbers = new Set(linked.numbers ?? []);
  return entries.map((entry) => {
    if (entry.decision !== "adopt" || !entry.invoice) {
      return entry;
    }
    const takenByUuid = uuids.has(entry.invoice.uuid);
    const takenByNumber = entry.invoice.number !== null && numbers.has(entry.invoice.number);
    if (!(takenByUuid || takenByNumber)) {
      return entry;
    }
    return {
      ...entry,
      confidence: undefined,
      decision: "ambiguous",
      evidence: undefined,
      invoice: undefined,
      invoiceTaxCode: undefined,
      reasons: [
        ...entry.reasons,
        `Refused: invoice ${entry.invoice.number ?? entry.invoice.uuid} is already recorded on another order in this ledger.`,
      ],
    };
  });
}

/**
 * Plan every order: decide each on its own, let chronology settle the same-day
 * duplicates it may, then apply the cross-order refusals.
 *
 * The pairing runs BEFORE `rejectContestedInvoices` on purpose. Two duplicate orders
 * that both resolve to the same single invoice are a contest and stay one; but two
 * that can be paired off one to one are not a contest at all, and running the
 * refusal first would have thrown away the answer before it was worked out.
 */
export function planAdoptions(
  orders: ReconcileOrder[],
  invoices: MatchInvoiceCandidate[],
  options: ReconcileOptions,
): AdoptionPlanEntry[] {
  const plans = orders.map((order) => planOne(order, invoices, options));
  pairDuplicatesByChronology(plans);
  return rejectContestedInvoices(plans.map((plan) => plan.entry));
}

/** The dry run's headline numbers. */
export function summarizePlan(entries: AdoptionPlanEntry[]): {
  scanned: number;
  adopt: number;
  ambiguous: number;
  no_match: number;
} {
  return {
    adopt: entries.filter((entry) => entry.decision === "adopt").length,
    ambiguous: entries.filter((entry) => entry.decision === "ambiguous").length,
    no_match: entries.filter((entry) => entry.decision === "no_match").length,
    scanned: entries.length,
  };
}

/**
 * Is this invoice's buyer a company, for the KSeF decision?
 *
 * Read off the DOCUMENT rather than off the order: the invoice is what was issued,
 * and if it carries a NIP it is a B2B document whatever the order looks like now.
 *
 * `normalizeNip` (the same function the builder applies) rather than a looser digit
 * strip, so this answers exactly what `decideKsef` would have been told had the
 * pipeline issued the invoice itself. A tax code that is not a valid Polish NIP -
 * a foreign VAT id, say - is therefore not a KSeF case, which is also the only
 * document the builder is capable of producing.
 */
export function invoiceIsCompany(taxCode?: string): { isCompany: boolean; nip?: string } {
  const nip = taxCode ? normalizeNip(taxCode) : null;
  return nip === null ? { isCompany: false } : { isCompany: true, nip };
}
