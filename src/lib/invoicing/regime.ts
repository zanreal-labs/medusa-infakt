/**
 * Which VAT regime a sale falls under.
 *
 * This is the legally consequential file in the plugin. Everything else moves
 * numbers around; this decides what the law says about them. It is pure and
 * synchronous so that every branch is unit-testable without a network, a
 * database or a clock, and so that the tree can be read top to bottom and
 * checked against the decision the owner approved.
 *
 * The four live regimes, and why each is separate:
 *
 *  - **domestic** - Poland. 23%. This path is live today and must not change.
 *  - **reverse_charge** - a business in another member state whose VAT id VIES
 *    confirmed. Place of supply is the customer's state (art. 28b ust. 1 ustawy
 *    o VAT / Directive 2006/112 art. 44); the customer accounts for the tax
 *    (Directive art. 196); the invoice must say so (art. 106e ust. 1 pkt 18
 *    ustawy o VAT / Directive art. 226 pkt 11a) and the supply must reach the
 *    VAT-UE summary (art. 100 ust. 1 pkt 4).
 *  - **oss** - a consumer in another member state. Place of supply is the
 *    consumer's state for electronically supplied services (art. 28k ust. 1 /
 *    Directive art. 58), and the destination country's rate is charged and
 *    declared through the union OSS scheme (art. 130a-130d). This is the branch
 *    most easily got wrong, because the intuitive answer - "not Poland, so no
 *    Polish VAT, so zero" - is the opposite of correct.
 *  - **export_services** - a business outside the EU, Great Britain included.
 *    Outside the scope of Polish VAT, so the same `np` symbol as a reverse
 *    charge, but a *different legal basis and different reporting*: an export of
 *    services is NOT a VAT-UE entry. Merging this branch into reverse_charge
 *    because the rate matches would be a reporting error on every non-EU sale,
 *    and it is the reason the two are separate `kind`s rather than one branch
 *    with a flag.
 *
 * Everything the tree cannot answer becomes `blocked`, never a guess. A blocked
 * sale parks in `needs_review` with a reason an operator can act on. That is
 * always the right trade here: a late invoice is a support ticket, a wrong one
 * is a liability.
 */

import { isEuMember, isPoland, normalizeCountry } from "./eu";
import { breachReason } from "./threshold";
import type { ThresholdVerdict } from "./threshold";
import { isParsedVatId, parseEuVatId, vatIdMatchesCountry } from "./vat-id";
import type { CachedViesResult } from "./vies";

/**
 * What is being supplied, in the only terms that change the answer.
 *
 * Derived from the product, never from the destination. Inferring "it went
 * abroad so it must be a service" is how the first physical SKU sold to Germany
 * gets invoiced under art. 28k. See `classification.ts`.
 *
 * `unknown` and `mixed` are first-class values rather than errors thrown
 * upstream, because both are perfectly fine domestically - a Polish sale is 23%
 * either way - and only become blocking once a border is involved. Modelling
 * them here is what lets an unmarked catalogue keep invoicing Polish orders
 * unchanged while the first foreign order for the same product parks.
 */
export type SupplyKind = "service" | "goods" | "unknown" | "mixed";

/** What to do when a VAT id could not be checked against VIES. */
export type ViesFallback = "review" | "consumer";

export interface RegimeInput {
  /** ISO alpha-2 billing country. Null when the order has none. */
  billingCountry: string | null;
  /** Raw buyer tax identifier as captured, if any. */
  taxId?: string | null;
  /** Cached VIES outcome for `taxId`, when the storefront recorded one. */
  vies?: CachedViesResult | null;
  /** Whether the lines are services or goods, decided from the products. */
  supply: SupplyKind;
  /**
   * The classifier's own explanation, when `supply` is `unknown` or `mixed`.
   * Surfaced verbatim so the operator is told which product to tag rather than
   * that "something" was unclassified.
   */
  supplyReason?: string;
  /** The domestic rate symbol, e.g. "23". */
  domesticTaxSymbol: string;
  /**
   * Whether the company is actually REGISTERED for the union OSS procedure.
   *
   * Distinct from `ossEnabled`, which only says the code path is switched on.
   * Registration is what makes destination-rate invoicing lawful, and without it
   * an EU consumer sale is either domestic-rate (below the threshold) or has no
   * correct treatment at all (above it).
   */
  ossRegistered: boolean;
  /** False keeps every EU consumer sale blocked instead of issuing OSS. */
  ossEnabled: boolean;
  /** Destination rate lookup, e.g. "19" for DE. Null when unknown. */
  ossRateFor: (country: string) => string | null;
  /**
   * Where this sale leaves the intra-EU B2C threshold, including itself.
   *
   * Computed by the caller because it needs the books; passed in so this
   * function stays pure. Only consulted on the EU consumer branch.
   */
  threshold?: ThresholdVerdict;
  /** Buyer's company name, the only B2B signal available outside the EU. */
  companyName?: string | null;
  /** What an unavailable VIES check means. Defaults to "review". */
  viesFallback?: ViesFallback;
}

export type VatRegime =
  | { kind: "domestic"; taxSymbol: string }
  | {
      kind: "reverse_charge";
      taxSymbol: "np";
      /** Normalized, prefixed VAT id for `client_tax_code`. */
      vatId: string;
      /** Buyer's country, which is also the place of supply. */
      country: string;
      note: string;
      /** Always true. Present so the field is impossible to forget downstream. */
      vatUeReportable: true;
    }
  | {
      kind: "oss";
      /** Destination member state, i.e. the country of consumption. */
      country: string;
      /** Destination VAT rate as inFakt expresses it, e.g. "19". */
      rate: string;
    }
  | {
      /**
       * An EU consumer, below the threshold: taxed at the Polish rate, in
       * Poland, lawfully. Its own kind rather than `domestic` because it is the
       * thing the threshold counter counts, and because it stops being correct
       * the moment the threshold is crossed.
       */
      kind: "eu_b2c_domestic_rate";
      taxSymbol: string;
      country: string;
      /** True once the running total has passed the alert ratio. */
      alert: boolean;
      /** Fraction of the limit used, including this sale. For the audit trail. */
      usedRatio: number;
    }
  | {
      kind: "export_services";
      taxSymbol: "np";
      country: string;
      note: string;
      /** Always false. An export of services must never reach the VAT-UE summary. */
      vatUeReportable: false;
    }
  | { kind: "blocked"; reason: string };

/**
 * The annotation a reverse-charge invoice must carry.
 *
 * Polish first because the issuer is Polish and the document is a Polish
 * invoice; English second because the reader is not. Art. 106e ust. 1 pkt 18
 * requires the words; Directive art. 226 pkt 11a requires "Reverse charge"
 * specifically, which is why the English is not optional decoration.
 */
export const REVERSE_CHARGE_NOTE =
  "Odwrotne obciazenie / Reverse charge. " +
  "Podatek VAT rozlicza nabywca. " +
  "Miejsce swiadczenia: kraj siedziby nabywcy (art. 28b ust. 1 ustawy o VAT, " +
  "art. 44 i art. 196 Dyrektywy 2006/112/WE).";

/**
 * The annotation an export of services must carry.
 *
 * Deliberately different text from the reverse-charge note even though both
 * carry `np`. The rate is the same; the reason is not, and the invoice is the
 * only place that reason is recorded.
 */
export const EXPORT_SERVICES_NOTE =
  "Uslugi niepodlegajace opodatkowaniu VAT w Polsce - " +
  "miejsce swiadczenia poza terytorium kraju (art. 28b ust. 1 ustawy o VAT). " +
  "Not subject to Polish VAT - place of supply outside Poland.";

export function decideVatRegime(input: RegimeInput): VatRegime {
  const country = normalizeCountry(input.billingCountry);
  if (!country) {
    return {
      kind: "blocked",
      reason: "the order has no usable billing country, so the place of supply cannot be decided",
    };
  }

  // Domestic first and unconditionally. Poland is the live path; no cross-border
  // consideration below can reach it, and goods and services are both 23% here.
  if (isPoland(country)) {
    return { kind: "domestic", taxSymbol: input.domesticTaxSymbol };
  }

  // Past this point the destination is foreign, and every rule the tree encodes
  // is a rule about services. Goods crossing a border are a different regime
  // entirely (WDT, export of goods, distance selling of goods) with different
  // evidence requirements that this plugin does not implement.
  if (input.supply !== "service") {
    return { kind: "blocked", reason: blockedSupplyReason(country, input) };
  }

  return isEuMember(country) ? decideEuRegime(country, input) : decideNonEuRegime(country, input);
}

/** Another member state: reverse charge for confirmed businesses, OSS otherwise. */
function decideEuRegime(country: string, input: RegimeInput): VatRegime {
  const rawTaxId = input.taxId?.trim();
  if (!rawTaxId) {
    // No claim to be a business. A consumer in another member state is the OSS
    // branch, NOT a zero-rated one.
    return ossRegime(country, input);
  }

  const parsed = parseEuVatId(rawTaxId);
  if (!isParsedVatId(parsed)) {
    // The buyer asserted a VAT id and it is not one. Neither automatic answer is
    // safe: zero-rating trusts a number we could not read, and charging
    // destination VAT quietly overrides a business customer's own statement
    // about who they are. A human reads it.
    return { kind: "blocked", reason: `${parsed.reason} - cannot classify the buyer` };
  }

  if (!vatIdMatchesCountry(parsed, country)) {
    return {
      kind: "blocked",
      reason: `the VAT id was issued by ${parsed.country} but the billing country is ${country} - the place of supply is ambiguous`,
    };
  }

  const vies = input.vies?.status ?? "unavailable";
  if (vies === "valid") {
    return {
      country,
      kind: "reverse_charge",
      note: REVERSE_CHARGE_NOTE,
      taxSymbol: "np",
      vatId: parsed.normalized,
      vatUeReportable: true,
    };
  }

  if (vies === "invalid") {
    // VIES says the number is not registered, so the buyer is not a taxable
    // person we may zero-rate. They are a consumer for VAT purposes.
    return ossRegime(country, input);
  }

  // Unavailable. The default is to park: a reverse charge rests on evidence we
  // do not have, and destination VAT overrides the customer's own claim. Stores
  // that would rather never delay a paid order can set the fallback to
  // "consumer", which over-collects - correctable by a corrective invoice -
  // rather than under-collecting, which is not.
  if ((input.viesFallback ?? "review") === "consumer") {
    return ossRegime(country, input);
  }
  return {
    kind: "blocked",
    reason: `the buyer's ${parsed.prefix} VAT id could not be confirmed against VIES, so the reverse charge cannot be evidenced`,
  };
}

/** Outside the EU. Great Britain arrives here too, and that is the point. */
function decideNonEuRegime(country: string, input: RegimeInput): VatRegime {
  // Business status outside the EU has no VIES equivalent, so the signals are a
  // tax identifier OR a company name. A company name alone is weak evidence, and
  // it is accepted here for a specific reason: the only cross-border invoice this
  // account has ever issued (2/05/2026, a US LLC) carries a company name and an
  // EMPTY tax code, and was treated as a business supply. Requiring a tax id
  // would park exactly the transaction the accountant has already handled.
  //
  // It is safe to be lenient in this direction and nowhere else: for an
  // electronically supplied service the place of supply is outside Poland for a
  // non-EU business AND a non-EU consumer, so this signal never moves a sale in
  // or out of Polish VAT - it only decides whether we can invoice it at all.
  if (input.taxId?.trim() || input.companyName?.trim()) {
    return {
      country,
      kind: "export_services",
      note: EXPORT_SERVICES_NOTE,
      taxSymbol: "np",
      vatUeReportable: false,
    };
  }

  // A consumer outside the EU. There is no correct invoice this plugin can
  // issue: union OSS does not cover non-EU consumers, and the non-union scheme
  // is unavailable to a supplier established in Poland. The place of supply is
  // the consumer's own country, which generally means registering there - the
  // United Kingdom in particular requires it from the first sale, with no
  // threshold for a non-established supplier. That is a registration decision,
  // not something a payload builder may invent a rate for.
  return {
    kind: "blocked",
    reason: `sale to a consumer in ${country}, outside the EU - no VAT treatment is implemented for this, and it may require a local VAT registration`,
  };
}

/**
 * Why a foreign sale was refused on the strength of what it contains.
 *
 * Three genuinely different situations, and the operator's next action differs
 * for each, so they get different sentences rather than one generic refusal.
 */
function blockedSupplyReason(country: string, input: RegimeInput): string {
  const detail = input.supplyReason ? ` (${input.supplyReason})` : "";
  if (input.supply === "goods") {
    return `order ships goods to ${country}; cross-border VAT for goods is not implemented by this plugin`;
  }
  if (input.supply === "mixed") {
    return `order to ${country} mixes services and goods${detail}`;
  }
  return `order to ${country} contains products with no VAT classification${detail}`;
}

/**
 * A consumer in another member state - the branch with three possible answers.
 *
 * Which one applies is decided by registration first, then by the threshold:
 *
 *  - **Registered for OSS** -> destination rate, declared through OSS.
 *  - **Not registered, below the threshold** -> the Polish rate, lawfully, under
 *    art. 28k ust. 2. This is the live path today.
 *  - **Not registered, threshold crossed** -> nothing correct exists. Park.
 *
 * The order of those checks matters. Registration is checked first because a
 * registered supplier cannot use the threshold at all - opting in surrenders it -
 * so consulting the counter first would produce the right answer for the wrong
 * reason and then be wrong the moment volumes fell.
 */
function ossRegime(country: string, input: RegimeInput): VatRegime {
  if (input.ossRegistered) {
    if (!input.ossEnabled) {
      return {
        kind: "blocked",
        reason: `sale to a consumer in ${country} requires the OSS procedure, which is not enabled`,
      };
    }
    const rate = input.ossRateFor(country);
    if (rate === null) {
      return { kind: "blocked", reason: `no OSS VAT rate is known for ${country}` };
    }
    return { country, kind: "oss", rate };
  }

  // Not registered. Everything now hinges on the threshold, so a missing verdict
  // is a blocker rather than an assumption of "plenty of room left".
  const verdict = input.threshold;
  if (!verdict) {
    return {
      kind: "blocked",
      reason: `sale to a consumer in ${country}: the intra-EU B2C threshold could not be evaluated, so the VAT treatment cannot be decided`,
    };
  }
  if (verdict.state === "unknown") {
    return { kind: "blocked", reason: verdict.reason };
  }
  if (verdict.state === "breached") {
    return { kind: "blocked", reason: breachReason(verdict.usedRatio) };
  }

  // Below the threshold: the place of supply stays in Poland and the domestic
  // rate is correct - because of the threshold, not in spite of it.
  return {
    alert: verdict.alert,
    country,
    kind: "eu_b2c_domestic_rate",
    taxSymbol: input.domesticTaxSymbol,
    usedRatio: verdict.usedRatio,
  };
}
