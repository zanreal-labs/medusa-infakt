import { model } from "@medusajs/framework/utils";

/**
 * Single-row runtime switch for invoicing, independent of `medusa-config.ts`.
 *
 * It exists because `apiKey` being present is not, on its own, a safe signal to
 * start invoicing. A store cutting over from a legacy invoicing system has
 * `apiKey` configured from day one - that credential has to be there for the
 * admin UI and the KSeF health check to work at all - but invoicing must stay off
 * until an operator deliberately turns it on. A config-file edit and a redeploy
 * is too slow, and too easy to forget, for a decision that matters this much;
 * this row is what makes it a live toggle in the admin instead.
 *
 * `invoicing_paused` defaults to true so a fresh install that already has
 * `apiKey` configured does not start issuing invoices the moment it boots. See
 * `InfaktModuleService.getSettings`, which mints this singleton on first access.
 *
 * ## The override columns
 *
 * `currency`, `ksef_mode`, `trigger_event`, `environment` and `api_key_ciphertext`
 * are every other setting the Settings page can change without a redeploy. Each
 * is nullable, and null means "not overridden - use the `medusa-config.ts` plugin
 * option instead" (see `mergeEffectiveOptions` in
 * `src/lib/invoicing/effective-config.ts`). That is deliberate: shipping this
 * column set onto an install that predates it leaves every row null, which
 * reproduces the exact configuration that install already had. Nothing about how
 * an existing store invoices changes until an operator opens the Settings page and
 * saves a field.
 *
 * `api_key_ciphertext` is not the admin-set API key itself - it is that key
 * encrypted with the plugin's `settingsEncryptionKey` option (see
 * `src/lib/crypto/secret-box.ts`). The plaintext key is never persisted and never
 * read back by any admin route; only whether an override is configured is ever
 * reported (`api_key_configured`).
 */
const InfaktSettings = model.define("infakt_settings", {
  /** Encrypted; see the class doc comment. Never returned by any admin route. */
  api_key_ciphertext: model.text().nullable(),
  currency: model.text().nullable(),
  environment: model.enum(["production", "sandbox"]).nullable(),
  id: model.id().primaryKey(),
  invoicing_paused: model.boolean().default(true),
  ksef_mode: model.enum(["nip-only", "all", "never"]).nullable(),
  trigger_event: model.enum(["payment.captured", "order.placed"]).nullable(),
});

export default InfaktSettings;
