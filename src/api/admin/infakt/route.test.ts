import type { MedusaRequest } from "@medusajs/framework/http";
import { describe, expect, it, vi } from "vitest";
import { INFAKT_MODULE } from "../../../modules/infakt";
import { mockResponse } from "./__tests__/mock-response";
import { GET } from "./route";

const request = (service: unknown, extra: Partial<MedusaRequest> = {}): MedusaRequest =>
  ({
    params: {},
    query: {},
    scope: { resolve: vi.fn().mockReturnValue(service) },
    ...extra,
  }) as unknown as MedusaRequest;

const service = (invoices: Record<string, unknown>[] = []) => ({
  getRunState: vi.fn().mockResolvedValue({
    id: "singleton",
    ksef_active: true,
    last_error: null,
    status: "ok",
  }),
  listInfaktInvoices: vi.fn().mockResolvedValue(invoices),
  publicOptions: {
    currency: "PLN",
    disabled: false,
    environment: "production",
    ksefMode: "nip-only",
    startDate: "2026-07-01",
  },
});

describe("GET /admin/infakt", () => {
  it("resolves the infakt module", async () => {
    const req = request(service());
    await GET(req, mockResponse());
    expect(req.scope.resolve).toHaveBeenCalledWith(INFAKT_MODULE);
  });

  it("returns the config, run state and per-status counts in one round trip", async () => {
    const res = mockResponse();
    await GET(
      request(
        service([
          { attempts: 0, id: "a", status: "done" },
          { attempts: 0, id: "b", status: "done" },
          { attempts: 1, id: "c", status: "needs_review" },
          { attempts: 0, id: "d", status: "pending" },
          { attempts: 0, id: "e", status: "skipped" },
        ]),
      ),
      res,
    );

    const payload = res.json.mock.calls[0][0];
    expect(payload.config).toMatchObject({ currency: "PLN", startDate: "2026-07-01" });
    expect(payload.run_state).toMatchObject({ ksef_active: true, status: "ok" });
    expect(payload.counts).toEqual({
      done: 2,
      needs_review: 1,
      pending: 1,
      processing: 0,
      skipped: 1,
    });
  });

  it("never returns the API key", async () => {
    const res = mockResponse();
    await GET(request(service()), res);
    expect(JSON.stringify(res.json.mock.calls[0][0])).not.toContain("apiKey");
  });

  it("counts the needs_review rows that are in the create crash window", async () => {
    // Reported separately because it is the one state an operator must not resolve
    // with a retry.
    const res = mockResponse();
    await GET(
      request(
        service([
          { attempts: 1, id: "a", status: "needs_review", submit_started_at: new Date() },
          { attempts: 1, id: "b", status: "needs_review", task_reference: "ref" },
          { attempts: 1, id: "c", status: "needs_review" },
        ]),
      ),
      res,
    );
    expect(res.json.mock.calls[0][0].crash_window_count).toBe(1);
  });

  it("ignores a status it does not know rather than crashing the page", async () => {
    const res = mockResponse();
    await GET(request(service([{ attempts: 0, id: "a", status: "something_new" }])), res);
    expect(res.json.mock.calls[0][0].counts.done).toBe(0);
  });

  it("answers 200 with a disabled, empty-counts payload when the plugin has no apiKey - never a 500", async () => {
    // This route touches only listInfaktInvoices, getRunState and publicOptions -
    // never apiClient - so a disabled plugin is exactly as safe to render as an
    // enabled one with zero rows.
    const disabled = {
      getRunState: vi.fn().mockResolvedValue({ id: "singleton", status: "idle" }),
      listInfaktInvoices: vi.fn().mockResolvedValue([]),
      publicOptions: {
        currency: "PLN",
        disabled: true,
        environment: "production",
        ksefMode: "nip-only",
        startDate: null,
      },
    };
    const res = mockResponse();
    await GET(request(disabled), res);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ disabled: true }),
        counts: { done: 0, needs_review: 0, pending: 0, processing: 0, skipped: 0 },
        crash_window_count: 0,
      }),
    );
  });
});
