import { describe, expect, it } from "vitest";
import type { RegimeInput, VatRegime } from "./regime";
import { decideVatRegime, EXPORT_SERVICES_NOTE, REVERSE_CHARGE_NOTE } from "./regime";

/**
 * The decision tree is the legally consequential part of this plugin, so these
 * tests are written as assertions about the law rather than about the code: each
 * one names the outcome a tax inspector would expect, not the branch taken.
 */

const DE_VAT = "DE123456789";

const input = (overrides: Partial<RegimeInput> = {}): RegimeInput => ({
  billingCountry: "PL",
  domesticTaxSymbol: "23",
  ossEnabled: true,
  ossRateFor: () => "19",
  ossRegistered: true,
  supply: "service",
  threshold: { alert: false, state: "below", usedRatio: 0 },
  ...overrides,
});

const decide = (overrides: Partial<RegimeInput> = {}): VatRegime =>
  decideVatRegime(input(overrides));

describe("domestic", () => {
  it("charges the configured Polish rate", () => {
    expect(decide()).toEqual({ kind: "domestic", taxSymbol: "23" });
  });

  it("stays domestic for goods, because a Polish sale is 23% either way", () => {
    expect(decide({ supply: "goods" })).toEqual({ kind: "domestic", taxSymbol: "23" });
  });

  it("stays domestic for an unclassified product, so an untagged catalogue keeps working", () => {
    expect(decide({ supply: "unknown" })).toEqual({ kind: "domestic", taxSymbol: "23" });
  });

  it("is not affected by a tax id, a VIES result or the OSS switch", () => {
    expect(
      decide({ ossEnabled: false, taxId: "5261040828", vies: { status: "invalid" } }),
    ).toEqual({ kind: "domestic", taxSymbol: "23" });
  });

  it("recognises a lowercase country code", () => {
    expect(decide({ billingCountry: "pl" })).toEqual({ kind: "domestic", taxSymbol: "23" });
  });
});

describe("EU business - reverse charge", () => {
  it("zero-rates a VIES-confirmed VAT id and marks it for the VAT-UE summary", () => {
    const result = decide({
      billingCountry: "DE",
      taxId: DE_VAT,
      vies: { status: "valid" },
    });
    expect(result).toEqual({
      country: "DE",
      kind: "reverse_charge",
      note: REVERSE_CHARGE_NOTE,
      taxSymbol: "np",
      vatId: DE_VAT,
      vatUeReportable: true,
    });
  });

  it("uses np, never the 0% rate - they are different things", () => {
    const result = decide({ billingCountry: "DE", taxId: DE_VAT, vies: { status: "valid" } });
    expect(result.kind === "reverse_charge" && result.taxSymbol).toBe("np");
    expect(JSON.stringify(result)).not.toContain('"0"');
  });

  it("carries an annotation naming both the Polish and the EU basis", () => {
    expect(REVERSE_CHARGE_NOTE).toContain("Reverse charge");
    expect(REVERSE_CHARGE_NOTE).toContain("art. 28b");
    expect(REVERSE_CHARGE_NOTE).toContain("196");
  });

  it("normalizes a spaced, lowercase VAT id onto the invoice", () => {
    const result = decide({
      billingCountry: "DE",
      taxId: " de 123 456 789 ",
      vies: { status: "valid" },
    });
    expect(result.kind === "reverse_charge" && result.vatId).toBe(DE_VAT);
  });

  it("accepts Greece's EL prefix against a GR billing country", () => {
    const result = decide({
      billingCountry: "GR",
      ossRateFor: () => "24",
      taxId: "EL123456789",
      vies: { status: "valid" },
    });
    expect(result.kind).toBe("reverse_charge");
  });
});

describe("EU business - when the evidence is not there", () => {
  it("treats a VIES-rejected number as a consumer, charging destination VAT once registered", () => {
    expect(
      decide({ billingCountry: "DE", taxId: DE_VAT, vies: { status: "invalid" } }),
    ).toEqual({ country: "DE", kind: "oss", rate: "19" });
  });

  it("parks by default when VIES could not be reached", () => {
    const result = decide({
      billingCountry: "DE",
      taxId: DE_VAT,
      vies: { status: "unavailable" },
    });
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" && result.reason).toContain("VIES");
  });

  it("parks when no VIES result was ever recorded", () => {
    expect(decide({ billingCountry: "DE", taxId: DE_VAT }).kind).toBe("blocked");
  });

  it("falls back to destination VAT instead of parking when configured to", () => {
    expect(
      decide({
        billingCountry: "DE",
        taxId: DE_VAT,
        vies: { status: "unavailable" },
        viesFallback: "consumer",
      }),
    ).toEqual({ country: "DE", kind: "oss", rate: "19" });
  });

  it("never zero-rates on an unconfirmed number, whichever fallback is set", () => {
    for (const viesFallback of ["review", "consumer"] as const) {
      const result = decide({
        billingCountry: "DE",
        taxId: DE_VAT,
        vies: { status: "unavailable" },
        viesFallback,
      });
      expect(result.kind).not.toBe("reverse_charge");
    }
  });

  it("parks a malformed VAT id rather than silently demoting the buyer to a consumer", () => {
    const result = decide({ billingCountry: "DE", taxId: "DE12", vies: { status: "valid" } });
    expect(result.kind).toBe("blocked");
  });

  it("parks when the VAT id's country disagrees with the billing country", () => {
    const result = decide({
      billingCountry: "FR",
      taxId: DE_VAT,
      vies: { status: "valid" },
    });
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" && result.reason).toContain("ambiguous");
  });

  it("never puts the tax id digits into a rejection reason", () => {
    const result = decide({ billingCountry: "DE", taxId: "DE12", vies: { status: "valid" } });
    expect(result.kind === "blocked" && result.reason).not.toContain("12");
  });
});

describe("EU consumer - OSS, once registered", () => {
  it("charges the destination country's rate, not zero", () => {
    expect(decide({ billingCountry: "DE" })).toEqual({
      country: "DE",
      kind: "oss",
      rate: "19",
    });
  });

  it("uses each country's own rate", () => {
    expect(decide({ billingCountry: "HU", ossRateFor: () => "27" })).toEqual({
      country: "HU",
      kind: "oss",
      rate: "27",
    });
  });

  it("blocks rather than guessing when OSS is not enabled", () => {
    const result = decide({ billingCountry: "DE", ossEnabled: false });
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" && result.reason).toContain("OSS");
  });

  it("blocks when no rate is known for the destination", () => {
    const result = decide({ billingCountry: "DE", ossRateFor: () => null });
    expect(result.kind).toBe("blocked");
  });

  it("does not treat 'not Poland' as 'no VAT' - the classic mistake", () => {
    const result = decide({ billingCountry: "DE" });
    expect(result.kind).not.toBe("reverse_charge");
    expect(result.kind).not.toBe("export_services");
  });
});

describe("outside the EU", () => {
  it("treats a business buyer as an export of services, not a reverse charge", () => {
    const result = decide({ billingCountry: "US", taxId: "12-3456789" });
    expect(result).toEqual({
      country: "US",
      kind: "export_services",
      note: EXPORT_SERVICES_NOTE,
      taxSymbol: "np",
      vatUeReportable: false,
    });
  });

  it("keeps an export of services OUT of the VAT-UE summary", () => {
    const result = decide({ billingCountry: "US", taxId: "12-3456789" });
    expect(result.kind === "export_services" && result.vatUeReportable).toBe(false);
  });

  it("gives an export a different annotation from a reverse charge, despite the same rate", () => {
    expect(EXPORT_SERVICES_NOTE).not.toBe(REVERSE_CHARGE_NOTE);
    expect(EXPORT_SERVICES_NOTE).not.toContain("Reverse charge");
  });

  it("treats Great Britain as a third country, not as an EU member", () => {
    const result = decide({ billingCountry: "GB", taxId: "GB123456789" });
    expect(result.kind).toBe("export_services");
    expect(result.kind === "export_services" && result.vatUeReportable).toBe(false);
  });

  it("blocks a non-EU consumer rather than inventing a treatment", () => {
    const result = decide({ billingCountry: "GB" });
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" && result.reason).toContain("GB");
  });

  it("mentions the possible local registration when blocking a non-EU consumer", () => {
    const result = decide({ billingCountry: "GB" });
    expect(result.kind === "blocked" && result.reason).toContain("registration");
  });

  it("treats Northern Ireland's XI prefix as outside the EU, because we sell services", () => {
    const result = decide({ billingCountry: "XI", taxId: "XI123456789" });
    expect(result.kind).toBe("export_services");
  });
});

describe("what the tree refuses to answer", () => {
  it("blocks when the billing country is missing", () => {
    expect(decideVatRegime(input({ billingCountry: null })).kind).toBe("blocked");
  });

  it("blocks when the billing country is not a country code", () => {
    expect(decideVatRegime(input({ billingCountry: "Germany" })).kind).toBe("blocked");
  });

  it("blocks cross-border goods, which have a different regime entirely", () => {
    const result = decide({ billingCountry: "DE", supply: "goods" });
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" && result.reason).toContain("goods");
  });

  it("blocks a cross-border order whose products carry no classification", () => {
    const result = decide({
      billingCountry: "DE",
      supply: "unknown",
      supplyReason: 'not classified for VAT: Widget - set metadata.tax_supply to "service"',
    });
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" && result.reason).toContain("Widget");
  });

  it("blocks a cross-border order that mixes services and goods", () => {
    const result = decide({ billingCountry: "DE", supply: "mixed" });
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" && result.reason).toContain("mixes");
  });
});

describe("EU consumer - not registered for OSS", () => {
  const unregistered = (overrides: Partial<RegimeInput> = {}) =>
    decide({ billingCountry: "DE", ossRegistered: false, ...overrides });

  it("charges the Polish rate while below the threshold", () => {
    // This is the live path today. It is correct BECAUSE of the threshold, which
    // is why it has its own regime rather than being folded into `domestic`.
    expect(unregistered()).toEqual({
      alert: false,
      country: "DE",
      kind: "eu_b2c_domestic_rate",
      taxSymbol: "23",
      usedRatio: 0,
    });
  });

  it("does not use np - the place of supply is still Poland", () => {
    const result = unregistered();
    expect(result.kind === "eu_b2c_domestic_rate" && result.taxSymbol).toBe("23");
  });

  it("does not issue an OSS invoice even when the code path is enabled", () => {
    expect(unregistered({ ossEnabled: true }).kind).toBe("eu_b2c_domestic_rate");
  });

  it("carries the alert flag up once the running total is high enough", () => {
    const result = unregistered({
      threshold: { alert: true, state: "below", usedRatio: 0.85 },
    });
    expect(result).toMatchObject({ alert: true, kind: "eu_b2c_domestic_rate", usedRatio: 0.85 });
  });

  it("blocks once the threshold is crossed - the same 23% is now wrong", () => {
    const result = unregistered({ threshold: { state: "breached", usedRatio: 1.05 } });
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" && result.reason).toContain("not registered for OSS");
  });

  it("never falls back to the domestic rate after a breach", () => {
    const result = unregistered({ threshold: { state: "breached", usedRatio: 1.05 } });
    expect(result.kind).not.toBe("eu_b2c_domestic_rate");
    expect(result.kind).not.toBe("oss");
  });

  it("blocks when the threshold could not be evaluated at all", () => {
    expect(unregistered({ threshold: undefined }).kind).toBe("blocked");
  });

  it("blocks, naming the currency, when a currency has no configured limit", () => {
    const result = unregistered({
      threshold: { reason: "no intra-EU B2C threshold is configured for USD", state: "unknown" },
    });
    expect(result.kind).toBe("blocked");
    expect(result.kind === "blocked" && result.reason).toContain("USD");
  });

  it("still reverse-charges a confirmed business - the threshold is B2C only", () => {
    const result = unregistered({
      taxId: DE_VAT,
      threshold: { state: "breached", usedRatio: 2 },
      vies: { status: "valid" },
    });
    expect(result.kind).toBe("reverse_charge");
  });

  it("leaves the domestic path untouched whatever the counter says", () => {
    expect(
      decide({ billingCountry: "PL", ossRegistered: false, threshold: { state: "breached", usedRatio: 9 } }),
    ).toEqual({ kind: "domestic", taxSymbol: "23" });
  });
});

describe("non-EU business, as the accountant actually invoiced one", () => {
  it("accepts a company name with no tax id at all", () => {
    // Mirrors invoice 2/05/2026 on the live account: a US LLC, company name
    // present, client_tax_code empty, treated as a business supply with np.
    const result = decide({ billingCountry: "US", companyName: "36NORTH LLC", taxId: null });
    expect(result.kind).toBe("export_services");
  });

  it("still blocks a genuine non-EU consumer with neither signal", () => {
    expect(decide({ billingCountry: "US", companyName: null, taxId: null }).kind).toBe("blocked");
  });
});
