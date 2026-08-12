import type { MedusaRequest } from "@medusajs/framework/http";
import { describe, expect, it, vi } from "vitest";
import { mockResponse } from "../__tests__/mock-response";
import { POST } from "./route";

const service = (overrides: Record<string, unknown> = {}) => ({
  enqueueOrder: vi.fn().mockResolvedValue({ created: true }),
  getEffectiveEnablement: vi.fn().mockResolvedValue({ effectiveEnabled: true, reason: "active" }),
  ...overrides,
});

const request = (svc: unknown, body: Record<string, unknown>): MedusaRequest =>
  ({
    body,
    params: {},
    query: {},
    scope: { resolve: vi.fn().mockReturnValue(svc) },
  }) as unknown as MedusaRequest;

describe("POST /admin/infakt/enqueue", () => {
  it("requires an order_id", async () => {
    await expect(POST(request(service(), {}), mockResponse())).rejects.toThrow(
      /`order_id` is required/u,
    );
  });

  it("queues the order when invoicing is effectively enabled", async () => {
    const svc = service();
    const res = mockResponse();
    await POST(request(svc, { order_id: "order_1" }), res);
    expect(svc.enqueueOrder).toHaveBeenCalledWith("order_1");
    expect(res.json).toHaveBeenCalledWith(
      expect.objectContaining({ created: true, order_id: "order_1" }),
    );
  });

  it("refuses when apiKey is not configured", async () => {
    const svc = service({
      getEffectiveEnablement: vi
        .fn()
        .mockResolvedValue({ effectiveEnabled: false, reason: "no_api_key" }),
    });
    await expect(POST(request(svc, { order_id: "order_1" }), mockResponse())).rejects.toThrow(
      /apiKey/u,
    );
    expect(svc.enqueueOrder).not.toHaveBeenCalled();
  });

  it("refuses when invoicing is paused", async () => {
    const svc = service({
      getEffectiveEnablement: vi
        .fn()
        .mockResolvedValue({ effectiveEnabled: false, reason: "paused" }),
    });
    await expect(POST(request(svc, { order_id: "order_1" }), mockResponse())).rejects.toThrow(
      /paused/u,
    );
    expect(svc.enqueueOrder).not.toHaveBeenCalled();
  });

  it("refuses when force-disabled by the environment", async () => {
    const svc = service({
      getEffectiveEnablement: vi
        .fn()
        .mockResolvedValue({ effectiveEnabled: false, reason: "env_force_disabled" }),
    });
    await expect(POST(request(svc, { order_id: "order_1" }), mockResponse())).rejects.toThrow(
      /INFAKT_INVOICING_DISABLED/u,
    );
    expect(svc.enqueueOrder).not.toHaveBeenCalled();
  });
});
