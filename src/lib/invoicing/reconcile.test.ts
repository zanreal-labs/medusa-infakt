import { BigNumber } from "@medusajs/framework/utils";
import { describe, expect, it } from "vitest";
import { defaultNipExtractor } from "./nip";
import type { MatchInvoiceCandidate } from "./matching";
import {
  dateOffsetDays,
  DEFAULT_DATE_TOLERANCE_DAYS,
  filterByDateWindow,
  gradeConfidence,
  invoiceIsCompany,
  MAX_DATE_TOLERANCE_DAYS,
  orderInvoicesBySequence,
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
  orderDate: "2026-08-10T11:05:00.000Z",
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
      source: "infakt-reconcile",
      tie_breaker: "none",
    });
    // The whole point of "signals, not values": no buyer data reaches the ledger.
    expect(JSON.stringify(entry.evidence)).not.toContain("allegromail");
    expect(JSON.stringify(entry.evidence)).not.toContain("Kowalski");
  });

  it("says nothing about what the invoice calls its lines, at any strength", () => {
    // The signal the owner ruled out. An invoice issued with "Towar" where the
    // order says "Dysk SSD 1TB" is the same document, and there is now nothing on
    // a candidate for a name check to read.
    const [entry] = plan([order()], [invoice()]);
    expect(entry.reasons.join(" ")).not.toMatch(/position|item name|line/iu);
    expect(JSON.stringify(entry.evidence)).not.toContain("positions");
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

describe("amounts as Medusa actually returns them", () => {
  it("adopts an order whose total is a real BigNumber, as the query layer returns it", () => {
    // The case this was blind to: `order.total` is a BigNumber
    // INSTANCE, whose own keys are `numeric_`, `raw_` and `bignumber_` and which
    // carries no `value` key. Read as null and defaulted to 0, the order reported
    // "1 of those matched the buyer, 0 of those matched the gross total 0" - the
    // amount was the only gate it failed. Built from the installed Medusa
    // package rather than hand-written, because a literal cannot show this.
    const medusaOrder: MedusaOrderLike = {
      billing_address: { first_name: "Jan", last_name: "Kowalski" },
      created_at: "2026-08-10T11:05:00Z",
      currency_code: "pln",
      display_id: 112,
      email: "buyer-synthetic@allegromail.pl",
      id: "order_112",
      items: [{ product_title: "Dysk SSD 1TB", quantity: 1 }],
      total: new BigNumber("149.00"),
    };
    const mapped = toReconcileOrder(medusaOrder, defaultNipExtractor, "PLN");
    expect(mapped.grossTotal).toBe(14_900);

    const [entry] = plan([mapped], [invoice()]);
    expect(entry.decision).toBe("adopt");
    expect(entry.evidence?.gross_total_minor).toBe(14_900);
  });

  it("REFUSES to compare an unreadable total against zero", () => {
    // Null means "I could not read this", never "this order is worth nothing".
    // A zero here would sail through the amount gate against any zero-value
    // invoice, and read as a confident no-match against every other one.
    const mapped = toReconcileOrder(
      {
        created_at: "2026-08-10T11:05:00Z",
        email: "buyer-synthetic@allegromail.pl",
        id: "order_112",
        total: { not: "an amount" },
      } as MedusaOrderLike,
      defaultNipExtractor,
      "PLN",
    );
    expect(mapped.grossTotal).toBeNull();

    const [entry] = plan([mapped], [invoice({ grossPrice: 0 })]);
    expect(entry.decision).toBe("no_match");
    expect(entry.candidates).toEqual([]);
    expect(entry.reasons[0]).toContain("could not be read");
    expect(entry.reasons[0]).not.toContain("matched the gross total 0");
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
    expect(entries[0].reasons.join(" ")).toContain("refusing to guess");
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
    // Two orders on DIFFERENT days, so the chronological pairing does not apply and
    // each adopts the same document on its own. One invoice cannot settle both.
    const entries = rejectContestedInvoices(
      plan(
        [order(), order({ displayId: 113, orderDay: "2026-08-09", orderId: "order_113" })],
        [invoice()],
      ),
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

describe("the confidence grade, with names gone", () => {
  it("is high for an email or NIP match issued on or next to the order day", () => {
    expect(
      gradeConfidence({
        dateOffsetDays: 0,
        declaredByOrder: false,
        identity: "email",
        tieBreaker: "none",
      }).confidence,
    ).toBe("high");
    expect(
      gradeConfidence({
        dateOffsetDays: 1,
        declaredByOrder: false,
        identity: "nip",
        tieBreaker: "none",
      }).confidence,
    ).toBe("high");
  });

  it("is medium when only a full name says who the buyer is", () => {
    // "Jan Kowalski" is thousands of people. A same-day, same-amount coincidence
    // between two of them is exactly the near-miss a human catches.
    const grade = gradeConfidence({
      dateOffsetDays: 0,
      declaredByOrder: false,
      identity: "name",
      tieBreaker: "none",
    });
    expect(grade.confidence).toBe("medium");
    expect(grade.reason).toContain("full name");
  });

  it("is medium when the invoice was issued more than a day from the order", () => {
    expect(
      gradeConfidence({
        dateOffsetDays: -3,
        declaredByOrder: false,
        identity: "email",
        tieBreaker: "none",
      }).confidence,
    ).toBe("medium");
  });

  it("is medium whenever chronology settled it, however strong the rest is", () => {
    expect(
      gradeConfidence({
        dateOffsetDays: 0,
        declaredByOrder: false,
        identity: "nip",
        tieBreaker: "chronological",
      }).confidence,
    ).toBe("medium");
  });

  it("is high when the order names the invoice itself, whatever else is weak", () => {
    expect(
      gradeConfidence({
        dateOffsetDays: 6,
        declaredByOrder: true,
        identity: "name",
        tieBreaker: "none",
      }).confidence,
    ).toBe("high");
  });

  it("does not grade on how busy the date window was", () => {
    // Candidates that lost on identity or amount lost on a hard gate. Letting their
    // number darken the survivor would mark a busy week weaker than a quiet one.
    const noise = [
      invoice({ clientEmail: "other@example.com", clientFirstName: "Anna", clientLastName: "Nowak", uuid: "noise-1" }),
      invoice({ grossPrice: 9_900, uuid: "noise-2" }),
    ];
    const [entry] = plan([order()], [invoice(), ...noise]);
    expect(entry.decision).toBe("adopt");
    expect(entry.confidence).toBe("high");
    expect(entry.evidence?.candidates_in_window).toBe(3);
  });

  it("grades a name match, same day, one buyer match in the window", () => {
    // A name-only match landing on the invoice's own day: matched on the full name,
    // date offset 0, two invoices in the window of which one was this buyer's.
    const [entry] = plan(
      [order({ email: undefined })],
      [invoice({ clientEmail: undefined, number: "3/08/2031" }), invoice({ grossPrice: 1, uuid: "other" })],
    );
    expect(entry.decision).toBe("adopt");
    expect(entry.evidence?.identity).toBe("name");
    expect(entry.evidence?.date_offset_days).toBe(0);
    expect(entry.confidence).toBe("medium");
  });
});

describe("orderInvoicesBySequence", () => {
  const numbered = (...numbers: string[]) =>
    numbers.map((number, index) => invoice({ number, uuid: `uuid-${index}` }));

  const ordered = (...numbers: string[]) =>
    orderInvoicesBySequence(numbered(...numbers))?.map((candidate) => candidate.number);

  it("sorts inFakt's default numbering by its counter, numerically", () => {
    // String order would put "10/08/2031" before "3/08/2031".
    expect(ordered("10/08/2031", "3/08/2031")).toEqual(["3/08/2031", "10/08/2031"]);
  });

  it("finds the counter wherever it sits in the format", () => {
    expect(ordered("FV/2026/08/4", "FV/2026/08/3")).toEqual(["FV/2026/08/3", "FV/2026/08/4"]);
    expect(ordered("ZR-009010", "ZR-009009")).toEqual(["ZR-009009", "ZR-009010"]);
  });

  it("refuses two different numbering formats", () => {
    expect(orderInvoicesBySequence(numbered("ZR-009009", "3/08/2031"))).toBeNull();
  });

  it("refuses when more than one position varies, because none of them is THE counter", () => {
    expect(orderInvoicesBySequence(numbered("3/08/2031", "4/09/2031"))).toBeNull();
  });

  it("refuses a repeated counter, and a number with no digits at all", () => {
    expect(orderInvoicesBySequence(numbered("3/08/2031", "3/08/2031"))).toBeNull();
    expect(orderInvoicesBySequence(numbered("draft", "final"))).toBeNull();
  });

  it("refuses when a candidate has no number to read", () => {
    expect(
      orderInvoicesBySequence([invoice({ number: undefined }), invoice({ number: "4/08/2031", uuid: "u-2" })]),
    ).toBeNull();
  });
});

describe("duplicate orders in one day, paired by chronology", () => {
  /**
   * The owner's rule, verbatim: "kwota i kolejnosc zamowien (timestamp) jesli sa
   * powielone zamowienia w ciagu dnia". Money is built from a real Medusa
   * BigNumber, as the query layer returns it, never a hand-written literal.
   */
  const duplicates = (times: (string | null)[], amount = "149.00") =>
    times.map((created_at, index) =>
      toReconcileOrder(
        {
          billing_address: { first_name: "Jan", last_name: "Kowalski" },
          created_at,
          currency_code: "pln",
          display_id: 100 + index,
          email: "buyer-synthetic@allegromail.pl",
          id: `order_dup_${index + 1}`,
          total: new BigNumber(amount),
        } as MedusaOrderLike,
        defaultNipExtractor,
        "PLN",
      ),
    );

  const twins = (...numbers: string[]) =>
    numbers.map((number, index) =>
      invoice({ invoiceDate: ORDER_DAY, number, uuid: `twin-${index + 1}` }),
    );

  it("pairs the earlier order with the earlier invoice, and the later with the later", () => {
    const entries = plan(
      duplicates(["2026-08-10T09:12:00Z", "2026-08-10T14:30:00Z"]),
      twins("3/08/2031", "4/08/2031"),
    );
    expect(entries.map((entry) => entry.decision)).toEqual(["adopt", "adopt"]);
    expect(entries[0].invoice?.number).toBe("3/08/2031");
    expect(entries[1].invoice?.number).toBe("4/08/2031");
  });

  it("pairs on placement time, not on the order the caller happened to list them in", () => {
    const [later, earlier] = duplicates(["2026-08-10T14:30:00Z", "2026-08-10T09:12:00Z"]);
    const entries = plan([later, earlier], twins("3/08/2031", "4/08/2031"));
    expect(entries[0].invoice?.number).toBe("4/08/2031");
    expect(entries[1].invoice?.number).toBe("3/08/2031");
  });

  it("records the tie-break in the evidence and grades it medium", () => {
    const [first, second] = plan(
      duplicates(["2026-08-10T09:12:00Z", "2026-08-10T14:30:00Z"]),
      twins("3/08/2031", "4/08/2031"),
    );
    expect(first.confidence).toBe("medium");
    expect(first.evidence).toMatchObject({
      duplicate_count: 2,
      duplicate_index: 1,
      gross_total_minor: 14_900,
      tie_breaker: "chronological",
    });
    expect(second.evidence).toMatchObject({ duplicate_index: 2, tie_breaker: "chronological" });
    expect(first.reasons.join(" ")).toContain("Paired by chronology");
  });

  it("REFUSES all three when three duplicate orders face two identical invoices", () => {
    // Any two of the three could be the invoiced ones, so nothing is determined -
    // not even the first pair.
    const entries = plan(
      duplicates(["2026-08-10T09:12:00Z", "2026-08-10T14:30:00Z", "2026-08-10T19:05:00Z"]),
      twins("3/08/2031", "4/08/2031"),
    );
    expect(entries.map((entry) => entry.decision)).toEqual([
      "ambiguous",
      "ambiguous",
      "ambiguous",
    ]);
    for (const entry of entries) {
      expect(entry.reasons.at(-1)).toContain("The counts differ");
    }
  });

  it("REFUSES two duplicate orders that face a single invoice", () => {
    const entries = plan(duplicates(["2026-08-10T09:12:00Z", "2026-08-10T14:30:00Z"]), twins("3/08/2031"));
    expect(entries.map((entry) => entry.decision)).toEqual(["ambiguous", "ambiguous"]);
    expect(entries[0].reasons.at(-1)).toContain("The counts differ");
  });

  it("REFUSES a lone order facing two identical invoices, and says why", () => {
    const entries = plan(duplicates(["2026-08-10T09:12:00Z"]), twins("3/08/2031", "4/08/2031"));
    expect(entries[0].decision).toBe("ambiguous");
    expect(entries[0].reasons.at(-1)).toContain("Only one order from this buyer");
  });

  it("REFUSES when the invoices do not share one issue date", () => {
    // Different dates mean something other than chronology separates them, and
    // picking the nearest is exactly the guess this module does not make.
    const entries = plan(duplicates(["2026-08-10T09:12:00Z", "2026-08-10T14:30:00Z"]), [
      invoice({ invoiceDate: ORDER_DAY, number: "3/08/2031", uuid: "twin-1" }),
      invoice({ invoiceDate: "2026-08-11", number: "4/08/2031", uuid: "twin-2" }),
    ]);
    expect(entries.map((entry) => entry.decision)).toEqual(["ambiguous", "ambiguous"]);
    expect(entries[0].reasons.at(-1)).toContain("do NOT share one issue date");
  });

  it("REFUSES when the invoice numbers are not one readable sequence", () => {
    const entries = plan(
      duplicates(["2026-08-10T09:12:00Z", "2026-08-10T14:30:00Z"]),
      twins("ZR-009009", "3/08/2031"),
    );
    expect(entries.map((entry) => entry.decision)).toEqual(["ambiguous", "ambiguous"]);
    expect(entries[0].reasons.at(-1)).toContain("do not form one readable sequence");
  });

  it("REFUSES two duplicate orders placed at the very same instant", () => {
    const entries = plan(
      duplicates(["2026-08-10T09:12:00Z", "2026-08-10T09:12:00Z"]),
      twins("3/08/2031", "4/08/2031"),
    );
    expect(entries.map((entry) => entry.decision)).toEqual(["ambiguous", "ambiguous"]);
    expect(entries[0].reasons.at(-1)).toContain("cannot be put in order");
  });

  it("REFUSES when one of the duplicates carries no placement instant", () => {
    const [first, second] = duplicates(["2026-08-10T09:12:00Z", "2026-08-10T14:30:00Z"]);
    const entries = plan(
      [first, { ...second, orderDate: undefined }],
      twins("3/08/2031", "4/08/2031"),
    );
    expect(entries.map((entry) => entry.decision)).toEqual(["ambiguous", "ambiguous"]);
    expect(entries[0].reasons.at(-1)).toContain("cannot be put in order");
  });

  it("REFUSES when an order outside the group also matches one of the invoices", () => {
    // The day before, same buyer, same amount, inside the tolerance: pairing could
    // hand over a document that belongs to that order instead.
    const outsider = order({ orderDay: "2026-08-09", orderId: "order_outside" });
    const entries = plan(
      [...duplicates(["2026-08-10T09:12:00Z", "2026-08-10T14:30:00Z"]), outsider],
      twins("3/08/2031", "4/08/2031"),
    );
    expect(entries[0].decision).toBe("ambiguous");
    expect(entries[0].reasons.at(-1)).toContain("also matched by an order outside this group");
  });

  it("does not engage at all when the amounts tell the orders apart", () => {
    const [first] = duplicates(["2026-08-10T09:12:00Z"]);
    const [second] = duplicates(["2026-08-10T14:30:00Z"], "99.00");
    const entries = plan([first, { ...second, orderId: "order_dup_2" }], [
      invoice({ invoiceDate: ORDER_DAY, number: "3/08/2031", uuid: "twin-1" }),
      invoice({ grossPrice: 9_900, invoiceDate: ORDER_DAY, number: "4/08/2031", uuid: "twin-2" }),
    ]);
    expect(entries.map((entry) => entry.decision)).toEqual(["adopt", "adopt"]);
    expect(entries.map((entry) => entry.evidence?.tie_breaker)).toEqual(["none", "none"]);
    expect(entries[0].confidence).toBe("high");
  });

  it("leaves an order that names its own invoice out of the pairing", () => {
    const [first, second] = duplicates(["2026-08-10T09:12:00Z", "2026-08-10T14:30:00Z"]);
    const entries = plan(
      [{ ...first, declaredInvoiceNumber: "4/08/2031" }, second],
      twins("3/08/2031", "4/08/2031"),
    );
    expect(entries[0].decision).toBe("adopt");
    expect(entries[0].invoice?.number).toBe("4/08/2031");
    expect(entries[0].evidence?.tie_breaker).toBe("none");
    expect(entries[1].decision).toBe("ambiguous");
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
      orderDate: "2026-08-10T11:05:00.000Z",
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

  it("carries no line item names into the rules at all", () => {
    const mapped = toReconcileOrder(medusaOrder(), defaultNipExtractor, "PLN");
    expect(JSON.stringify(mapped)).not.toContain("Dysk SSD");
  });

  it("leaves the placement instant unset when the order has no readable one", () => {
    // Never defaulted to "now": that would sort an undated order into a
    // chronological pairing it has no business being part of.
    for (const created_at of [null, "not a timestamp"]) {
      expect(
        toReconcileOrder(medusaOrder({ created_at }), defaultNipExtractor, "PLN").orderDate,
      ).toBeUndefined();
    }
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
