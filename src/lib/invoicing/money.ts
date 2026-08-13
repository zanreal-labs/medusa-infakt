/**
 * Money and calendar helpers shared by the builder, the paid gate and the
 * matching engine. Pure and dependency-free, so every rule here is unit-tested
 * without a database or an HTTP mock.
 */

/**
 * Major units (e.g. 133.44 PLN) to integer minor units (13344 grosze).
 *
 * Medusa v2 stores order amounts as decimals in the major unit, and its
 * `BigNumberValue` fields arrive as a number or a numeric string depending on
 * which read path produced them - hence the permissive input. The object forms
 * (a `BigNumber` instance, a raw `{ value, precision }`) are unwrapped onto
 * this by `bigNumberToMinorUnits`.
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
 * The public surface this module reads a Medusa `BigNumber` through.
 *
 * Declared structurally rather than importing the class: this file is pure and
 * dependency-free so its rules can be unit-tested without a framework, and a
 * money field also has to survive read paths that hand back a plain object
 * rather than a live instance.
 */
interface BigNumberLike {
  /** Public getter. Its presence is what identifies an object as a BigNumber. */
  numeric?: unknown;
  /** Public getter, `{ value, precision }`. */
  raw?: unknown;
  valueOf?: () => unknown;
}

/** The `{ value, precision }` shape, whether raw or held by a BigNumber. */
function rawValueOf(raw: unknown): number | string | null | undefined {
  if (typeof raw !== "object" || raw === null || !("value" in raw)) {
    return undefined;
  }
  const inner = (raw as { value: unknown }).value;
  if (typeof inner === "number" || typeof inner === "string" || inner === null) {
    return inner;
  }
  return undefined;
}

/**
 * Unwrap the shapes a Medusa `BigNumberValue` can take before converting.
 *
 * Depending on the read path, a money field comes back as a number, a numeric
 * string, a raw `{ value: "133.44", precision: 20 }` object, or - and this is
 * what the query layer actually returns for `order.total` - a live `BigNumber`
 * INSTANCE. An instance carries no `value` key of its own: its own enumerable
 * keys are `numeric_`, `raw_` and `bignumber_`, and everything readable is on
 * the prototype. Reading `Number(instance)` would work by coercion, but
 * `Number([])` is 0 and `Number({})` is NaN, so coercing blindly would turn
 * junk into an amount; each shape is therefore recognised explicitly.
 *
 * The instance is read through `valueOf()`, which is the class's own public
 * coercion contract (`toJSON`, `[Symbol.toPrimitive]` and the `numeric` getter
 * all resolve to the same number, and `numeric` is what `valueOf` delegates
 * to). Its private `numeric_` / `raw_` fields are consulted only as a last
 * resort, for an instance that lost its prototype crossing a serialization
 * boundary - a trailing underscore is not a contract, and preferring it over
 * `valueOf()` would mean re-deriving the number the class already derives.
 *
 * A shape this cannot read returns null, NEVER 0. Zero is a legitimate amount,
 * so "I could not read this" has to stay distinguishable from "this is worth
 * nothing" all the way to the caller; every call site is expected to route the
 * null to a human rather than default it.
 */
export function bigNumberToMinorUnits(value?: unknown): number | null {
  if (
    value === null ||
    value === undefined ||
    typeof value === "number" ||
    typeof value === "string"
  ) {
    return toMinorUnits(value);
  }
  if (typeof value !== "object") {
    return null;
  }

  // A live BigNumber instance, read through its public accessors.
  const candidate = value as BigNumberLike;
  const raw = rawValueOf(candidate.raw);
  if (typeof candidate.numeric === "number" || raw !== undefined) {
    const numeric = candidate.valueOf?.();
    if (typeof numeric === "number" || typeof numeric === "string") {
      return toMinorUnits(numeric);
    }
    return toMinorUnits(raw ?? null);
  }

  // A bare `BigNumberRawValue`, e.g. the column as the DAL hands it over.
  const bare = rawValueOf(value);
  if (bare !== undefined) {
    return toMinorUnits(bare);
  }

  // Last resort: a BigNumber flattened into a plain object (a spread, a
  // structured clone, a workflow step result) keeps the private fields and
  // loses every accessor above. `raw_` first, because that is the full-precision
  // value the `numeric` getter itself prefers.
  const detached = value as { numeric_?: unknown; raw_?: unknown };
  const detachedRaw = rawValueOf(detached.raw_);
  if (detachedRaw !== undefined) {
    return toMinorUnits(detachedRaw);
  }
  if (typeof detached.numeric_ === "number") {
    return toMinorUnits(detached.numeric_);
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
