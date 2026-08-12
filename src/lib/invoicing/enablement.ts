/**
 * The plugin's runtime enablement, folding together every source that can turn
 * invoicing off - not just the one fixed at boot.
 *
 * This is deliberately layered on top of, not merged into, `ResolvedInfaktOptions`.
 * `enabled` there (`apiKey` presence) is fixed for the process's lifetime, resolved
 * once when the module is constructed. The two other inputs here are NOT fixed:
 * `invoicingPaused` is an admin-editable database row and `envForceDisabled` is an
 * operator-controlled environment variable, and both have to be read fresh on
 * every subscriber invocation and every worker tick - baking either into
 * `ResolvedInfaktOptions` would mean a paused/unpaused toggle only took effect on
 * the next process restart.
 *
 * Precedence, from most to least authoritative:
 *
 *  1. `envForceDisabled` - an operator-controlled emergency brake that cannot be
 *     released from inside the admin UI. It overrides everything else, including
 *     an admin having already unpaused invoicing.
 *  2. `!apiKeyConfigured` - nothing to pause or resume without a credential.
 *  3. `invoicingPaused` - the admin-editable switch.
 *  4. Otherwise active.
 */

export type EnablementReason = "env_force_disabled" | "no_api_key" | "paused" | "active";

export interface EffectiveEnablement {
  effectiveEnabled: boolean;
  reason: EnablementReason;
  apiKeyConfigured: boolean;
  invoicingPaused: boolean;
  envForceDisabled: boolean;
}

/** Case-insensitive, mirrors how every other boolean-ish env flag in this codebase reads. */
const TRUTHY_ENV_VALUES = new Set(["1", "true", "yes"]);

/**
 * `INFAKT_INVOICING_DISABLED` as a hard, environment-level force-off.
 *
 * A plain environment variable rather than a plugin option, on purpose - mirroring
 * `INFAKT_WORKER_CRON`. An operator flips this during a deploy or a cutover
 * without touching `medusa-config.ts` or the database, and - critically - it
 * overrides a persisted `invoicingPaused: false` an admin already set through the
 * UI. It is the one switch that cannot be released from inside the admin.
 */
export function isInvoicingForceDisabledByEnv(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return TRUTHY_ENV_VALUES.has((env.INFAKT_INVOICING_DISABLED ?? "").trim().toLowerCase());
}

/** Combine the three enablement inputs into one answer, with one reason. */
export function resolveEffectiveEnablement(input: {
  apiKeyConfigured: boolean;
  invoicingPaused: boolean;
  envForceDisabled: boolean;
}): EffectiveEnablement {
  const { apiKeyConfigured, invoicingPaused, envForceDisabled } = input;
  const effectiveEnabled = apiKeyConfigured && !invoicingPaused && !envForceDisabled;

  let reason: EnablementReason;
  if (envForceDisabled) {
    reason = "env_force_disabled";
  } else if (!apiKeyConfigured) {
    reason = "no_api_key";
  } else if (invoicingPaused) {
    reason = "paused";
  } else {
    reason = "active";
  }

  return { apiKeyConfigured, effectiveEnabled, envForceDisabled, invoicingPaused, reason };
}
