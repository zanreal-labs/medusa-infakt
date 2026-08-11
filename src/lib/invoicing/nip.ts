/**
 * NIP (Polish tax identification number) handling.
 *
 * Two rules govern everything in this file:
 *
 * 1. A NIP is what decides whether an invoice is a B2B document that must be
 *    filed to KSeF. Getting it wrong in either direction is a legal problem, so
 *    the only accepted form is exactly ten digits and nothing is guessed.
 * 2. A NIP is buyer identity data. It never appears in a rejection reason,
 *    because those reasons are persisted to `last_error` and rendered in the
 *    admin UI. Field names and lengths only.
 */

/** A bare Polish NIP: exactly ten digits. */
const NIP_DIGITS = 10;

/**
 * Digits-only NIP, or null when the input is not one.
 *
 * Strips a leading "PL" (the VAT-EU prefix for the same number) and every
 * non-digit separator, so "PL 526-104-08-28" and "5261040828" converge. Anything
 * that does not land on exactly ten digits is rejected rather than padded or
 * truncated - a nine-digit value is not a NIP with a typo, it is an unknown
 * identifier, and inFakt would reject it (or worse, accept it) downstream.
 *
 * The country-prefix strip means this cannot tell a Polish NIP from a foreign
 * registration number that happens to be ten digits. That is why the default
 * extractor below only reads fields a storefront explicitly designated as a NIP,
 * and why `company` parsing requires the NIP shape to be unambiguous.
 */
export function normalizeNip(taxId: string): string | null {
  const digits = taxId.replace(/^\s*PL/iu, "").replaceAll(/\D/gu, "");
  return digits.length === NIP_DIGITS ? digits : null;
}

/**
 * The NIP checksum, per the Ministry of Finance's published algorithm: the
 * weighted sum of the first nine digits modulo 11 must equal the tenth.
 *
 * Deliberately NOT used as a gate on issuing an invoice. A buyer who typed a
 * NIP that fails its checksum still has to be invoiced, and inFakt (and
 * ultimately KSeF) is the authority on whether the number is acceptable -
 * refusing here would park a legally required document in needs_review over a
 * check we are not the arbiter of. It exists for the `company`-field heuristic
 * below, where the question is not "is this valid?" but "is this ten-digit run
 * a NIP at all, or a phone number that wandered into the wrong field?".
 */
export function hasValidNipChecksum(nip: string): boolean {
  if (!/^\d{10}$/u.test(nip)) {
    return false;
  }
  const weights = [6, 5, 7, 2, 3, 4, 5, 6, 7];
  const sum = weights.reduce((acc, weight, index) => acc + weight * Number(nip[index]), 0);
  const checksum = sum % 11;
  // A remainder of 10 makes the number unusable as a NIP; no valid NIP produces it.
  return checksum !== 10 && checksum === Number(nip[9]);
}

/** The subset of a Medusa order the default NIP extractor reads. */
export interface NipExtractorOrder {
  metadata?: Record<string, unknown> | null;
  billing_address?: {
    company?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
  shipping_address?: {
    company?: string | null;
    metadata?: Record<string, unknown> | null;
  } | null;
}

/** Keys the default extractor accepts, in the order it tries them. */
const NIP_METADATA_KEYS = ["nip", "tax_id", "taxId", "vat_id", "vatId"] as const;

const readMetadataNip = (metadata: Record<string, unknown> | null | undefined): string | null => {
  if (!metadata) {
    return null;
  }
  for (const key of NIP_METADATA_KEYS) {
    const raw = metadata[key];
    if (typeof raw === "string" && raw.trim().length > 0) {
      return raw;
    }
  }
  return null;
};

/**
 * A NIP embedded in the free-text `company` field, e.g.
 * "ACME Sp. z o.o. NIP 526-104-08-28".
 *
 * This is the least trustworthy source, so it is also the strictest: the field
 * must contain exactly one candidate run of ten digits (after separators are
 * stripped) AND that run must pass the NIP checksum. Both conditions exist to
 * stop a phone number, a KRS number or a street address from being read as a
 * tax id and silently turning a consumer invoice into a B2B one that gets filed
 * to KSeF under a stranger's number.
 */
export function nipFromCompanyField(company?: string | null): string | null {
  if (!company) {
    return null;
  }
  // Collapse the separators a human would type inside a NIP, then look for
  // ten-digit runs that are not part of a longer number.
  const collapsed = company.replaceAll(/(?<=\d)[\s.-]+(?=\d)/gu, "");
  const candidates = [...collapsed.matchAll(/(?<!\d)(\d{10})(?!\d)/gu)].map((match) => match[1]);
  const unique = [...new Set(candidates)];
  if (unique.length !== 1) {
    return null;
  }
  const [candidate] = unique;
  return hasValidNipChecksum(candidate) ? candidate : null;
}

/**
 * The default NIP source, in precedence order:
 *
 *   1. `order.metadata.nip`
 *   2. `order.billing_address.metadata.nip`
 *   3. a NIP parsed out of `order.billing_address.company`
 *
 * Storefronts differ wildly in where they put a business buyer's tax id -
 * Medusa core has no field for it - so this is a documented default, not a
 * standard. Override it with the `nipExtractor` plugin option when your
 * storefront writes it somewhere else.
 *
 * The shipping address is deliberately NOT consulted: a company shipping
 * address on a consumer order is common (delivery to an office), and reading it
 * would file that consumer's invoice to KSeF under their employer's NIP.
 */
export function defaultNipExtractor(order: NipExtractorOrder): string | undefined {
  const candidate =
    readMetadataNip(order.metadata) ??
    readMetadataNip(order.billing_address?.metadata) ??
    nipFromCompanyField(order.billing_address?.company);
  return candidate ?? undefined;
}
