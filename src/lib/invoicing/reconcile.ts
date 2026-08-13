import { filterByIdentity, filterByTotal, positionsOverlap } from "./matching";
import type { MatchInvoiceCandidate, MatchOrderInput, MatchOrderItem } from "./matching";
import { bigNumberToMinorUnits, warsawDate } from "./money";
import { normalizeNip } from "./nip";
import type { NipExtractorOrder } from "./nip";
import { lineItemName } from "./order-mapper";
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
 * ## The rules, in order
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
 * Line positions are then checked (`positionsOverlap`) but are NOT a gate: an
 * invoice issued by another system names its lines its own way, and demanding a
 * name match there would refuse most genuine history. It is recorded as the
 * difference between a `high` and a `medium` confidence match, so an operator can
 * see which is which before approving anything.
 *
 * ## Unambiguous or nothing
 *
 * Exactly one survivor is adopted. Two or more is AMBIGUOUS and is reported for a
 * human - never narrowed by picking the nearest date or the prettiest candidate.
 * `matching.ts` has a date tiebreak for the crash-window flow, and it is
 * deliberately NOT used here: in that flow a human is already looking at one order
 * and knows an invoice exists, while here nobody is watching, and two invoices to
 * the same buyer for the same amount within days of each other is exactly the
 * duplicate an operator has to see.
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
  /** Whether the invoice's line positions cover the order's items. */
  positions_confirmed: boolean;
  /** Whether the order itself already named this invoice number. */
  declared_by_order: boolean;
  /** Invoices that cleared the date window before identity and total narrowed it. */
  candidates_in_window: number;
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
    items: (order.items ?? []).map((item) => ({
      name: lineItemName(item),
      quantity: item.quantity,
    })),
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

// --- The plan ---

function planOne(
  order: ReconcileOrder,
  invoices: MatchInvoiceCandidate[],
  options: ReconcileOptions,
): AdoptionPlanEntry {
  // An order whose total could not be read cannot clear the amount gate, and
  // must not be silently compared against 0. Say so instead of reporting the
  // ordinary "nothing matched the gross total 0", which reads like a genuine
  // absence of candidates while actually being a data problem on this side.
  if (order.grossTotal === null) {
    return {
      candidates: [],
      decision: "no_match",
      displayId: order.displayId,
      orderId: order.orderId,
      reasons: [
        "The order's gross total could not be read, so no invoice can be matched on amount. Refusing rather than comparing every candidate against 0.",
      ],
    };
  }

  const inWindow = filterByDateWindow(order, invoices, options.dateToleranceDays);
  const byIdentity = filterByIdentity(order, inWindow);
  const byTotal = filterByTotal(order, byIdentity);
  const declared = order.declaredInvoiceNumber?.trim();
  const survivors = declared
    ? byTotal.filter((candidate) => candidate.number?.trim() === declared)
    : byTotal;

  const reasons = [
    `${inWindow.length} invoice(s) dated within ${options.dateToleranceDays} day(s) of ${order.orderDay}, ${byIdentity.length} of those matched the buyer, ${byTotal.length} of those matched the gross total ${order.grossTotal}.`,
  ];
  if (declared) {
    reasons.push(
      survivors.length > 0
        ? `The order already names invoice ${declared}, and that is the one that matched.`
        : `The order names invoice ${declared}, which is NOT among the invoices that matched - refusing rather than adopting a different document.`,
    );
  }

  if (survivors.length === 0) {
    return {
      candidates: [],
      decision: "no_match",
      displayId: order.displayId,
      orderId: order.orderId,
      reasons,
    };
  }

  if (survivors.length > 1) {
    reasons.push(
      `Ambiguous - refusing to guess between ${survivors.map((candidate) => candidate.number ?? candidate.uuid).join(", ")}.`,
    );
    return {
      candidates: survivors.map(summarize),
      decision: "ambiguous",
      displayId: order.displayId,
      orderId: order.orderId,
      reasons,
    };
  }

  const invoice = survivors[0];
  const confirmed = positionsOverlap(order, invoice);
  const identity = identitySignal(order, invoice);
  const offset = dateOffsetDays(order.orderDay, invoice.invoiceDate) ?? 0;
  reasons.push(
    confirmed
      ? "Line positions on the invoice cover every order item."
      : "Line positions did NOT confirm the match - the invoice was issued with different item names, so this rests on buyer identity, gross total and the issue date alone.",
  );

  return {
    candidates: [summarize(invoice)],
    confidence: confirmed ? "high" : "medium",
    decision: "adopt",
    displayId: order.displayId,
    evidence: {
      candidates_in_window: inWindow.length,
      confidence: confirmed ? "high" : "medium",
      currency: invoice.currency ?? order.currency ?? null,
      date_offset_days: offset,
      declared_by_order: Boolean(declared),
      gross_total_minor: order.grossTotal,
      identity,
      invoice_date: invoice.invoiceDate ?? null,
      invoice_number: invoice.number ?? null,
      invoice_uuid: invoice.uuid,
      positions_confirmed: confirmed,
      source: "infakt-reconcile",
    },
    invoice: summarize(invoice),
    invoiceTaxCode: invoice.clientTaxCode,
    orderId: order.orderId,
    reasons,
  };
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

/** Plan every order in one pass, then apply the cross-order refusals. */
export function planAdoptions(
  orders: ReconcileOrder[],
  invoices: MatchInvoiceCandidate[],
  options: ReconcileOptions,
): AdoptionPlanEntry[] {
  return rejectContestedInvoices(orders.map((order) => planOne(order, invoices, options)));
}

/**
 * Re-check the line positions of an adoption whose candidate was matched from the
 * LIST response alone, once the detail response has been fetched.
 *
 * inFakt's list endpoint may answer without `services`, and `positionsOverlap`
 * correctly reports no overlap for a candidate that carries none - so a genuine
 * match would otherwise be reported as `medium` purely because of which endpoint
 * it was read from. Positions are not a gate, so this only ever moves the
 * confidence up; the decision is untouched.
 */
export function applyPositionConfirmation(
  entry: AdoptionPlanEntry,
  order: ReconcileOrder,
  services: MatchOrderItem[],
): AdoptionPlanEntry {
  if (entry.decision !== "adopt" || !entry.evidence || entry.evidence.positions_confirmed) {
    return entry;
  }
  const confirmed = positionsOverlap(order, {
    services,
    uuid: entry.evidence.invoice_uuid,
  });
  if (!confirmed) {
    return entry;
  }
  return {
    ...entry,
    confidence: "high",
    evidence: { ...entry.evidence, confidence: "high", positions_confirmed: true },
    reasons: [
      ...entry.reasons.slice(0, -1),
      "Line positions on the invoice cover every order item.",
    ],
  };
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
