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
 * ## What is a signal, and what is not
 *
 * The signals are the PERSON, the DATE and the AMOUNT. Nothing else.
 *
 * Item names are deliberately NOT among them, at any strength: not as a gate, not
 * as a confidence grade, not as a tiebreak. The two systems name a line for their
 * own reasons - one writes the catalogue title, another writes a shortened trade
 * name, an aggregate "Towar" or whatever the seller typed - and those names differ
 * for perfectly legitimate documents. Grading on them produced exactly one visible
 * effect in production: correct matches were reported as weaker than they were,
 * which is noise an operator then has to learn to ignore. A signal that is wrong
 * for legitimate data is worse than no signal, so there is none here.
 *
 * ## Design
 *
 * Candidates are narrowed in two stages, both readable off inFakt's LIST response,
 * so a match needs no per-invoice detail fetch at all:
 *
 *   1. `filterByIdentity` - a B2B order (a NIP on the order) matches on
 *      normalized `clientTaxCode`. A B2C order matches on normalized email OR
 *      normalized full name.
 *   2. `filterByTotal` - keep only candidates whose gross total equals the
 *      order's, grosz for grosz (integer equality, no tolerance), and whose
 *      currency agrees when both sides state one.
 *
 * `classifyOrder` runs both and classifies. `classifyFromConfirmed` is the shared
 * tail end, so a caller that narrowed the candidates itself runs the same
 * MATCHED/AMBIGUOUS/NO_MATCH rule with no duplicated logic.
 *
 * ## Conservatism
 *
 * A wrong invoice-to-order pairing is worse than no pairing at all. It is
 * financial data, and a misapplied invoice number is a fact reported to customers
 * and to KSeF. So every check is a hard equality, never a fuzzy score with a
 * threshold dial. Multiple survivors classify as AMBIGUOUS and are NEVER
 * auto-applied; zero classify as NO_MATCH. Only a unique survivor classifies as
 * MATCHED.
 */

export type MatchClassification = "matched" | "ambiguous" | "no_match";

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
  /**
   * When the order was placed (ISO timestamp). Optional - read only by rules that
   * order candidates in time: the date tiebreak here, and the chronological
   * pairing of same-day duplicate orders in `reconcile.ts`. Never used by
   * identity or by the amount, so an order with no timestamp classifies exactly
   * as it would without those rules.
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
}

export interface MatchResult {
  orderId: string;
  classification: MatchClassification;
  /** The matched invoice; present only when `classification === "matched"`. */
  invoice?: MatchInvoiceCandidate;
  /** How many invoices survived every stage (identity + gross total). */
  survivorCount: number;
  /** How many passed the identity stage, before the total narrowed them. */
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

// --- Stage 3: date tiebreak, only among candidates that cleared both gates ---

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
 * Among invoices that already passed identity and gross total - the
 * otherwise-AMBIGUOUS set - break the tie by nearest invoice date, at calendar-day
 * precision. This never loosens an earlier gate: it only narrows a set that
 * already cleared every check down to the one candidate closest in time, and only
 * when that nearest candidate is unique.
 *
 * Returns null (stay AMBIGUOUS) when the order has no date, when any surviving
 * candidate has no invoice date (an un-dated candidate cannot be ruled in or out,
 * so the tiebreak cannot be trusted), or when two candidates tie exactly.
 */
function tiebreakByDate(
  orderDate: string | undefined,
  survivors: MatchInvoiceCandidate[],
): DateTiebreak | null {
  if (!orderDate || survivors.length < 2) {
    return null;
  }
  const orderTime = dayTime(orderDate);
  if (Number.isNaN(orderTime)) {
    return null;
  }

  const distances: { candidate: MatchInvoiceCandidate; distanceMs: number }[] = [];
  for (const candidate of survivors) {
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
    reason: `${survivors.length} candidates passed all signals - chose the invoice dated ${dayPrefix(winner.invoiceDate ?? "")}, nearest to the order date ${dayPrefix(orderDate)}`,
    winner,
  };
}

// --- Classification ---

function buildReasons(
  order: MatchOrderInput,
  identityCount: number,
  totalCount: number,
): string[] {
  const identityReason = order.isCompany
    ? `NIP match: ${identityCount} invoice(s)`
    : `Buyer match (email/name): ${identityCount} invoice(s)`;
  return [
    identityReason,
    order.grossTotal === null
      ? "Gross total could not be read off the order, so no invoice could match on amount"
      : `Gross total ${order.grossTotal} matched on ${totalCount} of those`,
  ];
}

/**
 * Classify one order from candidates that ALREADY cleared identity and total. The
 * shared tail end both `classifyOrder` and a caller that narrowed the candidates
 * itself use, so the MATCHED/AMBIGUOUS/NO_MATCH rule lives in exactly one place.
 */
export function classifyFromConfirmed(
  order: Pick<MatchOrderInput, "orderId" | "orderDate">,
  identityCount: number,
  totalMatchedCount: number,
  survivors: MatchInvoiceCandidate[],
): MatchResult {
  const reasons: string[] = [
    `${identityCount} invoice(s) matched by identity, ${totalMatchedCount} of those by gross total.`,
  ];

  if (survivors.length === 1) {
    return {
      classification: "matched",
      identityCount,
      invoice: survivors[0],
      orderId: order.orderId,
      reasons,
      survivorCount: 1,
    };
  }
  if (survivors.length > 1) {
    const tiebreak = tiebreakByDate(order.orderDate, survivors);
    if (tiebreak) {
      reasons.push(tiebreak.reason);
      return {
        classification: "matched",
        identityCount,
        invoice: tiebreak.winner,
        orderId: order.orderId,
        reasons,
        survivorCount: survivors.length,
      };
    }
    reasons.push(`Ambiguous: ${survivors.map((c) => c.number ?? c.uuid).join(", ")}`);
    return {
      classification: "ambiguous",
      identityCount,
      orderId: order.orderId,
      reasons,
      survivorCount: survivors.length,
    };
  }
  return {
    classification: "no_match",
    identityCount,
    orderId: order.orderId,
    reasons,
    survivorCount: 0,
  };
}

/** Full path: run both gates over raw candidates and classify what survives. */
export function classifyOrder(
  order: MatchOrderInput,
  candidates: MatchInvoiceCandidate[],
): MatchResult {
  const identity = filterByIdentity(order, candidates);
  const survivors = filterByTotal(order, identity);
  const result = classifyFromConfirmed(order, identity.length, survivors.length, survivors);
  // Prefer the richer stage-specific reasons built from `order` context, but keep
  // whatever classifyFromConfirmed appended after its summary line - the ambiguous
  // listing, or the tiebreak explanation - since neither is reconstructable here
  // without duplicating the tiebreak logic.
  const appended = result.reasons.slice(1);
  result.reasons = [...buildReasons(order, identity.length, survivors.length), ...appended];
  return result;
}
