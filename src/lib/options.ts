import type { InfaktEnvironment } from "./infakt/types";
import type { KsefDecider, KsefMode } from "./invoicing/ksef";
import { ksefPossible, resolveRequireActive } from "./invoicing/ksef";
import { isCalendarDate } from "./invoicing/money";
import { defaultNipExtractor } from "./invoicing/nip";
import type { NipExtractorOrder } from "./invoicing/nip";

/**
 * Options accepted by the inFakt plugin.
 *
 * Everything comes from `medusa-config.ts`; Medusa hands the plugin's `options`
 * object to every module inside the plugin unchanged. Secrets belong in
 * environment variables that the config file reads - the plugin never reads
 * `process.env` for credentials itself, so a host project keeps a single place
 * where its secrets are wired.
 *
 * The one exception is the worker's cron schedule, which cannot be an option at
 * all. See `INFAKT_WORKER_CRON` in the README.
 */
export interface InfaktPluginOptions {
  /**
   * inFakt API key, sent as `X-inFakt-ApiKey`.
   *
   * This is the plugin's on/off switch. Leave it unset (or point it at an env
   * var that is not set) and the plugin boots inert: no order is ever enqueued
   * or invoiced, and the boot log says so once. Set it and the plugin is fully
   * active. There is no separate enable flag - unwiring the credential is the
   * supported way to turn this integration off.
   */
  apiKey?: string;
  /**
   * Which inFakt to talk to. Defaults to "production".
   *
   * Note that inFakt's sandbox has been unreliable; the README recommends
   * testing against a real trial account with `ksef.mode: "never"` instead.
   */
  environment?: InfaktEnvironment;
  /**
   * Optional floor on which orders this plugin invoices, as a strict
   * YYYY-MM-DD calendar date. Orders placed before it are skipped.
   *
   * Leave it unset to invoice every order the pipeline sees, subject to every
   * other gate (fully paid, right currency, not canceled). Set it when this
   * plugin is being installed onto a store that already has a back catalogue
   * it should not touch - orders placed before the date are skipped rather
   * than issued.
   *
   * When set, it must be exactly `YYYY-MM-DD` and a real calendar date. A
   * malformed value fails loudly at boot rather than being treated as absent:
   * a typo here must not silently turn into "invoice everything".
   */
  startDate?: string;
  /** Currency the plugin invoices in. Defaults to "PLN". Others are skipped. */
  currency?: string;
  /** inFakt VAT rate symbol for every line. Defaults to "23". */
  taxSymbol?: string;
  /**
   * Which event enqueues an order.
   *
   * Defaults to `payment.captured`, because Medusa has no `order.paid` event and
   * an invoice must state a payment that happened. `order.placed` is available
   * for stores that invoice on placement (e.g. invoice-terms B2B), and is safe
   * because the worker's fully-paid gate still holds the row until the money
   * arrives - the event only decides when the row is created.
   */
  triggerEvent?: "payment.captured" | "order.placed";
  ksef?: {
    /**
     * - `nip-only` (default): a buyer with a NIP is filed to KSeF, a consumer is
     *   not. This is what Polish law requires from April 2026.
     * - `all`: file every invoice, including consumer ones.
     * - `never`: file nothing. Development and testing ONLY - in production this
     *   is a decision to break a legal obligation.
     */
    mode?: KsefMode;
    /**
     * Verify at startup that the inFakt account's KSeF integration is active,
     * and fail loudly when it is not. Defaults to true in production, false in
     * sandbox.
     */
    requireActive?: boolean;
    /**
     * Custom per-invoice predicate. Overrides `mode` entirely when set,
     * including `never`. Return true to file this invoice to KSeF.
     */
    decide?: KsefDecider;
  };
  /**
   * Where to find the buyer's NIP on an order. Defaults to
   * `order.metadata.nip`, then `billing_address.metadata.nip`, then a NIP parsed
   * out of `billing_address.company`.
   *
   * Medusa core has no field for a business buyer's tax id, so every storefront
   * puts it somewhere different. Override this rather than reshaping your orders.
   */
  nipExtractor?: (order: NipExtractorOrder) => string | undefined;
  /**
   * Emit `infakt.invoice.issued` once an invoice is issued, so other plugins can
   * react (e.g. attach the PDF to a marketplace order). Defaults to true.
   */
  emitIssuedEvent?: boolean;
  /** Per-request timeout for inFakt calls, in ms. Defaults to 60_000. */
  timeoutMs?: number;
  /**
   * Key material for encrypting an admin-set `apiKey` override at rest.
   *
   * `currency`, `ksef.mode`, `triggerEvent`, `environment` and `apiKey` can all be
   * overridden live from the Settings page (see `InfaktSettings` and
   * `src/lib/invoicing/effective-config.ts`) without a redeploy. Every override
   * except `apiKey` is operational configuration, not a secret, so it is stored as
   * plain text. `apiKey` is different - it is the same credential this option
   * carries here - so an override is encrypted with this key before it is
   * persisted (AES-256-GCM, Node's built-in `crypto`, no new dependency).
   *
   * Leave it unset and the admin UI can still change every OTHER setting; it
   * refuses only the one action that would write a plaintext credential to the
   * database (`POST /admin/infakt/settings` with a non-empty `api_key`), with a
   * message naming this option. Read it from an env var, exactly like `apiKey`.
   */
  settingsEncryptionKey?: string;
}

/** Options after defaults and validation. Every field is present. */
export interface ResolvedInfaktOptions {
  /** Whether the plugin is active. False exactly when `apiKey` is absent or blank. */
  enabled: boolean;
  /** null when the plugin is disabled (no `apiKey` configured). */
  apiKey: string | null;
  environment: InfaktEnvironment;
  /** null when no floor was configured: every order the pipeline sees is invoiced. */
  startDate: string | null;
  currency: string;
  taxSymbol: string;
  triggerEvent: "payment.captured" | "order.placed";
  ksefMode: KsefMode;
  ksefRequireActive: boolean;
  ksefDecide?: KsefDecider;
  ksefPossible: boolean;
  nipExtractor: (order: NipExtractorOrder) => string | undefined;
  emitIssuedEvent: boolean;
  timeoutMs: number;
  /** null when unset: no admin-set `apiKey` override can be persisted. */
  settingsEncryptionKey: string | null;
}

/**
 * The subset of the resolved options that is safe to hand to a caller.
 *
 * `ResolvedInfaktOptions` carries `apiKey`, so any accessor returning it whole is
 * one `res.json()` away from publishing the plugin's only credential. Every field
 * here is already visible in the admin UI.
 */
export interface InfaktPublicOptions {
  environment: InfaktEnvironment;
  startDate: string | null;
  currency: string;
  taxSymbol: string;
  triggerEvent: string;
  ksefMode: KsefMode;
  ksefRequireActive: boolean;
  ksefCustomPredicate: boolean;
  emitIssuedEvent: boolean;
  /** True when the plugin is inert because no `apiKey` is configured. */
  disabled: boolean;
}

export const DEFAULT_CURRENCY = "PLN";
export const DEFAULT_TAX_SYMBOL = "23";
export const DEFAULT_TIMEOUT_MS = 60_000;
/**
 * Exported so `src/lib/invoicing/effective-config.ts` validates an admin-set
 * override against the exact same list this boot-time check uses - there must be
 * one definition of "a valid `ksef.mode`", not two that can drift apart.
 */
export const VALID_KSEF_MODES: readonly KsefMode[] = ["nip-only", "all", "never"];
/** See the note on `VALID_KSEF_MODES` - shared with the admin-editable override. */
export const VALID_TRIGGERS = ["payment.captured", "order.placed"] as const;

export const toPublicInfaktOptions = (options: ResolvedInfaktOptions): InfaktPublicOptions => ({
  currency: options.currency,
  disabled: !options.enabled,
  emitIssuedEvent: options.emitIssuedEvent,
  environment: options.environment,
  ksefCustomPredicate: options.ksefDecide !== undefined,
  ksefMode: options.ksefMode,
  ksefRequireActive: options.ksefRequireActive,
  startDate: options.startDate,
  taxSymbol: options.taxSymbol,
  triggerEvent: options.triggerEvent,
});

const optionError = (message: string): Error =>
  new Error(`medusa-infakt: ${message} See https://github.com/zanreal-labs/medusa-infakt#options`);

/**
 * Validate and normalize the plugin options.
 *
 * Called from the module loader, so a misconfigured plugin fails at boot with a
 * precise message rather than at the first inFakt call in the middle of a
 * merchant's checkout. Every check here is one that would otherwise surface as an
 * opaque 401/422 from inFakt, or - worse - as an invoice that should not exist.
 *
 * `apiKey` is the deliberate exception to "fail at boot": an absent or blank
 * value resolves to `enabled: false` and disables the plugin instead of
 * throwing. The plugin should simply work when it is configured and do nothing
 * when it is not - a store that cannot boot because the credential was left
 * unset is a worse outcome than a store that boots with invoicing visibly off,
 * and both the loader log and the admin UI say so in as many words.
 *
 * `startDate`, once the arming switch this plugin used, is now an ordinary
 * optional setting: absent means "no date floor", and a value that is present
 * but not a strict `YYYY-MM-DD` calendar date still fails loudly, because a
 * typo there must not silently be read as "no floor".
 */
export const resolveInfaktOptions = (
  options?: Partial<InfaktPluginOptions>,
): ResolvedInfaktOptions => {
  if (!options) {
    throw optionError("no plugin options were provided; configure it in medusa-config.ts.");
  }

  const apiKeyRaw = typeof options.apiKey === "string" ? options.apiKey.trim() : "";
  const apiKey = apiKeyRaw ? apiKeyRaw : null;
  const enabled = apiKey !== null;

  const environment = options.environment ?? "production";
  if (environment !== "production" && environment !== "sandbox") {
    throw optionError(
      `plugin option \`environment\` must be "production" or "sandbox" (got "${String(environment)}").`,
    );
  }

  const currency = (options.currency ?? DEFAULT_CURRENCY).trim().toUpperCase();
  if (!/^[A-Z]{3}$/u.test(currency)) {
    throw optionError(
      `plugin option \`currency\` must be a 3-letter ISO code (got "${String(options.currency)}").`,
    );
  }

  const taxSymbol = (options.taxSymbol ?? DEFAULT_TAX_SYMBOL).toString().trim();
  if (!taxSymbol) {
    throw optionError("plugin option `taxSymbol` must not be blank.");
  }

  const triggerEvent = options.triggerEvent ?? "payment.captured";
  if (!(VALID_TRIGGERS as readonly string[]).includes(triggerEvent)) {
    throw optionError(
      `plugin option \`triggerEvent\` must be one of ${VALID_TRIGGERS.join(", ")} (got "${String(triggerEvent)}").`,
    );
  }

  const ksefMode = options.ksef?.mode ?? "nip-only";
  if (!VALID_KSEF_MODES.includes(ksefMode)) {
    throw optionError(
      `plugin option \`ksef.mode\` must be one of ${VALID_KSEF_MODES.join(", ")} (got "${String(ksefMode)}").`,
    );
  }

  const ksefDecide = options.ksef?.decide;
  if (ksefDecide !== undefined && typeof ksefDecide !== "function") {
    throw optionError("plugin option `ksef.decide` must be a function.");
  }

  // A boolean-looking string is the mistake this catches: `requireActive:
  // process.env.SOMETHING` yields "false", which a truthiness test honours as
  // TRUE - the operator would believe the startup check was off while it was on,
  // or vice versa. Both directions are bad here, so fail instead of coercing.
  if (
    options.ksef?.requireActive !== undefined &&
    typeof options.ksef.requireActive !== "boolean"
  ) {
    throw optionError(
      `plugin option \`ksef.requireActive\` must be a boolean (got ${typeof options.ksef.requireActive}).`,
    );
  }
  if (options.emitIssuedEvent !== undefined && typeof options.emitIssuedEvent !== "boolean") {
    throw optionError(
      `plugin option \`emitIssuedEvent\` must be a boolean (got ${typeof options.emitIssuedEvent}).`,
    );
  }

  const { nipExtractor } = options;
  if (nipExtractor !== undefined && typeof nipExtractor !== "function") {
    throw optionError("plugin option `nipExtractor` must be a function.");
  }

  // Blank and absent are the same "not configured" as every other optional string
  // option here - a key of `"   "` would otherwise derive from whitespace, which
  // is never what an operator meant.
  const settingsEncryptionKeyRaw =
    typeof options.settingsEncryptionKey === "string" ? options.settingsEncryptionKey.trim() : "";
  if (options.settingsEncryptionKey !== undefined && !settingsEncryptionKeyRaw) {
    throw optionError("plugin option `settingsEncryptionKey` must not be blank when provided.");
  }
  const settingsEncryptionKey = settingsEncryptionKeyRaw ? settingsEncryptionKeyRaw : null;

  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw optionError(
      `plugin option \`timeoutMs\` must be a positive number (got ${String(options.timeoutMs)}).`,
    );
  }

  // Blank and absent are the same thing here (mirroring how `apiKey` treats a
  // blank string as unset) - only a non-blank value is held to the strict
  // calendar-date format, and only a non-blank value that fails it throws.
  const startDateRaw = typeof options.startDate === "string" ? options.startDate.trim() : "";
  let startDate: string | null = null;
  if (startDateRaw) {
    if (!isCalendarDate(startDateRaw)) {
      throw optionError(
        `plugin option \`startDate\` must be a strict YYYY-MM-DD calendar date when set (got "${String(options.startDate)}"). Leave it unset entirely to invoice every order with no date floor.`,
      );
    }
    startDate = startDateRaw;
  }

  return {
    apiKey,
    currency,
    emitIssuedEvent: options.emitIssuedEvent ?? true,
    enabled,
    environment,
    ksefDecide,
    ksefMode,
    ksefPossible: ksefPossible(ksefMode, ksefDecide),
    ksefRequireActive: resolveRequireActive(options.ksef?.requireActive, environment),
    nipExtractor: nipExtractor ?? defaultNipExtractor,
    settingsEncryptionKey,
    startDate,
    taxSymbol,
    timeoutMs,
    triggerEvent,
  };
};
