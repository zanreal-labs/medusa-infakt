import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { INFAKT_MODULE } from "../../../../modules/infakt";
import type InfaktModuleService from "../../../../modules/infakt/service";
import { setInvoicingPausedWorkflow } from "../../../../workflows/set-invoicing-paused";

interface SettingsPayload {
  invoicing_paused: boolean;
  env_force_disabled: boolean;
  api_key_configured: boolean;
  effective_enabled: boolean;
  reason: string;
}

const toPayload = (enablement: {
  invoicingPaused: boolean;
  envForceDisabled: boolean;
  apiKeyConfigured: boolean;
  effectiveEnabled: boolean;
  reason: string;
}): SettingsPayload => ({
  api_key_configured: enablement.apiKeyConfigured,
  effective_enabled: enablement.effectiveEnabled,
  env_force_disabled: enablement.envForceDisabled,
  invoicing_paused: enablement.invoicingPaused,
  reason: enablement.reason,
});

/**
 * GET /admin/infakt/settings
 *
 * The live picture behind the plugin's runtime enable switch: whether `apiKey`
 * is configured, whether an admin has paused invoicing, and whether the
 * environment has force-disabled it - plus the one answer that folds all three
 * together. Never touches `apiClient`, so it is safe to call in every state,
 * including fully disabled.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);
  const enablement = await infakt.getEffectiveEnablement();
  res.json(toPayload(enablement));
}

/**
 * POST /admin/infakt/settings  { "invoicing_paused": boolean }
 *
 * The only way to flip the admin-editable pause switch. Deliberately narrow:
 * this route writes exactly one field, and does not accept a way to clear
 * `INFAKT_INVOICING_DISABLED` - that switch lives in the environment on purpose,
 * so it cannot be released from inside the admin.
 *
 * Always answers 200 with the resulting state, even when the environment force-
 * off means the toggle just written has no effect yet - the response's
 * `effective_enabled` and `reason` say so, rather than the caller having to
 * infer it from a second request.
 *
 * The write itself goes through a workflow, not a direct service call, so it is
 * compensable: a failure anywhere downstream restores the previous value rather
 * than leaving the switch in whatever state a partial attempt left it.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);
  const body = (req.body ?? {}) as { invoicing_paused?: unknown };

  if (typeof body.invoicing_paused !== "boolean") {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "`invoicing_paused` is required and must be a boolean.",
    );
  }

  await setInvoicingPausedWorkflow(req.scope).run({
    input: { invoicingPaused: body.invoicing_paused },
  });
  const enablement = await infakt.getEffectiveEnablement();
  res.json(toPayload(enablement));
}
