import type { InfaktInvoicePayload, InfaktServicePayload } from "../infakt/types";
import { toMinorUnits, warsawDate } from "./money";
import { normalizeNip } from "./nip";

/**
 * inFakt invoice payload builder.
 *
 * Turns an order (already mapped off Medusa's DTOs by
 * `src/lib/invoicing/order-mapper.ts`) plus its buyer into an inFakt invoice
 * payload. Pure and synchronous so every rule is unit-testable.
 *
 * Rules, in the order they are enforced:
 *
 *  - Configured currency only. Anything else is skipped upstream rather than
 *    guessed at, because the VAT treatment of a foreign-currency sale is not
 *    something a payload builder gets to invent.
 *  - Every amount is converted to integer minor units exactly once (see
 *    `toMinorUnits`).
 *  - One service line per order item, plus one per shipping method that costs
 *    anything.
 *  - The sum of the lines MUST equal the order total, grosz for grosz. A
 *    mismatch fails the build. This is the single most important rule in the
 *    plugin: an invoice is a legal statement of what the buyer paid, and one
 *    that says a different number than the payment is worse than no invoice at
 *    all, because correcting it needs a formal corrective invoice.
 *  - A buyer with a NIP is a company: `client_business_activity_kind:
 *    "other_business"`, and the invoice is a candidate for KSeF filing. Without
 *    one it is a consumer invoice (`private_person`).
 *
 * Failure reasons are persisted to `InfaktInvoice.last_error` and rendered in
 * the admin UI, so they MUST NOT contain buyer PII - field names, counts and
 * amounts only. Never a name, never an address, never the NIP itself. There is
 * a test for each of those.
 */

/** inFakt rejects overly long service names; marketplace titles can be long. */
const MAX_SERVICE_NAME = 255;
/** Polish "pcs.", the unit for a countable line. */
const UNIT_PIECES = "szt.";
/** inFakt's own label for a bank transfer. */
const PAYMENT_METHOD_TRANSFER = "transfer";

export interface InvoiceBuilderConfig {
  /** Currency code the plugin invoices in, uppercase (e.g. "PLN"). */
  currency: string;
  /** inFakt VAT rate symbol applied to every line (e.g. "23"). */
  taxSymbol: string;
}

export interface InvoiceItemInput {
  name: string;
  quantity: number;
  /**
   * Gross total for the WHOLE line, in major units. Preferred, and what the
   * Medusa mapper supplies (`item.total`), because it is post-discount and
   * tax-inclusive - i.e. what the buyer actually paid for that line.
   */
  grossTotal?: number | string | null;
  /**
   * Gross price per unit, in major units. Used only when `grossTotal` is
   * absent, and then the line total is `round(unitPrice * 100) * quantity` -
   * one rounding, then an integer multiply.
   */
  unitPrice?: number | string | null;
}

export interface InvoiceShippingInput {
  /** Shipping method name, appended to the "Dostawa" line label. */
  name?: string | null;
  /** Gross total for this shipping method, in major units. */
  grossTotal?: number | string | null;
}

export interface InvoiceOrderInput {
  /** Order currency code (any case; compared case-insensitively). */
  currency: string;
  /** Gross grand total, in major units. The line sum must equal this. */
  total: number | string | null;
  /** When the order was placed (ISO timestamp). Becomes the sale date. */
  placedAt?: string | Date | null;
  items: InvoiceItemInput[];
  shipping?: InvoiceShippingInput[];
}

export interface InvoiceBuyerInput {
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
  /** Raw tax id as captured; normalized (and validated) here. */
  taxId?: string | null;
  street?: string | null;
  city?: string | null;
  postalCode?: string | null;
  /** ISO country code; defaults to "PL". */
  countryCode?: string | null;
  email?: string | null;
}

export type BuildInvoiceResult =
  | {
      ok: true;
      payload: InfaktInvoicePayload;
      isCompany: boolean;
      /** Normalized NIP when the buyer is a company. Never logged. */
      nip?: string;
      /** The verified line total, integer minor units. */
      totalMinor: number;
    }
  | { ok: false; reason: string };

export function buildInfaktInvoicePayload(
  order: InvoiceOrderInput,
  buyer: InvoiceBuyerInput | undefined,
  config: InvoiceBuilderConfig,
): BuildInvoiceResult {
  const orderCurrency = (order.currency || config.currency).toUpperCase();
  if (orderCurrency !== config.currency.toUpperCase()) {
    return { ok: false, reason: `unsupported currency ${orderCurrency}` };
  }
  if (order.items.length === 0) {
    return { ok: false, reason: "order has no items" };
  }

  const services: InfaktServicePayload[] = [];
  for (const item of order.items) {
    const line = lineTotalMinor(item);
    if (line === null) {
      return { ok: false, reason: "order item has an invalid price or quantity" };
    }
    services.push({
      gross_price: line,
      name: item.name.slice(0, MAX_SERVICE_NAME),
      quantity: item.quantity,
      tax_symbol: config.taxSymbol,
      unit: UNIT_PIECES,
    });
  }

  for (const shipping of order.shipping ?? []) {
    // The one `?? 0` here that is safe: an unreadable shipping cost drops the
    // line, the lines then sum short of the order total, and the total-match
    // guard below refuses the invoice. It cannot become an amount on a document.
    const shippingMinor = toMinorUnits(shipping.grossTotal) ?? 0;
    // A free shipping method is not a line. inFakt accepts a zero-gross
    // position, but a "Dostawa - 0,00 zl" row on a customer's invoice is noise,
    // and a zero line cannot affect the total-match guard either way.
    if (shippingMinor <= 0) {
      continue;
    }
    services.push({
      gross_price: shippingMinor,
      name: shipping.name ? `Dostawa - ${shipping.name}`.slice(0, MAX_SERVICE_NAME) : "Dostawa",
      quantity: 1,
      tax_symbol: config.taxSymbol,
      unit: UNIT_PIECES,
    });
  }

  // Never invoice an amount that differs from what the buyer paid. Discounts,
  // gift cards, credit lines and fee adjustments the mapper does not model must
  // be looked at by a human rather than silently absorbed into a line. A missing
  // order total means there is nothing to cross-check against, so refuse instead
  // of trusting the line sum blindly.
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

  const client = buildClientFields(buyer);
  if ("reason" in client) {
    return { ok: false, reason: client.reason };
  }

  const saleDate = warsawDate(order.placedAt ?? null);
  return {
    isCompany: client.isCompany,
    nip: client.nip,
    ok: true,
    payload: {
      currency: config.currency.toUpperCase(),
      // Issued today in Poland; numbering is delegated entirely to inFakt.
      invoice_date: warsawDate(),
      payment_method: PAYMENT_METHOD_TRANSFER,
      sale_date: saleDate,
      services,
      ...client.fields,
    },
    totalMinor: orderTotal,
  };
}

/**
 * One line's gross total in minor units, or null when the item is unusable.
 *
 * Quantity must be a positive integer: inFakt's `quantity` is a count against a
 * "szt." unit, and a fractional one would make the per-unit price it derives
 * meaningless.
 */
function lineTotalMinor(item: InvoiceItemInput): number | null {
  if (!Number.isInteger(item.quantity) || item.quantity <= 0) {
    return null;
  }
  if (item.grossTotal !== undefined && item.grossTotal !== null) {
    const total = toMinorUnits(item.grossTotal);
    return total !== null && total >= 0 ? total : null;
  }
  const unit = toMinorUnits(item.unitPrice);
  if (unit === null || unit < 0) {
    return null;
  }
  return unit * item.quantity;
}

type ClientFieldsResult =
  | { fields: Partial<InfaktInvoicePayload>; isCompany: boolean; nip?: string }
  | { reason: string };

function buildClientFields(buyer: InvoiceBuyerInput | undefined): ClientFieldsResult {
  if (!buyer) {
    return { reason: "order has no billing details" };
  }

  const street = buyer.street?.trim();
  const city = buyer.city?.trim();
  const postCode = buyer.postalCode?.trim();
  if (!(street && city && postCode)) {
    // Name the missing fields, never their values - this string is displayed.
    const missing = [
      street ? null : "street",
      city ? null : "city",
      postCode ? null : "postal_code",
    ].filter(Boolean);
    return { reason: `buyer address is incomplete (missing: ${missing.join(", ")})` };
  }

  const common = {
    client_city: city,
    client_country: buyer.countryCode?.trim().toUpperCase() || "PL",
    client_post_code: postCode,
    client_street: street,
    ...(buyer.email ? { client_email: buyer.email } : {}),
  } satisfies Partial<InfaktInvoicePayload>;

  const taxId = buyer.taxId?.trim();
  if (taxId) {
    const nip = normalizeNip(taxId);
    if (!nip) {
      // Report the digit COUNT, never the value: enough to tell a typo from a
      // foreign VAT id, without printing a tax number into the admin UI or into
      // `last_error`. There is a test asserting the digits do not appear.
      const digitCount = taxId.replaceAll(/\D/gu, "").length;
      return {
        reason: `buyer tax id does not normalize to a 10-digit NIP (${digitCount} digits found)`,
      };
    }
    const companyName = buyer.companyName?.trim();
    if (!companyName) {
      return { reason: "buyer has a NIP but no company name" };
    }
    return {
      fields: {
        ...common,
        client_business_activity_kind: "other_business",
        client_company_name: companyName,
        client_tax_code: nip,
      },
      isCompany: true,
      nip,
    };
  }

  const firstName = buyer.firstName?.trim();
  const lastName = buyer.lastName?.trim();
  if (!(firstName && lastName)) {
    return { reason: "buyer name is missing for a consumer invoice" };
  }
  return {
    fields: {
      ...common,
      client_business_activity_kind: "private_person",
      client_first_name: firstName,
      client_last_name: lastName,
    },
    isCompany: false,
  };
}
