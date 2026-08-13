import { BigNumber } from "@medusajs/framework/utils";
import { describe, expect, it } from "vitest";
import { buildInfaktInvoicePayload } from "./builder";
import { defaultNipExtractor } from "./nip";
import {
  cleanCompanyName,
  lineItemName,
  streetLine,
  toInvoiceBuyerInput,
  toInvoiceOrderInput,
} from "./order-mapper";
import type { MedusaOrderLike } from "./order-mapper";

const VALID_NIP = "5261040828";

const medusaOrder = (overrides: Partial<MedusaOrderLike> = {}): MedusaOrderLike => ({
  billing_address: {
    address_1: "Prosta 1",
    city: "Warszawa",
    country_code: "pl",
    first_name: "Jan",
    last_name: "Kowalski",
    postal_code: "00-001",
  },
  created_at: "2026-07-14T21:30:00Z",
  currency_code: "pln",
  email: "jan@example.com",
  id: "order_01",
  items: [
    { product_title: "Program antywirusowy", quantity: 1, total: 61.73, unit_price: 61.73 },
    { product_title: "Pendrive", quantity: 2, total: 61.72, unit_price: 30.86 },
  ],
  shipping_methods: [{ name: "Paczkomat InPost", total: 9.99 }],
  total: 133.44,
  ...overrides,
});

describe("lineItemName", () => {
  it("qualifies the product title with the variant when both exist", () => {
    expect(lineItemName({ product_title: "T-shirt", quantity: 1, variant_title: "L" })).toBe(
      "T-shirt - L",
    );
  });

  it("does not repeat the product title as its own variant", () => {
    expect(lineItemName({ product_title: "T-shirt", quantity: 1, variant_title: "T-shirt" })).toBe(
      "T-shirt",
    );
  });

  it("qualifies with the full variant title when it does not carry the product name", () => {
    // The legacy shape: the variant title holds only its option axes. Old
    // snapshots and any catalogue that still writes variants this way must keep
    // getting the product-title prefix.
    expect(
      lineItemName({ product_title: "Bitdefender Antivirus for Mac", quantity: 1, variant_title: "1 rok / 1" }),
    ).toBe("Bitdefender Antivirus for Mac - 1 rok / 1");
  });

  it("does not double the product title when the variant title already carries it", () => {
    // The current catalogue shape: every live variant title is prefixed with
    // the product title, e.g. "Bitdefender Antivirus for Mac - 1 rok / 1".
    expect(
      lineItemName({
        product_title: "Bitdefender Antivirus for Mac",
        quantity: 1,
        variant_title: "Bitdefender Antivirus for Mac - 1 rok / 1",
      }),
    ).toBe("Bitdefender Antivirus for Mac - 1 rok / 1");
  });

  it("does not treat a variant title as prefixed when it only shares a word boundary-less prefix", () => {
    // "MacBook" is not "Mac" plus a separator, so both names must still show.
    expect(lineItemName({ product_title: "Mac", quantity: 1, variant_title: "MacBook" })).toBe(
      "Mac - MacBook",
    );
  });

  it("falls back to the line title, then the variant title", () => {
    expect(lineItemName({ quantity: 1, title: "Legacy title" })).toBe("Legacy title");
    expect(lineItemName({ quantity: 1, variant_title: "L" })).toBe("L");
  });

  it("never returns an empty name", () => {
    // inFakt rejects a blank service name, and a blank one would also make the
    // matching engine unable to confirm the invoice later.
    expect(lineItemName({ quantity: 1 })).toBe("Pozycja");
    expect(lineItemName({ product_title: "   ", quantity: 1 })).toBe("Pozycja");
  });
});

describe("streetLine", () => {
  it("joins address_1 and address_2", () => {
    expect(streetLine({ address_1: "Prosta 1", address_2: "lok. 5" })).toBe("Prosta 1 lok. 5");
  });

  it("uses whichever line is present", () => {
    expect(streetLine({ address_1: "Prosta 1" })).toBe("Prosta 1");
    expect(streetLine({ address_2: "lok. 5" })).toBe("lok. 5");
  });

  it("returns undefined when there is no street at all", () => {
    expect(streetLine({})).toBeUndefined();
    expect(streetLine(null)).toBeUndefined();
    expect(streetLine({ address_1: "  " })).toBeUndefined();
  });
});

describe("cleanCompanyName", () => {
  it("removes a NIP the storefront concatenated into the name", () => {
    expect(cleanCompanyName(`ACME Sp. z o.o. NIP ${VALID_NIP}`, VALID_NIP)).toBe("ACME Sp. z o.o.");
    expect(cleanCompanyName("ACME Sp. z o.o., NIP: 526-104-08-28", VALID_NIP)).toBe(
      "ACME Sp. z o.o.",
    );
  });

  it("leaves the name alone when no NIP was extracted", () => {
    expect(cleanCompanyName("ACME 5261040828")).toBe("ACME 5261040828");
  });

  it("leaves digits that are not the extracted NIP alone", () => {
    expect(cleanCompanyName("Firma 24h Sp. z o.o.", VALID_NIP)).toBe("Firma 24h Sp. z o.o.");
  });

  it("never returns a blank name", () => {
    // A buyer with a NIP must have a company name or the builder rejects the
    // invoice; a slightly ugly name beats a needs_review row.
    expect(cleanCompanyName(VALID_NIP, VALID_NIP)).toBe(VALID_NIP);
  });

  it("returns null for a missing name", () => {
    expect(cleanCompanyName(null, VALID_NIP)).toBeNull();
    expect(cleanCompanyName("   ", VALID_NIP)).toBeNull();
  });
});

describe("toInvoiceOrderInput", () => {
  it("maps currency, total, placed date, items and shipping", () => {
    const input = toInvoiceOrderInput(medusaOrder(), "PLN");
    expect(input.currency).toBe("PLN");
    expect(input.total).toBe(133.44);
    expect(input.placedAt).toBe("2026-07-14T21:30:00Z");
    expect(input.items).toHaveLength(2);
    expect(input.items[0]).toMatchObject({ grossTotal: 61.73, quantity: 1 });
    expect(input.shipping?.[0]).toMatchObject({ grossTotal: 9.99, name: "Paczkomat InPost" });
  });

  it("reads item.total, not unit_price * quantity", () => {
    // The discount case: unit_price * quantity is 61.72, the real line total is 50.
    const input = toInvoiceOrderInput(
      medusaOrder({
        items: [{ product_title: "Pendrive", quantity: 2, total: 50, unit_price: 30.86 }],
      }),
      "PLN",
    );
    expect(input.items[0]?.grossTotal).toBe(50);
  });

  it("falls back to shipping amount when total is absent", () => {
    const input = toInvoiceOrderInput(
      medusaOrder({ shipping_methods: [{ amount: 12.5, name: "Kurier" }] }),
      "PLN",
    );
    expect(input.shipping?.[0]?.grossTotal).toBe(12.5);
  });

  it("unwraps the raw BigNumber { value } shape everywhere", () => {
    const input = toInvoiceOrderInput(
      medusaOrder({
        items: [{ product_title: "X", quantity: 1, total: { value: "61.73" } }],
        shipping_methods: [{ name: "Kurier", total: { value: "9.99" } }],
        total: { value: "71.72" },
      }) as MedusaOrderLike,
      "PLN",
    );
    expect(input.total).toBe(71.72);
    expect(input.items[0]?.grossTotal).toBe(61.73);
    expect(input.shipping?.[0]?.grossTotal).toBe(9.99);
  });

  it("reads real BigNumber instances everywhere", () => {
    // Every amount here is constructed by the installed Medusa package, which is
    // what `query.graph` hands back. Its instances expose `numeric_`, `raw_` and
    // `bignumber_` and no `value` key, so only a real one exercises this path.
    const input = toInvoiceOrderInput(
      medusaOrder({
        items: [
          { product_title: "X", quantity: 1, total: new BigNumber("61.73"), unit_price: new BigNumber("61.73") },
        ],
        shipping_methods: [{ name: "Kurier", total: new BigNumber("9.99") }],
        total: new BigNumber("71.72"),
      }) as MedusaOrderLike,
      "PLN",
    );
    expect(input.total).toBe(71.72);
    expect(input.items[0]?.grossTotal).toBe(61.73);
    expect(input.items[0]?.unitPrice).toBe(61.73);
    expect(input.shipping?.[0]?.grossTotal).toBe(9.99);
  });

  it("falls back to the configured currency when the order states none", () => {
    expect(toInvoiceOrderInput(medusaOrder({ currency_code: null }), "PLN").currency).toBe("PLN");
  });

  it("copes with an order that has no items or shipping arrays", () => {
    const input = toInvoiceOrderInput(medusaOrder({ items: null, shipping_methods: null }), "PLN");
    expect(input.items).toEqual([]);
    expect(input.shipping).toEqual([]);
  });
});

describe("toInvoiceBuyerInput", () => {
  it("maps the billing address", () => {
    const buyer = toInvoiceBuyerInput(medusaOrder(), defaultNipExtractor);
    expect(buyer).toMatchObject({
      city: "Warszawa",
      countryCode: "pl",
      email: "jan@example.com",
      firstName: "Jan",
      lastName: "Kowalski",
      postalCode: "00-001",
      street: "Prosta 1",
      taxId: null,
    });
  });

  it("falls back to the shipping address only when there is no billing address", () => {
    const buyer = toInvoiceBuyerInput(
      medusaOrder({
        billing_address: null,
        shipping_address: {
          address_1: "Dluga 2",
          city: "Gdansk",
          first_name: "Anna",
          last_name: "Nowak",
          postal_code: "80-001",
        },
      }),
      defaultNipExtractor,
    );
    expect(buyer.city).toBe("Gdansk");
    expect(buyer.firstName).toBe("Anna");
  });

  it("does not mix a billing address with shipping fields", () => {
    // A half-billing, half-shipping address is a fiction that ends up on a legal
    // document. An incomplete billing address must fail the builder instead.
    const buyer = toInvoiceBuyerInput(
      medusaOrder({
        billing_address: { city: "Warszawa", first_name: "Jan", last_name: "Kowalski" },
        shipping_address: { address_1: "Dluga 2", city: "Gdansk", postal_code: "80-001" },
      }),
      defaultNipExtractor,
    );
    expect(buyer.street).toBeNull();
    expect(buyer.postalCode).toBeNull();
  });

  it("picks up a NIP from order metadata and cleans the company name", () => {
    const buyer = toInvoiceBuyerInput(
      medusaOrder({
        billing_address: {
          address_1: "Rynek 5",
          city: "Krakow",
          company: `ACME Sp. z o.o. NIP ${VALID_NIP}`,
          postal_code: "31-042",
        },
        metadata: { nip: VALID_NIP },
      }),
      defaultNipExtractor,
    );
    expect(buyer.taxId).toBe(VALID_NIP);
    expect(buyer.companyName).toBe("ACME Sp. z o.o.");
  });

  it("honours a custom extractor", () => {
    const buyer = toInvoiceBuyerInput(medusaOrder(), () => "PL 526-104-08-28");
    expect(buyer.taxId).toBe("PL 526-104-08-28");
  });
});

describe("mapper plus builder, end to end", () => {
  const config = { currency: "PLN", taxSymbol: "23" };

  it("produces a payload whose lines sum to the Medusa order total", () => {
    const order = medusaOrder();
    const result = buildInfaktInvoicePayload(
      toInvoiceOrderInput(order, "PLN"),
      toInvoiceBuyerInput(order, defaultNipExtractor),
      config,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.totalMinor).toBe(13_344);
      expect(result.payload.services).toHaveLength(3);
      expect(result.isCompany).toBe(false);
    }
  });

  it("produces a company payload for an order carrying a NIP", () => {
    const order = medusaOrder({
      billing_address: {
        address_1: "Rynek 5",
        city: "Krakow",
        company: "ACME Sp. z o.o.",
        postal_code: "31-042",
      },
      metadata: { nip: VALID_NIP },
    });
    const result = buildInfaktInvoicePayload(
      toInvoiceOrderInput(order, "PLN"),
      toInvoiceBuyerInput(order, defaultNipExtractor),
      config,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.isCompany).toBe(true);
      expect(result.nip).toBe(VALID_NIP);
      expect(result.payload.client_business_activity_kind).toBe("other_business");
    }
  });

  it("issues an invoice for an order read exactly as the query layer returns it", () => {
    // The whole chain against real BigNumber amounts: the lines have to sum to
    // the order total in minor units, which is impossible if any one of them
    // reads as null and gets defaulted.
    const order = medusaOrder({
      items: [
        { product_title: "Program antywirusowy", quantity: 1, total: new BigNumber("61.73") },
        { product_title: "Pendrive", quantity: 2, total: new BigNumber("61.72") },
      ],
      shipping_methods: [{ name: "Paczkomat InPost", total: new BigNumber("9.99") }],
      total: new BigNumber("133.44"),
    });
    const result = buildInfaktInvoicePayload(
      toInvoiceOrderInput(order, "PLN"),
      toInvoiceBuyerInput(order, defaultNipExtractor),
      config,
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.totalMinor).toBe(13_344);
      expect(result.payload.services.map((service) => service.gross_price)).toEqual([
        6173, 6172, 999,
      ]);
    }
  });

  it("fails the total-match guard when Medusa reports a discount we did not model", () => {
    const order = medusaOrder({ total: 100 });
    const result = buildInfaktInvoicePayload(
      toInvoiceOrderInput(order, "PLN"),
      toInvoiceBuyerInput(order, defaultNipExtractor),
      config,
    );
    expect(result).toMatchObject({ ok: false, reason: expect.stringContaining("does not match") });
  });
});
