import { describe, expect, it } from "vitest";
import { isEuMember, isPoland, normalizeCountry } from "./eu";
import { isParsedVatId, parseEuVatId, vatIdMatchesCountry } from "./vat-id";

const parse = (raw: string) => parseEuVatId(raw);

describe("parseEuVatId", () => {
  it("splits a well-formed number into prefix and body", () => {
    const result = parse("DE123456789");
    expect(isParsedVatId(result) && result).toMatchObject({
      country: "DE",
      normalized: "DE123456789",
      number: "123456789",
      prefix: "DE",
    });
  });

  it("strips spaces, dots and dashes and uppercases", () => {
    for (const raw of ["de 123.456-789", "  DE123456789  ", "De-123 456 789"]) {
      const result = parse(raw);
      expect(isParsedVatId(result) && result.normalized).toBe("DE123456789");
    }
  });

  it("maps Greece's EL prefix onto the GR country code", () => {
    const result = parse("EL123456789");
    expect(isParsedVatId(result) && result.country).toBe("GR");
    // The prefix stays EL, because that is what belongs on the invoice.
    expect(isParsedVatId(result) && result.prefix).toBe("EL");
  });

  it("accepts each member state's documented format", () => {
    const samples = [
      "ATU12345678",
      "BE0123456789",
      "CY12345678L",
      "CZ12345678",
      "DK12345678",
      // Spanish NIF: 9 characters after the prefix, not 8.
      "ES A12345674",
      "FI12345678",
      "FR12123456789",
      "HR12345678901",
      "IE1234567FA",
      "IT12345678901",
      "LT123456789",
      "LU12345678",
      "LV12345678901",
      "MT12345678",
      "NL123456789B01",
      "PL5261040828",
      "SE123456789012",
      "SI12345678",
      "SK1234567890",
    ];
    for (const sample of samples) {
      expect(isParsedVatId(parse(sample)), `${sample} should parse`).toBe(true);
    }
  });

  it("rejects a bare number with no country prefix", () => {
    // A Polish NIP typed into a German order must not become a German VAT id.
    const result = parse("5261040828");
    expect(isParsedVatId(result)).toBe(false);
  });

  it("rejects a non-EU prefix by name", () => {
    const result = parse("GB123456789");
    expect(isParsedVatId(result)).toBe(false);
    expect(!isParsedVatId(result) && result.reason).toContain("GB");
  });

  it("rejects Northern Ireland's XI prefix, which covers goods only", () => {
    expect(isParsedVatId(parse("XI123456789"))).toBe(false);
  });

  it("rejects a number whose length is wrong for its country", () => {
    // DE is exactly 9 digits.
    expect(isParsedVatId(parse("DE12345678"))).toBe(false);
    expect(isParsedVatId(parse("DE1234567890"))).toBe(false);
  });

  it("rejects an empty or whitespace value", () => {
    expect(isParsedVatId(parse(""))).toBe(false);
    expect(isParsedVatId(parse("   "))).toBe(false);
  });

  it("never leaks the digits into a rejection reason", () => {
    const result = parse("DE99887766554433");
    expect(isParsedVatId(result)).toBe(false);
    expect(!isParsedVatId(result) && result.reason).not.toContain("998877");
  });

  it("reports the length so a typo can be told from a wrong country", () => {
    const result = parse("DE12345678");
    expect(!isParsedVatId(result) && result.reason).toContain("8 characters");
  });
});

describe("vatIdMatchesCountry", () => {
  it("matches a German id against a German address", () => {
    const parsed = parse("DE123456789");
    expect(isParsedVatId(parsed) && vatIdMatchesCountry(parsed, "DE")).toBe(true);
    expect(isParsedVatId(parsed) && vatIdMatchesCountry(parsed, "de")).toBe(true);
  });

  it("does not match a German id against a French address", () => {
    const parsed = parse("DE123456789");
    expect(isParsedVatId(parsed) && vatIdMatchesCountry(parsed, "FR")).toBe(false);
  });

  it("matches an EL-prefixed id against a GR address", () => {
    const parsed = parse("EL123456789");
    expect(isParsedVatId(parsed) && vatIdMatchesCountry(parsed, "GR")).toBe(true);
  });

  it("does not match a missing country", () => {
    const parsed = parse("DE123456789");
    expect(isParsedVatId(parsed) && vatIdMatchesCountry(parsed, null)).toBe(false);
  });
});

describe("EU membership", () => {
  it("counts the 27 member states", () => {
    for (const country of ["PL", "DE", "FR", "IE", "GR", "HR", "MT", "CY"]) {
      expect(isEuMember(country), country).toBe(true);
    }
  });

  it("excludes Great Britain", () => {
    expect(isEuMember("GB")).toBe(false);
  });

  it("excludes Northern Ireland, because this plugin invoices services", () => {
    expect(isEuMember("XI")).toBe(false);
  });

  it("excludes other third countries", () => {
    for (const country of ["US", "CH", "NO", "UA", "CA"]) {
      expect(isEuMember(country), country).toBe(false);
    }
  });

  it("identifies Poland regardless of case", () => {
    expect(isPoland("pl")).toBe(true);
    expect(isPoland("PL")).toBe(true);
    expect(isPoland("DE")).toBe(false);
    expect(isPoland(null)).toBe(false);
  });

  it("rejects anything that is not a two-letter code", () => {
    expect(normalizeCountry("Poland")).toBeNull();
    expect(normalizeCountry("P")).toBeNull();
    expect(normalizeCountry("")).toBeNull();
    expect(normalizeCountry(null)).toBeNull();
    expect(normalizeCountry(" pl ")).toBe("PL");
  });
});
