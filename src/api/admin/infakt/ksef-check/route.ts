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
 *
 * Guarded on `enabled` (whether `apiKey` is configured) before anything else:
 * there is no inFakt account to check without one, and letting `apiClient` throw
 * into this handler would turn a benign "nothing to check" into a 500 on the
 * admin page. This is independent of the pause switch - a store mid-cutover with
 * invoicing paused can still verify KSeF health ahead of turning it on.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);

  if (!infakt.resolvedOptions.enabled) {
    res.json({
      active: false,
      checked_at: new Date().toISOString(),
      error:
        "the plugin is disabled (no `apiKey` configured) - there is no KSeF integration to check",
    });
    return;
  }

  const integration = await infakt.verifyKsefIntegration();
  res.json({
    active: integration.active,
    checked_at: new Date().toISOString(),
    error: "error" in integration ? integration.error : undefined,
  });
}
