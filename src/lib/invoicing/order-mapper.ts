import type { InvoiceBuyerInput, InvoiceOrderInput } from "./builder";
import { companyNameDefect } from "./builder";
import type { ClassifiableLine } from "./classification";
import { bigNumberToMinorUnits, bigNumberToQuantity } from "./money";
import type { NipExtractorOrder } from "./nip";

/**
 * The bridge between Medusa's order DTOs and the pure builder.
 *
 * Kept separate from `builder.ts` on purpose: the builder's rules are the part
 * worth pinning down with tests and porting faithfully, and they should not have
 * to change when Medusa reshapes a DTO. Everything Medusa-shaped lives here.
 *
 * ## Which amounts are read, and why
 *
 * Medusa v2 keeps money as decimals in the major unit, and every line carries
 * both a `unit_price` and a computed `total`. This mapper reads `total`:
 *
 *  - `item.total` is tax-inclusive and post-discount - it is what the buyer
 *    actually paid for that line.
 *  - `unit_price * quantity` is neither. On any order with a promotion, a
 *    gift card, or per-line tax, that product differs from the order total, and
 *    the builder's total-match guard would then send EVERY discounted order to
 *    needs_review. The guard is doing its job in that case; the input was wrong.
 *
 * The builder still supports the `unitPrice * quantity` form (see
 * `InvoiceItemInput`), because that is how the reference pipeline this was ported
 * from computed its lines, and a caller mapping from a system that only exposes
 * unit prices needs it.
 */

export interface MedusaLineItemLike {
  title?: string | null;
  product_title?: string | null;
  variant_title?: string | null;
  quantity: number;
  total?: unknown;
  unit_price?: unknown;
  /**
   * The three places a VAT classification marker can live, in the order the
   * classifier checks them: the line, then its variant, then its product. A
   * line-level marker wins so a one-off correction is possible without editing
   * the catalogue.
   */
  metadata?: Record<string, unknown> | null;
  variant?: { metadata?: Record<string, unknown> | null } | null;
  product?: { metadata?: Record<string, unknown> | null } | null;
}

export interface MedusaShippingMethodLike {
  name?: string | null;
  total?: unknown;
  amount?: unknown;
}

export interface MedusaAddressLike {
  first_name?: string | null;
  last_name?: string | null;
  company?: string | null;
  address_1?: string | null;
  address_2?: string | null;
  city?: string | null;
  postal_code?: string | null;
  country_code?: string | null;
  metadata?: Record<string, unknown> | null;
}

export interface MedusaOrderLike extends NipExtractorOrder {
  id: string;
  display_id?: number | string | null;
  currency_code?: string | null;
  total?: unknown;
  /**
   * VAT the checkout collected. Only the OSS path reads it, and only to prove
   * the buyer was charged the destination country's rate before an invoice
   * claims they were. Requires `tax_total` in the worker's field list.
   */
  tax_total?: unknown;
  email?: string | null;
  created_at?: string | Date | null;
  canceled_at?: string | Date | null;
  status?: string | null;
  items?: MedusaLineItemLike[] | null;
  shipping_methods?: MedusaShippingMethodLike[] | null;
  billing_address?: MedusaAddressLike | null;
  shipping_address?: MedusaAddressLike | null;
  metadata?: Record<string, unknown> | null;
}

/** Divide by 100 to get back to major units; the builder re-multiplies. */
const minorToMajor = (minor: number | null): number | null => (minor === null ? null : minor / 100);

/**
 * A line's display name.
 *
 * `title` on a Medusa line item is the variant title, which is often just
 * "Default" or a size. Prefer the product title and qualify it with the variant
 * when both exist, so the invoice reads like a document a buyer recognises rather
 * than a database row.
 *
 * Some catalogues bake the product title into the variant title itself
 * ("Antivirus Suite for Mac - 1 rok / 1" for an "Antivirus Suite for Mac"
 * product); qualifying that with the full variant title would print the
 * product name twice. When the variant title starts with the product title at a
 * word boundary, only the remainder after the shared prefix is appended.
 */
export function lineItemName(item: MedusaLineItemLike): string {
  const product = item.product_title?.trim();
  const variant = item.variant_title?.trim();
  const title = item.title?.trim();
  if (product && variant && variant !== product) {
    if (variant.startsWith(product) && /^[^\p{L}\p{N}]/u.test(variant.slice(product.length))) {
      // Every leading non-alphanumeric is dropped, not just whitespace and
      // hyphens. Stripping only `[\s-]` left the rest of the join behind, so a
      // variant titled "Product / 1 rok" came out as "Product - / 1 rok" - a
      // separator with nothing between it and the next one, printed on an
      // invoice. See `builder.ts`'s `textShapeDefect` for the shape.
      const suffix = variant.slice(product.length).replace(/^[^\p{L}\p{N}]+/u, "").trim();
      return suffix ? `${product} - ${suffix}` : product;
    }
    return `${product} - ${variant}`;
  }
  return product || title || variant || "Pozycja";
}

/**
 * The company name, but only when it is evidence that the buyer is a business.
 *
 * `decideVatRegime` treats a non-empty company name as one of the two signals that
 * a non-EU buyer is a business rather than a consumer, and a business supply is
 * invoiced `np` - outside Polish VAT - with a statutory annotation on the document.
 * That decision was being made on the RAW `billing_address.company`, while the
 * builder printed the CLEANED one. So the same order could be classified as a
 * company on the strength of text the builder had already stripped away: an order
 * whose company field held nothing but `(5261040828)` was a business to the regime
 * and had no company name at all to the payload.
 *
 * Cleaning it first makes the two halves agree, and refusing residue makes the
 * disagreement fail in the safe direction: a non-EU buyer with no usable company
 * name and no tax id is `blocked`, which is a `needs_review` row an operator looks
 * at, rather than an invoice asserting a place of supply outside Poland.
 */
export function businessNameSignal(
  companyName?: string | null,
  taxId?: string,
): string | null {
  const cleaned = cleanCompanyName(companyName, taxId);
  if (!cleaned) {
    return null;
  }
  // The full builder gate, tax-id branch included, and that branch is load
  // bearing here: `cleanCompanyName` falls back to the RAW value when cleaning
  // empties it, so a company field holding nothing but `(5261040828)` survives
  // as itself - balanced brackets, digits present, no dangling separator. Only
  // "the name still contains the tax id" catches that one.
  return companyNameDefect(cleaned, taxId) ? null : cleaned;
}

/** Street line: `address_1`, with `address_2` appended when present. */
export function streetLine(address?: MedusaAddressLike | null): string | undefined {
  const first = address?.address_1?.trim();
  const second = address?.address_2?.trim();
  if (!first) {
    return second || undefined;
  }
  return second ? `${first} ${second}` : first;
}

/** Map a Medusa order onto the builder's order input. */
export function toInvoiceOrderInput(
  order: MedusaOrderLike,
  fallbackCurrency: string,
): InvoiceOrderInput {
  return {
    currency: (order.currency_code ?? fallbackCurrency).toUpperCase(),
    items: (order.items ?? []).map((item) => ({
      grossTotal: minorToMajor(bigNumberToMinorUnits(item.total)),
      name: lineItemName(item),
      // `quantity` is a BigNumber off `query.graph`, same as the money columns.
      quantity: bigNumberToQuantity(item.quantity) ?? Number.NaN,
      // Only consulted when grossTotal is null (an order read without totals).
      unitPrice: minorToMajor(bigNumberToMinorUnits(item.unit_price)),
    })),
    placedAt: order.created_at ?? null,
    taxTotal: minorToMajor(bigNumberToMinorUnits(order.tax_total)),
    shipping: (order.shipping_methods ?? []).map((method) => ({
      grossTotal: minorToMajor(
        bigNumberToMinorUnits(method.total) ?? bigNumberToMinorUnits(method.amount),
      ),
      name: method.name ?? null,
    })),
    total: minorToMajor(bigNumberToMinorUnits(order.total)),
  };
}

/**
 * Reduce an order's lines to just what the VAT classifier needs.
 *
 * Kept beside the other mappers rather than inside `classification.ts` so the
 * classifier stays free of Medusa DTO shapes and can be unit-tested on plain
 * objects, the same way the builder is.
 */
export function toClassifiableLines(order: MedusaOrderLike): ClassifiableLine[] {
  return (order.items ?? []).map((item) => ({
    metadata: item.metadata ?? null,
    name: lineItemName(item),
    productMetadata: item.product?.metadata ?? null,
    variantMetadata: item.variant?.metadata ?? null,
  }));
}

/**
 * Map a Medusa order onto the builder's buyer input.
 *
 * The billing address is the invoice address, falling back to the shipping
 * address only when there is no billing address at all - not field by field. A
 * half-billing, half-shipping address is a fiction that appears on a legal
 * document, and "the buyer gave us one address" is a far more defensible reading
 * than "we assembled one".
 *
 * `taxId` comes from the configured extractor (defaults documented in `nip.ts`).
 * The company name comes from the same address the NIP was found on.
 */
export function toInvoiceBuyerInput(
  order: MedusaOrderLike,
  nipExtractor: (order: NipExtractorOrder) => string | undefined,
): InvoiceBuyerInput {
  const address = order.billing_address ?? order.shipping_address ?? null;
  const taxId = nipExtractor(order);
  return {
    city: address?.city ?? null,
    companyName: cleanCompanyName(address?.company, taxId),
    countryCode: address?.country_code ?? null,
    email: order.email ?? null,
    firstName: address?.first_name ?? null,
    lastName: address?.last_name ?? null,
    postalCode: address?.postal_code ?? null,
    street: streetLine(address) ?? null,
    taxId: taxId ?? null,
  };
}

/**
 * Strip a NIP out of the company name when the storefront concatenated them.
 *
 * "ACME Sp. z o.o. NIP 526-104-08-28" is a company name a human typed into one
 * field; putting it on the invoice verbatim prints the tax number twice, once in
 * the wrong place. Only the trailing NIP-ish tail is removed, and only when a NIP
 * was actually extracted, so a company whose legal name genuinely contains digits
 * is untouched.
 */
export function cleanCompanyName(
  companyName?: string | null,
  nip?: string,
): string | null {
  const name = companyName?.trim();
  if (!name) {
    return null;
  }
  if (!nip) {
    return name;
  }
  const cleaned = name
    .replaceAll(/\bNIP\b/giu, " ")
    .replaceAll(/(?<=\d)[\s.-]+(?=\d)/gu, "")
    .replaceAll(new RegExp(`(?<!\\d)${nip}(?!\\d)`, "gu"), " ")
    // Taking the NIP out of "Firma (NIP 526-104-08-28)" leaves the brackets
    // behind, and an invoice reading "Firma ( )" went out to a customer.
    // Drop any bracket pair the removal emptied; a pair with text left inside
    // is part of the name and stays.
    .replaceAll(/[([{]\s*[)\]}]/gu, " ")
    .replaceAll(/[\s,:;-]+$/gu, "")
    .replaceAll(/\s{2,}/gu, " ")
    .trim();
  // Never return an empty company name: a buyer with a NIP must have one, and the
  // builder rejects the invoice if it is blank. Falling back to the raw value
  // keeps a slightly ugly invoice instead of a needs_review row.
  return cleaned || name;
}
