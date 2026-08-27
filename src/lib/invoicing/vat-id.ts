/**
 * EU VAT identification numbers.
 *
 * Two rules govern this file, and they are the same two that govern `nip.ts`:
 *
 * 1. **Shape is not validity.** Everything here is a structural check - "could
 *    this string be a VAT number issued by DE?" - and nothing more. A number
 *    that passes every check in this file may still belong to nobody. Only VIES
 *    can say otherwise (`vies.ts`), and only a VIES-confirmed number may be used
 *    to zero-rate a supply. Treating a well-formed number as a valid one is the
 *    single most expensive mistake available in this area: it turns an
 *    under-collected VAT liability into our own.
 * 2. **A VAT id is buyer identity data.** It never appears in a rejection
 *    reason, because those reasons are persisted to `InfaktInvoice.last_error`
 *    and rendered in the admin UI. Country codes and lengths only, never the
 *    digits. There is a test for that.
 *
 * The country *prefix* on a VAT number is its own namespace and does not always
 * equal the ISO country code of the state that issued it. Greece issues `EL`
 * numbers but is `GR` in ISO. That mapping is handled here so that no caller
 * has to remember it.
 */

import { normalizeCountry } from "./eu";

/**
 * Structural pattern per VAT prefix, applied after the prefix is stripped.
 *
 * Sourced from the EU Commission's published national VAT number formats. These
 * are deliberately permissive about check digits: several member states use
 * checksum schemes that are undocumented or have changed over time, and a
 * checksum rejection here would park a legitimate order over a rule we are not
 * the authority on. VIES is the authority. Compare the reasoning in
 * `nip.ts:hasValidNipChecksum`, which exists but is deliberately not a gate.
 */
const VAT_PATTERNS: Readonly<Record<string, RegExp>> = {
  AT: /^U\d{8}$/u,
  BE: /^\d{10}$/u,
  BG: /^\d{9,10}$/u,
  CY: /^\d{8}[A-Z]$/u,
  CZ: /^\d{8,10}$/u,
  DE: /^\d{9}$/u,
  DK: /^\d{8}$/u,
  EE: /^\d{9}$/u,
  // Greece issues EL-prefixed numbers; see `PREFIX_TO_COUNTRY`.
  EL: /^\d{9}$/u,
  ES: /^[A-Z0-9]\d{7}[A-Z0-9]$/u,
  FI: /^\d{8}$/u,
  FR: /^[A-Z0-9]{2}\d{9}$/u,
  HR: /^\d{11}$/u,
  HU: /^\d{8}$/u,
  IE: /^(?:\d{7}[A-Z]{1,2}|\d[A-Z*+]\d{5}[A-Z])$/u,
  IT: /^\d{11}$/u,
  LT: /^(?:\d{9}|\d{12})$/u,
  LU: /^\d{8}$/u,
  LV: /^\d{11}$/u,
  MT: /^\d{8}$/u,
  NL: /^\d{9}B\d{2}$/u,
  PL: /^\d{10}$/u,
  PT: /^\d{9}$/u,
  RO: /^\d{2,10}$/u,
  SE: /^\d{12}$/u,
  SI: /^\d{8}$/u,
  SK: /^\d{10}$/u,
};

/**
 * VAT prefixes that do not equal the ISO country code of the issuing state.
 *
 * `XI` is deliberately absent. Northern Ireland's XI prefix covers goods only;
 * for services NI is outside the EU VAT area, and this plugin invoices
 * services. See the header of `eu.ts`.
 */
const PREFIX_TO_COUNTRY: Readonly<Record<string, string>> = { EL: "GR" };

export interface ParsedVatId {
  /** The ISO alpha-2 country of the issuing state (Greece resolves to `GR`). */
  country: string;
  /** The VAT prefix as it belongs on an invoice (Greece is `EL`). */
  prefix: string;
  /** The number with the prefix stripped, uppercased, separators removed. */
  number: string;
  /** Prefix + number, i.e. the form that belongs in `client_tax_code`. */
  normalized: string;
}

export type ParseVatIdResult = ParsedVatId | { reason: string };

/**
 * Parse a raw buyer-supplied VAT identifier into its prefix and number.
 *
 * Requires an explicit country prefix. A bare run of digits is rejected rather
 * than combined with the billing country, because "10 digits and the address
 * says DE" is not a German VAT number - German ones are 9 digits - and guessing
 * the prefix is how a Polish NIP typed into a foreign order becomes a German
 * reverse charge. The one place a bare number is meaningful is the domestic
 * path, which has its own parser in `nip.ts`.
 */
export function parseEuVatId(raw: string | null | undefined): ParseVatIdResult {
  const compact = (raw ?? "").replaceAll(/[\s.-]/gu, "").toUpperCase();
  if (!compact) {
    return { reason: "no VAT id supplied" };
  }

  const prefix = compact.slice(0, 2);
  if (!/^[A-Z]{2}$/u.test(prefix)) {
    return { reason: "VAT id does not start with a two-letter country prefix" };
  }

  const pattern = VAT_PATTERNS[prefix];
  if (!pattern) {
    // Named because the prefix is not identity data - it is on the envelope, not
    // in it - and knowing WHICH country was refused is what makes this
    // actionable in the admin UI.
    return { reason: `VAT id prefix ${prefix} is not an EU member state` };
  }

  const number = compact.slice(2);
  if (!pattern.test(number)) {
    // Length only. Never the digits.
    return {
      reason: `VAT id is not a well-formed ${prefix} number (${number.length} characters after the prefix)`,
    };
  }

  return {
    country: PREFIX_TO_COUNTRY[prefix] ?? prefix,
    normalized: `${prefix}${number}`,
    number,
    prefix,
  };
}

/** Narrowing helper, so call sites read as a question rather than a property test. */
export function isParsedVatId(result: ParseVatIdResult): result is ParsedVatId {
  return !("reason" in result);
}

/**
 * Whether a parsed VAT id was issued by the country the buyer is billed in.
 *
 * A mismatch is not automatically fraud - a German company genuinely can be
 * billed at a French address - but it does mean the two pieces of evidence
 * disagree about where the customer belongs, and the place of supply follows
 * the customer. This plugin treats a mismatch as something a human looks at
 * rather than something it resolves by preferring one field over the other.
 */
export function vatIdMatchesCountry(parsed: ParsedVatId, billingCountry: string | null): boolean {
  const normalized = normalizeCountry(billingCountry);
  return normalized !== null && normalized === parsed.country;
}
