import type { LoaderOptions } from "@medusajs/framework/types";
import { resolveInfaktOptions } from "../../../lib/options";
import type { InfaktPluginOptions } from "../../../lib/options";

/**
 * Fail fast on a misconfigured plugin, and say loudly when invoicing is inert.
 *
 * Loaders run once at application startup, before any request is served, which is
 * the only place a configuration error can reach the person who can fix it. Left
 * to the service, the same error would surface on the first inFakt call - in the
 * middle of a customer's checkout, wrapped in an unrelated stack trace.
 *
 * `apiKey` is the one setting that does not throw. An absent or blank value
 * disables the plugin instead: it boots, does nothing, and says so once. The
 * plugin should simply work when it is configured and not work when it is not -
 * there is no separate enable flag, and a store must never fail to boot just
 * because the credential was left unset.
 */
export default async function validateInfaktOptions({
  options,
  logger,
}: LoaderOptions<InfaktPluginOptions>): Promise<void> {
  const resolved = resolveInfaktOptions(options);

  if (!resolved.enabled) {
    logger?.error(
      "[medusa-infakt] DISABLED: plugin option `apiKey` is not configured. " +
        "No order will be invoiced until it is set. This is the plugin's only enable switch.",
    );
    return;
  }

  logger?.info(
    `[medusa-infakt] configured for ${resolved.environment}: invoicing ${resolved.currency} orders` +
      `${resolved.startDate ? ` placed on or after ${resolved.startDate}` : " with no start-date floor"}, ` +
      `VAT ${resolved.taxSymbol}, triggered by ${resolved.triggerEvent}, KSeF mode ${resolved.ksefMode}` +
      `${resolved.ksefDecide ? " (overridden by a custom predicate)" : ""}.`,
  );

  if (
    resolved.ksefMode === "never" &&
    resolved.environment === "production" &&
    !resolved.ksefDecide
  ) {
    logger?.warn(
      '[medusa-infakt] ksef.mode is "never" in a PRODUCTION deployment. No invoice will be filed to KSeF. ' +
        "Filing B2B invoices has been mandatory in Poland since April 2026 - this setting is intended for development only.",
    );
  }
}
