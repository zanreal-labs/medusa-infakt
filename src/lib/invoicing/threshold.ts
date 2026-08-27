/**
 * The intra-EU B2C threshold.
 *
 * A supplier established in one member state only may keep taxing its intra-EU
 * B2C distance sales of goods and TBE services at its OWN rate - Polish 23% here
 * - for as long as the combined value of those sales stays at or below EUR
 * 10 000, measured across the current and the previous calendar year (art. 28k
 * ust. 2 ustawy o VAT; Directive 2006/112 art. 59c). Above it, the place of
 * supply moves to each consumer's own country and OSS registration (or 27
 * separate registrations) is required.
 *
 * Three properties of that rule drive everything in this file:
 *
 * 1. **Crossing flips the treatment mid-year, from the crossing transaction
 *    onward** - not from the next month, not the next year. So the counter has
 *    to be consulted BEFORE an invoice is issued. A report produced afterwards
 *    would be a record of invoices that are already wrong.
 *
 * 2. **Below the threshold, 23% is correct BECAUSE of the threshold.** Once it
 *    is crossed the identical 23% becomes wrong. There is therefore no safe
 *    fallback: an order that crosses the line with no registration in place has
 *    no correct invoice, and must be parked rather than issued at either rate.
 *
 * 3. **Registration is not instantaneous.** A counter that only fires at 100%
 *    guarantees a window in which sales are legally obliged to use a regime the
 *    company has not registered for. Hence the alert ratio: the owner is warned
 *    with room to act, and the block only ever exists as a backstop.
 *
 * ## The currency approximation, stated plainly
 *
 * The threshold is EUR 10 000, with a fixed PLN equivalent of 42 000 PLN. Sales
 * may be in either, or in a currency with no statutory equivalent at all. Doing
 * this exactly needs NBP reference rates per transaction date, which this plugin
 * does not have and should not invent.
 *
 * What it does instead: track a running total per currency, express each as a
 * fraction of that currency's own limit, and sum the fractions. Breach at 1.0.
 * With limits that are genuinely FX-equivalent this is exact; where they drift
 * it is conservative in the direction that matters, because over-counting parks
 * an order for a human and under-counting issues a wrong invoice.
 *
 * A currency with no configured limit is NOT ignored - it makes the result
 * `unknown`, which parks. Silently not counting a currency would be the one
 * failure mode this whole file exists to prevent.
 */

/** EUR 10 000, in minor units. */
export const DEFAULT_EUR_THRESHOLD_MINOR = 1_000_000;
/** The statutory PLN equivalent, 42 000 PLN, in minor units. */
export const DEFAULT_PLN_THRESHOLD_MINOR = 4_200_000;

/**
 * Warn at 80% of the limit.
 *
 * Proposed rather than derived: OSS registration (VIU-R) is filed by the 10th of
 * the month following the first qualifying sale, so the practical need is weeks
 * of notice, not days. At this store's current volume 80% is many orders' worth
 * of headroom. The owner should move it if their volume changes.
 */
export const DEFAULT_ALERT_RATIO = 0.8;

export const DEFAULT_THRESHOLDS: Readonly<Record<string, number>> = {
  EUR: DEFAULT_EUR_THRESHOLD_MINOR,
  PLN: DEFAULT_PLN_THRESHOLD_MINOR,
};

/** One EU B2C sale already on the books. */
export interface EuB2cSale {
  /** Net (taxable base) in minor units. */
  baseMinor: number;
  currency: string;
  /** Warsaw calendar date, YYYY-MM-DD. */
  date: string;
}

export type ThresholdVerdict =
  | { state: "below"; usedRatio: number; alert: boolean }
  | { state: "breached"; usedRatio: number }
  | { state: "unknown"; reason: string };

export interface ThresholdInput {
  /** Sales already invoiced under the EU B2C branch. */
  prior: readonly EuB2cSale[];
  /** The sale about to be invoiced. */
  pending: EuB2cSale;
  /** Per-currency limits in minor units, uppercase keys. */
  thresholds?: Readonly<Record<string, number>>;
  /** Warn at this fraction of the limit. */
  alertRatio?: number;
}

/**
 * The two calendar years the rule looks at, given a sale's date.
 *
 * "Current and previous calendar year" is a rolling pair, not a 24-month window:
 * a sale on 2027-01-01 is measured against 2027 and 2026, and 2025 drops out
 * entirely on that date.
 */
export function relevantYears(date: string): [number, number] {
  const year = Number.parseInt(date.slice(0, 4), 10);
  return [year - 1, year];
}

/**
 * Decide whether this sale may still be taxed at the domestic rate.
 *
 * The pending sale is INCLUDED in the total before comparing, because the rule
 * bites on the transaction that crosses the line, not on the one after it.
 */
export function evaluateThreshold(input: ThresholdInput): ThresholdVerdict {
  const thresholds = normalizeThresholds(input.thresholds ?? DEFAULT_THRESHOLDS);
  const alertRatio = input.alertRatio ?? DEFAULT_ALERT_RATIO;
  const [previousYear, currentYear] = relevantYears(input.pending.date);

  const counted = [...input.prior, input.pending].filter((sale) => {
    const year = Number.parseInt(sale.date.slice(0, 4), 10);
    return year === previousYear || year === currentYear;
  });

  const totals = new Map<string, number>();
  for (const sale of counted) {
    const currency = sale.currency.trim().toUpperCase();
    totals.set(currency, (totals.get(currency) ?? 0) + Math.max(sale.baseMinor, 0));
  }

  let usedRatio = 0;
  for (const [currency, total] of totals) {
    const limit = thresholds[currency];
    if (!limit || limit <= 0) {
      // Parks rather than guesses. See the header: never silently skip a currency.
      return {
        reason: `no intra-EU B2C threshold is configured for ${currency}, so the OSS limit cannot be evaluated`,
        state: "unknown",
      };
    }
    usedRatio += total / limit;
  }

  if (usedRatio >= 1) {
    return { state: "breached", usedRatio };
  }
  return { alert: usedRatio >= alertRatio, state: "below", usedRatio };
}

function normalizeThresholds(
  thresholds: Readonly<Record<string, number>>,
): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [currency, limit] of Object.entries(thresholds)) {
    normalized[currency.trim().toUpperCase()] = limit;
  }
  return normalized;
}

/** The review reason a breach produces. Kept here so it is tested in one place. */
export function breachReason(usedRatio: number): string {
  return (
    `this sale crosses the intra-EU B2C threshold (${Math.round(usedRatio * 100)}% of the limit including this order), ` +
    "and the company is not registered for OSS. Below the threshold the Polish rate is correct because of the threshold; " +
    "above it the same rate is wrong, so there is no correct invoice to issue until OSS registration is in place."
  );
}

/** The wording of the early warning. */
export function alertMessage(usedRatio: number): string {
  return (
    `Intra-EU B2C sales have reached ${Math.round(usedRatio * 100)}% of the EUR 10 000 OSS threshold. ` +
    "Once it is crossed, EU consumer sales must be taxed at the destination country's rate and OSS registration " +
    "(VIU-R) is required. Orders that would cross it will be parked rather than invoiced."
  );
}
