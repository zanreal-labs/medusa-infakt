import { describe, expect, it } from "vitest";
import {
  buildInfaktInvoicePayload,
  companyNameDefect,
  MAX_SERVICE_NAME,
  shippingLineName,
  textShapeDefect,
  truncateServiceName,
} from "./builder";
import { EXPORT_SERVICES_NOTE, REVERSE_CHARGE_NOTE } from "./regime";
import type {
  InvoiceBuilderConfig,
  InvoiceBuyerInput,
  InvoiceItemInput,
  InvoiceOrderInput,
} from "./builder";

const config: InvoiceBuilderConfig = { currency: "PLN", taxSymbol: "23" };

const items: InvoiceItemInput[] = [
  { grossTotal: 61.73, name: "Program antywirusowy - licencja roczna", quantity: 1 },
  { grossTotal: 61.72, name: "Pendrive 64GB", quantity: 2 },
];

const order = (overrides: Partial<InvoiceOrderInput> = {}): InvoiceOrderInput => ({
  currency: "PLN",
  items,
  placedAt: "2026-07-14T21:30:00Z",
  shipping: [{ grossTotal: 9.99, name: "Paczkomat InPost" }],
  total: 133.44,
  ...overrides,
});

const consumer: InvoiceBuyerInput = {
  city: "Warszawa",
  countryCode: "pl",
  firstName: "Jan",
  lastName: "Kowalski",
  postalCode: "00-001",
  street: "Prosta 1",
};

const company: InvoiceBuyerInput = {
  ...consumer,
  city: "Krakow",
  companyName: "ACME Sp. z o.o.",
  postalCode: "31-042",
  street: "Rynek 5",
  taxId: "PL 526-104-08-28",
};

const unwrap = (result: ReturnType<typeof buildInfaktInvoicePayload>) => {
  if (!result.ok) {
    throw new Error(`expected a built payload, got: ${result.reason}`);
  }
  return result;
};

describe("buildInfaktInvoicePayload", () => {
  it("builds a consumer invoice whose lines sum to the order total", () => {
    const result = unwrap(buildInfaktInvoicePayload(order(), consumer, config));

    expect(result.isCompany).toBe(false);
    expect(result.nip).toBeUndefined();
    expect(result.totalMinor).toBe(13_344);
    expect(result.payload.client_business_activity_kind).toBe("private_person");
    expect(result.payload.client_first_name).toBe("Jan");
    expect(result.payload.client_last_name).toBe("Kowalski");
    expect(result.payload.client_tax_code).toBeUndefined();
    expect(result.payload.client_country).toBe("PL");
    expect(result.payload.currency).toBe("PLN");
    expect(result.payload.payment_method).toBe("transfer");
    expect(result.payload.services).toHaveLength(3);
    const sum = result.payload.services.reduce(
      (acc, service) => acc + (service.gross_price ?? 0),
      0,
    );
    expect(sum).toBe(13_344);
  });

  it("labels every line with the configured tax symbol and the szt. unit", () => {
    const result = unwrap(buildInfaktInvoicePayload(order(), consumer, config));
    for (const service of result.payload.services) {
      expect(service.tax_symbol).toBe("23");
      expect(service.unit).toBe("szt.");
    }
  });

  it("honours a non-default tax symbol", () => {
    const result = unwrap(
      buildInfaktInvoicePayload(order(), consumer, { currency: "PLN", taxSymbol: "8" }),
    );
    expect(result.payload.services.every((service) => service.tax_symbol === "8")).toBe(true);
  });

  it("uses the sale date from the order's placed date, in Warsaw time", () => {
    // 21:30 UTC on the 14th is 23:30 in Warsaw (CEST) - still the 14th.
    expect(unwrap(buildInfaktInvoicePayload(order(), consumer, config)).payload.sale_date).toBe(
      "2026-07-14",
    );
    // 23:30 UTC is 01:30 the next day in Warsaw.
    const late = order({ placedAt: "2026-07-14T23:30:00Z" });
    expect(unwrap(buildInfaktInvoicePayload(late, consumer, config)).payload.sale_date).toBe(
      "2026-07-15",
    );
  });

  it("issues with today's Warsaw date and never sets a number", () => {
    const result = unwrap(buildInfaktInvoicePayload(order(), consumer, config));
    expect(result.payload.invoice_date).toMatch(/^\d{4}-\d{2}-\d{2}$/u);
    // Numbering is inFakt's job; a payload that carried one would collide with
    // the account's own series.
    expect(result.payload).not.toHaveProperty("number");
  });

  it("names the shipping line after its method", () => {
    const result = unwrap(buildInfaktInvoicePayload(order(), consumer, config));
    expect(result.payload.services.at(-1)).toMatchObject({
      gross_price: 999,
      name: "Dostawa - Paczkomat InPost",
      quantity: 1,
    });
  });

  it("falls back to a bare Dostawa label for an unnamed method", () => {
    const result = unwrap(
      buildInfaktInvoicePayload(
        order({ shipping: [{ grossTotal: 9.99, name: null }] }),
        consumer,
        config,
      ),
    );
    expect(result.payload.services.at(-1)?.name).toBe("Dostawa");
  });

  it("omits a zero-cost or negative shipping line entirely", () => {
    for (const grossTotal of [0, null, -1]) {
      const result = unwrap(
        buildInfaktInvoicePayload(
          order({ shipping: [{ grossTotal, name: "Free" }], total: 123.45 }),
          consumer,
          config,
        ),
      );
      expect(result.payload.services).toHaveLength(2);
    }
  });

  it("adds one line per shipping method when there are several", () => {
    const result = unwrap(
      buildInfaktInvoicePayload(
        order({
          shipping: [
            { grossTotal: 5, name: "Kurier" },
            { grossTotal: 4.99, name: "Ubezpieczenie" },
          ],
        }),
        consumer,
        config,
      ),
    );
    expect(result.payload.services).toHaveLength(4);
    expect(result.payload.services.map((service) => service.name)).toContain(
      "Dostawa - Ubezpieczenie",
    );
  });

  it("multiplies the unit price by quantity when only a unit price is given", () => {
    const result = unwrap(
      buildInfaktInvoicePayload(
        order({
          items: [{ name: "Pendrive", quantity: 2, unitPrice: 30.86 }],
          shipping: [],
          total: 61.72,
        }),
        consumer,
        config,
      ),
    );
    expect(result.payload.services[0]).toMatchObject({ gross_price: 6172, quantity: 2 });
  });

  it("prefers grossTotal over unitPrice when both are present", () => {
    // Post-discount line total: unitPrice * quantity would be 6172 and would fail
    // the total-match guard, which is exactly the regression this guards.
    const result = unwrap(
      buildInfaktInvoicePayload(
        order({
          items: [{ grossTotal: 55, name: "Pendrive", quantity: 2, unitPrice: 30.86 }],
          shipping: [],
          total: 55,
        }),
        consumer,
        config,
      ),
    );
    expect(result.payload.services[0]?.gross_price).toBe(5500);
  });

  it("rounds each amount exactly once, with no float drift", () => {
    const result = unwrap(
      buildInfaktInvoicePayload(
        order({
          items: [{ grossTotal: 0.1 + 0.2, name: "Grosze", quantity: 1 }],
          shipping: [],
          total: 0.3,
        }),
        consumer,
        config,
      ),
    );
    expect(result.payload.services[0]?.gross_price).toBe(30);
  });

  it("truncates an over-long service name to 255 characters", () => {
    const long = "x".repeat(400);
    const result = unwrap(
      buildInfaktInvoicePayload(
        order({ items: [{ grossTotal: 10, name: long, quantity: 1 }], shipping: [], total: 10 }),
        consumer,
        config,
      ),
    );
    expect(result.payload.services[0]?.name).toHaveLength(255);
  });

  it("truncates an over-long shipping label too", () => {
    const result = unwrap(
      buildInfaktInvoicePayload(
        order({
          items: [{ grossTotal: 10, name: "X", quantity: 1 }],
          shipping: [{ grossTotal: 5, name: "y".repeat(400) }],
          total: 15,
        }),
        consumer,
        config,
      ),
    );
    expect(result.payload.services.at(-1)?.name).toHaveLength(255);
  });

  it("builds a company invoice from the buyer's NIP", () => {
    const result = unwrap(buildInfaktInvoicePayload(order(), company, config));
    expect(result.isCompany).toBe(true);
    expect(result.nip).toBe("5261040828");
    expect(result.payload.client_tax_code).toBe("5261040828");
    expect(result.payload.client_company_name).toBe("ACME Sp. z o.o.");
    expect(result.payload.client_business_activity_kind).toBe("other_business");
    expect(result.payload.client_city).toBe("Krakow");
    expect(result.payload.client_first_name).toBeUndefined();
    expect(result.payload.client_last_name).toBeUndefined();
  });

  it("carries the buyer email through when present", () => {
    const result = unwrap(
      buildInfaktInvoicePayload(order(), { ...consumer, email: "jan@example.com" }, config),
    );
    expect(result.payload.client_email).toBe("jan@example.com");
  });

  it("omits client_email entirely when the order has none", () => {
    const result = unwrap(buildInfaktInvoicePayload(order(), consumer, config));
    expect(result.payload).not.toHaveProperty("client_email");
  });
});

describe("buildInfaktInvoicePayload: the total-match guard", () => {
  it("refuses a line sum that differs from the order total", () => {
    const result = buildInfaktInvoicePayload(order({ total: 999 }), consumer, config);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("does not match order total"),
    });
  });

  it("refuses a one-grosz mismatch just as hard as a large one", () => {
    const result = buildInfaktInvoicePayload(order({ total: 133.45 }), consumer, config);
    expect(result.ok).toBe(false);
  });

  it("refuses when the order total is missing - nothing to verify against", () => {
    const result = buildInfaktInvoicePayload(order({ total: null }), consumer, config);
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("order total is missing"),
    });
  });

  it("refuses a non-numeric order total", () => {
    const result = buildInfaktInvoicePayload(order({ total: "not a number" }), consumer, config);
    expect(result).toMatchObject({ ok: false });
  });
});

describe("buildInfaktInvoicePayload: gates", () => {
  it("refuses a currency other than the configured one", () => {
    const result = buildInfaktInvoicePayload(order({ currency: "EUR" }), consumer, config);
    expect(result).toMatchObject({ ok: false, reason: "unsupported currency EUR" });
  });

  it("compares the currency case-insensitively", () => {
    const result = buildInfaktInvoicePayload(order({ currency: "pln" }), consumer, config);
    expect(result.ok).toBe(true);
  });

  it("honours a non-PLN configured currency", () => {
    const eur: InvoiceBuilderConfig = { currency: "EUR", taxSymbol: "23" };
    const result = unwrap(buildInfaktInvoicePayload(order({ currency: "EUR" }), consumer, eur));
    expect(result.payload.currency).toBe("EUR");
  });

  it("refuses an order with no items", () => {
    const result = buildInfaktInvoicePayload(order({ items: [] }), consumer, config);
    expect(result).toMatchObject({ ok: false, reason: "order has no items" });
  });

  it("refuses a fractional or non-positive quantity", () => {
    for (const quantity of [0.5, 0, -1]) {
      const result = buildInfaktInvoicePayload(
        order({ items: [{ grossTotal: 10, name: "X", quantity }], shipping: [], total: 10 }),
        consumer,
        config,
      );
      expect(result).toMatchObject({
        ok: false,
        reason: expect.stringContaining("invalid price or quantity"),
      });
    }
  });

  it("refuses an item with neither a gross total nor a unit price", () => {
    const result = buildInfaktInvoicePayload(
      order({ items: [{ name: "X", quantity: 1 }], shipping: [], total: 10 }),
      consumer,
      config,
    );
    expect(result).toMatchObject({
      ok: false,
      reason: expect.stringContaining("invalid price or quantity"),
    });
  });

  it("refuses a negative line amount", () => {
    const result = buildInfaktInvoicePayload(
      order({ items: [{ grossTotal: -10, name: "X", quantity: 1 }], shipping: [], total: -10 }),
      consumer,
      config,
    );
    expect(result).toMatchObject({ ok: false });
  });
});

describe("buildInfaktInvoicePayload: buyer validation", () => {
  it("refuses an order with no billing details at all", () => {
    expect(buildInfaktInvoicePayload(order(), undefined, config)).toMatchObject({
      ok: false,
      reason: "order has no billing details",
    });
  });

  it("names the missing address fields without printing their values", () => {
    const result = buildInfaktInvoicePayload(
      order(),
      { ...consumer, city: null, postalCode: "  " },
      config,
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) {
      expect(result.reason).toContain("city");
      expect(result.reason).toContain("postal_code");
      expect(result.reason).not.toContain("Prosta 1");
    }
  });

  it("refuses a consumer with no first or last name", () => {
    expect(
      buildInfaktInvoicePayload(order(), { ...consumer, lastName: null }, config),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("buyer name is missing") });
    expect(
      buildInfaktInvoicePayload(order(), { ...consumer, firstName: "   " }, config),
    ).toMatchObject({ ok: false, reason: expect.stringContaining("buyer name is missing") });
  });

  it("refuses a buyer with a NIP but no company name", () => {
    expect(
      buildInfaktInvoicePayload(order(), { ...company, companyName: null }, config),
    ).toMatchObject({ ok: false, reason: "buyer has a NIP but no company name" });
  });

  it("defaults the country to PL and uppercases a given one", () => {
    expect(
      unwrap(buildInfaktInvoicePayload(order(), { ...consumer, countryCode: null }, config)).payload
        .client_country,
    ).toBe("PL");
    expect(
      unwrap(buildInfaktInvoicePayload(order(), { ...consumer, countryCode: "de" }, config)).payload
        .client_country,
    ).toBe("DE");
  });

  it("trims surrounding whitespace off the address and name fields", () => {
    const result = unwrap(
      buildInfaktInvoicePayload(
        order(),
        { ...consumer, city: "  Warszawa  ", firstName: " Jan " },
        config,
      ),
    );
    expect(result.payload.client_city).toBe("Warszawa");
    expect(result.payload.client_first_name).toBe("Jan");
  });
});

describe("buildInfaktInvoicePayload: rejection reasons never leak the NIP", () => {
  it("rejects a tax id that does not normalize to 10 digits without echoing it", () => {
    const result = buildInfaktInvoicePayload(order(), { ...company, taxId: "DE811907980" }, config);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain("811907980");
      expect(result.reason).toContain("10-digit NIP");
      // The digit COUNT is safe and is what makes the failure diagnosable.
      expect(result.reason).toContain("9 digits");
    }
  });

  it("does not leak an over-long tax id either", () => {
    const result = buildInfaktInvoicePayload(
      order(),
      { ...company, taxId: "5261040828123" },
      config,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).not.toContain("5261040828");
      expect(result.reason).toContain("13 digits");
    }
  });

  it("never puts the buyer name, street or company into any rejection reason", () => {
    const secrets = ["Jan", "Kowalski", "Rynek 5", "ACME Sp. z o.o.", "5261040828"];
    const broken: Partial<InvoiceBuyerInput>[] = [
      { taxId: "12345" },
      { companyName: null },
      { city: null },
      { firstName: null, lastName: null, taxId: null },
    ];
    for (const patch of broken) {
      const result = buildInfaktInvoicePayload(
        order({ total: 1 }),
        { ...company, ...patch },
        config,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        for (const secret of secrets) {
          expect(result.reason).not.toContain(secret);
        }
      }
    }
  });
});

describe("the last gate on a company name", () => {
  /**
   * Two invoices went out to real customers reading `NZOZ "Familia" Monika
   * Kwasniak ( )` - numbered, filed to KSeF, and correctable only by a corrective
   * invoice. The cause was an upstream import folding the tax id into the company
   * name; this gate is what makes the same class of residue a `needs_review` row
   * instead of a document.
   */
  const withName = (companyName: string) =>
    buildInfaktInvoicePayload(order(), { ...company, companyName }, config);

  it("refuses the exact shape that reached a customer", () => {
    const result = withName('NZOZ "Familia" Monika Kwasniak ( )');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("empty bracket pair");
    }
  });

  it("refuses an unbalanced bracket", () => {
    expect(withName("Poradnia Lekarska (").ok).toBe(false);
    expect(withName("Poradnia Lekarska )").ok).toBe(false);
  });

  it("refuses a dangling separator", () => {
    for (const name of ["ACME Sp. z o.o. -", "ACME Sp. z o.o. ,", "- ACME Sp. z o.o."]) {
      expect(withName(name).ok).toBe(false);
    }
  });

  it("refuses a name that is nothing but punctuation", () => {
    const result = withName("- .");
    expect(result.ok).toBe(false);
  });

  it("refuses a name that still carries the tax id, in either spelling", () => {
    for (const name of ["ACME Sp. z o.o. 5261040828", "ACME Sp. z o.o. 526-104-08-28"]) {
      const result = withName(name);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toContain("still contains the tax id");
      }
    }
  });

  it("passes the names this must never hold up", () => {
    for (const name of [
      "ACME Sp. z o.o.",
      'Poradnia Lekarska "Medicus" Sp. z o.o.',
      'NZOZ "Familia" Monika Kwasniak',
      "Nowak-Kowalski i Wspolnicy S.C.",
      "Firma (Oddzial Zachodni) Sp. z o.o.",
      "Zaklad Nr 4",
    ]) {
      const result = withName(name);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.payload.client_company_name).toBe(name);
      }
    }
  });

  it("never names the buyer or the tax id in the reason", () => {
    const secrets = ["Familia", "Kwasniak", "ACME", "5261040828", "526-104-08-28"];
    for (const name of ['NZOZ "Familia" Monika Kwasniak ( )', "ACME Sp. z o.o. 526-104-08-28"]) {
      const result = withName(name);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        for (const secret of secrets) {
          expect(result.reason).not.toContain(secret);
        }
      }
    }
  });

  it("is a pure predicate, callable without a whole order", () => {
    expect(companyNameDefect("ACME Sp. z o.o.")).toBeNull();
    expect(companyNameDefect("ACME ( )")).toContain("empty bracket pair");
    expect(companyNameDefect("ACME", "5261040828")).toBeNull();
  });
});

describe("cross-border regimes", () => {
  const eur: InvoiceBuilderConfig = { currency: "EUR", taxSymbol: "23" };
  const eurOrder = () => order({ currency: "EUR" });

  const deCompany: InvoiceBuyerInput = {
    city: "Berlin",
    companyName: "ACME GmbH",
    countryCode: "DE",
    postalCode: "10115",
    street: "Hauptstrasse 1",
    taxId: "DE123456789",
  };

  const reverseCharge = {
    country: "DE",
    kind: "reverse_charge",
    note: REVERSE_CHARGE_NOTE,
    taxSymbol: "np",
    vatId: "DE123456789",
    vatUeReportable: true,
  } as const;

  const exportServices = {
    country: "US",
    kind: "export_services",
    note: EXPORT_SERVICES_NOTE,
    taxSymbol: "np",
    vatUeReportable: false,
  } as const;

  it("holds a cross-border invoice whose company name is malformed", () => {
    // The same last gate as the domestic path. A reverse-charge document is no less
    // a legal one, and the same upstream un-concatenation feeds it.
    const result = buildInfaktInvoicePayload(
      eurOrder(),
      { ...deCompany, companyName: "ACME GmbH ( )" },
      { ...eur, regime: reverseCharge },
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("empty bracket pair");
    }
  });

  it("puts np on every line of a reverse-charge invoice, never 0", () => {
    const result = unwrap(
      buildInfaktInvoicePayload(eurOrder(), deCompany, { ...eur, regime: reverseCharge }),
    );
    expect(result.payload.services.every((service) => service.tax_symbol === "np")).toBe(true);
  });

  it("puts np on the shipping line too", () => {
    const result = unwrap(
      buildInfaktInvoicePayload(eurOrder(), deCompany, { ...eur, regime: reverseCharge }),
    );
    const shipping = result.payload.services.at(-1);
    expect(shipping?.name).toContain("Dostawa");
    expect(shipping?.tax_symbol).toBe("np");
  });

  it("carries the reverse-charge annotation", () => {
    const result = unwrap(
      buildInfaktInvoicePayload(eurOrder(), deCompany, { ...eur, regime: reverseCharge }),
    );
    expect(result.payload.notes).toBe(REVERSE_CHARGE_NOTE);
    expect(result.payload.sale_type).toBe("service");
  });

  it("puts the prefixed VAT id on the invoice, not a stripped one", () => {
    const result = unwrap(
      buildInfaktInvoicePayload(eurOrder(), deCompany, { ...eur, regime: reverseCharge }),
    );
    expect(result.payload.client_tax_code).toBe("DE123456789");
    expect(result.payload.client_business_activity_kind).toBe("other_business");
    expect(result.payload.client_country).toBe("DE");
  });

  it("marks a foreign business as a company but records no Polish NIP", () => {
    const result = unwrap(
      buildInfaktInvoicePayload(eurOrder(), deCompany, { ...eur, regime: reverseCharge }),
    );
    // `isCompany` drives the KSeF decision, which the owner wants to include
    // foreign buyers; `nip` stays undefined because a DE number is not a NIP.
    expect(result.isCompany).toBe(true);
    expect(result.nip).toBeUndefined();
  });

  it("no longer rejects a foreign VAT id as a malformed NIP", () => {
    const result = buildInfaktInvoicePayload(eurOrder(), deCompany, {
      ...eur,
      regime: reverseCharge,
    });
    expect(result.ok).toBe(true);
  });

  it("gives an export of services the same np but a different annotation", () => {
    const usCompany: InvoiceBuyerInput = {
      ...deCompany,
      countryCode: "US",
      taxId: "12-3456789",
    };
    const result = unwrap(
      buildInfaktInvoicePayload(eurOrder(), usCompany, { ...eur, regime: exportServices }),
    );
    expect(result.payload.services.every((service) => service.tax_symbol === "np")).toBe(true);
    expect(result.payload.notes).toBe(EXPORT_SERVICES_NOTE);
    expect(result.payload.notes).not.toBe(REVERSE_CHARGE_NOTE);
  });

  it("refuses a cross-border business invoice with no company name", () => {
    const result = buildInfaktInvoicePayload(
      eurOrder(),
      { ...deCompany, companyName: null },
      { ...eur, regime: reverseCharge },
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("company name");
  });

  it("refuses to build an OSS sale, which is a different document family", () => {
    const result = buildInfaktInvoicePayload(eurOrder(), deCompany, {
      ...eur,
      regime: { country: "DE", kind: "oss", rate: "19" },
    });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("different document family");
  });

  it("surfaces a blocked regime's reason unchanged", () => {
    const result = buildInfaktInvoicePayload(eurOrder(), deCompany, {
      ...eur,
      regime: { kind: "blocked", reason: "no OSS VAT rate is known for DE" },
    });
    expect(result).toMatchObject({ ok: false, reason: "no OSS VAT rate is known for DE" });
  });

  it("still enforces the total-match guard across a border", () => {
    const result = buildInfaktInvoicePayload(order({ currency: "EUR", total: 200 }), deCompany, {
      ...eur,
      regime: reverseCharge,
    });
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("does not match order total");
  });
});

describe("the domestic path is unchanged", () => {
  it("produces an identical payload with no regime and with an explicit domestic one", () => {
    const withoutRegime = unwrap(buildInfaktInvoicePayload(order(), company, config));
    const withRegime = unwrap(
      buildInfaktInvoicePayload(order(), company, {
        ...config,
        regime: { kind: "domestic", taxSymbol: "23" },
      }),
    );
    expect(withRegime.payload).toEqual(withoutRegime.payload);
  });

  it("adds no notes and no sale_type to a domestic invoice", () => {
    const result = unwrap(buildInfaktInvoicePayload(order(), company, config));
    expect(result.payload.notes).toBeUndefined();
    expect(result.payload.sale_type).toBeUndefined();
  });

  it("still keeps the Polish rate symbol domestically", () => {
    const result = unwrap(buildInfaktInvoicePayload(order(), company, config));
    expect(result.payload.services.every((service) => service.tax_symbol === "23")).toBe(true);
  });

  it("still records the normalized Polish NIP", () => {
    const result = unwrap(buildInfaktInvoicePayload(order(), company, config));
    expect(result.nip).toBe("5261040828");
    expect(result.payload.client_tax_code).toBe("5261040828");
  });
});

describe("residue never reaches a service line", () => {
  /**
   * The company name was never the only free text on an invoice. A service line
   * name is assembled by concatenation too, and the same missing value leaves the
   * same stranded separator behind - `Dostawa - ` instead of `Firma ( )`. These
   * pin the gate that `companyNameDefect` always had and the line names did not.
   */
  const lineNames = (o: InvoiceOrderInput): string[] => {
    const result = buildInfaktInvoicePayload(o, consumer, config);
    if (!result.ok) {
      throw new Error(`expected a payload, got: ${result.reason}`);
    }
    return (result.payload.services ?? []).map((service) => service.name);
  };

  it("drops the qualifier when the shipping method name is only a separator", () => {
    for (const name of [" ", "-", " - ", "()", ","]) {
      expect(shippingLineName(name)).toBe("Dostawa");
    }
  });

  it("keeps a real carrier name, brackets and all", () => {
    expect(shippingLineName("Paczkomat InPost")).toBe("Dostawa - Paczkomat InPost");
    expect(shippingLineName("Kurier (DPD)")).toBe("Dostawa - Kurier (DPD)");
  });

  it("never puts a dangling separator on a shipping line of a real invoice", () => {
    const names = lineNames(order({ shipping: [{ grossTotal: 9.99, name: " - " }] }));
    expect(names).toContain("Dostawa");
    for (const name of names) {
      expect(textShapeDefect(name)).toBeNull();
    }
  });

  it("truncates a long name on a character, never inside one", () => {
    // A surrogate pair straddling the limit used to be cut in half, emitting a
    // lone surrogate - a replacement glyph on the customer's PDF.
    const long = `${"a".repeat(MAX_SERVICE_NAME - 1)}😀 tail`;
    const cut = truncateServiceName(long);
    expect(cut.length).toBeLessThanOrEqual(MAX_SERVICE_NAME);
    expect([...cut].every((character) => character.codePointAt(0) !== undefined)).toBe(true);
    expect(/[\uD800-\uDFFF]/u.test(cut)).toBe(false);
  });

  it("leaves no dangling separator where it cut", () => {
    expect(truncateServiceName(`${"a".repeat(MAX_SERVICE_NAME - 2)} - tail`)).toBe(
      "a".repeat(MAX_SERVICE_NAME - 2),
    );
  });

  it("leaves a name that already fits exactly as it is", () => {
    expect(truncateServiceName("Program antywirusowy")).toBe("Program antywirusowy");
  });
});

describe("textShapeDefect", () => {
  it("names the shapes no legal text has", () => {
    expect(textShapeDefect("ACME ( )")).toBe("empty_brackets");
    expect(textShapeDefect("ACME (")).toBe("unbalanced_bracket");
    expect(textShapeDefect("ACME -")).toBe("dangling_separator");
    expect(textShapeDefect("...")).toBe("no_alphanumerics");
  });

  it("passes text a document may legitimately carry", () => {
    for (const value of [
      "ACME Sp. z o.o.",
      "Firma (Oddzial Zachodni) Sp. z o.o.",
      "Dostawa - Paczkomat InPost",
      "Program antywirusowy - licencja roczna",
    ]) {
      expect(textShapeDefect(value)).toBeNull();
    }
  });

  it("still produces the company-name wording it was extracted from", () => {
    expect(companyNameDefect("ACME ( )")).toBe(
      "buyer company name contains an empty bracket pair",
    );
    expect(companyNameDefect("ACME (")).toBe("buyer company name has an unbalanced bracket");
    expect(companyNameDefect("ACME -")).toBe(
      "buyer company name starts or ends with a dangling separator",
    );
    expect(companyNameDefect("...")).toBe("buyer company name contains no letters or digits");
  });
});
