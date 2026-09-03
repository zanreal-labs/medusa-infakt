import { isCalendarDate } from "./money";
import { capturedMinorUnits, evaluatePaidGate, refundedMinorUnits } from "./paid";
import type { PaidGateOrder } from "./paid";

/**
 * Settlement reconciliation: does inFakt agree that this order was paid?
 *
 * The pure rules, with no database, no HTTP client and no clock of their own -
 * `src/lib/invoicing/settle.ts` supplies all three. Everything here is a
 * function of two facts: what Medusa's payment state says, and what inFakt's
 * `paid_date` says.
 *
 * ## Why `paid_date` and nothing else
 *
 * inFakt's `status` is a single last-write-wins enum (`draft`, `sent`,
 * `printed`, `paid`) that ANY later action on the document overwrites, including
 * a plain PDF download. On production invoice 2/09/2026 our own marking survived
 * as `paid_date` while `status` was flipped to `sent` three seconds later by our
 * own Allegro attachment fetching the PDF. Reading settlement off `status`
 * therefore does not measure settlement; it measures who touched the document
 * last.
 *
 * `paid_price` is no better as a signal, in the other direction: invoice
 * 9/08/2026 carries `status: "paid"` together with `paid_price: 0`. Both amounts
 * are recorded as evidence and neither is ever decisive.
 *
 * ## Medusa is the source of truth, and this only ever reads
 *
 * The reconciliation compares and reports. It never writes payment state back
 * into Medusa - "somebody ticked paid in the inFakt panel" must not be able to
 * settle an order, or the panel becomes a payment gateway - and in this first
 * version it writes nothing into inFakt either. What it produces is four columns
 * on the ledger row and a report an operator reads.
 */

/** The reconciliation's sliding backstop: how far back the job looks by default. */
export const SETTLEMENT_WINDOW_DAYS = 90;

/**
 * How long a checked row is left alone before it is read again.
 *
 * Six hours, against an hourly job, is what keeps the API cost in the tens of
 * requests a day rather than the hundreds: a row settles once and is then never
 * re-read (see `settlementCandidatePredicate` in the module service), so only
 * genuinely drifting rows come back around, and they come back four times a day
 * rather than twenty-four.
 */
export const SETTLEMENT_RECHECK_MS = 6 * 60 * 60_000;

/** Rows read from inFakt in one reconciliation run. */
export const SETTLEMENT_BATCH_LIMIT = 50;

/**
 * How Medusa and inFakt disagree about one invoice.
 *
 * - `unsettled` - Medusa has the order captured in full, inFakt has no
 *   `paid_date`. The marking was lost, never took, or was never sent. **The only
 *   code a machine could ever safely fix**, and even that is not armed yet.
 * - `refunded_but_settled` - money went back to the buyer and inFakt still has
 *   the invoice settled. Report only, forever: inFakt has no "un-mark", and the
 *   correct instrument is a corrective invoice, which this plugin does not issue.
 * - `settled_without_capture` - inFakt has the invoice settled and Medusa never
 *   captured anything. Somebody settled it by hand, or it belongs to a payment
 *   this store never saw. Report only.
 * - `amount_mismatch` - inFakt has it settled, Medusa captured part of the
 *   total. Report only, and deliberately derived from CAPTURES rather than from
 *   inFakt's `paid_price`, which cannot be trusted (see the note above).
 * - `unreadable` - the invoice or the order could not be read well enough to
 *   compare. Not a discrepancy, but not a clean bill either, and it must not be
 *   silently indistinguishable from "agrees".
 */
export type SettlementDrift =
  | "unsettled"
  | "refunded_but_settled"
  | "settled_without_capture"
  | "amount_mismatch"
  | "unreadable";

export interface SettlementInput {
  /**
   * inFakt's `paid_date` for the invoice, or null/undefined when it has none.
   * Anything that is not a YYYY-MM-DD calendar date is treated as unreadable
   * rather than as "unsettled" - guessing in that direction would invent a
   * discrepancy out of a parsing failure.
   */
  paidDate?: string | null;
  /** The order, for the capture and refund figures. Null when it could not be read. */
  order?: PaidGateOrder | null;
  /** True when reading the invoice from inFakt failed outright. */
  invoiceUnreadable?: boolean;
  /**
   * An invoice an operator adopted rather than this plugin issuing it. Carried
   * through to the verdict so a caller never has to re-derive it: an adopted row
   * is REPORTED exactly like any other and is never a candidate for a fix.
   */
  adopted?: boolean;
}

export interface SettlementVerdict {
  /** inFakt's settlement day, as a timestamp, or null when it has none. */
  settledAt: Date | null;
  /** Null when the two systems agree. */
  drift: SettlementDrift | null;
  /** One line, PII-free, safe for a log and for the admin UI. */
  reason: string;
  /** Captured net of refunds, minor units. Zero when the order was unreadable. */
  capturedMinor: number;
  /** Order total, minor units, or null when unreadable. */
  totalMinor: number | null;
  /** Refunds, minor units. */
  refundedMinor: number;
  adopted: boolean;
}

/**
 * Turn a `paid_date` into a timestamp, or null.
 *
 * UTC midnight of the calendar day inFakt reported, deliberately: `paid_date` IS
 * a calendar day, it carries no time of its own, and inventing a local one would
 * make the column drift by an hour twice a year for no gain. Nothing compares
 * this to another timestamp for ordering - it is a date to show an operator and
 * a not-null test.
 */
export function parseSettledAt(paidDate?: string | null): Date | null {
  if (!isCalendarDate(paidDate)) {
    return null;
  }
  const parsed = new Date(`${paidDate}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

/**
 * Compare one invoice against its order.
 *
 * The order of the checks is the whole design:
 *
 * 1. Anything unreadable stops here. A comparison against a value nobody could
 *    read is not a comparison, and reporting it as agreement would hide exactly
 *    the case worth looking at.
 * 2. Not settled in inFakt: a discrepancy only if Medusa says the money is in.
 *    An unpaid order with an unsettled invoice is two systems agreeing.
 * 3. Settled in inFakt: refunds first (money that came back outranks everything
 *    else), then no capture at all, then a partial one.
 */
export function classifySettlement(input: SettlementInput): SettlementVerdict {
  const adopted = input.adopted === true;
  const settledAt = parseSettledAt(input.paidDate);
  const order = input.order ?? null;
  const capturedMinor = order ? capturedMinorUnits(order) : 0;
  const refundedMinor = order ? refundedMinorUnits(order) : 0;
  const gate = order ? evaluatePaidGate(order) : null;
  const totalMinor = gate?.totalMinor ?? null;

  const base = { adopted, capturedMinor, refundedMinor, settledAt, totalMinor };

  if (input.invoiceUnreadable) {
    return { ...base, drift: "unreadable", reason: "the invoice could not be read from inFakt" };
  }
  if (input.paidDate && !settledAt) {
    return {
      ...base,
      drift: "unreadable",
      reason: "inFakt reported a paid date that is not a calendar date",
    };
  }
  if (!order) {
    return { ...base, drift: "unreadable", reason: "the order could not be read from Medusa" };
  }
  if (totalMinor === null) {
    return { ...base, drift: "unreadable", reason: "the order total is unreadable" };
  }

  if (!settledAt) {
    if (gate?.fullyPaid) {
      return {
        ...base,
        drift: "unsettled",
        reason: `captured ${capturedMinor} of ${totalMinor} (minor units) in Medusa, no paid date in inFakt`,
      };
    }
    return {
      ...base,
      drift: null,
      reason: `not settled in inFakt, and captured ${capturedMinor} of ${totalMinor} (minor units) in Medusa - both agree`,
    };
  }

  if (refundedMinor > 0) {
    return {
      ...base,
      drift: "refunded_but_settled",
      reason: `inFakt has the invoice settled, Medusa recorded ${refundedMinor} (minor units) refunded`,
    };
  }
  if (capturedMinor <= 0) {
    return {
      ...base,
      drift: "settled_without_capture",
      reason: "inFakt has the invoice settled, Medusa captured nothing",
    };
  }
  if (!gate?.fullyPaid) {
    return {
      ...base,
      drift: "amount_mismatch",
      reason: `inFakt has the invoice settled, Medusa captured ${capturedMinor} of ${totalMinor} (minor units)`,
    };
  }
  return {
    ...base,
    drift: null,
    reason: `settled in inFakt and captured ${capturedMinor} of ${totalMinor} (minor units) in Medusa`,
  };
}

/**
 * Could a machine put this right on its own?
 *
 * Exactly one code qualifies, and only on an invoice this plugin issued itself.
 *
 * `unsettled` is fixable because the fix is the one call the plugin already
 * makes on the issuing path - re-sending the paid marking for an order Medusa
 * has captured in full. Every other code describes a document whose correction
 * is an accounting decision (a corrective invoice) or whose facts this plugin
 * does not own.
 *
 * An **adopted** invoice is refused whatever its code. It existed before its
 * ledger row did, its payment bookkeeping belongs to whoever issued it, and
 * writing a paid date onto it is a change to somebody else's accounting record.
 * On the estate this was designed against, 25 of 30 rows are adopted - so this
 * refusal is not an edge case, it is most of the table.
 *
 * Nothing acts on this yet: no auto-fix exists in this version. It is defined
 * here, now, so the report can already say which rows a future fix would touch
 * and an operator can judge the blast radius before it is armed.
 */
export function isSettlementAutoFixable(
  drift: SettlementDrift | null,
  options: { adopted: boolean },
): boolean {
  return drift === "unsettled" && !options.adopted;
}

export interface SettlementCountable {
  drift: SettlementDrift | null;
  adopted: boolean;
  settledAt?: Date | string | null;
}

export interface SettlementSummary {
  /** Rows considered. */
  checked: number;
  /** Rows inFakt has a `paid_date` for. */
  settled: number;
  /** Rows where the two systems agree. */
  agreed: number;
  /** Rows a future auto-fix would touch: `unsettled`, not adopted. */
  auto_fixable: number;
  /** Drifting rows on an adopted invoice - report only, always. */
  adopted_drift: number;
  /** Count per drift code, including the codes with no rows. */
  drift: Record<SettlementDrift, number>;
}

/** Count a set of verdicts, with every code present so a gauge never goes missing. */
export function summarizeSettlement(entries: SettlementCountable[]): SettlementSummary {
  const summary: SettlementSummary = {
    adopted_drift: 0,
    agreed: 0,
    auto_fixable: 0,
    checked: entries.length,
    drift: {
      amount_mismatch: 0,
      refunded_but_settled: 0,
      settled_without_capture: 0,
      unreadable: 0,
      unsettled: 0,
    },
    settled: 0,
  };
  for (const entry of entries) {
    if (entry.settledAt) {
      summary.settled += 1;
    }
    if (!entry.drift) {
      summary.agreed += 1;
      continue;
    }
    summary.drift[entry.drift] += 1;
    if (entry.adopted) {
      summary.adopted_drift += 1;
    }
    if (isSettlementAutoFixable(entry.drift, { adopted: entry.adopted })) {
      summary.auto_fixable += 1;
    }
  }
  return summary;
}

/** The oldest `settlement_checked_at` a row may carry and still be left alone. */
export function settlementRecheckCutoff(now: Date, recheckMs = SETTLEMENT_RECHECK_MS): Date {
  return new Date(now.getTime() - recheckMs);
}

/**
 * The start of the sliding backstop window.
 *
 * Ninety days, and a deliberate trade rather than a limit that happened. An
 * invoice whose settlement never reconciled is an operational problem for as long
 * as it takes somebody to notice - which is weeks, not months - and a window that
 * never ends means the job re-reads the entire invoice history of the store for
 * the rest of its life to find nothing. A full pass is still available on demand
 * (`full=true` on the admin endpoint), which is the right shape for it: rare,
 * asked for, and watched.
 */
export function settlementWindowStart(now: Date, days = SETTLEMENT_WINDOW_DAYS): Date {
  return new Date(now.getTime() - days * 24 * 60 * 60_000);
}
