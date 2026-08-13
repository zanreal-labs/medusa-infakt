import { decryptSecret } from "../crypto/secret-box";
import type { InfaktEnvironment } from "../infakt/types";
import { VALID_KSEF_MODES, VALID_TRIGGERS } from "../options";
import type { ResolvedInfaktOptions } from "../options";
import type { KsefMode } from "./ksef";
import { ksefPossible } from "./ksef";

/**
 * The admin-editable layer on top of `medusa-config.ts`.
 *
 * Every field here is nullable, and null means exactly one thing: "no operator has
 * changed this yet - keep using the boot-time plugin option." That is what makes
 * shipping this schema onto an existing install safe. A store upgrading to this
 * version of the plugin gets a settings row with every one of these columns null,
 * so `mergeEffectiveOptions` reproduces its current boot configuration exactly -
 * nothing about how it invoices changes until an operator opens the Settings page
 * and saves a field on purpose.
 *
 * `api_key_ciphertext` is the one column that is not the admin-facing value
 * directly - see `resolveEffectiveApiKey`.
 */
export interface InfaktConfigOverrides {
  currency: string | null;
  ksef_mode: KsefMode | null;
  trigger_event: "payment.captured" | "order.placed" | null;
  environment: InfaktEnvironment | null;
  api_key_ciphertext: string | null;
}

export const NO_CONFIG_OVERRIDES: InfaktConfigOverrides = {
  api_key_ciphertext: null,
  currency: null,
  environment: null,
  ksef_mode: null,
  trigger_event: null,
};

/** Same list `resolveInfaktOptions` validates `environment` against at boot. */
export const VALID_ENVIRONMENTS: readonly InfaktEnvironment[] = ["production", "sandbox"];

/**
 * Merge the persisted overrides on top of the boot-time resolved options.
 *
 * Every runtime decision point - the subscriber's trigger check, the worker's
 * currency/KSeF gates, the API client's key and base URL - should read the result
 * of this function (via `InfaktModuleService.getEffectiveOptions`), never
 * `boot` directly, so an admin edit takes effect on the very next tick rather than
 * requiring a restart.
 *
 * Derived fields are recomputed from the merged inputs rather than copied from
 * `boot`: `ksefPossible` depends on `ksefMode`, and `enabled` depends on `apiKey`,
 * both of which an override can change. `ksefRequireActive` is deliberately NOT
 * recomputed from an `environment` override - it is not one of the fields this
 * plugin exposes as admin-editable, so it always reflects the boot configuration.
 */
export function mergeEffectiveOptions(
  boot: ResolvedInfaktOptions,
  overrides: InfaktConfigOverrides,
): ResolvedInfaktOptions {
  const currency = overrides.currency ?? boot.currency;
  const ksefMode = overrides.ksef_mode ?? boot.ksefMode;
  const triggerEvent = overrides.trigger_event ?? boot.triggerEvent;
  const environment = overrides.environment ?? boot.environment;
  const apiKey = resolveEffectiveApiKey(boot, overrides);

  return {
    ...boot,
    apiKey,
    currency,
    enabled: apiKey !== null,
    environment,
    ksefMode,
    ksefPossible: ksefPossible(ksefMode, boot.ksefDecide),
    triggerEvent,
  };
}

/**
 * Decrypt the persisted `apiKey` override, when there is one to decrypt.
 *
 * Every failure mode here - no override set, no `settingsEncryptionKey`
 * configured, a wrong or rotated key, a corrupt payload - falls back to the
 * boot-time `apiKey` rather than throwing. This function runs at every worker
 * tick and every subscriber invocation, so it must never be the reason invoicing
 * stops; `InfaktModuleService.getConfigOverrides` is where an operator can see
 * that an override exists at all (`api_key_configured`), which is the place a
 * mismatch between "override is set" and "override cannot be read" is meant to
 * surface.
 */
function resolveEffectiveApiKey(
  boot: ResolvedInfaktOptions,
  overrides: InfaktConfigOverrides,
): string | null {
  if (!(overrides.api_key_ciphertext && boot.settingsEncryptionKey)) {
    return boot.apiKey;
  }
  try {
    const decrypted = decryptSecret(
      overrides.api_key_ciphertext,
      boot.settingsEncryptionKey,
    ).trim();
    return decrypted ? decrypted : boot.apiKey;
  } catch {
    return boot.apiKey;
  }
}

const validationError = (message: string): Error => new Error(`medusa-infakt: ${message}`);

/** Normalize and validate a currency override the same way `resolveInfaktOptions` does. */
export function validateCurrencyOverride(value: string): string {
  const normalized = value.trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(normalized)) {
    throw validationError(`\`currency\` must be a 3-letter ISO code (got "${value}").`);
  }
  return normalized;
}

export function validateKsefModeOverride(value: string): KsefMode {
  if (!(VALID_KSEF_MODES as readonly string[]).includes(value)) {
    throw validationError(
      `\`ksef_mode\` must be one of ${VALID_KSEF_MODES.join(", ")} (got "${value}").`,
    );
  }
  return value as KsefMode;
}

export function validateTriggerEventOverride(value: string): "payment.captured" | "order.placed" {
  if (!(VALID_TRIGGERS as readonly string[]).includes(value)) {
    throw validationError(
      `\`trigger_event\` must be one of ${VALID_TRIGGERS.join(", ")} (got "${value}").`,
    );
  }
  return value as "payment.captured" | "order.placed";
}

export function validateEnvironmentOverride(value: string): InfaktEnvironment {
  if (!(VALID_ENVIRONMENTS as readonly string[]).includes(value)) {
    throw validationError(
      `\`environment\` must be one of ${VALID_ENVIRONMENTS.join(", ")} (got "${value}").`,
    );
  }
  return value as InfaktEnvironment;
}
