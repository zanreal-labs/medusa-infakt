/**
 * Turning a Medusa order into a VAT regime.
 *
 * `regime.ts` holds the rules and is deliberately pure; this file is the impure
 * half - it reads the order, pulls the destination rate off inFakt, and hands
 * the pure function everything it needs. Keeping the two apart is what lets the
 * legally consequential branches be tested exhaustively without a network.
 */

import type { InfaktClient } from "../infakt/client";
import { classifyOrderSupply } from "./classification";
import { isEuMember } from "./eu";
import type { MedusaOrderLike } from "./order-mapper";
import { toClassifiableLines } from "./order-mapper";
import type { VatRegime, ViesFallback } from "./regime";
import { decideVatRegime } from "./regime";
import type { EuB2cSale } from "./threshold";
import { evaluateThreshold } from "./threshold";
import { readCachedVies } from "./vies";

export interface RegimeResolutionOptions {
  domesticTaxSymbol: string;
  crossBorderEnabled: boolean;
  ossEnabled: boolean;
  /** Whether the company holds an actual OSS registration. */
  ossRegistered: boolean;
  viesFallback: ViesFallback;
  /** Per-currency intra-EU B2C limits, minor units. */
  thresholds: Readonly<Record<string, number>>;
  /** Warn at this fraction of the limit. */
  alertRatio: number;
}

/**
 * Destination VAT rates, cached per country for the life of a worker run.
 *
 * Cached because a batch of twenty orders to Germany should ask inFakt once, not
 * twenty times, and because the worker's rate limit budget is shared with the
 * calls that actually issue invoices. Not cached across process restarts: a rate
 * change that a member state announces is exactly the kind of thing that must
 * not be pinned by a long-lived cache.
 *
 * Only the standard rate is used. Reduced rates exist per country, but knowing
 * that a given product qualifies for one is a product-classification question
 * this plugin has no data for, and guessing "reduced" would understate the tax.
 * Standard is the safe direction: over-collecting is correctable, under-
 * collecting is a liability.
 */
export class MossRateCache {
  private readonly cache = new Map<string, string | null>();

  constructor(private readonly client: Pick<InfaktClient, "listMossRates">) {}

  async rateFor(country: string): Promise<string | null> {
    const key = country.toUpperCase();
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    let resolved: string | null = null;
    try {
      const rates = await this.client.listMossRates(key);
      const standard = rates.find((rate) => !rate.reduced && Number.isFinite(rate.value));
      resolved = standard ? String(standard.value) : null;
    } catch {
      // A failed lookup must not be cached as "no rate", because that would turn
      // a transient inFakt blip into a permanent block for that country. Return
      // null for this order and let the next one ask again.
      return null;
    }
    this.cache.set(key, resolved);
    return resolved;
  }
}

/**
 * Decide the regime for one order.
 *
 * The OSS rate is fetched up front rather than lazily inside the pure function,
 * because that function must stay synchronous. A rate is only looked up when the
 * destination could plausibly need one, so a store with cross-border disabled
 * never calls inFakt for rates at all.
 */
export async function resolveOrderRegime(
  order: MedusaOrderLike,
  buyerTaxId: string | undefined,
  options: RegimeResolutionOptions,
  rates: Pick<MossRateCache, "rateFor">,
  /** The EU B2C sales already on the books, read only when they can matter. */
  priorSales: () => Promise<EuB2cSale[]>,
  /** This order expressed as a candidate EU B2C sale. */
  pendingSale: EuB2cSale,
): Promise<VatRegime> {
  const address = order.billing_address ?? order.shipping_address ?? null;
  const billingCountry = address?.country_code ?? null;

  const classification = classifyOrderSupply(toClassifiableLines(order));

  // Fetch the destination rate before entering the synchronous decision. Doing
  // it unconditionally for foreign destinations costs one cached call and keeps
  // the pure function free of promises.
  const country = billingCountry?.trim().toUpperCase() ?? "";
  const foreign = country.length === 2 && country !== "PL";
  const needsRate = options.ossEnabled && options.ossRegistered && foreign;
  const rate = needsRate ? await rates.rateFor(country) : null;

  // The threshold only matters for an EU consumer while we are NOT registered.
  // Reading the books for a domestic order, or when registration makes the
  // counter irrelevant, would be pure overhead.
  const threshold =
    foreign && !options.ossRegistered && isEuMember(country)
      ? evaluateThreshold({
          alertRatio: options.alertRatio,
          pending: pendingSale,
          prior: await priorSales(),
          thresholds: options.thresholds,
        })
      : undefined;

  return decideVatRegime({
    billingCountry,
    companyName: address?.company ?? null,
    domesticTaxSymbol: options.domesticTaxSymbol,
    ossEnabled: options.ossEnabled,
    ossRateFor: () => rate,
    ossRegistered: options.ossRegistered,
    supply: classification.supply,
    supplyReason: "reason" in classification ? classification.reason : undefined,
    taxId: buyerTaxId ?? null,
    threshold,
    vies: readCachedVies(order.metadata),
    viesFallback: options.viesFallback,
  });
}

/**
 * Whether a regime describes a sale that leaves Poland.
 *
 * Used to decide whether the invoice needs emailing to the buyer, since a
 * foreign buyer cannot collect one from KSeF.
 */
export function isCrossBorder(regime: VatRegime | null | undefined): boolean {
  return (
    regime?.kind === "reverse_charge" ||
    regime?.kind === "export_services" ||
    regime?.kind === "oss" ||
    regime?.kind === "eu_b2c_domestic_rate"
  );
}
