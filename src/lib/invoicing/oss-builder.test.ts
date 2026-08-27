import { describe, expect, it } from "vitest";
import type { InvoiceBuyerInput, InvoiceOrderInput } from "./builder";
import type { OssBuilderConfig } from "./oss-builder";
import { buildOssInvoicePayload } from "./oss-builder";

const config: OssBuilderConfig = {
  country: "DE",
  currency: "EUR",
  rate: "19",
  serviceType: "electronic",
};

const consumer: InvoiceBuyerInput = {
  city: "Berlin",
  countryCode: "DE",
  email: "kunde@example.de",
  firstName: "Anna",
  lastName: "Schmidt",
  postalCode: "10115",
  street: "Hauptstrasse 1",
};

/**
 * 100.00 gross at 19% is 84.03 net + 15.97 tax. Every fixture below is built
 * from that so the arithmetic guard is exercised with real rounding.
 */
const order = (overrides: Partial<InvoiceOrderInput> = {}): InvoiceOrderInput => ({
  currency: "EUR",
  items: [{ grossTotal: 100, name: "Bitdefender", quantity: 1 }],
  taxTotal: 15.97,
  total: 100,
  ...overrides,
});

const unwrap = (result: ReturnType<typeof buildOssInvoicePayload>) => {
  if (!result.ok) {
    throw new Error(`expected a payload, got: ${result.reason}`);
  }
  return result;
};

describe("buildOssInvoicePayload", () => {
  it("charges the destination country's rate on every line", () => {
    const result = unwrap(buildOssInvoicePayload(order(), consumer, config));
    expect(result.payload.services.every((service) => service.tax_rate === "19")).toBe(true);
  });

  it("carries no tax_symbol - an OSS line has a rate, not a Polish symbol", () => {
    const result = unwrap(buildOssInvoicePayload(order(), consumer, config));
    for (const service of result.payload.services) {
      expect(service).not.toHaveProperty("tax_symbol");
    }
  });

  it("states the destination country and an electronic service", () => {
    const result = unwrap(buildOssInvoicePayload(order(), consumer, config));
    expect(result.payload).toMatchObject({
      country: "DE",
      sale_type: "service",
      service_place_primary: "DE",
      service_type: "electronic",
    });
  });

  it("keeps the invoice total equal to what the buyer paid", () => {
    const result = unwrap(buildOssInvoicePayload(order(), consumer, config));
    expect(result.totalMinor).toBe(10_000);
    expect(result.payload.gross_price).toBe(10_000);
    expect(result.payload.net_price).toBe(8403);
    expect(result.payload.tax_price).toBe(1597);
  });

  it("invoices in the order's own currency", () => {
    const result = unwrap(buildOssInvoicePayload(order(), consumer, config));
    expect(result.payload.currency).toBe("EUR");
  });

  it("names the consumer, because OSS is a B2C procedure", () => {
    const result = unwrap(buildOssInvoicePayload(order(), consumer, config));
    expect(result.payload).toMatchObject({
      client_first_name: "Anna",
      client_last_name: "Schmidt",
    });
  });

  it("refuses without a consumer name rather than falling back to a company", () => {
    const result = buildOssInvoicePayload(
      order(),
      { ...consumer, firstName: null, lastName: null },
      config,
    );
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("first and last name");
  });
});

describe("the destination-VAT guard", () => {
  it("refuses when the checkout charged no VAT at all", () => {
    // The live case today: Medusa's non-Polish tax regions carry no rate, so an
    // EU consumer is charged 0%. No correct OSS invoice exists for that order.
    const result = buildOssInvoicePayload(order({ taxTotal: 0 }), consumer, config);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("no VAT");
    expect(!result.ok && result.reason).toContain("19%");
  });

  it("points at the unconfigured tax region, which is the actual fix", () => {
    const result = buildOssInvoicePayload(order({ taxTotal: 0 }), consumer, config);
    expect(!result.ok && result.reason).toContain("tax region");
  });

  it("refuses when the rate charged was some other country's", () => {
    // 23% Polish VAT on a German consumer's order.
    const result = buildOssInvoicePayload(order({ taxTotal: 18.7 }), consumer, config);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("disagree");
  });

  it("refuses when the order reports no tax total at all", () => {
    const result = buildOssInvoicePayload(order({ taxTotal: null }), consumer, config);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("tax total");
  });

  it("tolerates per-line rounding of a grosz", () => {
    // Note the asymmetry: the tax figure also moves the implied net, so the
    // window is not symmetric around the exact value. 15.96 implies a net of
    // 84.04 and is within a grosz of the 19% of that; 15.98 implies 84.02, whose
    // 19% is 15.96 - two grosze out, which is a real disagreement rather than
    // rounding, and is covered by the test below.
    for (const taxTotal of [15.96, 15.97]) {
      expect(buildOssInvoicePayload(order({ taxTotal }), consumer, config).ok, `${taxTotal}`).toBe(
        true,
      );
    }
  });

  it("does not tolerate a difference wider than rounding", () => {
    expect(buildOssInvoicePayload(order({ taxTotal: 16.5 }), consumer, config).ok).toBe(false);
  });

  it("accepts a correctly taxed multi-line order", () => {
    const result = buildOssInvoicePayload(
      order({
        items: [
          { grossTotal: 60, name: "A", quantity: 1 },
          { grossTotal: 40, name: "B", quantity: 1 },
        ],
      }),
      consumer,
      config,
    );
    expect(result.ok).toBe(true);
  });
});

describe("the invariants inherited from the VAT builder", () => {
  it("refuses when the lines do not sum to the order total", () => {
    const result = buildOssInvoicePayload(order({ total: 120 }), consumer, config);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.reason).toContain("does not match order total");
  });

  it("refuses an order with no items", () => {
    expect(buildOssInvoicePayload(order({ items: [] }), consumer, config).ok).toBe(false);
  });

  it("refuses a missing order total", () => {
    expect(buildOssInvoicePayload(order({ total: null }), consumer, config).ok).toBe(false);
  });

  it("refuses a fractional quantity", () => {
    const result = buildOssInvoicePayload(
      order({ items: [{ grossTotal: 100, name: "A", quantity: 0.5 }] }),
      consumer,
      config,
    );
    expect(result.ok).toBe(false);
  });

  it("adds a paid shipping line and keeps the total matching", () => {
    const result = unwrap(
      buildOssInvoicePayload(
        order({
          items: [{ grossTotal: 90, name: "A", quantity: 1 }],
          shipping: [{ grossTotal: 10, name: "Kurier" }],
        }),
        consumer,
        config,
      ),
    );
    expect(result.payload.services).toHaveLength(2);
    expect(result.payload.services[1]?.name).toBe("Dostawa - Kurier");
  });

  it("drops a free shipping line", () => {
    const result = unwrap(
      buildOssInvoicePayload(order({ shipping: [{ grossTotal: 0, name: "Free" }] }), consumer, config),
    );
    expect(result.payload.services).toHaveLength(1);
  });

  it("refuses an unusable rate rather than issuing an untaxed document", () => {
    const result = buildOssInvoicePayload(order(), consumer, { ...config, rate: "abc" });
    expect(result).toMatchObject({ ok: false });
  });

  it("never puts buyer identity data into a rejection reason", () => {
    const result = buildOssInvoicePayload(order({ taxTotal: 0 }), consumer, config);
    const reason = !result.ok ? result.reason : "";
    expect(reason).not.toContain("Anna");
    expect(reason).not.toContain("Schmidt");
    expect(reason).not.toContain("Hauptstrasse");
    expect(reason).not.toContain("kunde@example.de");
  });
});
