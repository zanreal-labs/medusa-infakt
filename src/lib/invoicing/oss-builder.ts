/**
 * OSS invoice payload builder.
 *
 * Separate from `builder.ts` because an OSS invoice is a separate document
 * family at inFakt - its own endpoint, its own field set, its own numbering -
 * and folding it into the VAT builder as a variant would have meant one function
 * where half the fields are meaningless depending on a flag.
 *
 * The invariant from `builder.ts` is preserved exactly: the lines must sum, minor
 * unit for minor unit, to what the buyer actually paid. An invoice that states a
 * different number than the payment is worse than no invoice.
 *
 * ## The check that matters
 *
 * There is a second guard here that the VAT builder does not need, and it is the
 * reason this file is worth reading. Under OSS the buyer owes the *destination*
 * country's rate. This plugin decides that rate from inFakt's own
 * `/moss_vat_rates.json` rather than from Medusa - but the money was already
 * taken by Medusa's checkout, at whatever rate Medusa's tax module happened to
 * be configured with. If those two disagree, no correct invoice exists: the
 * document would either misstate the tax or misstate the total.
 *
 * At the time of writing Medusa's non-Polish tax regions carry **no rate at
 * all**, so checkout charges 0% VAT to EU consumers. Every OSS order will
 * therefore fail the guard below and park in `needs_review` until the tax module
 * is configured with destination rates. That is the intended behaviour and it is
 * not a bug: parking is the honest outcome when the payment and the law
 * disagree, and it fails loudly at the first foreign consumer order rather than
 * quietly issuing wrong documents for months.
 *
 * See the PR body: OSS cannot go live on the plugin alone.
 */

import type { InfaktOssInvoicePayload, InfaktOssServicePayload } from "../infakt/types";
import type { InvoiceBuyerInput, InvoiceOrderInput } from "./builder";
import { lineGrossMinor, MAX_SERVICE_NAME, shippingLineName, UNIT_PIECES } from "./builder";
import { toMinorUnits, warsawDate } from "./money";

export interface OssBuilderConfig {
  currency: string;
  /** Destination member state, from the regime decision. */
  country: string;
  /** Destination rate as inFakt expresses it, e.g. "19". */
  rate: string;
  /** inFakt's service-type taxonomy. License keys are `electronic`. */
  serviceType: "electronic" | "broadcasting" | "telecommunications";
}

export type BuildOssResult =
  | { ok: true; payload: InfaktOssInvoicePayload; totalMinor: number }
  | { ok: false; reason: string };

/**
 * Rounding slack for the destination-VAT cross-check, in minor units per line.
 *
 * Medusa and inFakt both round per line, and the two can legitimately land a
 * grosz apart on each. Anything wider than that is a rate disagreement, not
 * rounding, and must not be absorbed.
 */
const PER_LINE_ROUNDING_SLACK = 1;

export function buildOssInvoicePayload(
  order: InvoiceOrderInput,
  buyer: InvoiceBuyerInput | undefined,
  config: OssBuilderConfig,
): BuildOssResult {
  const orderCurrency = (order.currency || config.currency).toUpperCase();
  if (order.items.length === 0) {
    return { ok: false, reason: "order has no items" };
  }

  const rate = Number(config.rate);
  if (!Number.isFinite(rate) || rate < 0) {
    return { ok: false, reason: `OSS rate "${config.rate}" is not a usable percentage` };
  }

  const services: InfaktOssServicePayload[] = [];
  for (const item of order.items) {
    const line = lineGrossMinor(item);
    if (line === null) {
      return { ok: false, reason: "order item has an invalid price or quantity" };
    }
    services.push({
      gross_price: line,
      name: item.name.slice(0, MAX_SERVICE_NAME),
      quantity: item.quantity,
      tax_rate: config.rate,
      unit: UNIT_PIECES,
    });
  }

  for (const shipping of order.shipping ?? []) {
    const shippingMinor = toMinorUnits(shipping.grossTotal) ?? 0;
    if (shippingMinor <= 0) {
      continue;
    }
    services.push({
      gross_price: shippingMinor,
      name: shippingLineName(shipping.name),
      quantity: 1,
      tax_rate: config.rate,
      unit: UNIT_PIECES,
    });
  }

  const linesTotal = services.reduce((sum, service) => sum + (service.gross_price ?? 0), 0);
  const orderTotal = toMinorUnits(order.total);
  if (orderTotal === null) {
    return { ok: false, reason: "order total is missing - cannot verify the invoice amount" };
  }
  if (linesTotal !== orderTotal) {
    return {
      ok: false,
      reason: `line total ${linesTotal} does not match order total ${orderTotal} (minor units)`,
    };
  }

  const charged = chargedTaxMinor(order);
  if (charged === null) {
    return {
      ok: false,
      reason:
        "the order does not report a tax total, so the VAT actually charged cannot be checked against the destination rate",
    };
  }

  const verdict = verifyDestinationTax(orderTotal, charged, rate, services.length);
  if (verdict !== null) {
    return { ok: false, reason: verdict };
  }

  const client = ossClientFields(buyer);
  if ("reason" in client) {
    return { ok: false, reason: client.reason };
  }

  return {
    ok: true,
    payload: {
      client_first_name: client.firstName,
      client_last_name: client.lastName,
      country: config.country,
      currency: orderCurrency,
      gross_price: orderTotal,
      issue_date: warsawDate(),
      net_price: orderTotal - charged,
      sale_type: "service",
      service_date: warsawDate(order.placedAt ?? null),
      service_place_primary: config.country,
      service_type: config.serviceType,
      services,
      tax_price: charged,
      ...client.optional,
    },
    totalMinor: orderTotal,
  };
}

/**
 * The VAT the checkout actually collected, in minor units.
 *
 * Read off the order rather than derived, because the entire point is to compare
 * it with what the destination rate says it should have been. Deriving it would
 * make the comparison tautological.
 */
function chargedTaxMinor(order: InvoiceOrderInput): number | null {
  if (order.taxTotal === undefined || order.taxTotal === null) {
    return null;
  }
  return toMinorUnits(order.taxTotal);
}

/**
 * Confirm the tax the buyer paid matches the destination country's rate.
 *
 * Returns null when it does, or the reason it does not. The reason names both
 * numbers, which is safe - amounts are not buyer identity data, and the operator
 * cannot act without them.
 */
function verifyDestinationTax(
  grossMinor: number,
  chargedTaxMinor: number,
  ratePercent: number,
  lineCount: number,
): string | null {
  const netMinor = grossMinor - chargedTaxMinor;
  const expectedTax = Math.round((netMinor * ratePercent) / 100);
  const slack = Math.max(PER_LINE_ROUNDING_SLACK * lineCount, PER_LINE_ROUNDING_SLACK);

  if (Math.abs(expectedTax - chargedTaxMinor) <= slack) {
    return null;
  }

  if (chargedTaxMinor === 0) {
    // Overwhelmingly the likeliest failure, and it has a specific fix, so it
    // gets a specific sentence rather than the generic mismatch below.
    return (
      `the order was charged no VAT, but an OSS sale needs the destination rate of ${ratePercent}% ` +
      `(expected ${expectedTax} minor units of tax) - the store's tax region for this country is probably unconfigured`
    );
  }
  return (
    `the order was charged ${chargedTaxMinor} minor units of VAT, but the destination rate of ${ratePercent}% ` +
    `implies ${expectedTax} - checkout and the OSS rate disagree, so no correct invoice can be issued`
  );
}

type OssClientResult =
  | { firstName: string; lastName: string; optional: Partial<InfaktOssInvoicePayload> }
  | { reason: string };

/**
 * OSS is a consumer procedure, and inFakt requires a natural person's name.
 *
 * A missing name blocks rather than falls back to the company name: an OSS
 * invoice naming a company is a contradiction in terms, and the plugin should
 * not paper over an order that reached this branch with business details on it.
 */
function ossClientFields(buyer: InvoiceBuyerInput | undefined): OssClientResult {
  if (!buyer) {
    return { reason: "order has no billing details" };
  }
  const firstName = buyer.firstName?.trim();
  const lastName = buyer.lastName?.trim();
  if (!(firstName && lastName)) {
    return { reason: "an OSS invoice needs the consumer's first and last name" };
  }
  return {
    firstName,
    lastName,
    optional: {
      ...(buyer.email ? { client_email: buyer.email } : {}),
      ...(buyer.street?.trim() ? { client_street: buyer.street.trim() } : {}),
      ...(buyer.city?.trim() ? { client_city: buyer.city.trim() } : {}),
      ...(buyer.postalCode?.trim() ? { client_post_code: buyer.postalCode.trim() } : {}),
    },
  };
}
