import { describe, expect, it } from "vitest";
import { defaultNipExtractor, hasValidNipChecksum, nipFromCompanyField, normalizeNip } from "./nip";

/** A real, checksum-valid NIP (the Ministry of Finance's own published example). */
const VALID_NIP = "5261040828";

describe("normalizeNip", () => {
  it("strips the PL prefix and separators", () => {
    expect(normalizeNip("PL 526-104-08-28")).toBe(VALID_NIP);
    expect(normalizeNip("pl5261040828")).toBe(VALID_NIP);
    expect(normalizeNip("526 104 08 28")).toBe(VALID_NIP);
    expect(normalizeNip(VALID_NIP)).toBe(VALID_NIP);
  });

  it("rejects anything that is not exactly ten digits", () => {
    expect(normalizeNip("12345")).toBeNull();
    expect(normalizeNip("PL")).toBeNull();
    expect(normalizeNip("")).toBeNull();
    expect(normalizeNip("52610408281")).toBeNull();
    expect(normalizeNip("DE811907980")).toBeNull();
  });

  it("does not validate the checksum - inFakt and KSeF are the authority", () => {
    // Ten digits, deliberately wrong checksum: still normalized.
    expect(normalizeNip("5261040829")).toBe("5261040829");
  });
});

describe("hasValidNipChecksum", () => {
  it("accepts a valid NIP", () => {
    expect(hasValidNipChecksum(VALID_NIP)).toBe(true);
  });

  it("rejects a wrong check digit", () => {
    expect(hasValidNipChecksum("5261040829")).toBe(false);
  });

  it("rejects anything that is not ten bare digits", () => {
    expect(hasValidNipChecksum("526-104-08-28")).toBe(false);
    expect(hasValidNipChecksum("123")).toBe(false);
    expect(hasValidNipChecksum("")).toBe(false);
  });

  it("rejects a number whose weighted sum lands on remainder 10", () => {
    // 1111111111: weighted sum 45, 45 % 11 = 1 - a valid-looking pattern that
    // still has to agree with the tenth digit.
    expect(hasValidNipChecksum("1111111111")).toBe(true);
    expect(hasValidNipChecksum("1111111112")).toBe(false);
  });
});

describe("nipFromCompanyField", () => {
  it("extracts a NIP typed into the company name", () => {
    expect(nipFromCompanyField(`ACME Sp. z o.o. NIP ${VALID_NIP}`)).toBe(VALID_NIP);
    expect(nipFromCompanyField("ACME Sp. z o.o., NIP: 526-104-08-28")).toBe(VALID_NIP);
    expect(nipFromCompanyField("ACME 526 104 08 28")).toBe(VALID_NIP);
  });

  it("returns null for a company name with no digits", () => {
    expect(nipFromCompanyField("ACME Sp. z o.o.")).toBeNull();
    expect(nipFromCompanyField("")).toBeNull();
    expect(nipFromCompanyField(null)).toBeNull();
    expect(nipFromCompanyField()).toBeNull();
  });

  it("refuses a ten-digit run that fails the NIP checksum", () => {
    // A phone number is the realistic case, and reading it as a tax id would
    // silently turn a consumer invoice into a B2B one filed to KSeF.
    expect(nipFromCompanyField("ACME tel 501234567")).toBeNull();
    expect(nipFromCompanyField("ACME 1234567890")).toBeNull();
  });

  it("refuses an ambiguous field with two different candidates", () => {
    expect(nipFromCompanyField(`ACME NIP ${VALID_NIP} REGON 1111111111`)).toBeNull();
  });

  it("tolerates the same NIP repeated", () => {
    expect(nipFromCompanyField(`ACME ${VALID_NIP} / ${VALID_NIP}`)).toBe(VALID_NIP);
  });

  it("does not read a ten-digit run out of a longer number", () => {
    expect(nipFromCompanyField("ACME 52610408281234")).toBeNull();
  });
});

describe("defaultNipExtractor", () => {
  it("prefers order.metadata.nip", () => {
    expect(
      defaultNipExtractor({
        billing_address: { company: `ACME ${VALID_NIP}`, metadata: { nip: "1111111111" } },
        metadata: { nip: VALID_NIP },
      }),
    ).toBe(VALID_NIP);
  });

  it("falls back to the billing address metadata", () => {
    expect(
      defaultNipExtractor({
        billing_address: { company: "ACME", metadata: { nip: VALID_NIP } },
        metadata: {},
      }),
    ).toBe(VALID_NIP);
  });

  it("falls back to a NIP parsed out of the company field", () => {
    expect(defaultNipExtractor({ billing_address: { company: `ACME NIP ${VALID_NIP}` } })).toBe(
      VALID_NIP,
    );
  });

  it("accepts the common alternative metadata keys", () => {
    for (const key of ["nip", "tax_id", "taxId", "vat_id", "vatId"]) {
      expect(defaultNipExtractor({ metadata: { [key]: VALID_NIP } })).toBe(VALID_NIP);
    }
  });

  it("ignores a blank metadata value and keeps looking", () => {
    expect(
      defaultNipExtractor({
        billing_address: { metadata: { nip: VALID_NIP } },
        metadata: { nip: "   " },
      }),
    ).toBe(VALID_NIP);
  });

  it("ignores a non-string metadata value", () => {
    expect(defaultNipExtractor({ metadata: { nip: 5_261_040_828 } })).toBeUndefined();
  });

  it("never reads the shipping address", () => {
    // Delivery to an office is common on consumer orders; reading it would file
    // that consumer's invoice to KSeF under their employer's NIP.
    expect(
      defaultNipExtractor({
        shipping_address: { company: `ACME NIP ${VALID_NIP}`, metadata: { nip: VALID_NIP } },
      }),
    ).toBeUndefined();
  });

  it("returns undefined for a consumer order", () => {
    expect(defaultNipExtractor({})).toBeUndefined();
    expect(
      defaultNipExtractor({ billing_address: { company: null }, metadata: null }),
    ).toBeUndefined();
  });
});
