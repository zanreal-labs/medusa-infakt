/**
 * Invoice-number collision guard.
 *
 * The invoice number is not just a label on a document. Downstream it is the
 * reference the Marken plugin buys license keys under, and it is the *only*
 * cross-system identity those keys have: `marken_license_code.provider_reference`
 * is indexed but deliberately not unique, and the recovery call
 * `GetLicensesByInvoice` returns whatever was ever bought under a given string.
 *
 * So if two different orders ever end up with the same invoice-number string:
 *
 *  - the second order's fulfilment recovers the *first* order's license keys,
 *  - persists them against the second order (a different `order_id`, so the
 *    unique triple on `(order_id, sku, code_fingerprint)` does not stop it),
 *  - and emails one customer the keys another customer already received.
 *
 * That is a credential disclosure, not a billing error, and no amount of care in
 * the Marken plugin can detect it - by the time the number arrives there, the
 * ambiguity is already lost.
 *
 * Within a single inFakt numbering series a collision cannot normally happen.
 * The risk arrives with OSS: OSS invoices are a separate document family with
 * their own series, which can legitimately restart at 1 and produce a string
 * that a VAT invoice already used. The numbering inFakt actually assigns could
 * not be established without issuing a real OSS invoice, so rather than assume
 * it is safe, this guard makes the collision impossible to act on.
 *
 * It runs before `infakt.invoice.issued` is emitted, which is the last moment
 * before the number reaches anything that spends money.
 */

/** One already-issued number, as read back from `infakt_invoice`. */
export interface IssuedNumberClaim {
  orderId: string;
  invoiceNumber: string | null | undefined;
}

/**
 * Normalize a number for comparison.
 *
 * Case- and whitespace-insensitive on purpose. Two strings that a human would
 * read as the same invoice number must collide here even if inFakt returned
 * them with different spacing across document families, because the question is
 * "could these be confused downstream?", not "are these byte-identical?".
 */
export function normalizeInvoiceNumber(value: string | null | undefined): string | null {
  const normalized = value?.trim().replaceAll(/\s+/gu, "").toUpperCase();
  return normalized ? normalized : null;
}

/**
 * The order id that already claimed this number, or null when it is free.
 *
 * Returns the *other* order's id so the caller can name it in a review reason -
 * an operator resolving this needs to know which two orders are entangled, and
 * an order id is not buyer identity data.
 */
export function findNumberCollision(
  invoiceNumber: string | null | undefined,
  orderId: string,
  existing: readonly IssuedNumberClaim[],
): string | null {
  const target = normalizeInvoiceNumber(invoiceNumber);
  if (!target) {
    return null;
  }
  for (const claim of existing) {
    if (claim.orderId === orderId) {
      continue;
    }
    if (normalizeInvoiceNumber(claim.invoiceNumber) === target) {
      return claim.orderId;
    }
  }
  return null;
}

/** The review reason a collision produces. Kept here so it is tested in one place. */
export function collisionReason(invoiceNumber: string, otherOrderId: string): string {
  return (
    `invoice number ${invoiceNumber} is already recorded against order ${otherOrderId}. ` +
    "Refusing to announce this invoice: downstream license-key fulfilment is keyed on the " +
    "invoice number, so continuing could deliver one order's keys to another buyer."
  );
}
