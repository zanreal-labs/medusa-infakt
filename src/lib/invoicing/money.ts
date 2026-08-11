/**
 * Money and calendar helpers shared by the builder, the paid gate and the
 * matching engine. Pure and dependency-free, so every rule here is unit-tested
 * without a database or an HTTP mock.
 */

/**
 * Major units (e.g. 133.44 PLN) to integer minor units (13344 grosze).
 *
 * Medusa v2 stores order amounts as decimals in the major unit, and its
 * `BigNumberValue` fields arrive as a number, a numeric string, or a
 * `{ value }`-shaped raw object depending on which read path produced them -
 * hence the permissive input.
 *
 * `Math.round(x * 100)` is applied exactly ONCE per value, never to an
 * already-rounded intermediate. Rounding twice (per unit, then again after
 * multiplying) is how a line total drifts one grosz away from what the buyer
 * was charged, and a one-grosz drift is the difference between an invoice that
 * matches the payment and one that does not.
 */
export function toMinorUnits(value?: number | string | null): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  if (!Number.isFinite(parsed)) {
    return null;
  }
  return Math.round(parsed * 100);
}

/**
 * Unwrap the shapes a Medusa `BigNumberValue` can take before converting.
 *
 * Depending on the read path, a money field comes back as a number, a numeric
 * string, or a raw `{ value: "133.44", precision: 20 }` object. Reading
 * `Number(rawObject)` yields NaN, which `toMinorUnits` correctly rejects - but
 * that would send a perfectly good order to needs_review for a serialization
 * detail, so the object form is unwrapped here instead.
 */
export function bigNumberToMinorUnits(value?: unknown): number | null {
  if (typeof value === "object" && value !== null && "value" in value) {
    return toMinorUnits((value as { value: number | string | null }).value);
  }
  if (typeof value === "number" || typeof value === "string" || value === null) {
    return toMinorUnits(value);
  }
  return null;
}

/**
 * The calendar date in Poland, as YYYY-MM-DD.
 *
 * Invoices are issued under Polish law, so the issue date is the Polish
 * calendar day, not the server's. `en-CA` is the locale whose short date format
 * is already YYYY-MM-DD, which avoids hand-assembling the string from
 * `Intl.DateTimeFormat` parts.
 *
 * An unparseable input falls back to today rather than throwing: the caller is
 * mapping a stored timestamp, and a malformed one must not be able to stop a
 * legally required document from being issued.
 */
export function warsawDate(isoTimestamp?: string | Date | null): string {
  const date = isoTimestamp ? new Date(isoTimestamp) : new Date();
  if (Number.isNaN(date.getTime())) {
    return warsawDate();
  }
  return date.toLocaleDateString("en-CA", { timeZone: "Europe/Warsaw" });
}

/**
 * Strict YYYY-MM-DD, rejecting everything `Date.parse` leniently accepts.
 *
 * The shape check alone is not enough: `Date.parse("2026-02-30")` succeeds,
 * because ECMAScript rolls the overflow over to March 2nd. That would let a
 * fat-fingered `startDate` become a floor that silently means a different day
 * than it reads as, so the parse is required to round-trip back to the same
 * string.
 */
export function isCalendarDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}
