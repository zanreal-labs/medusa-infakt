import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { INFAKT_MODULE } from "../../../../modules/infakt";
import type InfaktModuleService from "../../../../modules/infakt/service";

/**
 * POST /admin/infakt/ksef-check
 *
 * Re-verify the inFakt account's KSeF integration now, rather than waiting for the
 * worker's hourly check.
 *
 * This is what an operator reaches for straight after fixing the integration in
 * inFakt: without it, a store whose invoicing is refusing to run stays refusing for
 * up to an hour with nothing to show that the fix landed.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);
  const integration = await infakt.verifyKsefIntegration();
  res.json({
    active: integration.active,
    checked_at: new Date().toISOString(),
    error: "error" in integration ? integration.error : undefined,
  });
}
