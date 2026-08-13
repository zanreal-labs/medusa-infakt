import type { MedusaRequest } from "@medusajs/framework/http";
import { describe, expect, it, vi } from "vitest";
import { mockResponse } from "../__tests__/mock-response";
import { POST } from "./route";

const service = (overrides: Record<string, unknown> = {}) => ({
  getEffectiveOptions: vi.fn().mockResolvedValue({ enabled: true }),
  verifyKsefIntegration: vi.fn().mockResolvedValue({ active: true }),
  ...overrides,
});

const request = (svc: unknown): MedusaRequest =>
  ({
    body: {},
    params: {},
    query: {},
    scope: { resolve: vi.fn().mockReturnValue(svc) },
  }) as unknown as MedusaRequest;

describe("POST /admin/infakt/ksef-check", () => {
  it("checks the integration and reports it active", async () => {
    const res = mockResponse();
    await POST(request(service()), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ active: true, error: undefined }),
    );
  });

  it("surfaces a failed check's error without throwing", async () => {
    const svc = service({
      verifyKsefIntegration: vi.fn().mockResolvedValue({ active: false, error: "network down" }),
    });
    const res = mockResponse();
    await POST(request(svc), res);
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ active: false, error: "network down" }),
    );
  });

  it("never touches verifyKsefIntegration when the plugin is disabled, and answers 200", async () => {
    // The API client throws when disabled; verifyKsefIntegration happens to
    // swallow that, but this route guards up front rather than depending on that
    // incidentally.
    const verifyKsefIntegration = vi.fn();
    const svc = service({
      getEffectiveOptions: vi.fn().mockResolvedValue({ enabled: false }),
      verifyKsefIntegration,
    });
    const res = mockResponse();
    await POST(request(svc), res);
    expect(verifyKsefIntegration).not.toHaveBeenCalled();
    expect(res.status).not.toHaveBeenCalled();
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ active: false, error: expect.stringContaining("disabled") }),
    );
  });
});
