import type { MedusaRequest } from "@medusajs/framework/http";
import { describe, expect, it, vi } from "vitest";
import { resolveInfaktOptions } from "../../../../lib/options";
import { mockResponse } from "../__tests__/mock-response";
import { GET, POST } from "./route";

const ledgerRow = (overrides: Record<string, unknown> = {}) => ({
  adopted_at: null,
  created_at: new Date("2026-09-01T10:00:00.000Z"),
  id: "inv_01",
  invoice_number: "1/09/2026",
  invoice_uuid: "u-1",
  order_id: "order_01",
  settled_at: new Date("2026-09-02T00:00:00.000Z"),
  settlement_checked_at: new Date("2026-09-03T11:00:00.000Z"),
  settlement_drift: null,
  settlement_paid_minor: 12_345,
  status: "done",
  ...overrides,
});

const service = (rows: Record<string, unknown>[] = [], overrides: Record<string, unknown> = {}) => ({
  getEffectiveOptions: vi
    .fn()
    .mockResolvedValue(resolveInfaktOptions({ apiKey: "test-key", startDate: "2026-07-01" })),
  listSettlementLedger: vi.fn().mockResolvedValue(rows),
  ...overrides,
});

const request = (service: unknown, extra: Partial<MedusaRequest> = {}): MedusaRequest =>
  ({
    params: {},
    query: {},
    scope: { resolve: vi.fn().mockReturnValue(service) },
    ...extra,
  }) as unknown as MedusaRequest;

describe("GET /admin/infakt/settlement", () => {
  it("reports the ledger without calling inFakt at all", async () => {
    const infakt = service([ledgerRow()]);
    const res = mockResponse();
    await GET(request(infakt), res);

    const payload = res.json.mock.calls[0][0];
    expect(payload.refreshed).toBe(false);
    expect(payload.summary).toMatchObject({ agreed: 1, checked: 1, settled: 1 });
    expect(payload.entries[0]).toMatchObject({
      auto_fixable: false,
      drift: null,
      order_id: "order_01",
      paid_minor: 12_345,
    });
  });

  it("names the rows a future auto-fix would touch, and excludes adopted ones", async () => {
    const res = mockResponse();
    await GET(
      request(
        service([
          ledgerRow({ settled_at: null, settlement_drift: "unsettled" }),
          ledgerRow({
            adopted_at: new Date("2026-08-01"),
            id: "inv_02",
            order_id: "order_02",
            settled_at: null,
            settlement_drift: "unsettled",
          }),
        ]),
      ),
      res,
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.summary).toMatchObject({ adopted_drift: 1, auto_fixable: 1 });
    expect(payload.entries.map((entry: { auto_fixable: boolean }) => entry.auto_fixable)).toEqual([
      true,
      false,
    ]);
  });

  it("surfaces a reconciliation that has stopped running", async () => {
    // The failure mode this exists for: a ledger nobody has read since Tuesday
    // looks exactly like a settled one unless the AGE of the check is measured.
    const res = mockResponse();
    await GET(request(service([ledgerRow({ settlement_checked_at: null })])), res);
    expect(res.json.mock.calls[0][0].summary.never_checked).toBe(1);
  });

  it("defaults to the ninety-day window and takes a full pass on request", async () => {
    const infakt = service([]);
    await GET(request(infakt), mockResponse());
    expect(infakt.listSettlementLedger.mock.calls[0][0].createdAfter).toBeInstanceOf(Date);

    await GET(request(infakt, { query: { full: "true" } }), mockResponse());
    expect(infakt.listSettlementLedger.mock.calls[1][0].createdAfter).toBeNull();
  });

  it("refuses a nonsensical window rather than reading the whole ledger", async () => {
    await expect(
      GET(request(service(), { query: { days: "0" } }), mockResponse()),
    ).rejects.toThrow(/days/u);
    await expect(
      GET(request(service(), { query: { days: "99999" } }), mockResponse()),
    ).rejects.toThrow(/days/u);
  });

  it("answers 409 when the plugin has no apiKey", async () => {
    const disabled = { getEffectiveOptions: vi.fn().mockResolvedValue(resolveInfaktOptions({})) };
    const res = mockResponse();
    await GET(request(disabled), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe("POST /admin/infakt/settlement", () => {
  it("refuses `apply` outright rather than quietly reporting", async () => {
    // Auto-fixing does not exist in this version, and a caller who asked for it
    // must not be left believing a discrepancy was corrected.
    await expect(
      POST(request(service(), { body: { apply: true } }), mockResponse()),
    ).rejects.toThrow(/never corrects it/u);
  });
});
