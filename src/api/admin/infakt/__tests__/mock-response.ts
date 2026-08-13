import type { MedusaResponse } from "@medusajs/framework/http";
import { vi } from "vitest";

/**
 * A `MedusaResponse` double for route unit tests.
 *
 * `status()` returns the same object so the `res.status(409).json(...)` chain the
 * refusal path uses works, and both calls stay assertable. `setHeader` and `send`
 * are here for the binary routes (the PDF fetch) - `send` also returns the same
 * object, matching Express, so `res.status(200).send(buffer)` chains too.
 */
export const mockResponse = () => {
  const res = { json: vi.fn(), send: vi.fn(), setHeader: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  res.send.mockReturnValue(res);
  return res as unknown as MedusaResponse & {
    json: ReturnType<typeof vi.fn>;
    send: ReturnType<typeof vi.fn>;
    setHeader: ReturnType<typeof vi.fn>;
    status: ReturnType<typeof vi.fn>;
  };
};
