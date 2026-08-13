import { describe, expect, it } from "vitest";
import {
  classifyFromConfirmed,
  classifyOrder,
  filterByIdentity,
  filterByTotal,
  normalizeEmail,
  normalizeItemName,
  normalizeName,
  normalizeTaxId,
  positionsOverlap,
  totalsMatch,
} from "./matching";
import type { MatchInvoiceCandidate, MatchOrderInput } from "./matching";

const consumerOrder = (overrides: Partial<MatchOrderInput> = {}): MatchOrderInput => ({
  currency: "PLN",
  email: "jan@example.com",
  fullName: "Jan Kowalski",
  grossTotal: 13_344,
  isCompany: false,
  items: [
    { name: "Program antywirusowy", quantity: 1 },
    { name: "Pendrive 64GB", quantity: 2 },
  ],
  orderId: "order_1",
  ...overrides,
});

const companyOrder = (overrides: Partial<MatchOrderInput> = {}): MatchOrderInput =>
  consumerOrder({
    email: undefined,
    fullName: undefined,
    isCompany: true,
    taxId: "5261040828",
    ...overrides,
  });

const candidate = (overrides: Partial<MatchInvoiceCandidate> = {}): MatchInvoiceCandidate => ({
  clientEmail: "jan@example.com",
  clientFirstName: "Jan",
  clientLastName: "Kowalski",
  currency: "PLN",
  grossPrice: 13_344,
  number: "1/07/2026",
  services: [
    { name: "Program antywirusowy", quantity: 1 },
    { name: "Pendrive 64GB", quantity: 2 },
  ],
  uuid: "u-1",
  ...overrides,
});

describe("normalization", () => {
  it("reduces a tax id to bare digits with no leading zeros", () => {
    expect(normalizeTaxId("PL 526-104-08-28")).toBe("5261040828");
    expect(normalizeTaxId("0005261040828")).toBe("5261040828");
    expect(normalizeTaxId("abc")).toBe("");
  });

  it("lowercases and trims an email", () => {
    expect(normalizeEmail("  JAN@Example.COM ")).toBe("jan@example.com");
  });

  it("strips Polish diacritics, including the non-decomposing L", () => {
    expect(normalizeName("Łukasz Żółć")).toBe("lukasz zolc");
    expect(normalizeName("  Jan   Kowalski  ")).toBe("jan kowalski");
  });

  it("strips punctuation from an item name but keeps letters and digits", () => {
    expect(normalizeItemName("Pendrive 64GB (USB-C)")).toBe("pendrive 64gb usb c");
    expect(normalizeItemName("!!!")).toBe("");
  });
});

describe("stage 1: identity", () => {
  it("matches a company order on its NIP, in any format", () => {
    const matches = filterByIdentity(companyOrder(), [
      candidate({ clientTaxCode: "526-104-08-28" }),
    ]);
    expect(matches).toHaveLength(1);
  });

  it("rejects a company order against a different NIP", () => {
    expect(filterByIdentity(companyOrder(), [candidate({ clientTaxCode: "1111111111" })])).toEqual(
      [],
    );
  });

  it("rejects a company order against a candidate with no NIP at all", () => {
    expect(filterByIdentity(companyOrder(), [candidate({ clientTaxCode: undefined })])).toEqual([]);
  });

  it("rejects a company order that itself carries no NIP", () => {
    expect(
      filterByIdentity(companyOrder({ taxId: undefined }), [
        candidate({ clientTaxCode: "5261040828" }),
      ]),
    ).toEqual([]);
  });

  it("never matches a company order on email or name", () => {
    // A company invoice is identified by its tax code. Matching a B2B order to an
    // invoice on the buyer's personal email would attach a KSeF-filed document to
    // the wrong entity.
    expect(
      filterByIdentity(companyOrder(), [
        candidate({ clientEmail: "jan@example.com", clientTaxCode: undefined }),
      ]),
    ).toEqual([]);
  });

  it("matches a consumer order on email", () => {
    expect(
      filterByIdentity(consumerOrder({ fullName: undefined }), [
        candidate({ clientEmail: "JAN@EXAMPLE.COM", clientFirstName: undefined }),
      ]),
    ).toHaveLength(1);
  });

  it("matches a consumer order on full name when the email differs", () => {
    expect(
      filterByIdentity(consumerOrder(), [candidate({ clientEmail: "other@example.com" })]),
    ).toHaveLength(1);
  });

  it("matches a consumer name across diacritic spellings", () => {
    expect(
      filterByIdentity(consumerOrder({ email: undefined, fullName: "Łukasz Nowak" }), [
        candidate({
          clientEmail: undefined,
          clientFirstName: "Lukasz",
          clientLastName: "Nowak",
        }),
      ]),
    ).toHaveLength(1);
  });

  it("rejects a consumer order with neither email nor name to compare", () => {
    expect(
      filterByIdentity(consumerOrder({ email: undefined, fullName: undefined }), [candidate()]),
    ).toEqual([]);
  });
});

describe("stage 2: gross total", () => {
  it("requires exact integer equality", () => {
    expect(totalsMatch(consumerOrder(), candidate({ grossPrice: 13_344 }))).toBe(true);
    expect(totalsMatch(consumerOrder(), candidate({ grossPrice: 13_345 }))).toBe(false);
    expect(totalsMatch(consumerOrder(), candidate({ grossPrice: undefined }))).toBe(false);
  });

  it("rejects a currency mismatch when both sides state one", () => {
    expect(totalsMatch(consumerOrder(), candidate({ currency: "EUR" }))).toBe(false);
  });

  it("matches nothing when the order's total could not be read", () => {
    // Null is "unknown", not "zero". A zero-priced invoice must not clear the
    // amount gate for an order whose amount nobody managed to read.
    expect(totalsMatch(consumerOrder({ grossTotal: null }), candidate({ grossPrice: 0 }))).toBe(
      false,
    );
    expect(
      filterByTotal(consumerOrder({ grossTotal: null }), [candidate(), candidate({ grossPrice: 0, uuid: "u-2" })]),
    ).toHaveLength(0);
  });

  it("does not reject when either side omits its currency", () => {
    expect(totalsMatch(consumerOrder({ currency: undefined }), candidate())).toBe(true);
    expect(totalsMatch(consumerOrder(), candidate({ currency: undefined }))).toBe(true);
  });

  it("filters a candidate list", () => {
    expect(
      filterByTotal(consumerOrder(), [candidate(), candidate({ grossPrice: 1, uuid: "u-2" })]),
    ).toHaveLength(1);
  });
});

describe("stage 3: line positions", () => {
  it("confirms a candidate whose positions cover every order item", () => {
    expect(positionsOverlap(consumerOrder(), candidate())).toBe(true);
  });

  it("is order-independent", () => {
    expect(
      positionsOverlap(
        consumerOrder(),
        candidate({
          services: [
            { name: "Pendrive 64GB", quantity: 2 },
            { name: "Program antywirusowy", quantity: 1 },
          ],
        }),
      ),
    ).toBe(true);
  });

  it("accepts a position name that contains the order item name", () => {
    expect(
      positionsOverlap(consumerOrder({ items: [{ name: "Pendrive", quantity: 2 }] }), candidate()),
    ).toBe(true);
  });

  it("rejects a quantity mismatch", () => {
    expect(
      positionsOverlap(
        consumerOrder(),
        candidate({
          services: [
            { name: "Program antywirusowy", quantity: 1 },
            { name: "Pendrive 64GB", quantity: 3 },
          ],
        }),
      ),
    ).toBe(false);
  });

  it("requires EVERY order item to be covered, not most of them", () => {
    expect(
      positionsOverlap(
        consumerOrder(),
        candidate({ services: [{ name: "Program antywirusowy", quantity: 1 }] }),
      ),
    ).toBe(false);
  });

  it("consumes each position at most once", () => {
    // Two identical order lines need two positions, not one matched twice.
    expect(
      positionsOverlap(
        consumerOrder({
          items: [
            { name: "Pendrive", quantity: 1 },
            { name: "Pendrive", quantity: 1 },
          ],
        }),
        candidate({ services: [{ name: "Pendrive", quantity: 1 }] }),
      ),
    ).toBe(false);
  });

  it("reports no overlap for an un-fetched candidate with no positions", () => {
    // This is what stops a list-only candidate from passing stage 3 by omission.
    expect(positionsOverlap(consumerOrder(), candidate({ services: [] }))).toBe(false);
  });

  it("reports no overlap for an order with no items", () => {
    expect(positionsOverlap(consumerOrder({ items: [] }), candidate())).toBe(false);
  });
});

describe("classifyOrder", () => {
  it("matches a unique survivor", () => {
    const result = classifyOrder(consumerOrder(), [candidate()]);
    expect(result.classification).toBe("matched");
    expect(result.invoice?.uuid).toBe("u-1");
    expect(result.confirmedCount).toBe(1);
    expect(result.identityCount).toBe(1);
  });

  it("reports no_match when nothing survives", () => {
    const result = classifyOrder(consumerOrder(), [
      candidate({ clientEmail: "nobody@example.com", clientFirstName: "Anna" }),
    ]);
    expect(result.classification).toBe("no_match");
    expect(result.invoice).toBeUndefined();
  });

  it("reports no_match against an empty candidate list", () => {
    expect(classifyOrder(consumerOrder(), []).classification).toBe("no_match");
  });

  it("reports ambiguous, with no invoice, when two candidates survive", () => {
    const result = classifyOrder(consumerOrder(), [
      candidate(),
      candidate({ number: "2/07/2026", uuid: "u-2" }),
    ]);
    expect(result.classification).toBe("ambiguous");
    expect(result.invoice).toBeUndefined();
    expect(result.confirmedCount).toBe(2);
    expect(result.reasons.at(-1)).toContain("1/07/2026");
    expect(result.reasons.at(-1)).toContain("2/07/2026");
  });

  it("carries a reason line per stage", () => {
    const result = classifyOrder(companyOrder(), [candidate({ clientTaxCode: "5261040828" })]);
    expect(result.reasons[0]).toContain("NIP match");
    expect(result.reasons[1]).toContain("Gross total");
    expect(result.reasons[2]).toContain("Line positions confirmed");
  });

  it("names the buyer-match stage for a consumer order", () => {
    expect(classifyOrder(consumerOrder(), [candidate()]).reasons[0]).toContain(
      "Buyer match (email/name)",
    );
  });
});

describe("classifyOrder: the date tiebreak", () => {
  const twin = (uuid: string, invoiceDate?: string) =>
    candidate({ invoiceDate, number: uuid, uuid });

  it("breaks a two-way tie by the nearest invoice date", () => {
    const result = classifyOrder(consumerOrder({ orderDate: "2026-07-14T21:30:00Z" }), [
      twin("u-far", "2026-08-30"),
      twin("u-near", "2026-07-15"),
    ]);
    expect(result.classification).toBe("matched");
    expect(result.invoice?.uuid).toBe("u-near");
    expect(result.reasons.at(-1)).toContain("nearest to the order date 2026-07-14");
  });

  it("stays ambiguous when two candidates share the nearest calendar day", () => {
    const result = classifyOrder(consumerOrder({ orderDate: "2026-07-14T21:30:00Z" }), [
      twin("u-a", "2026-07-15"),
      twin("u-b", "2026-07-15"),
    ]);
    expect(result.classification).toBe("ambiguous");
  });

  it("stays ambiguous when the two are equidistant on either side", () => {
    const result = classifyOrder(consumerOrder({ orderDate: "2026-07-15T12:00:00Z" }), [
      twin("u-before", "2026-07-14"),
      twin("u-after", "2026-07-16"),
    ]);
    expect(result.classification).toBe("ambiguous");
  });

  it("is not affected by the order's time of day", () => {
    // Day-precision comparison: an order at 00:01 and one at 23:59 on the same day
    // must resolve identically, or the tiebreak is an artifact of the clock.
    for (const time of ["T00:01:00Z", "T23:59:00Z"]) {
      const result = classifyOrder(consumerOrder({ orderDate: `2026-07-15${time}` }), [
        twin("u-near", "2026-07-15"),
        twin("u-far", "2026-07-20"),
      ]);
      expect(result.invoice?.uuid).toBe("u-near");
    }
  });

  it("stays ambiguous when the order has no date", () => {
    const result = classifyOrder(consumerOrder({ orderDate: undefined }), [
      twin("u-a", "2026-07-15"),
      twin("u-b", "2026-08-30"),
    ]);
    expect(result.classification).toBe("ambiguous");
  });

  it("stays ambiguous when any candidate has no invoice date", () => {
    const result = classifyOrder(consumerOrder({ orderDate: "2026-07-14T21:30:00Z" }), [
      twin("u-a", "2026-07-15"),
      twin("u-b"),
    ]);
    expect(result.classification).toBe("ambiguous");
  });

  it("stays ambiguous when a candidate's date is unparseable", () => {
    const result = classifyOrder(consumerOrder({ orderDate: "2026-07-14T21:30:00Z" }), [
      twin("u-a", "2026-07-15"),
      twin("u-b", "not a date"),
    ]);
    expect(result.classification).toBe("ambiguous");
  });

  it("stays ambiguous when the order's own date is unparseable", () => {
    const result = classifyOrder(consumerOrder({ orderDate: "nonsense!!" }), [
      twin("u-a", "2026-07-15"),
      twin("u-b", "2026-08-30"),
    ]);
    expect(result.classification).toBe("ambiguous");
  });

  it("never rescues a candidate that failed an earlier stage", () => {
    // The tiebreak only ever narrows an already-confirmed set. A wrong-total
    // invoice dated the same day as the order must not win it.
    const result = classifyOrder(consumerOrder({ orderDate: "2026-07-15T10:00:00Z" }), [
      candidate({ grossPrice: 999, invoiceDate: "2026-07-15", uuid: "u-wrong-total" }),
    ]);
    expect(result.classification).toBe("no_match");
  });
});

describe("classifyFromConfirmed", () => {
  it("is what the production two-phase caller uses, with the same rule", () => {
    const order = { orderDate: "2026-07-14T21:30:00Z", orderId: "order_1" };
    expect(classifyFromConfirmed(order, 3, 2, [candidate()]).classification).toBe("matched");
    expect(classifyFromConfirmed(order, 3, 2, []).classification).toBe("no_match");
    expect(
      classifyFromConfirmed(order, 3, 2, [candidate(), candidate({ uuid: "u-2" })]).classification,
    ).toBe("ambiguous");
  });

  it("reports the stage counts it was handed", () => {
    const result = classifyFromConfirmed({ orderId: "order_1" }, 7, 3, [candidate()]);
    expect(result.identityCount).toBe(7);
    expect(result.reasons[0]).toContain("7 invoice(s) matched by identity, 3 of those");
  });
});
