import { describe, expect, it } from "vitest";
import { bigNumberToMinorUnits, isCalendarDate, toMinorUnits, warsawDate } from "./money";

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
