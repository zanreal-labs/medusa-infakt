import type { MedusaResponse } from "@medusajs/framework/http";
import { vi } from "vitest";

/**
 * A `MedusaResponse` double for route unit tests.
 *
 * `status()` returns the same object so the `res.status(409).json(...)` chain the
 * refusal path uses works, and both calls stay assertable.
 */
export const mockResponse = () => {
  const res = { json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  return res as unknown as MedusaResponse & {
    json: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  };
};
