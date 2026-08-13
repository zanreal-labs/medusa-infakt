import { describe, expect, it } from "vitest";
import { defaultNipExtractor } from "./nip";
import type { MatchInvoiceCandidate } from "./matching";
import {
  applyPositionConfirmation,
  dateOffsetDays,
  DEFAULT_DATE_TOLERANCE_DAYS,
  filterByDateWindow,
  invoiceIsCompany,
  MAX_DATE_TOLERANCE_DAYS,
  planAdoptions,
  rejectAlreadyLinked,
  rejectContestedInvoices,
  resolveDateTolerance,
  summarizePlan,
  toReconcileOrder,
} from "./reconcile";
import type { ReconcileOrder } from "./reconcile";
import type { MedusaOrderLike } from "./order-mapper";

/**
 * The reconciliation's rules, in the shape the production case arrived in: an
 * Allegro order backfilled from a legacy export whose invoice number was lost,
 * whose invoice is nonetheless sitting in inFakt.
 */

const ORDER_DAY = "2026-08-10";

const order = (overrides: Partial<ReconcileOrder> = {}): ReconcileOrder => ({
  currency: "PLN",
  displayId: 112,
  email: "buyer-synthetic@allegromail.pl",
  fullName: "Jan Kowalski",
  grossTotal: 14_900,
  isCompany: false,
  items: [{ name: "Dysk SSD 1TB", quantity: 1 }],
  orderDay: ORDER_DAY,
  orderId: "order_112",
  ...overrides,
});

const invoice = (overrides: Partial<MatchInvoiceCandidate> = {}): MatchInvoiceCandidate => ({
  clientEmail: "buyer-synthetic@allegromail.pl",
  clientFirstName: "Jan",
  clientLastName: "Kowalski",
  currency: "PLN",
  grossPrice: 14_900,
  invoiceDate: ORDER_DAY,
  number: "ZR-009009",
  services: [{ name: "Dysk SSD 1TB", quantity: 1 }],
  uuid: "uuid-1",
  ...overrides,
});

const plan = (orders: ReconcileOrder[], invoices: MatchInvoiceCandidate[], toleranceDays = 7) =>
  planAdoptions(orders, invoices, { dateToleranceDays: toleranceDays });

describe("dateOffsetDays", () => {
  it("is the signed calendar-day distance", () => {
    expect(dateOffsetDays(ORDER_DAY, "2026-08-10")).toBe(0);
    expect(dateOffsetDays(ORDER_DAY, "2026-08-13")).toBe(3);
    expect(dateOffsetDays(ORDER_DAY, "2026-08-07")).toBe(-3);
  });

  it("refuses rather than defaulting to zero when a date is missing or unparseable", () => {
    expect(dateOffsetDays(ORDER_DAY, undefined)).toBeNull();
    expect(dateOffsetDays(ORDER_DAY, "not a date")).toBeNull();
  });
});

describe("the date window", () => {
  it("keeps invoices within the tolerance, either side", () => {
    const kept = filterByDateWindow(
      order(),
      [
        invoice({ invoiceDate: "2026-08-07", uuid: "a" }),
        invoice({ invoiceDate: "2026-08-13", uuid: "b" }),
      ],
      3,
    );
    expect(kept.map((candidate) => candidate.uuid)).toEqual(["a", "b"]);
  });

  it("drops invoices outside it", () => {
    expect(filterByDateWindow(order(), [invoice({ invoiceDate: "2026-08-14" })], 3)).toEqual([]);
  });

  it("drops an invoice with no date - an undated document cannot be placed in time", () => {
    expect(filterByDateWindow(order(), [invoice({ invoiceDate: undefined })], 3)).toEqual([]);
  });
});

describe("resolveDateTolerance", () => {
  it("defaults when unset or nonsense", () => {
    for (const value of [undefined, "", "abc", -1]) {
      expect(resolveDateTolerance(value)).toBe(DEFAULT_DATE_TOLERANCE_DAYS);
    }
  });

  it("caps what an operator may ask for", () => {
    expect(resolveDateTolerance(3)).toBe(3);
    expect(resolveDateTolerance(0)).toBe(0);
    expect(resolveDateTolerance(9999)).toBe(MAX_DATE_TOLERANCE_DAYS);
  });
});

describe("an unambiguous match", () => {
  it("adopts the one invoice that clears every gate", () => {
    const [entry] = plan([order()], [invoice()]);
    expect(entry.decision).toBe("adopt");
    expect(entry.invoice?.uuid).toBe("uuid-1");
    expect(entry.invoice?.number).toBe("ZR-009009");
    expect(entry.confidence).toBe("high");
  });

  it("records PII-free evidence an operator can audit later", () => {
    const [entry] = plan([order()], [invoice()]);
    expect(entry.evidence).toEqual({
      candidates_in_window: 1,
      confidence: "high",
      currency: "PLN",
      date_offset_days: 0,
      declared_by_order: false,
      gross_total_minor: 14_900,
      identity: "email",
      invoice_date: ORDER_DAY,
      invoice_number: "ZR-009009",
      invoice_uuid: "uuid-1",
      positions_confirmed: true,
      source: "infakt-reconcile",
    });
    // The whole point of "signals, not values": no buyer data reaches the ledger.
    expect(JSON.stringify(entry.evidence)).not.toContain("allegromail");
    expect(JSON.stringify(entry.evidence)).not.toContain("Kowalski");
  });

  it("is a medium-confidence match when the invoice names its lines differently", () => {
    const [entry] = plan([order()], [invoice({ services: [{ name: "Towar", quantity: 1 }] })]);
    expect(entry.decision).toBe("adopt");
    expect(entry.confidence).toBe("medium");
    expect(entry.evidence?.positions_confirmed).toBe(false);
    expect(entry.reasons.at(-1)).toContain("did NOT confirm");
  });

  it("matches a consumer on the name when the invoice carries no email", () => {
    const [entry] = plan([order()], [invoice({ clientEmail: undefined })]);
    expect(entry.decision).toBe("adopt");
    expect(entry.evidence?.identity).toBe("name");
  });

  it("matches a company on its NIP", () => {
    const [entry] = plan(
      [order({ isCompany: true, taxId: "526-104-08-28" })],
      [invoice({ clientEmail: undefined, clientTaxCode: "PL5261040828" })],
    );
    expect(entry.decision).toBe("adopt");
    expect(entry.evidence?.identity).toBe("nip");
  });
});

describe("an order that already names its invoice", () => {
  it("adopts only that invoice, and records that the order named it", () => {
    const [entry] = plan([order({ declaredInvoiceNumber: "ZR-009009" })], [invoice()]);
    expect(entry.decision).toBe("adopt");
    expect(entry.evidence?.declared_by_order).toBe(true);
    expect(entry.reasons[1]).toContain("that is the one that matched");
  });

  it("REFUSES a different document, however well it fits", () => {
    // An order that names an invoice and matches another one by amount and buyer is
    // a warning, not a discovery.
    const [entry] = plan(
      [order({ declaredInvoiceNumber: "ZR-000001" })],
      [invoice({ number: "ZR-009009" })],
    );
    expect(entry.decision).toBe("no_match");
    expect(entry.reasons[1]).toContain("refusing rather than adopting a different document");
  });

  it("uses the invoice number the order carries in its metadata", () => {
    const mapped = toReconcileOrder(
      {
        created_at: "2026-08-10T11:05:00Z",
        id: "order_112",
        metadata: { invoice_number: " ZR-009009 " },
      },
      defaultNipExtractor,
      "PLN",
    );
    expect(mapped.declaredInvoiceNumber).toBe("ZR-009009");
  });

  it("ignores metadata that is not a usable invoice number", () => {
    for (const invoice_number of [null, 7, "   ", undefined]) {
      const mapped = toReconcileOrder(
        { created_at: "2026-08-10T11:05:00Z", id: "order_112", metadata: { invoice_number } },
        defaultNipExtractor,
        "PLN",
      );
      expect(mapped.declaredInvoiceNumber).toBeUndefined();
    }
  });
});

describe("what it refuses", () => {
  it("REFUSES an ambiguous multi-candidate case rather than guessing", () => {
    const entries = plan(
      [order()],
      [
        invoice({ number: "ZR-009009", uuid: "uuid-1" }),
        invoice({ invoiceDate: "2026-08-11", number: "ZR-009010", uuid: "uuid-2" }),
      ],
    );
    expect(entries[0].decision).toBe("ambiguous");
    expect(entries[0].invoice).toBeUndefined();
    expect(entries[0].evidence).toBeUndefined();
    expect(entries[0].candidates.map((candidate) => candidate.uuid)).toEqual(["uuid-1", "uuid-2"]);
    expect(entries[0].reasons.at(-1)).toContain("refusing to guess");
  });

  it("does NOT break an ambiguity by nearest date, even when one is nearer", () => {
    // `matching.ts` has a date tiebreak for the crash-window flow, where a human is
    // already looking at the order. Nobody is watching here.
    const entries = plan(
      [order()],
      [invoice({ uuid: "same-day" }), invoice({ invoiceDate: "2026-08-12", uuid: "later" })],
    );
    expect(entries[0].decision).toBe("ambiguous");
  });

  it("refuses a total that is off by a single grosz", () => {
    expect(plan([order()], [invoice({ grossPrice: 20_599 })])[0].decision).toBe("no_match");
  });

  it("refuses a currency mismatch", () => {
    expect(plan([order()], [invoice({ currency: "EUR" })])[0].decision).toBe("no_match");
  });

  it("refuses a different buyer, however well the amount and date fit", () => {
    expect(
      plan(
        [order()],
        [
          invoice({
            clientEmail: "someone.else@example.com",
            clientFirstName: "Anna",
            clientLastName: "Nowak",
          }),
        ],
      )[0].decision,
    ).toBe("no_match");
  });

  it("refuses a company whose NIP does not match", () => {
    expect(
      plan(
        [order({ isCompany: true, taxId: "5261040828" })],
        [invoice({ clientTaxCode: "1111111111" })],
      )[0].decision,
    ).toBe("no_match");
  });

  it("refuses an invoice dated outside the window", () => {
    expect(plan([order()], [invoice({ invoiceDate: "2026-09-30" })])[0].decision).toBe("no_match");
  });
});

describe("one invoice, one order", () => {
  it("refuses both orders when the same invoice matches two of them", () => {
    const entries = rejectContestedInvoices(
      plan([order(), order({ orderId: "order_113", displayId: 113 })], [invoice()]),
    );
    expect(entries.map((entry) => entry.decision)).toEqual(["ambiguous", "ambiguous"]);
    expect(entries[0].reasons.at(-1)).toContain("only settle one order");
    expect(entries[0].invoice).toBeUndefined();
  });

  it("refuses an invoice already recorded on another row, by uuid", () => {
    const entries = rejectAlreadyLinked(plan([order()], [invoice()]), { uuids: ["uuid-1"] });
    expect(entries[0].decision).toBe("ambiguous");
    expect(entries[0].reasons.at(-1)).toContain("already recorded");
  });

  it("refuses an invoice already recorded on another row, by number alone", () => {
    // The legacy import that produced this ledger recorded numbers, not uuids.
    const entries = rejectAlreadyLinked(plan([order()], [invoice()]), { numbers: ["ZR-009009"] });
    expect(entries[0].decision).toBe("ambiguous");
  });

  it("leaves an untaken invoice alone", () => {
    const entries = rejectAlreadyLinked(plan([order()], [invoice()]), {
      numbers: ["ZR-000001"],
      uuids: ["uuid-other"],
    });
    expect(entries[0].decision).toBe("adopt");
  });
});

describe("applyPositionConfirmation", () => {
  const medium = () => plan([order()], [invoice({ services: [] })])[0];

  it("upgrades a list-only match once the detail response confirms the lines", () => {
    expect(medium().confidence).toBe("medium");
    const upgraded = applyPositionConfirmation(medium(), order(), [
      { name: "Dysk SSD 1TB", quantity: 1 },
    ]);
    expect(upgraded.confidence).toBe("high");
    expect(upgraded.evidence?.positions_confirmed).toBe(true);
    expect(upgraded.reasons.at(-1)).toContain("cover every order item");
  });

  it("leaves the entry as it was when the lines still do not confirm", () => {
    const unchanged = applyPositionConfirmation(medium(), order(), [
      { name: "Something else", quantity: 4 },
    ]);
    expect(unchanged.confidence).toBe("medium");
  });

  it("never touches a refusal", () => {
    const ambiguous = plan([order()], [invoice({ uuid: "a" }), invoice({ uuid: "b" })])[0];
    expect(applyPositionConfirmation(ambiguous, order(), [])).toBe(ambiguous);
  });
});

describe("summarizePlan", () => {
  it("counts each decision", () => {
    const entries = plan(
      [order(), order({ orderId: "order_113" }), order({ grossTotal: 1, orderId: "order_47" })],
      [invoice()],
    );
    expect(summarizePlan(entries)).toEqual({
      adopt: 0,
      ambiguous: 2,
      no_match: 1,
      scanned: 3,
    });
  });
});

describe("toReconcileOrder", () => {
  const medusaOrder = (overrides: Partial<MedusaOrderLike> = {}): MedusaOrderLike => ({
    billing_address: { first_name: "Jan", last_name: "Kowalski" },
    created_at: "2026-08-10T11:05:00Z",
    currency_code: "pln",
    display_id: 112,
    email: "buyer-synthetic@allegromail.pl",
    id: "order_112",
    items: [{ product_title: "Dysk SSD 1TB", quantity: 1 }],
    total: 149,
    ...overrides,
  });

  it("reduces an order to the facts the rules read", () => {
    expect(toReconcileOrder(medusaOrder(), defaultNipExtractor, "PLN")).toMatchObject({
      currency: "PLN",
      displayId: 112,
      email: "buyer-synthetic@allegromail.pl",
      fullName: "Jan Kowalski",
      grossTotal: 14_900,
      isCompany: false,
      items: [{ name: "Dysk SSD 1TB", quantity: 1 }],
      orderDay: "2026-08-10",
      orderId: "order_112",
    });
  });

  it("uses the Warsaw calendar day, which is the day the invoice would be dated", () => {
    // 23:30 UTC is already the next day in Poland, and the invoice would say so.
    const mapped = toReconcileOrder(
      medusaOrder({ created_at: "2026-08-10T23:30:00Z" }),
      defaultNipExtractor,
      "PLN",
    );
    expect(mapped.orderDay).toBe("2026-08-11");
  });

  it("reads a NIP through the configured extractor", () => {
    const mapped = toReconcileOrder(
      medusaOrder({ metadata: { nip: "5261040828" } }),
      defaultNipExtractor,
      "PLN",
    );
    expect(mapped).toMatchObject({ isCompany: true, taxId: "5261040828" });
  });
});

describe("invoiceIsCompany", () => {
  it("reads the buyer type off the document, not the order", () => {
    expect(invoiceIsCompany("PL 526-104-08-28")).toEqual({ isCompany: true, nip: "5261040828" });
    expect(invoiceIsCompany(undefined)).toEqual({ isCompany: false });
    expect(invoiceIsCompany("")).toEqual({ isCompany: false });
  });

  it("does not treat an unusable tax code as a NIP", () => {
    expect(invoiceIsCompany("123")).toEqual({ isCompany: false });
  });
});
