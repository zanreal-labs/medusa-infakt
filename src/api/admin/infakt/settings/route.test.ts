import type { MedusaRequest } from "@medusajs/framework/http";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockResponse } from "../__tests__/mock-response";
import { GET, POST } from "./route";

// Hoisted so the static import of ./route below picks up the mock. Each
// workflow (and its compensation) has its own test file; here they are the
// boundary.
const { pauseRun, configRun } = vi.hoisted(() => ({ configRun: vi.fn(), pauseRun: vi.fn() }));
vi.mock("../../../../workflows/set-invoicing-paused", () => ({
  setInvoicingPausedWorkflow: () => ({ run: pauseRun }),
}));
vi.mock("../../../../workflows/update-infakt-config", () => ({
  updateInfaktConfigWorkflow: () => ({ run: configRun }),
}));

const enablement = (overrides: Record<string, unknown> = {}) => ({
  apiKeyConfigured: true,
  effectiveEnabled: true,
  envForceDisabled: false,
  invoicingPaused: false,
  reason: "active",
  ...overrides,
});

const NO_OVERRIDES = {
  api_key_ciphertext: null,
  currency: null,
  environment: null,
  ksef_mode: null,
  trigger_event: null,
};

/** `NO_OVERRIDES` minus the ciphertext column, which the GET payload never carries. */
const NO_OVERRIDES_VIEW = {
  currency: null,
  environment: null,
  ksef_mode: null,
  trigger_event: null,
};

const EFFECTIVE = {
  currency: "PLN",
  environment: "production",
  ksefMode: "nip-only",
  triggerEvent: "payment.captured",
};

const service = (overrides: Record<string, unknown> = {}) => ({
  getConfigOverrides: vi.fn().mockResolvedValue(NO_OVERRIDES),
  getEffectiveEnablement: vi.fn().mockResolvedValue(enablement()),
  getEffectiveOptions: vi.fn().mockResolvedValue(EFFECTIVE),
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
  pauseRun.mockReset();
  configRun.mockReset();
  pauseRun.mockResolvedValue({ result: { invoicingPaused: false } });
  configRun.mockResolvedValue({ result: { applied: true } });
});

describe("GET /admin/infakt/settings", () => {
  it("never throws - it reports the current state, in every state", async () => {
    const res = mockResponse();
    await GET(request(service()), res);
    expect(res.json).toHaveBeenCalledWith({
      api_key_configured: true,
      api_key_override_configured: false,
      effective: {
        currency: "PLN",
        environment: "production",
        ksef_mode: "nip-only",
        trigger_event: "payment.captured",
      },
      effective_enabled: true,
      env_force_disabled: false,
      invoicing_paused: false,
      reason: "active",
      settings: NO_OVERRIDES_VIEW,
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

  it("surfaces a saved override in settings, distinct from the effective value", async () => {
    const svc = service({
      getConfigOverrides: vi.fn().mockResolvedValue({ ...NO_OVERRIDES, currency: "EUR" }),
      getEffectiveOptions: vi.fn().mockResolvedValue({ ...EFFECTIVE, currency: "EUR" }),
    });
    const res = mockResponse();
    await GET(request(svc), res);
    const payload = res.json.mock.calls[0][0];
    expect(payload.settings.currency).toBe("EUR");
    expect(payload.effective.currency).toBe("EUR");
  });

  it("never exposes the api key, encrypted or otherwise - only whether an override is set", async () => {
    const svc = service({
      getConfigOverrides: vi
        .fn()
        .mockResolvedValue({ ...NO_OVERRIDES, api_key_ciphertext: "iv.tag.ciphertext" }),
    });
    const res = mockResponse();
    await GET(request(svc), res);
    const payload = res.json.mock.calls[0][0];
    expect(JSON.stringify(payload)).not.toContain("ciphertext");
    expect(payload.api_key_override_configured).toBe(true);
  });
});

describe("POST /admin/infakt/settings", () => {
  it("requires at least one recognized field", async () => {
    await expect(POST(request(service(), {}), mockResponse())).rejects.toThrow(/at least one of/u);
    expect(pauseRun).not.toHaveBeenCalled();
    expect(configRun).not.toHaveBeenCalled();
  });

  it("rejects a non-boolean invoicing_paused", async () => {
    await expect(
      POST(request(service(), { invoicing_paused: "true" }), mockResponse()),
    ).rejects.toThrow(/must be a boolean/u);
    expect(pauseRun).not.toHaveBeenCalled();
  });

  it("writes the pause switch through its workflow and returns the resulting state", async () => {
    const svc = service({
      getEffectiveEnablement: vi
        .fn()
        .mockResolvedValue(
          enablement({ effectiveEnabled: false, invoicingPaused: true, reason: "paused" }),
        ),
    });
    const res = mockResponse();
    await POST(request(svc, { invoicing_paused: true }), res);
    expect(pauseRun).toHaveBeenCalledWith({ input: { invoicingPaused: true } });
    expect(configRun).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({
        effective_enabled: false,
        invoicing_paused: true,
        reason: "paused",
      }),
    );
  });

  it("writes currency, ksef_mode, trigger_event and environment through the config workflow", async () => {
    const res = mockResponse();
    await POST(
      request(service(), {
        currency: "EUR",
        environment: "sandbox",
        ksef_mode: "all",
        trigger_event: "order.placed",
      }),
      res,
    );
    expect(configRun).toHaveBeenCalledWith({
      input: {
        currency: "EUR",
        environment: "sandbox",
        ksefMode: "all",
        triggerEvent: "order.placed",
      },
    });
    expect(pauseRun).not.toHaveBeenCalled();
  });

  it("writes the pause switch and a config field in one request, through both workflows", async () => {
    const res = mockResponse();
    await POST(request(service(), { currency: "EUR", invoicing_paused: true }), res);
    expect(pauseRun).toHaveBeenCalledWith({ input: { invoicingPaused: true } });
    expect(configRun).toHaveBeenCalledWith({ input: { currency: "EUR" } });
  });

  it("forwards a non-empty api_key as the apiKey field, unvalidated here (the workflow encrypts it)", async () => {
    const res = mockResponse();
    await POST(request(service(), { api_key: "admin-set-key" }), res);
    expect(configRun).toHaveBeenCalledWith({ input: { apiKey: "admin-set-key" } });
  });

  it("forwards an empty api_key too, so the config workflow can clear the override", async () => {
    const res = mockResponse();
    await POST(request(service(), { api_key: "" }), res);
    expect(configRun).toHaveBeenCalledWith({ input: { apiKey: "" } });
  });

  it("rejects a non-string value for any config field", async () => {
    await expect(POST(request(service(), { currency: 123 }), mockResponse())).rejects.toThrow(
      /`currency` must be a string/u,
    );
    expect(configRun).not.toHaveBeenCalled();
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
    expect(pauseRun).toHaveBeenCalledWith({ input: { invoicingPaused: false } });
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ effective_enabled: false, reason: "env_force_disabled" }),
    );
  });
});
