import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { INFAKT_MODULE } from "../modules/infakt";
import type InfaktModuleService from "../modules/infakt/service";

/**
 * Flip the admin-editable pause switch.
 *
 * A workflow rather than a direct service call from the route, same as every
 * other mutation this plugin exposes over HTTP: the write is compensable, so a
 * failure anywhere downstream restores the previous value instead of leaving
 * the switch in whatever state the failed attempt left it. That matters more
 * here than almost anywhere else in the plugin - this switch is the one thing
 * standing between a cutover and invoicing starting on its own.
 */

export interface SetInvoicingPausedInput {
  invoicingPaused: boolean;
}

export interface SetInvoicingPausedResult {
  invoicingPaused: boolean;
}

interface CompensationData {
  previous: boolean;
}

/** The slice of the module service this step uses. */
export interface InvoicingPauseService {
  getSettings: () => Promise<unknown>;
  setInvoicingPaused: (paused: boolean) => Promise<unknown>;
}

/**
 * The step's body, as a plain function.
 *
 * `createStep` returns an opaque callable whose invoke/compensate handlers are
 * not reachable from the outside, so the logic lives here where it can be
 * unit-tested against a fake service. The step below is a thin binding.
 */
export async function runSetInvoicingPaused(
  input: SetInvoicingPausedInput,
  infakt: InvoicingPauseService,
): Promise<{ result: SetInvoicingPausedResult; compensation: CompensationData }> {
  const before = (await infakt.getSettings()) as { invoicing_paused?: boolean };
  const previous = Boolean(before.invoicing_paused);

  await infakt.setInvoicingPaused(input.invoicingPaused);

  return {
    compensation: { previous },
    result: { invoicingPaused: input.invoicingPaused },
  };
}

/** Restore the value `runSetInvoicingPaused` overwrote. */
export async function revertInvoicingPaused(
  compensation: CompensationData | undefined,
  infakt: InvoicingPauseService,
): Promise<void> {
  if (!compensation) {
    return;
  }
  await infakt.setInvoicingPaused(compensation.previous);
}

export const setInvoicingPausedStep = createStep(
  "set-invoicing-paused",
  async (input: SetInvoicingPausedInput, { container }) => {
    const infakt = container.resolve<InfaktModuleService>(INFAKT_MODULE);
    const { result, compensation } = await runSetInvoicingPaused(input, infakt);
    return new StepResponse<SetInvoicingPausedResult, CompensationData>(result, compensation);
  },
  async (compensation: CompensationData | undefined, { container }) => {
    const infakt = container.resolve<InfaktModuleService>(INFAKT_MODULE);
    await revertInvoicingPaused(compensation, infakt);
  },
);

export const setInvoicingPausedWorkflow = createWorkflow(
  "set-invoicing-paused",
  (input: SetInvoicingPausedInput) => new WorkflowResponse(setInvoicingPausedStep(input)),
);
