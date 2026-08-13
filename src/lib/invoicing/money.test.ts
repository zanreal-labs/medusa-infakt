import { BigNumber } from "@medusajs/framework/utils";
import { describe, expect, it } from "vitest";
import { bigNumberToMinorUnits, isCalendarDate, toMinorUnits, warsawDate } from "./money";

/**
 * `BigNumber` is imported from the installed Medusa package on purpose, and is
 * never hand-modelled as a literal here.
 *
 * A hand-written `{ value: "133.44" }` was exactly how this function's object
 * case was tested before, and it passed while production returned 0 for every
 * order: what the query layer actually hands back for `order.total` is a
 * `BigNumber` INSTANCE, which carries no `value` key of its own. A fixture that
 * models the shape rather than constructing it can only ever prove that the
 * code agrees with the fixture. The assertions below therefore start by pinning
 * what the real class looks like, so this file fails if Medusa changes it.
 */

describe("toMinorUnits", () => {
  it("converts floats and numeric strings without drift", () => {
    expect(toMinorUnits(123.45)).toBe(12_345);
    expect(toMinorUnits("123.45")).toBe(12_345);
    expect(toMinorUnits(0.1 + 0.2)).toBe(30);
    expect(toMinorUnits(0)).toBe(0);
  });

  it("rejects what is not a number", () => {
    expect(toMinorUnits(null)).toBeNull();
    expect(toMinorUnits()).toBeNull();
    expect(toMinorUnits("not a number")).toBeNull();
    expect(toMinorUnits(Number.NaN)).toBeNull();
    expect(toMinorUnits(Number.POSITIVE_INFINITY)).toBeNull();
  });

  it("rounds a genuine half up", () => {
    // 0.125 and 0.375 are exactly representable, so *100 really is 12.5 and 37.5.
    expect(toMinorUnits(0.125)).toBe(13);
    expect(toMinorUnits(0.375)).toBe(38);
  });

  it("rounds down where the float is not really a half (documented, not desired)", () => {
    // 1.005 * 100 is 100.49999999999999 in IEEE 754, so this lands on 100, and
    // 1.015 * 100 is 101.49999999999999. That is inherent to holding decimal money
    // in a float, and is exactly why the builder verifies its line sum against the
    // order total rather than trusting its own arithmetic: whatever this returns,
    // a mismatch is caught before an invoice is issued.
    expect(toMinorUnits(1.005)).toBe(100);
    expect(toMinorUnits(1.015)).toBe(101);
  });
});

describe("bigNumberToMinorUnits", () => {
  it("is handed a BigNumber whose own keys do NOT include `value`", () => {
    // The premise of the bug, asserted rather than assumed. If this ever fails,
    // the instance case below is testing something Medusa no longer returns.
    const total = new BigNumber("149.00");
    expect(Object.keys(total)).toEqual(["numeric_", "raw_", "bignumber_"]);
    expect("value" in total).toBe(false);
    expect(typeof total.valueOf()).toBe("number");
  });

  it("reads a real Medusa BigNumber instance", () => {
    expect(bigNumberToMinorUnits(new BigNumber("133.44"))).toBe(13_344);
    expect(bigNumberToMinorUnits(new BigNumber(149))).toBe(14_900);
    expect(bigNumberToMinorUnits(new BigNumber({ precision: 20, value: "131.00" }))).toBe(13_100);
  });

  it("reads a zero and a negative BigNumber as amounts, not as failures", () => {
    expect(bigNumberToMinorUnits(new BigNumber(0))).toBe(0);
    expect(bigNumberToMinorUnits(new BigNumber("-12.50"))).toBe(-1250);
  });

  it("reads a BigNumber that lost its prototype crossing a serialization boundary", () => {
    // A spread, a structured clone or a workflow step result keeps the private
    // fields and loses every accessor. Still an amount, still readable.
    expect(bigNumberToMinorUnits({ ...new BigNumber("133.44") })).toBe(13_344);
    expect(bigNumberToMinorUnits(structuredClone({ ...new BigNumber("149.00") }))).toBe(14_900);
  });

  it("unwraps the raw { value } object form", () => {
    expect(bigNumberToMinorUnits({ precision: 20, value: "133.44" })).toBe(13_344);
    expect(bigNumberToMinorUnits({ value: 133.44 })).toBe(13_344);
  });

  it("passes plain numbers and numeric strings straight through", () => {
    expect(bigNumberToMinorUnits(133.44)).toBe(13_344);
    expect(bigNumberToMinorUnits("133.44")).toBe(13_344);
  });

  it("returns null for shapes it cannot read", () => {
    expect(bigNumberToMinorUnits()).toBeNull();
    expect(bigNumberToMinorUnits(null)).toBeNull();
    expect(bigNumberToMinorUnits({})).toBeNull();
    expect(bigNumberToMinorUnits([])).toBeNull();
    expect(bigNumberToMinorUnits({ value: "abc" })).toBeNull();
    expect(bigNumberToMinorUnits(true)).toBeNull();
    // An object whose `valueOf()` happens to yield a number is not an amount.
    // Only something that identifies itself as a BigNumber is read that way.
    expect(bigNumberToMinorUnits(new Date("2026-08-10T11:05:00Z"))).toBeNull();
  });
});

describe("warsawDate", () => {
  it("renders the Polish calendar date of a UTC timestamp", () => {
    // 21:30 UTC on the 14th is 23:30 in Warsaw (CEST) - still the 14th.
    expect(warsawDate("2026-07-14T21:30:00Z")).toBe("2026-07-14");
    // 23:30 UTC is 01:30 the next day in Warsaw.
    expect(warsawDate("2026-07-14T23:30:00Z")).toBe("2026-07-15");
  });

  it("handles winter time, where the offset is +1 rather than +2", () => {
    expect(warsawDate("2026-01-14T23:30:00Z")).toBe("2026-01-15");
    expect(warsawDate("2026-01-14T22:30:00Z")).toBe("2026-01-14");
  });

  it("accepts a Date as well as a string", () => {
    expect(warsawDate(new Date("2026-07-14T21:30:00Z"))).toBe("2026-07-14");
  });

  it("falls back to today for a missing or unparseable input", () => {
    const today = warsawDate();
    expect(today).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    expect(warsawDate(null)).toBe(today);
    expect(warsawDate("not a date")).toBe(today);
  });
});

describe("isCalendarDate", () => {
  it("accepts a strict YYYY-MM-DD", () => {
    expect(isCalendarDate("2026-07-15")).toBe(true);
  });

  it("rejects everything Date.parse would leniently accept", () => {
    for (const value of [
      "0",
      "2020",
      "2026-7-15",
      "15/07/2026",
      "2026-07-15T00:00:00Z",
      "July 15 2026",
      "",
      "  2026-07-15  ",
      null,
      undefined,
      20_260_715,
    ]) {
      expect(isCalendarDate(value)).toBe(false);
    }
  });

  it("rejects a well-shaped but impossible date", () => {
    expect(isCalendarDate("2026-13-01")).toBe(false);
    expect(isCalendarDate("2026-02-30")).toBe(false);
  });
});
