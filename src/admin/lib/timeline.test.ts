import { describe, expect, it } from "vitest";
import { buildInvoiceTimeline } from "./timeline";
import type { InfaktInvoiceRow } from "./types";

/**
 * A minimal, valid ledger row. Every test starts here and overrides only the
 * fields it is exercising, so the assertions read against a single known shape.
 */
const row = (overrides: Partial<InfaktInvoiceRow> = {}): InfaktInvoiceRow => ({
  attempts: 0,
  id: "inv_1",
  in_crash_window: false,
  is_company: true,
  order_id: "order_123",
  status: "done",
  ...overrides,
});

describe("buildInvoiceTimeline", () => {
  it("emits exactly one issuance entry keyed by the invoice number", () => {
    const entries = buildInvoiceTimeline(
      row({ completed_at: "2026-08-19T10:00:00.000Z", invoice_number: "FV/2026/08/1" }),
    );
    const issuance = entries.filter((entry) => entry.key === "FV/2026/08/1");
    expect(issuance).toHaveLength(1);
    expect(issuance[0].timestamp).toBe("2026-08-19T10:00:00.000Z");
    expect(issuance[0].title).toContain("FV/2026/08/1");
  });

  it("is idempotent: re-deriving the same row yields identical keys, so a Map collapses re-runs to one", () => {
    const persisted = row({ invoice_number: "FV/2026/08/2" });

    // Two independent derivations stand in for a sweep re-reading the same
    // persisted row, or a re-render / re-mount of the widget.
    const first = buildInvoiceTimeline(persisted);
    const second = buildInvoiceTimeline(persisted);

    expect(second.map((entry) => entry.key)).toEqual(first.map((entry) => entry.key));

    // The dedupe contract itself: keying both runs together collapses to one
    // entry per key, never a duplicate per re-run.
    const deduped = new Map([...first, ...second].map((entry) => [entry.key, entry]));
    expect(deduped.size).toBe(first.length);
  });

  it("keys the issuance by the uuid while the number is still pending", () => {
    // A `done` row with a uuid but no number yet - the issuance entry still
    // appears, keyed stably by the uuid.
    expect(buildInvoiceTimeline(row({ invoice_uuid: "uuid-9" }))[0].key).toBe("uuid-9");
  });

  it("keys a filed KSeF entry by the order id when no number is known", () => {
    // The last-resort key floor: filed on `ksef_status` alone, with neither a
    // KSeF number nor an invoice number to key by.
    const entries = buildInvoiceTimeline(
      row({ invoice_uuid: "uuid-9", ksef_required: true, ksef_status: "sent" }),
    );
    const ksef = entries.filter((entry) => entry.key.startsWith("ksef:"));
    expect(ksef).toHaveLength(1);
    expect(ksef[0].key).toBe("ksef:order_123");
  });

  it.each(["pending", "processing", "needs_review", "skipped"] as const)(
    "emits no issuance entry for a %s row",
    (status) => {
      // Even carrying an invoice number, a non-`done` row is not an issued invoice.
      const entries = buildInvoiceTimeline(row({ invoice_number: "FV/x", status }));
      expect(entries.some((entry) => !entry.key.startsWith("ksef:"))).toBe(false);
    },
  );

  it("emits no KSeF entry for a consumer invoice (ksef_required === false)", () => {
    const entries = buildInvoiceTimeline(
      row({ invoice_number: "FV/3", ksef_number: "KSEF-1", ksef_required: false }),
    );
    expect(entries.some((entry) => entry.key.startsWith("ksef:"))).toBe(false);
  });

  it("emits no KSeF entry for a row that never filed", () => {
    const notFiled = buildInvoiceTimeline(row({ invoice_number: "FV/4", ksef_required: true }));
    expect(notFiled.some((entry) => entry.key.startsWith("ksef:"))).toBe(false);

    // An errored filing is not a filing.
    const errored = buildInvoiceTimeline(
      row({ invoice_number: "FV/4", ksef_required: true, ksef_status: "error" }),
    );
    expect(errored.some((entry) => entry.key.startsWith("ksef:"))).toBe(false);
  });

  it("emits exactly one KSeF entry, keyed stably, for a filed row", () => {
    const entries = buildInvoiceTimeline(
      row({
        completed_at: "2026-08-19T10:00:00.000Z",
        invoice_number: "FV/5",
        ksef_number: "KSEF-77",
        ksef_required: true,
        ksef_sent_at: "2026-08-19T11:00:00.000Z",
      }),
    );
    const ksef = entries.filter((entry) => entry.key.startsWith("ksef:"));
    expect(ksef).toHaveLength(1);
    expect(ksef[0].key).toBe("ksef:KSEF-77");
    expect(ksef[0].timestamp).toBe("2026-08-19T11:00:00.000Z");
    expect(ksef[0].title).toContain("KSEF-77");
  });

  it("treats a 'sent' status with no number as a filing, keyed by the invoice number", () => {
    const entries = buildInvoiceTimeline(
      row({ invoice_number: "FV/6", ksef_required: true, ksef_status: "sent" }),
    );
    const ksef = entries.filter((entry) => entry.key.startsWith("ksef:"));
    expect(ksef).toHaveLength(1);
    expect(ksef[0].key).toBe("ksef:FV/6");
  });

  it("carries no buyer PII in any title or key", () => {
    // A fully populated, filed row - the richest output the function produces.
    const entries = buildInvoiceTimeline(
      row({
        completed_at: "2026-08-19T10:00:00.000Z",
        invoice_number: "FV/7",
        ksef_number: "KSEF-7",
        ksef_required: true,
        ksef_sent_at: "2026-08-19T11:00:00.000Z",
      }),
    );
    expect(entries).toHaveLength(2);
    const text = entries.flatMap((entry) => [entry.key, entry.title]).join(" ");
    // The output reads back only the safe invoice identifiers we fed in...
    for (const value of ["FV/7", "KSEF-7"]) {
      expect(text).toContain(value);
    }
    // ...and nothing that looks like buyer PII. The row shape has no name / email
    // / NIP field to leak in the first place; this guards against one being added.
    expect(text).not.toMatch(/@/);
    expect(text).not.toMatch(/\b\d{10}\b/);
  });
});
