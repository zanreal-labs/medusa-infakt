import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { InfaktApiError } from "../../../../../lib/infakt";
import type { OperatorAction } from "../../../../../lib/invoicing/operator-actions";
import { runInvoicingNow } from "../../../../../lib/invoicing/run";
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
 *
 * An action that leaves the row runnable - retry, adopt, clear - then runs the
 * pipeline for that one order immediately, through the same shared runner the
 * payment subscriber uses. An operator clicking Retry and watching the row sit
 * there until the next five-minute boundary was the whole complaint; a cron is
 * the safety net, never the mechanism. `skip` is terminal and starts nothing.
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

  // Adopt is the one action here that touches the inFakt API client. Guard on
  // the EFFECTIVE `enabled` (boot `apiKey` or an admin-set override) before it,
  // rather than letting the getter's throw reach this handler as an uncaught
  // error - refused-with-a-reason is the same shape every other impossible
  // action on this route already answers with. Checked only for `adopt`, so the
  // other three actions cost no extra round trip.
  if (action === "adopt" && !(await infakt.getEffectiveOptions()).enabled) {
    res.status(409).json({
      error: "the plugin is disabled (no `apiKey` configured) - there is no inFakt to adopt from",
      id,
    });
    return;
  }

  // For an adopt, confirm the invoice exists in inFakt BEFORE the link is written,
  // and carry its number over. Linking a uuid that does not exist would leave the
  // row looking complete with no document behind it. The same lookup yields the
  // buyer's tax code, which is what decides whether the adopted row still owes KSeF
  // a filing.
  const adopted = action === "adopt" ? await readAdoptedInvoice(infakt, body.invoice_uuid) : null;

  const { result } = (await applyInvoiceActionWorkflow(req.scope).run({
    input: {
      action,
      confirmNoDuplicate: body.confirm_no_duplicate,
      id,
      invoiceNumber: adopted?.number ?? null,
      invoiceTaxCode: adopted ? (adopted.taxCode ?? null) : undefined,
      invoiceUuid: body.invoice_uuid,
      reason: body.reason,
    },
  })) as { result: ApplyInvoiceActionResult };

  if (!result.applied) {
    res.status(409).json({ error: result.refusal, id });
    return;
  }

  const [patched] = (await infakt.listInfaktInvoices({ id: [id] })) as unknown as {
    order_id: string;
    status: string;
  }[];

  // Terminal rows start nothing: `skip` is a decision not to issue, and a row
  // already `done` has nowhere left to go.
  if (patched && patched.status !== "done" && patched.status !== "skipped") {
    await runInvoicingNow(req.scope, {
      orderId: patched.order_id,
      source: `medusa-infakt/admin-${action}`,
    });
  }

  const [invoice] = await infakt.listInfaktInvoices({ id: [id] });
  res.json({ invoice, note: result.note });
}

/**
 * Read the invoice an operator is adopting, and return the two facts the row needs
 * from it: the number inFakt assigned, and the buyer's tax code.
 *
 * A 404 from inFakt is reported as invalid input rather than a server error: the
 * operator mistyped a uuid, which is theirs to fix.
 */
async function readAdoptedInvoice(
  infakt: InfaktModuleService,
  uuid: string | undefined,
): Promise<{ number: string | null; taxCode: string | null }> {
  const trimmed = uuid?.trim();
  if (!trimmed) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "`invoice_uuid` is required to adopt an existing inFakt invoice.",
    );
  }
  try {
    const client = await infakt.getApiClient();
    const invoice = await client.getInvoice(trimmed);
    return { number: invoice.number ?? null, taxCode: invoice.clientTaxCode ?? null };
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
