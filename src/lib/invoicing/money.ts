/**
 * Money and calendar helpers shared by the builder, the paid gate and the
 * matching engine. Pure and dependency-free, so every rule here is unit-tested
 * without a database or an HTTP mock.
 *
 * The BigNumber-unwrapping half of `bigNumberToMinorUnits` (recognising a
 * Medusa `BigNumber` instance, a bare `{ value, precision }` shape, or a
 * detached instance that lost its prototype) lives in `./big-number`, shared
 * byte-for-byte with medusa-allegro and medusa-marken - see that file's
 * header for the vendoring contract. This module keeps what is genuinely
 * infakt-specific: minor-unit conversion, the "does this even look like a
 * BigNumber" gate (a `Date`'s `valueOf()` also happens to return a number,
 * and is not an amount), and the calendar helpers.
 */
import { type BigNumberInput, bigNumberCandidates } from "./big-number";

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
 * The public surface this module reads a Medusa `BigNumber` through, used
 * only to decide whether an object is worth reading at all - see
 * `looksLikeBigNumber` below. The actual candidate extraction (public
 * accessors, bare raw shape, detached private fields, string coercion) is
 * shared with medusa-allegro and medusa-marken - see `./big-number`.
 */
interface BigNumberLike {
  /** Public getter. Its presence is one of the signals that identify an object as a BigNumber. */
  numeric?: unknown;
  /** Public getter, `{ value, precision }`. */
  raw?: unknown;
  /** The raw shape passed directly, which is how a serialized big number arrives. */
  value?: unknown;
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
 * Does this object identify itself as a BigNumber - live, bare, or a
 * detached instance that lost its prototype - before its `valueOf()` /
 * `toString()` coercion is trusted for anything?
 *
 * This is the one thing the shared `bigNumberCandidates` deliberately leaves
 * to the caller (see that file's header): it is what stops a `Date`, whose
 * `valueOf()` also happens to return a number, from being read as an amount.
 * `Number([])` is 0 and `Number({})` is NaN, so coercing blindly would turn
 * junk into an amount - each shape is instead recognised explicitly first.
 *
 * medusa-allegro and medusa-marken do not apply this gate: they lean on
 * their own numeric parsers to reject the resulting garbage instead. This
 * module's `toMinorUnits` is permissive (`Number.parseFloat`, no strict
 * format validation), so it needs the gate to do that rejection up front.
 */
function looksLikeBigNumber(value: BigNumberLike & { raw_?: unknown; numeric_?: unknown }): boolean {
  return (
    typeof value.numeric === "number" ||
    rawValueOf(value.raw) !== undefined ||
    value.value !== undefined ||
    rawValueOf(value.raw_) !== undefined ||
    typeof value.numeric_ === "number"
  );
}

/**
 * Unwrap the shapes a Medusa `BigNumberValue` can take before converting.
 *
 * Depending on the read path, a money field comes back as a number, a numeric
 * string, a raw `{ value: "133.44", precision: 20 }` object, or - and this is
 * what the query layer actually returns for `order.total` - a live `BigNumber`
 * INSTANCE. An instance carries no `value` key of its own: its own enumerable
 * keys are `numeric_`, `raw_` and `bignumber_`, and everything readable is on
 * the prototype.
 *
 * `looksLikeBigNumber` gates entry; `bigNumberCandidates` (shared) then reads
 * the object in its order of authority - `raw.value` before the derived
 * `numeric`, public accessors before the private `raw_`/`numeric_` fallback -
 * and the first candidate `toMinorUnits` can actually parse wins.
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
  if (!looksLikeBigNumber(value as BigNumberLike & { raw_?: unknown; numeric_?: unknown })) {
    return null;
  }

  for (const candidate of bigNumberCandidates(value as BigNumberInput)) {
    const minor = toMinorUnits(candidate);
    if (minor !== null) {
      return minor;
    }
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

/**
 * Read a quantity the same way `bigNumberToMinorUnits` reads an amount, but
 * as a bare count: no minor-unit scaling, no rounding. `order_item.quantity`
 * comes back from `query.graph` as a BigNumber instance exactly like the
 * money columns do, and the invoice builder's `Number.isInteger(quantity)`
 * check rejected the instance outright - which parked today's first live
 * invoice in needs_review with "invalid price or quantity" while the value
 * inside was a perfectly good 1.
 */
export function bigNumberToQuantity(value?: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  // Reuse the money unwrap, then undo its one deliberate transformation.
  const minor = bigNumberToMinorUnits(value);
  return minor === null ? null : minor / 100;
}
