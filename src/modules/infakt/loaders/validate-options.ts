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
 * `startDate` is the one setting that does not throw. An absent or malformed value
 * disables the pipeline instead, because the alternative default - invoice
 * everything - would issue real invoices for an entire back catalogue and file
 * them to KSeF, and neither can be undone. A store that boots with invoicing
 * visibly off is recoverable; one that boots and starts issuing is not.
 */
export default async function validateInfaktOptions({
  options,
  logger,
}: LoaderOptions<InfaktPluginOptions>): Promise<void> {
  const resolved = resolveInfaktOptions(options);

  if (resolved.startDate === null) {
    logger?.error(
      "[medusa-infakt] DISABLED: plugin option `startDate` is missing or is not a strict YYYY-MM-DD date. " +
        "No order will be invoiced until it is set. This is a safe default, not a silent one: " +
        "invoicing without a floor would issue real invoices for every historical order.",
    );
    return;
  }

  logger?.info(
    `[medusa-infakt] configured for ${resolved.environment}: invoicing ${resolved.currency} orders placed on or after ${resolved.startDate}, ` +
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
