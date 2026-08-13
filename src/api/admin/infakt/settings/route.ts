import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import type { InfaktConfigOverrides } from "../../../../lib/invoicing/effective-config";
import type { ResolvedInfaktOptions } from "../../../../lib/options";
import { INFAKT_MODULE } from "../../../../modules/infakt";
import type InfaktModuleService from "../../../../modules/infakt/service";
import { setInvoicingPausedWorkflow } from "../../../../workflows/set-invoicing-paused";
import { updateInfaktConfigWorkflow } from "../../../../workflows/update-infakt-config";
import type { UpdateInfaktConfigInput } from "../../../../workflows/update-infakt-config";

interface SettingsPayload {
  invoicing_paused: boolean;
  env_force_disabled: boolean;
  api_key_configured: boolean;
  /**
   * Whether an `apiKey` OVERRIDE specifically is saved - distinct from
   * `api_key_configured`, which is true from the boot `apiKey` alone. This is
   * what the Settings page uses to decide whether "clear override" makes sense
   * to show at all, and it is true even in the rare case where the override
   * cannot currently be decrypted (a rotated `settingsEncryptionKey`) - that
   * case still has something worth letting an operator clear.
   */
  api_key_override_configured: boolean;
  effective_enabled: boolean;
  reason: string;
  /**
   * The raw override, exactly as saved - null means "not overridden, following
   * `medusa-config.ts`". This is what the Settings page's form fields are seeded
   * from, since always seeding from `effective` would make the form claim an
   * override exists the moment the boot value happens to match it.
   */
  settings: {
    currency: string | null;
    ksef_mode: string | null;
    trigger_event: string | null;
    environment: string | null;
  };
  /** The merged, currently-in-effect value - what the worker and subscriber act on. */
  effective: {
    currency: string;
    ksef_mode: string;
    trigger_event: string;
    environment: string;
  };
}

const toPayload = (
  enablement: {
    invoicingPaused: boolean;
    envForceDisabled: boolean;
    apiKeyConfigured: boolean;
    effectiveEnabled: boolean;
    reason: string;
  },
  overrides: InfaktConfigOverrides,
  effectiveOptions: ResolvedInfaktOptions,
): SettingsPayload => ({
  api_key_configured: enablement.apiKeyConfigured,
  api_key_override_configured: overrides.api_key_ciphertext !== null,
  effective: {
    currency: effectiveOptions.currency,
    environment: effectiveOptions.environment,
    ksef_mode: effectiveOptions.ksefMode,
    trigger_event: effectiveOptions.triggerEvent,
  },
  effective_enabled: enablement.effectiveEnabled,
  env_force_disabled: enablement.envForceDisabled,
  invoicing_paused: enablement.invoicingPaused,
  reason: enablement.reason,
  settings: {
    currency: overrides.currency,
    environment: overrides.environment,
    ksef_mode: overrides.ksef_mode,
    trigger_event: overrides.trigger_event,
  },
});

const currentState = async (infakt: InfaktModuleService): Promise<SettingsPayload> => {
  const [enablement, overrides, effectiveOptions] = await Promise.all([
    infakt.getEffectiveEnablement(),
    infakt.getConfigOverrides(),
    infakt.getEffectiveOptions(),
  ]);
  return toPayload(enablement, overrides, effectiveOptions);
};

/**
 * GET /admin/infakt/settings
 *
 * Everything the Settings page's form needs in one round trip: the runtime
 * enable switch (`apiKey`, the pause switch, the environment force-off), the
 * raw override for every other admin-editable field, and the effective
 * (merged-with-boot) value each one currently resolves to. Never touches the
 * inFakt API client, so it is safe to call in every state, including fully
 * disabled.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);
  res.json(await currentState(infakt));
}

interface SettingsBody {
  invoicing_paused?: unknown;
  currency?: unknown;
  ksef_mode?: unknown;
  trigger_event?: unknown;
  environment?: unknown;
  /** Non-empty sets/replaces the override; `""` clears it. Never read back. */
  api_key?: unknown;
}

/**
 * POST /admin/infakt/settings
 *
 * Every field is optional, and only the ones present are written - a Save on the
 * currency input alone does not touch the pause switch, and vice versa. At least
 * one recognized field must be present, so a caller who mistyped every key gets a
 * clear 400 rather than a 200 that changed nothing.
 *
 * `invoicing_paused` still goes through `setInvoicingPausedWorkflow` exactly as
 * before - unchanged behavior, unchanged contract. Every other field goes
 * through `updateInfaktConfigWorkflow`, which validates, encrypts `api_key` when
 * given, and persists - both workflows are compensable, so a failure anywhere
 * downstream restores whatever this write changed rather than leaving the
 * configuration half-applied.
 *
 * Always answers 200 with the resulting state, even when the environment
 * force-off means a pause-switch write just made has no effect yet - the
 * response's `effective_enabled` and `reason` say so.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);
  const body = (req.body ?? {}) as SettingsBody;

  const hasPause = body.invoicing_paused !== undefined;
  const configPatch = readConfigPatch(body);
  const hasConfigPatch = Object.keys(configPatch).length > 0;

  if (!(hasPause || hasConfigPatch)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "at least one of `invoicing_paused`, `currency`, `ksef_mode`, `trigger_event`, " +
        "`environment` or `api_key` must be provided.",
    );
  }

  if (hasPause) {
    if (typeof body.invoicing_paused !== "boolean") {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        "`invoicing_paused` must be a boolean when provided.",
      );
    }
    await setInvoicingPausedWorkflow(req.scope).run({
      input: { invoicingPaused: body.invoicing_paused },
    });
  }

  if (hasConfigPatch) {
    await updateInfaktConfigWorkflow(req.scope).run({ input: configPatch });
  }

  res.json(await currentState(infakt));
}

/** Validate the shape of every present config field; leave absent ones out entirely. */
function readConfigPatch(body: SettingsBody): UpdateInfaktConfigInput {
  const patch: UpdateInfaktConfigInput = {};

  if (body.currency !== undefined) {
    patch.currency = requireString(body.currency, "currency");
  }
  if (body.ksef_mode !== undefined) {
    patch.ksefMode = requireString(body.ksef_mode, "ksef_mode");
  }
  if (body.trigger_event !== undefined) {
    patch.triggerEvent = requireString(body.trigger_event, "trigger_event");
  }
  if (body.environment !== undefined) {
    patch.environment = requireString(body.environment, "environment");
  }
  if (body.api_key !== undefined) {
    patch.apiKey = requireString(body.api_key, "api_key");
  }

  return patch;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new MedusaError(MedusaError.Types.INVALID_DATA, `\`${field}\` must be a string.`);
  }
  return value;
}
