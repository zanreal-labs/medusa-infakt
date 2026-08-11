import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { planOperatorAction } from "../lib/invoicing/operator-actions";
import type { OperatorAction } from "../lib/invoicing/operator-actions";
import type { InvoiceStateRow } from "../lib/invoicing/state-machine";
import { INFAKT_MODULE } from "../modules/infakt";
import type InfaktModuleService from "../modules/infakt/service";

/**
 * Apply an operator action to one invoice row.
 *
 * A workflow rather than a direct service call from the route, for the two reasons
 * Medusa's own guidance gives - and both earn their keep here:
 *
 *  1. Compensation. These actions rewrite the columns that decide whether a create
 *     may run again. If anything downstream of the write fails, the previous values
 *     are restored rather than left half-applied, because a row stuck between "in
 *     the crash window" and "cleared" is the one state with no safe reading.
 *  2. The mutation is reusable and observable. A future bulk "retry everything that
 *     failed on a 503" has one place to call.
 *
 * The decision itself is NOT here: `planOperatorAction` is pure and unit-tested, and
 * this step only carries out what it returns.
 */

export interface ApplyInvoiceActionInput {
  id: string;
  action: OperatorAction;
  invoiceUuid?: string;
  /** Looked up from inFakt by the caller before adopting. */
  invoiceNumber?: string | null;
  reason?: string;
  confirmNoDuplicate?: boolean;
}

export interface ApplyInvoiceActionResult {
  applied: boolean;
  /** Present when the action was refused; written for the operator reading it. */
  refusal?: string;
  note?: string;
}

interface CompensationData {
  id: string;
  previous: Record<string, unknown>;
}

/** The slice of the module service these functions use. */
export interface InvoiceActionService {
  listInfaktInvoices: (filters?: Record<string, unknown>) => Promise<unknown[]>;
  updateInfaktInvoices: (data: Record<string, unknown>) => Promise<unknown>;
  resolvedOptions: { emitIssuedEvent: boolean };
}

/** The columns any action can write, so compensation can restore all of them. */
const MUTABLE_COLUMNS = [
  "adopted_at",
  "attempts",
  "completed_at",
  "invoice_number",
  "invoice_uuid",
  "last_error",
  "next_attempt_at",
  "skip_reason",
  "status",
  "submit_started_at",
  "task_reference",
] as const;

/**
 * The step's body, as a plain function.
 *
 * `createStep` returns an opaque callable whose invoke/compensate handlers are not
 * reachable from the outside, so the logic lives here where it can be unit-tested
 * against a fake service. The step below is a thin binding.
 */
export async function applyInvoiceAction(
  input: ApplyInvoiceActionInput,
  infakt: InvoiceActionService,
): Promise<{ result: ApplyInvoiceActionResult; compensation?: CompensationData }> {
  const [row] = (await infakt.listInfaktInvoices({
    id: [input.id],
  })) as unknown as InvoiceStateRow[];
  if (!row) {
    return { result: { applied: false, refusal: `No invoice record with id ${input.id}.` } };
  }

  const plan = planOperatorAction(
    row,
    {
      action: input.action,
      confirmNoDuplicate: input.confirmNoDuplicate,
      invoiceNumber: input.invoiceNumber,
      invoiceUuid: input.invoiceUuid,
      reason: input.reason,
    },
    { emitEvent: infakt.resolvedOptions.emitIssuedEvent },
  );

  if (!plan.ok) {
    // A refusal writes nothing, so it is a result rather than a thrown error - there
    // is no compensation to run and nothing for the workflow to roll back.
    return { result: { applied: false, refusal: plan.reason } };
  }

  // Captured BEFORE the write, and for every column any action can touch. A column
  // absent from the row is captured as null, so restoring cannot leave behind a value
  // the action introduced.
  const previous: Record<string, unknown> = {};
  for (const column of MUTABLE_COLUMNS) {
    previous[column] = (row as unknown as Record<string, unknown>)[column] ?? null;
  }

  await infakt.updateInfaktInvoices({ id: input.id, ...plan.patch });

  return {
    compensation: { id: input.id, previous },
    result: { applied: true, note: plan.note },
  };
}

/** Restore the columns `applyInvoiceAction` overwrote. */
export async function revertInvoiceAction(
  compensation: CompensationData | undefined,
  infakt: InvoiceActionService,
): Promise<void> {
  if (!compensation) {
    return;
  }
  await infakt.updateInfaktInvoices({ id: compensation.id, ...compensation.previous });
}

export const applyInvoiceActionStep = createStep(
  "apply-invoice-action",
  async (input: ApplyInvoiceActionInput, { container }) => {
    const infakt = container.resolve<InfaktModuleService>(INFAKT_MODULE);
    const { result, compensation } = await applyInvoiceAction(input, infakt);
    return new StepResponse<ApplyInvoiceActionResult, CompensationData>(
      result,
      compensation as CompensationData,
    );
  },
  async (compensation: CompensationData | undefined, { container }) => {
    const infakt = container.resolve<InfaktModuleService>(INFAKT_MODULE);
    await revertInvoiceAction(compensation, infakt);
  },
);

export const applyInvoiceActionWorkflow = createWorkflow(
  "apply-invoice-action",
  (input: ApplyInvoiceActionInput) => new WorkflowResponse(applyInvoiceActionStep(input)),
);
