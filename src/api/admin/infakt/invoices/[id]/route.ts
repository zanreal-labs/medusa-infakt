import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { InfaktApiError } from "../../../../../lib/infakt";
import type { OperatorAction } from "../../../../../lib/invoicing/operator-actions";
import { INFAKT_MODULE } from "../../../../../modules/infakt";
import type InfaktModuleService from "../../../../../modules/infakt/service";
import { applyInvoiceActionWorkflow } from "../../../../../workflows/apply-invoice-action";
import type { ApplyInvoiceActionResult } from "../../../../../workflows/apply-invoice-action";

interface ActionBody {
  action?: string;
  invoice_uuid?: string;
  reason?: string;
  confirm_no_duplicate?: boolean;
}

const VALID_ACTIONS: readonly OperatorAction[] = ["retry", "adopt", "clear", "skip"];

/**
 * POST /admin/infakt/invoices/:id
 *
 * The operator surface for a parked invoice: retry, adopt an existing inFakt
 * invoice, clear the crash-window marker, or skip the order.
 *
 * Which action is allowed for a given row is decided by `planOperatorAction` - pure
 * and unit-tested - and carried out by `applyInvoiceActionWorkflow`, which can
 * compensate. This route only validates the request shape and, for an adopt, reads
 * the invoice from inFakt first.
 *
 * A refused action answers 409, not 400: the request was well-formed, and it is the
 * row's state that makes it impossible. The reason string is written for the person
 * reading it in the admin UI, and says what to do instead.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);
  const { id } = req.params;
  const body = (req.body ?? {}) as ActionBody;

  const action = String(body.action ?? "") as OperatorAction;
  if (!VALID_ACTIONS.includes(action)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `\`action\` must be one of ${VALID_ACTIONS.join(", ")}.`,
    );
  }

  // Adopt is the one action here that touches `apiClient`. Guard on `enabled`
  // before it, rather than letting the getter's throw reach this handler as an
  // uncaught error - refused-with-a-reason is the same shape every other
  // impossible action on this route already answers with.
  if (action === "adopt" && !infakt.resolvedOptions.enabled) {
    res.status(409).json({
      error: "the plugin is disabled (no `apiKey` configured) - there is no inFakt to adopt from",
      id,
    });
    return;
  }

  // For an adopt, confirm the invoice exists in inFakt BEFORE the link is written,
  // and carry its number over. Linking a uuid that does not exist would leave the
  // row looking complete with no document behind it.
  const invoiceNumber =
    action === "adopt" ? await readAdoptedInvoiceNumber(infakt, body.invoice_uuid) : null;

  const { result } = (await applyInvoiceActionWorkflow(req.scope).run({
    input: {
      action,
      confirmNoDuplicate: body.confirm_no_duplicate,
      id,
      invoiceNumber,
      invoiceUuid: body.invoice_uuid,
      reason: body.reason,
    },
  })) as { result: ApplyInvoiceActionResult };

  if (!result.applied) {
    res.status(409).json({ error: result.refusal, id });
    return;
  }

  const [invoice] = await infakt.listInfaktInvoices({ id: [id] });
  res.json({ invoice, note: result.note });
}

/**
 * Read the invoice an operator is adopting, and return its number.
 *
 * A 404 from inFakt is reported as invalid input rather than a server error: the
 * operator mistyped a uuid, which is theirs to fix.
 */
async function readAdoptedInvoiceNumber(
  infakt: InfaktModuleService,
  uuid: string | undefined,
): Promise<string | null> {
  const trimmed = uuid?.trim();
  if (!trimmed) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "`invoice_uuid` is required to adopt an existing inFakt invoice.",
    );
  }
  try {
    const invoice = await infakt.apiClient.getInvoice(trimmed);
    return invoice.number ?? null;
  } catch (error) {
    if (error instanceof InfaktApiError && error.httpStatus === 404) {
      throw new MedusaError(
        MedusaError.Types.INVALID_DATA,
        `inFakt has no invoice with uuid ${trimmed}. Check the uuid in inFakt and try again.`,
      );
    }
    throw error;
  }
}
