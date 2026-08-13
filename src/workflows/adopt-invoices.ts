import {
  createStep,
  createWorkflow,
  StepResponse,
  WorkflowResponse,
} from "@medusajs/framework/workflows-sdk";
import { INFAKT_MODULE } from "../modules/infakt";
import type InfaktModuleService from "../modules/infakt/service";

/**
 * Write the ledger rows for invoices that already exist in inFakt.
 *
 * This is the APPLY half of the reconciliation; every decision behind it was made
 * by `src/lib/invoicing/reconcile.ts`, which is pure and unit-tested, and by an
 * operator who then named the orders explicitly. Nothing here re-decides anything.
 *
 * ## Why the row lands terminal
 *
 * Each row is written straight to `done`, with `completed_at` set to the day the
 * document was issued. That is not a shortcut - it is the safety property:
 * `listDueInvoices` only ever picks up `pending` and `processing` rows, so a `done`
 * row is never touched by the worker again. It therefore cannot create an invoice,
 * cannot file anything to KSeF, and cannot emit `infakt.invoice.issued` - which is
 * exactly right for a document that was issued long ago and whose consumers (a
 * marketplace upload, an email to the buyer) already happened at the time.
 *
 * `ksef_required` is still recorded, from the tax code on the adopted document, so
 * the ledger states plainly whether the document was a B2B one. It is an audit
 * fact here, not an instruction: nothing acts on a terminal row.
 *
 * ## Idempotency
 *
 * An order that already has a row is skipped and left completely alone - not
 * updated, not re-pointed. `order_id` is unique on the table, so even a race
 * between two operators clicking at once ends with one row, and the loser is
 * reported as skipped rather than failing the whole batch.
 */

export interface AdoptInvoiceInput {
  orderId: string;
  invoiceUuid: string;
  invoiceNumber: string | null;
  /** inFakt's `invoice_date`, YYYY-MM-DD. The row completes as of that day. */
  invoiceDate: string | null;
  isCompany: boolean;
  ksefRequired: boolean;
  ksefDecisionReason: string;
  /** `AdoptionEvidence`, serialized. PII-free by construction. */
  evidence: string;
}

export interface AdoptInvoicesInput {
  adoptions: AdoptInvoiceInput[];
}

export interface AdoptInvoicesResult {
  adopted: { order_id: string; invoice_number: string | null; invoice_uuid: string }[];
  skipped: { order_id: string; reason: string }[];
}

interface CompensationData {
  ids: string[];
}

/** The slice of the module service this workflow uses. */
export interface AdoptInvoicesService {
  listInfaktInvoices: (filters?: Record<string, unknown>) => Promise<unknown[]>;
  createInfaktInvoices: (data: Record<string, unknown>) => Promise<unknown>;
  deleteInfaktInvoices: (ids: string[]) => Promise<unknown>;
}

/** Midnight UTC of the issue date, or now when inFakt gave no date. */
function completedAt(invoiceDate: string | null): Date {
  if (!invoiceDate) {
    return new Date();
  }
  const parsed = new Date(`${invoiceDate.slice(0, 10)}T00:00:00.000Z`);
  return Number.isNaN(parsed.getTime()) ? new Date() : parsed;
}

export async function adoptInvoices(
  input: AdoptInvoicesInput,
  infakt: AdoptInvoicesService,
): Promise<{ result: AdoptInvoicesResult; compensation?: CompensationData }> {
  const result: AdoptInvoicesResult = { adopted: [], skipped: [] };
  const created: string[] = [];

  const orderIds = input.adoptions.map((adoption) => adoption.orderId);
  const existing = (await infakt.listInfaktInvoices({ order_id: orderIds })) as unknown as {
    order_id: string;
  }[];
  const alreadyLedgered = new Set(existing.map((row) => row.order_id));

  for (const adoption of input.adoptions) {
    if (alreadyLedgered.has(adoption.orderId)) {
      result.skipped.push({
        order_id: adoption.orderId,
        reason: "this order already has an invoice record - left untouched",
      });
      continue;
    }
    try {
      const row = (await infakt.createInfaktInvoices({
        adopted_at: new Date(),
        adopted_evidence: adoption.evidence,
        completed_at: completedAt(adoption.invoiceDate),
        invoice_number: adoption.invoiceNumber,
        invoice_uuid: adoption.invoiceUuid,
        is_company: adoption.isCompany,
        ksef_decision_reason: adoption.ksefDecisionReason,
        ksef_required: adoption.ksefRequired,
        order_id: adoption.orderId,
        status: "done",
      })) as { id?: string } | undefined;
      if (row?.id) {
        created.push(row.id);
      }
      result.adopted.push({
        invoice_number: adoption.invoiceNumber,
        invoice_uuid: adoption.invoiceUuid,
        order_id: adoption.orderId,
      });
    } catch {
      // The unique `order_id` is the real guard. Losing a race to a concurrent
      // adopt is the expected outcome here, not a batch failure.
      result.skipped.push({
        order_id: adoption.orderId,
        reason: "could not write the invoice record - another one was created for this order first",
      });
    }
  }

  return { compensation: { ids: created }, result };
}

/**
 * Remove the rows this step created.
 *
 * Safe precisely because the rows are terminal and were created here: nothing
 * downstream has acted on them, and deleting one only takes the order back to
 * having no invoice record - the state it was in a moment earlier. No inFakt
 * document is touched, because none was created.
 */
export async function revertAdoptInvoices(
  compensation: CompensationData | undefined,
  infakt: AdoptInvoicesService,
): Promise<void> {
  if (!compensation || compensation.ids.length === 0) {
    return;
  }
  await infakt.deleteInfaktInvoices(compensation.ids);
}

export const adoptInvoicesStep = createStep(
  "adopt-invoices",
  async (input: AdoptInvoicesInput, { container }) => {
    const infakt = container.resolve<InfaktModuleService>(INFAKT_MODULE);
    const { result, compensation } = await adoptInvoices(
      input,
      infakt as unknown as AdoptInvoicesService,
    );
    return new StepResponse<AdoptInvoicesResult, CompensationData>(
      result,
      compensation as CompensationData,
    );
  },
  async (compensation: CompensationData | undefined, { container }) => {
    const infakt = container.resolve<InfaktModuleService>(INFAKT_MODULE);
    await revertAdoptInvoices(compensation, infakt as unknown as AdoptInvoicesService);
  },
);

export const adoptInvoicesWorkflow = createWorkflow(
  "adopt-invoices",
  (input: AdoptInvoicesInput) => new WorkflowResponse(adoptInvoicesStep(input)),
);
