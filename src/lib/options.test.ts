import { describe, expect, it } from "vitest";
import {
  DEFAULT_CURRENCY,
  DEFAULT_TAX_SYMBOL,
  DEFAULT_TIMEOUT_MS,
  resolveInfaktOptions,
  toPublicInfaktOptions,
} from "./options";
import type { InfaktPluginOptions } from "./options";

const valid = (overrides: Partial<InfaktPluginOptions> = {}): Partial<InfaktPluginOptions> => ({
  apiKey: "test-key",
  startDate: "2026-07-01",
  ...overrides,
});

describe("resolveInfaktOptions: defaults", () => {
  it("applies every default", () => {
    const resolved = resolveInfaktOptions(valid());
    expect(resolved).toMatchObject({
      currency: DEFAULT_CURRENCY,
      emitIssuedEvent: true,
      environment: "production",
      ksefMode: "nip-only",
      ksefPossible: true,
      ksefRequireActive: true,
      startDate: "2026-07-01",
      taxSymbol: DEFAULT_TAX_SYMBOL,
      timeoutMs: DEFAULT_TIMEOUT_MS,
      triggerEvent: "payment.captured",
    });
    expect(resolved.nipExtractor).toBeTypeOf("function");
  });

  it("uppercases the currency and trims the api key", () => {
    const resolved = resolveInfaktOptions(valid({ apiKey: "  key  ", currency: "pln" }));
    expect(resolved.apiKey).toBe("key");
    expect(resolved.currency).toBe("PLN");
  });

  it("defaults ksef.requireActive off in sandbox and on in production", () => {
    expect(resolveInfaktOptions(valid({ environment: "sandbox" })).ksefRequireActive).toBe(false);
    expect(resolveInfaktOptions(valid({ environment: "production" })).ksefRequireActive).toBe(true);
  });

  it("reports that KSeF is impossible only for mode never with no predicate", () => {
    expect(resolveInfaktOptions(valid({ ksef: { mode: "never" } })).ksefPossible).toBe(false);
    expect(
      resolveInfaktOptions(valid({ ksef: { decide: () => true, mode: "never" } })).ksefPossible,
    ).toBe(true);
  });
});

describe("resolveInfaktOptions: startDate is the one option that does not throw", () => {
  it("resolves an absent or malformed value to null, disabling the pipeline", () => {
    // Failing to boot over a date is worse than booting with invoicing visibly off,
    // and the alternative default - invoice everything - would issue a real invoice
    // for every historical order on an existing store.
    for (const startDate of [undefined, "", "  ", "2026-7-1", "2026", "0", "tomorrow"]) {
      expect(resolveInfaktOptions(valid({ startDate })).startDate).toBeNull();
    }
  });

  it("rejects a well-shaped but impossible date", () => {
    // Date.parse("2026-02-30") succeeds by rolling over to March 2nd, which would make
    // a fat-fingered floor silently mean a different day than it reads as.
    expect(resolveInfaktOptions(valid({ startDate: "2026-02-30" })).startDate).toBeNull();
    expect(resolveInfaktOptions(valid({ startDate: "2026-13-01" })).startDate).toBeNull();
  });

  it("accepts a strict calendar date, trimmed", () => {
    expect(resolveInfaktOptions(valid({ startDate: "  2026-08-15  " })).startDate).toBe(
      "2026-08-15",
    );
    // A leap day in a leap year is a real date.
    expect(resolveInfaktOptions(valid({ startDate: "2028-02-29" })).startDate).toBe("2028-02-29");
  });
});

describe("resolveInfaktOptions: boot failures", () => {
  const expectError = (options: Partial<InfaktPluginOptions> | undefined, match: RegExp) => {
    expect(() => resolveInfaktOptions(options)).toThrow(match);
  };

  it("requires an options object at all", () => {
    expectError(undefined, /no plugin options were provided/u);
  });

  it("requires an api key", () => {
    for (const apiKey of [undefined, "", "   "]) {
      expectError(valid({ apiKey }), /`apiKey` is required/u);
    }
  });

  it("rejects an unknown environment", () => {
    expectError(valid({ environment: "staging" as never }), /must be "production" or "sandbox"/u);
  });

  it("rejects a currency that is not a 3-letter code", () => {
    for (const currency of ["PL", "POLAND", "P1N", ""]) {
      expectError(valid({ currency }), /must be a 3-letter ISO code/u);
    }
  });

  it("rejects a blank tax symbol", () => {
    expectError(valid({ taxSymbol: "  " }), /`taxSymbol` must not be blank/u);
  });

  it("rejects an unsupported trigger event", () => {
    expectError(
      valid({ triggerEvent: "order.updated" as never }),
      /`triggerEvent` must be one of/u,
    );
  });

  it("rejects an unknown ksef.mode", () => {
    expectError(valid({ ksef: { mode: "sometimes" as never } }), /`ksef.mode` must be one of/u);
  });

  it("rejects a non-function ksef.decide or nipExtractor", () => {
    expectError(valid({ ksef: { decide: "yes" as never } }), /`ksef.decide` must be a function/u);
    expectError(valid({ nipExtractor: "nip" as never }), /`nipExtractor` must be a function/u);
  });

  it("rejects a boolean-looking STRING for the boolean options", () => {
    // The mistake this catches: `requireActive: process.env.SOMETHING` yields "false",
    // which a truthiness test honours as TRUE. The operator would believe the startup
    // check was off while it was on, or the reverse. Both directions are bad, so this
    // fails rather than coercing.
    expectError(
      valid({ ksef: { requireActive: "false" as never } }),
      /`ksef.requireActive` must be a boolean/u,
    );
    expectError(
      valid({ emitIssuedEvent: "true" as never }),
      /`emitIssuedEvent` must be a boolean/u,
    );
  });

  it("rejects a non-positive or non-numeric timeout", () => {
    for (const timeoutMs of [0, -1, Number.NaN, "60000" as never]) {
      expectError(valid({ timeoutMs }), /`timeoutMs` must be a positive number/u);
    }
  });

  it("points at the README from every message", () => {
    try {
      resolveInfaktOptions({});
      expect.fail("should throw");
    } catch (error) {
      expect((error as Error).message).toContain("medusa-infakt#options");
    }
  });
});

describe("toPublicInfaktOptions", () => {
  it("never carries the api key, the extractor or the predicate", () => {
    const publicOptions = toPublicInfaktOptions(
      resolveInfaktOptions(valid({ ksef: { decide: () => true } })),
    );
    expect(publicOptions).not.toHaveProperty("apiKey");
    expect(publicOptions).not.toHaveProperty("nipExtractor");
    expect(publicOptions).not.toHaveProperty("ksefDecide");
    expect(JSON.stringify(publicOptions)).not.toContain("test-key");
  });

  it("reports a custom predicate as a boolean flag", () => {
    expect(toPublicInfaktOptions(resolveInfaktOptions(valid())).ksefCustomPredicate).toBe(false);
    expect(
      toPublicInfaktOptions(resolveInfaktOptions(valid({ ksef: { decide: () => true } })))
        .ksefCustomPredicate,
    ).toBe(true);
  });

  it("reports disabled exactly when startDate is null", () => {
    expect(toPublicInfaktOptions(resolveInfaktOptions(valid())).disabled).toBe(false);
    expect(toPublicInfaktOptions(resolveInfaktOptions(valid({ startDate: "nope" }))).disabled).toBe(
      true,
    );
  });
});
