import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import type { InfaktConfigOverrides } from "../lib/invoicing/effective-config";
import { INFAKT_MODULE } from "../modules/infakt";
import type { ConfigOverridePatch } from "../modules/infakt/service";
import type InfaktModuleService from "../modules/infakt/service";

/**
 * Change `currency`, `ksef.mode`, `triggerEvent`, `environment` or `apiKey` from
 * the Settings page.
 *
 * A separate workflow from `set-invoicing-paused`, which keeps owning the pause
 * switch exactly as it does today - these two write disjoint sets of columns and
 * there is no reason to route the pause toggle through the validation and
 * encryption this one does.
 *
 * Compensable for the same reason every other admin-facing mutation in this
 * plugin is: a failure anywhere downstream (a step added later, a workflow
 * hook a host registers) restores every column this wrote rather than leaving
 * the configuration half-applied. The captured "previous" state is the RAW
 * override row, `api_key_ciphertext` included - restoring writes that exact
 * ciphertext back via `setConfigOverridesRaw`, never re-encrypting a plaintext,
 * because nothing upstream of compensation ever holds one.
 */

export type UpdateInfaktConfigInput = ConfigOverridePatch;

export interface UpdateInfaktConfigResult {
  applied: true;
}

interface CompensationData {
  previous: InfaktConfigOverrides;
}

/** The slice of the module service this step uses. */
export interface ConfigOverrideService {
  getConfigOverrides: () => Promise<InfaktConfigOverrides>;
  updateConfigOverrides: (patch: UpdateInfaktConfigInput) => Promise<void>;
  setConfigOverridesRaw: (patch: Partial<InfaktConfigOverrides>) => Promise<void>;
}

/**
 * The step's body, as a plain function.
 *
 * `createStep` returns an opaque callable whose invoke/compensate handlers are
 * not reachable from the outside, so the logic lives here where it can be
 * unit-tested against a fake service. The step below is a thin binding.
 */
export async function runUpdateInfaktConfig(
  input: UpdateInfaktConfigInput,
  infakt: ConfigOverrideService,
): Promise<{ result: UpdateInfaktConfigResult; compensation: CompensationData }> {
  const previous = await infakt.getConfigOverrides();

  await infakt.updateConfigOverrides(input);

  return { compensation: { previous }, result: { applied: true } };
}

/** Restore the exact raw override row `runUpdateInfaktConfig` overwrote. */
export async function revertInfaktConfig(
  compensation: CompensationData | undefined,
  infakt: ConfigOverrideService,
): Promise<void> {
  if (!compensation) {
    return;
  }
  await infakt.setConfigOverridesRaw(compensation.previous);
}

export const updateInfaktConfigStep = createStep(
  "update-infakt-config",
  async (input: UpdateInfaktConfigInput, { container }) => {
    const infakt = container.resolve<InfaktModuleService>(INFAKT_MODULE);
    const { result, compensation } = await runUpdateInfaktConfig(input, infakt);
    return new StepResponse<UpdateInfaktConfigResult, CompensationData>(result, compensation);
  },
  async (compensation: CompensationData | undefined, { container }) => {
    const infakt = container.resolve<InfaktModuleService>(INFAKT_MODULE);
    await revertInfaktConfig(compensation, infakt);
  },
);

export const updateInfaktConfigWorkflow = createWorkflow(
  "update-infakt-config",
  (input: UpdateInfaktConfigInput) => new WorkflowResponse(updateInfaktConfigStep(input)),
);
