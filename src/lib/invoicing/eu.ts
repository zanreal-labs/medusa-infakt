/**
 * EU membership, for VAT purposes only.
 *
 * This is not a general-purpose country list and must not be used as one. It
 * answers exactly one question - "does this destination fall inside the EU VAT
 * area for a supply of services?" - and the answer differs from political
 * membership in two ways that matter here:
 *
 *  - **GB is a third country.** Since 2021 a supply to Great Britain is an
 *    export of services, not an intra-Community one. It must never reach the
 *    VAT-UE summary.
 *  - **XI (Northern Ireland) is a third country FOR SERVICES.** The Windsor
 *    Framework keeps Northern Ireland inside the EU VAT area for *goods* only,
 *    which is why the XI VAT prefix exists at all. For services NI follows UK
 *    rules. This plugin invoices electronically supplied services, so XI is
 *    deliberately absent from the list below. If this plugin ever invoices
 *    goods, that decision has to be revisited rather than inherited.
 *
 * Kept as a plain frozen set rather than pulled from a library: the membership
 * of the EU changes on a timescale of years and always with warning, and a
 * silent dependency bump that adds or removes a country would silently change
 * which invoices carry VAT.
 */

/**
 * The 27 member states, as ISO 3166-1 alpha-2, uppercase.
 *
 * Greece is `GR` here because that is its ISO country code, and country codes
 * are what Medusa stores on an address. Its *VAT prefix* is `EL`, which is a
 * different namespace - see `vat-id.ts`.
 */
export const EU_MEMBER_STATES: ReadonlySet<string> = new Set([
  "AT",
  "BE",
  "BG",
  "CY",
  "CZ",
  "DE",
  "DK",
  "EE",
  "ES",
  "FI",
  "FR",
  "GR",
  "HR",
  "HU",
  "IE",
  "IT",
  "LT",
  "LU",
  "LV",
  "MT",
  "NL",
  "PL",
  "PT",
  "RO",
  "SE",
  "SI",
  "SK",
]);

/** Poland's country code. The domestic path keys off this and nothing else. */
export const POLAND = "PL";

/** Normalize a country code to the uppercase alpha-2 form the sets above use. */
export function normalizeCountry(value: string | null | undefined): string | null {
  const trimmed = value?.trim().toUpperCase();
  return trimmed && /^[A-Z]{2}$/u.test(trimmed) ? trimmed : null;
}

/** True for Poland. Kept as a function so call sites read as intent, not string equality. */
export function isPoland(country: string | null | undefined): boolean {
  return normalizeCountry(country) === POLAND;
}

/**
 * True for an EU member state, Poland included.
 *
 * Callers deciding a VAT regime want "another member state", so they check
 * `isEuMember(c) && !isPoland(c)`. That is spelled out at each call site rather
 * than hidden in a second helper, because "EU" meaning "EU except us" is exactly
 * the kind of implicit exclusion that produces a domestic invoice with a
 * reverse-charge annotation on it.
 */
export function isEuMember(country: string | null | undefined): boolean {
  const normalized = normalizeCountry(country);
  return normalized !== null && EU_MEMBER_STATES.has(normalized);
}
