import { Module } from "@medusajs/framework/utils";
import validateInfaktOptions from "./loaders/validate-options";
import InfaktModuleService from "./service";

/**
 * Container registration key for the inFakt module.
 *
 * Resolve it from anywhere that has the Medusa container:
 *
 *   const infakt = req.scope.resolve(INFAKT_MODULE) as InfaktModuleService
 */
export const INFAKT_MODULE = "infakt";

export default Module(INFAKT_MODULE, {
  loaders: [validateInfaktOptions],
  service: InfaktModuleService,
});

export { default as InfaktModuleService } from "./service";
export { RUN_STATE_SINGLETON_KEY, STALE_CLAIM_MS } from "./service";
export type { RunClaim, RunOutcome } from "./service";
