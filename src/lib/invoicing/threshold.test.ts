import { describe, expect, it } from "vitest";
import type { EuB2cSale } from "./threshold";
import {
  alertMessage,
  breachReason,
  DEFAULT_EUR_THRESHOLD_MINOR,
  evaluateThreshold,
  relevantYears,
} from "./threshold";

/**
 * The threshold is the part of this change with the sharpest edge: below it the
 * Polish rate is correct, above it the identical rate is wrong, and the flip
 * happens on the transaction that crosses the line rather than at a period
 * boundary. These tests are written around that edge.
 */

const sale = (overrides: Partial<EuB2cSale> = {}): EuB2cSale => ({
  baseMinor: 100_000,
  currency: "EUR",
  date: "2026-08-27",
  ...overrides,
});

describe("evaluateThreshold", () => {
  it("reports plenty of room when the books are empty", () => {
    const result = evaluateThreshold({ pending: sale({ baseMinor: 10_000 }), prior: [] });
    expect(result).toMatchObject({ alert: false, state: "below" });
  });

  it("counts the pending sale itself, because the crossing transaction is caught", () => {
    // 9 900 EUR already, plus a 200 EUR sale, is over 10 000.
    const result = evaluateThreshold({
      pending: sale({ baseMinor: 20_000 }),
      prior: [sale({ baseMinor: 990_000, date: "2026-03-01" })],
    });
    expect(result.state).toBe("breached");
  });

  it("does not breach one minor unit below the limit", () => {
    const result = evaluateThreshold({
      pending: sale({ baseMinor: 1 }),
      prior: [sale({ baseMinor: DEFAULT_EUR_THRESHOLD_MINOR - 2, date: "2026-03-01" })],
    });
    expect(result.state).toBe("below");
  });

  it("breaches exactly at the limit", () => {
    const result = evaluateThreshold({
      pending: sale({ baseMinor: 1 }),
      prior: [sale({ baseMinor: DEFAULT_EUR_THRESHOLD_MINOR - 1, date: "2026-03-01" })],
    });
    expect(result.state).toBe("breached");
  });

  it("alerts before it blocks, so there is time to register", () => {
    const result = evaluateThreshold({
      pending: sale({ baseMinor: 10_000 }),
      prior: [sale({ baseMinor: 800_000, date: "2026-03-01" })],
    });
    expect(result).toMatchObject({ alert: true, state: "below" });
  });

  it("honours a custom alert ratio", () => {
    const input = {
      pending: sale({ baseMinor: 10_000 }),
      prior: [sale({ baseMinor: 500_000, date: "2026-03-01" })],
    };
    expect(evaluateThreshold({ ...input, alertRatio: 0.9 })).toMatchObject({ alert: false });
    expect(evaluateThreshold({ ...input, alertRatio: 0.5 })).toMatchObject({ alert: true });
  });

  it("counts the previous calendar year as well as the current one", () => {
    const result = evaluateThreshold({
      pending: sale({ baseMinor: 20_000, date: "2026-01-05" }),
      prior: [sale({ baseMinor: 990_000, date: "2025-11-01" })],
    });
    expect(result.state).toBe("breached");
  });

  it("drops a year once it is no longer current or previous", () => {
    const result = evaluateThreshold({
      pending: sale({ baseMinor: 20_000, date: "2027-01-05" }),
      prior: [sale({ baseMinor: 990_000, date: "2025-11-01" })],
    });
    expect(result.state).toBe("below");
  });

  it("combines currencies as fractions of their own limits", () => {
    // 6 000 EUR (60%) + 21 000 PLN (50%) = 110% of the combined allowance.
    const result = evaluateThreshold({
      pending: sale({ baseMinor: 2_100_000, currency: "PLN" }),
      prior: [sale({ baseMinor: 600_000, currency: "EUR", date: "2026-03-01" })],
    });
    expect(result.state).toBe("breached");
  });

  it("parks rather than silently skipping a currency with no configured limit", () => {
    const result = evaluateThreshold({ pending: sale({ currency: "USD" }), prior: [] });
    expect(result.state).toBe("unknown");
    expect(result.state === "unknown" && result.reason).toContain("USD");
  });

  it("accepts lowercase currency codes on either side", () => {
    const result = evaluateThreshold({
      pending: sale({ baseMinor: 20_000, currency: "eur" }),
      prior: [sale({ baseMinor: 990_000, currency: "eur", date: "2026-03-01" })],
    });
    expect(result.state).toBe("breached");
  });

  it("ignores negative amounts rather than letting them buy back headroom", () => {
    const result = evaluateThreshold({
      pending: sale({ baseMinor: 20_000 }),
      prior: [
        sale({ baseMinor: 990_000, date: "2026-03-01" }),
        sale({ baseMinor: -500_000, date: "2026-04-01" }),
      ],
    });
    expect(result.state).toBe("breached");
  });

  it("reports the ratio so the figure can be shown, not just trusted", () => {
    const result = evaluateThreshold({
      pending: sale({ baseMinor: 250_000 }),
      prior: [sale({ baseMinor: 250_000, date: "2026-03-01" })],
    });
    expect(result.state === "below" && Math.round(result.usedRatio * 100)).toBe(50);
  });
});

describe("relevantYears", () => {
  it("returns the previous and current calendar year", () => {
    expect(relevantYears("2026-08-27")).toEqual([2025, 2026]);
    expect(relevantYears("2027-01-01")).toEqual([2026, 2027]);
  });
});

describe("the operator-facing wording", () => {
  it("explains why 23% stops being correct once the line is crossed", () => {
    const reason = breachReason(1.02);
    expect(reason).toContain("102%");
    expect(reason).toContain("not registered for OSS");
    expect(reason).toContain("no correct invoice");
  });

  it("tells the owner what to do, not just that a number moved", () => {
    const message = alertMessage(0.85);
    expect(message).toContain("85%");
    expect(message).toContain("VIU-R");
    expect(message).toContain("parked");
  });
});
