/**
 * Pure matching engine for invoice reconciliation.
 *
 * No I/O and no Medusa imports: this module only ever sees plain data the caller
 * already fetched, so every rule is unit-testable in isolation.
 *
 * ## Why it exists
 *
 * Two situations produce an order that has an invoice in inFakt but no record of
 * it here:
 *
 *  1. The create crash window. `submit_started_at` was written, the POST reached
 *     inFakt, and the process died before the task reference landed. The row is
 *     parked in needs_review precisely so a human decides - and this engine is
 *     what tells the human WHICH invoice to adopt.
 *  2. Adoption of an existing store. Invoices issued before this plugin was
 *     installed, or by another system during a migration.
 *
 * ## Design
 *
 * Candidates are narrowed in three stages, each strictly more expensive than the
 * last, so the caller can defer fetching invoice line positions (only available
 * from inFakt's per-invoice detail endpoint) until they are actually needed:
 *
 *   1. `filterByIdentity` - a B2B order (a NIP on the order) matches on
 *      normalized `clientTaxCode`. A B2C order matches on normalized email OR
 *      normalized full name. Cheap: every field is on the LIST response.
 *   2. `filterByTotal` - keep only candidates whose gross total equals the
 *      order's, grosz for grosz (integer equality, no tolerance), and whose
 *      currency agrees when both sides state one. Also list-response fields.
 *   3. `positionsOverlap` - keep only candidates whose line positions cover the
 *      order's items (name similarity plus equal quantity, order-independent).
 *      This is the one check that needs the DETAIL response.
 *
 * `classifyOrder` runs all three assuming every candidate already carries its
 * positions, which is the shape tests want. Production code filters by identity
 * and total against list-only candidates, detail-fetches only the survivors, then
 * calls `classifyFromConfirmed` - so the same classification rule runs in both
 * places with no duplicated logic.
 *
 * ## Conservatism
 *
 * A wrong invoice-to-order pairing is worse than no pairing at all. It is
 * financial data, and a misapplied invoice number is a fact reported to customers
 * and to KSeF. So every check is a hard equality or a deliberately narrow
 * similarity rule, never a fuzzy score with a threshold dial. Multiple survivors
 * classify as AMBIGUOUS and are NEVER auto-applied; zero classify as NO_MATCH.
 * Only a unique survivor classifies as MATCHED.
 */

export type MatchClassification = "matched" | "ambiguous" | "no_match";

export interface MatchOrderItem {
  name: string;
  quantity: number;
}

export interface MatchOrderInput {
  orderId: string;
  /** True when the order was billed to a company (a NIP is present). */
  isCompany: boolean;
  /** NIP, required (and only used) when `isCompany`. */
  taxId?: string;
  /** Buyer email, required (and only used) when not `isCompany`. */
  email?: string;
  /** "First Last", required (and only used) when not `isCompany`. */
  fullName?: string;
  /**
   * Gross total the order was billed, integer minor units.
   *
   * Null when the amount could not be read off the order. It is deliberately
   * NOT defaulted to 0 by the mappers that build this: 0 is a real amount that
   * a zero-value invoice would match, and every other amount would read as a
   * confident no-match against a number nobody ever charged. A null loses every
   * candidate at `totalsMatch`, which is the only safe answer.
   */
  grossTotal: number | null;
  currency?: string;
  items: MatchOrderItem[];
  /**
   * When the order was placed (ISO timestamp/date). Optional - used only by the
   * date tiebreaker, and only when every candidate still in the running also
   * carries a date. Never used by any earlier stage, so an order with no date
   * classifies exactly as it would without the tiebreaker.
   */
  orderDate?: string;
}

export interface MatchInvoiceCandidate {
  uuid: string;
  number?: string;
  invoiceDate?: string;
  grossPrice?: number;
  currency?: string;
  clientTaxCode?: string;
  clientEmail?: string;
  clientFirstName?: string;
  clientLastName?: string;
  clientCompanyName?: string;
  /**
   * Line positions. Empty when the candidate has not been detail-fetched yet -
   * `positionsOverlap` then correctly reports no overlap, so an un-fetched
   * candidate can never pass stage 3 by omission.
   */
  services: MatchOrderItem[];
}

export interface MatchResult {
  orderId: string;
  classification: MatchClassification;
  /** The matched invoice; present only when `classification === "matched"`. */
  invoice?: MatchInvoiceCandidate;
  /** How many invoices survived stage 3 (identity + total + positions). */
  confirmedCount: number;
  /** How many passed the identity stage, before totals/positions narrowed them. */
  identityCount: number;
  /** Human-readable signals for the dry-run report. */
  reasons: string[];
}

// --- Normalization ---

/**
 * Digits only - strips spaces, dashes and any country prefix, plus leading zeros.
 *
 * The country prefix matters more than it looks: the same Polish NIP arrives as
 * bare digits ("123-456-32-18") or VAT-EU-prefixed ("PL1234563218") depending on
 * where it was captured. Stripping every non-digit makes both converge on the
 * value inFakt stores in `client_tax_code`, so no prefix-specific handling is
 * needed - and adding one would create a second normalization to keep in step
 * with this one.
 */
export function normalizeTaxId(taxId: string): string {
  return taxId.replaceAll(/[^0-9]/gu, "").replace(/^0*/u, "");
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function normalizeName(name: string): string {
  return (
    name
      // L/l does not decompose under NFKD (it is a distinct letter, not a
      // combining diacritic), so it needs an explicit map before the generic
      // diacritic strip below handles everything else (o, z, n, ...).
      .replaceAll(/[łŁ]/gu, "l")
      .normalize("NFKD")
      .replaceAll(/\p{Diacritic}/gu, "")
      .trim()
      .toLowerCase()
      .replaceAll(/\s+/gu, " ")
  );
}

/** A name normalization plus punctuation strip - line names carry SKUs and units. */
export function normalizeItemName(name: string): string {
  return normalizeName(name)
    .replaceAll(/[^\p{L}\p{N} ]+/gu, " ")
    .replaceAll(/\s+/gu, " ")
    .trim();
}

// --- Stage 1: identity ---

function identityMatches(order: MatchOrderInput, candidate: MatchInvoiceCandidate): boolean {
  if (order.isCompany) {
    if (!order.taxId) {
      return false;
    }
    const candidateTaxId = candidate.clientTaxCode ? normalizeTaxId(candidate.clientTaxCode) : "";
    const orderTaxId = normalizeTaxId(order.taxId);
    return candidateTaxId.length > 0 && candidateTaxId === orderTaxId;
  }

  const candidateEmail = candidate.clientEmail ? normalizeEmail(candidate.clientEmail) : "";
  const orderEmail = order.email ? normalizeEmail(order.email) : "";
  if (orderEmail && candidateEmail && candidateEmail === orderEmail) {
    return true;
  }

  const candidateName = normalizeName(
    [candidate.clientFirstName, candidate.clientLastName].filter(Boolean).join(" "),
  );
  const orderName = order.fullName ? normalizeName(order.fullName) : "";
  return orderName.length > 0 && candidateName.length > 0 && candidateName === orderName;
}

export function filterByIdentity(
  order: MatchOrderInput,
  candidates: MatchInvoiceCandidate[],
): MatchInvoiceCandidate[] {
  return candidates.filter((candidate) => identityMatches(order, candidate));
}

// --- Stage 2: gross total ---

/** Exact integer equality, no tolerance. Currency must agree when both state one. */
export function totalsMatch(order: MatchOrderInput, candidate: MatchInvoiceCandidate): boolean {
  if (order.grossTotal === null) {
    return false;
  }
  if (candidate.grossPrice === undefined || candidate.grossPrice !== order.grossTotal) {
    return false;
  }
  if (order.currency && candidate.currency && order.currency !== candidate.currency) {
    return false;
  }
  return true;
}

export function filterByTotal(
  order: MatchOrderInput,
  candidates: MatchInvoiceCandidate[],
): MatchInvoiceCandidate[] {
  return candidates.filter((candidate) => totalsMatch(order, candidate));
}

// --- Stage 3: line-position overlap ---

function itemNamesOverlap(orderItemName: string, positionName: string): boolean {
  const a = normalizeItemName(orderItemName);
  const b = normalizeItemName(positionName);
  if (!(a && b)) {
    return false;
  }
  return a === b || a.includes(b) || b.includes(a);
}

/**
 * Every order line must find a distinct, unconsumed invoice position with a
 * matching (normalized, similar) name and an equal quantity. Order-independent:
 * positions are consumed greedily as items are matched against them, so
 * permutations do not affect the result.
 *
 * Deliberately strict - EVERY order item must be covered, not "most of them" -
 * because a partial match on line items is exactly the kind of near-miss that
 * makes a wrong invoice look plausible.
 */
export function positionsOverlap(
  order: MatchOrderInput,
  candidate: MatchInvoiceCandidate,
): boolean {
  if (order.items.length === 0 || candidate.services.length === 0) {
    return false;
  }
  const remaining = [...candidate.services];
  for (const item of order.items) {
    const index = remaining.findIndex(
      (position) =>
        position.quantity === item.quantity && itemNamesOverlap(item.name, position.name),
    );
    if (index === -1) {
      return false;
    }
    remaining.splice(index, 1);
  }
  return true;
}

// --- Stage 4: date tiebreak, only among fully confirmed candidates ---

interface DateTiebreak {
  winner: MatchInvoiceCandidate;
  reason: string;
}

/**
 * The "YYYY-MM-DD" calendar-day prefix of an ISO date or timestamp.
 *
 * An order date is a full timestamp; inFakt's `invoiceDate` is date-only.
 * Comparing them as full timestamps would let time-of-day (and the implicit UTC
 * offset `new Date()` applies to a date-only string) sway which candidate looks
 * "nearest" - two invoices dated the same calendar day could come out different
 * distances apart purely because of what hour the order was placed. Slicing both
 * to their calendar day first makes the tiebreak genuinely date-based.
 */
function dayPrefix(value: string): string {
  return value.slice(0, 10);
}

/** Midnight UTC of a value's calendar day, as a fixed reference instant. */
function dayTime(value: string): number {
  return new Date(`${dayPrefix(value)}T00:00:00.000Z`).getTime();
}

/**
 * Among invoices that already passed identity, total and line-position
 * confirmation - the otherwise-AMBIGUOUS set - break the tie by nearest invoice
 * date, at calendar-day precision. This never loosens an earlier gate: it only
 * narrows a set that already cleared every check down to the one candidate
 * closest in time, and only when that nearest candidate is unique.
 *
 * Returns null (stay AMBIGUOUS) when the order has no date, when any confirmed
 * candidate has no invoice date (an un-dated candidate cannot be ruled in or out,
 * so the tiebreak cannot be trusted), or when two candidates tie exactly.
 */
function tiebreakByDate(
  orderDate: string | undefined,
  confirmed: MatchInvoiceCandidate[],
): DateTiebreak | null {
  if (!orderDate || confirmed.length < 2) {
    return null;
  }
  const orderTime = dayTime(orderDate);
  if (Number.isNaN(orderTime)) {
    return null;
  }

  const distances: { candidate: MatchInvoiceCandidate; distanceMs: number }[] = [];
  for (const candidate of confirmed) {
    if (!candidate.invoiceDate) {
      return null;
    }
    const invoiceTime = dayTime(candidate.invoiceDate);
    if (Number.isNaN(invoiceTime)) {
      return null;
    }
    distances.push({ candidate, distanceMs: Math.abs(invoiceTime - orderTime) });
  }

  const minDistance = Math.min(...distances.map((d) => d.distanceMs));
  const nearest = distances.filter((d) => d.distanceMs === minDistance);
  const onlyNearest = nearest.length === 1 ? nearest[0] : undefined;
  if (!onlyNearest) {
    return null;
  }

  const winner = onlyNearest.candidate;
  return {
    reason: `${confirmed.length} candidates passed all signals - chose the invoice dated ${dayPrefix(winner.invoiceDate ?? "")}, nearest to the order date ${dayPrefix(orderDate)}`,
    winner,
  };
}

// --- Classification ---

function buildReasons(
  order: MatchOrderInput,
  identityCount: number,
  totalCount: number,
  confirmedCount: number,
): string[] {
  const identityReason = order.isCompany
    ? `NIP match: ${identityCount} invoice(s)`
    : `Buyer match (email/name): ${identityCount} invoice(s)`;
  return [
    identityReason,
    order.grossTotal === null
      ? "Gross total could not be read off the order, so no invoice could match on amount"
      : `Gross total ${order.grossTotal} matched on ${totalCount} of those`,
    `Line positions confirmed on ${confirmedCount} of those`,
  ];
}

/**
 * Classify one order from candidates that are ALREADY the identity + total
 * survivors, now carrying their fetched `services`. The shared tail end both
 * `classifyOrder` and a production report builder call, so the
 * MATCHED/AMBIGUOUS/NO_MATCH rule lives in exactly one place.
 */
export function classifyFromConfirmed(
  order: Pick<MatchOrderInput, "orderId" | "orderDate">,
  identityCount: number,
  totalMatchedCount: number,
  confirmed: MatchInvoiceCandidate[],
): MatchResult {
  const reasons: string[] = [
    `${identityCount} invoice(s) matched by identity, ${totalMatchedCount} of those by gross total, ${confirmed.length} confirmed by line positions.`,
  ];

  if (confirmed.length === 1) {
    return {
      classification: "matched",
      confirmedCount: 1,
      identityCount,
      invoice: confirmed[0],
      orderId: order.orderId,
      reasons,
    };
  }
  if (confirmed.length > 1) {
    const tiebreak = tiebreakByDate(order.orderDate, confirmed);
    if (tiebreak) {
      reasons.push(tiebreak.reason);
      return {
        classification: "matched",
        confirmedCount: confirmed.length,
        identityCount,
        invoice: tiebreak.winner,
        orderId: order.orderId,
        reasons,
      };
    }
    reasons.push(`Ambiguous: ${confirmed.map((c) => c.number ?? c.uuid).join(", ")}`);
    return {
      classification: "ambiguous",
      confirmedCount: confirmed.length,
      identityCount,
      orderId: order.orderId,
      reasons,
    };
  }
  return {
    classification: "no_match",
    confirmedCount: 0,
    identityCount,
    orderId: order.orderId,
    reasons,
  };
}

/**
 * Full path for callers that already hold every candidate's line positions: runs
 * all three stages and classifies.
 */
export function classifyOrder(
  order: MatchOrderInput,
  candidates: MatchInvoiceCandidate[],
): MatchResult {
  const identity = filterByIdentity(order, candidates);
  const totalMatched = filterByTotal(order, identity);
  const confirmed = totalMatched.filter((candidate) => positionsOverlap(order, candidate));
  const result = classifyFromConfirmed(order, identity.length, totalMatched.length, confirmed);
  // Prefer the richer stage-specific reasons built from `order` context, but keep
  // whatever classifyFromConfirmed appended after its summary line - the ambiguous
  // listing, or the tiebreak explanation - since neither is reconstructable here
  // without duplicating the tiebreak logic.
  const appended = result.reasons.slice(1);
  result.reasons = [
    ...buildReasons(order, identity.length, totalMatched.length, confirmed.length),
    ...appended,
  ];
  return result;
}
