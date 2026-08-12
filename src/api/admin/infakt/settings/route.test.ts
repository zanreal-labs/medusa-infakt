import type { MedusaRequest } from "@medusajs/framework/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockResponse } from "../__tests__/mock-response";
import { GET, POST } from "./route";

// Hoisted so the static import of ./route below picks up the mock. The workflow
// (and its compensation) has its own test file; here it is the boundary.
const { run } = vi.hoisted(() => ({ run: vi.fn() }));
vi.mock("../../../../workflows/set-invoicing-paused", () => ({
  setInvoicingPausedWorkflow: () => ({ run }),
}));

const enablement = (overrides: Record<string, unknown> = {}) => ({
  apiKeyConfigured: true,
  effectiveEnabled: true,
  envForceDisabled: false,
  invoicingPaused: false,
  reason: "active",
  ...overrides,
});

const service = (overrides: Record<string, unknown> = {}) => ({
  getEffectiveEnablement: vi.fn().mockResolvedValue(enablement()),
  ...overrides,
});

const request = (svc: unknown, body: Record<string, unknown> = {}): MedusaRequest =>
  ({
    body,
    params: {},
    query: {},
    scope: { resolve: vi.fn().mockReturnValue(svc) },
  }) as unknown as MedusaRequest;

beforeEach(() => {
  run.mockReset();
  run.mockResolvedValue({ result: { invoicingPaused: false } });
});

describe("GET /admin/infakt/settings", () => {
  it("never throws - it reports the current state, in every state", async () => {
    const res = mockResponse();
    await GET(request(service()), res);
    expect(res.json).toHaveBeenCalledWith({
      api_key_configured: true,
      effective_enabled: true,
      env_force_disabled: false,
      invoicing_paused: false,
      reason: "active",
    });
  });

  it("reports disabled/paused/env-forced states with the same 200 shape", async () => {
    const svc = service({
      getEffectiveEnablement: vi.fn().mockResolvedValue(
        enablement({
          apiKeyConfigured: false,
          effectiveEnabled: false,
          invoicingPaused: true,
          reason: "no_api_key",
        }),
      ),
    });
    const res = mockResponse();
    await GET(request(svc), res);
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ effective_enabled: false, reason: "no_api_key" }),
    );
  });
});

describe("POST /admin/infakt/settings", () => {
  it("requires invoicing_paused as a boolean", async () => {
    await expect(POST(request(service(), {}), mockResponse())).rejects.toThrow(
      /`invoicing_paused` is required and must be a boolean/u,
    );
    await expect(
      POST(request(service(), { invoicing_paused: "true" }), mockResponse()),
    ).rejects.toThrow(/must be a boolean/u);
    expect(run).not.toHaveBeenCalled();
  });

  it("writes the pause switch through the workflow and returns the resulting state", async () => {
    const svc = service({
      getEffectiveEnablement: vi
        .fn()
        .mockResolvedValue(
          enablement({ effectiveEnabled: false, invoicingPaused: true, reason: "paused" }),
        ),
    });
    const res = mockResponse();
    await POST(request(svc, { invoicing_paused: true }), res);
    expect(run).toHaveBeenCalledWith({ input: { invoicingPaused: true } });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        effective_enabled: false,
        invoicing_paused: true,
        reason: "paused",
      }),
    );
  });

  it("still answers 200 when the environment force-off means the write has no effect yet", async () => {
    const svc = service({
      getEffectiveEnablement: vi.fn().mockResolvedValue(
        enablement({
          effectiveEnabled: false,
          envForceDisabled: true,
          invoicingPaused: false,
          reason: "env_force_disabled",
        }),
      ),
    });
    const res = mockResponse();
    await POST(request(svc, { invoicing_paused: false }), res);
    expect(run).toHaveBeenCalledWith({ input: { invoicingPaused: false } });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ effective_enabled: false, reason: "env_force_disabled" }),
    );
  });
});
