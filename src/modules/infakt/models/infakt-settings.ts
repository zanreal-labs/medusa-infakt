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
 */
const InfaktSettings = model.define("infakt_settings", {
  id: model.id().primaryKey(),
  invoicing_paused: model.boolean().default(true),
});

export default InfaktSettings;
