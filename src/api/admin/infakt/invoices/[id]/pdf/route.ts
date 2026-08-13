import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import type { InfaktClient } from "../../../../../../lib/infakt";
import { INFAKT_MODULE } from "../../../../../../modules/infakt";
import type InfaktModuleService from "../../../../../../modules/infakt/service";

interface LedgerRow {
  id: string;
  invoice_uuid?: string | null;
  invoice_number?: string | null;
}

/** Characters a Content-Disposition filename cannot carry unescaped. */
const UNSAFE_FILENAME_CHARS = /[^\w.-]+/gu;

/**
 * GET /admin/infakt/invoices/:id/pdf
 *
 * Streams the inFakt invoice PDF for one ledger row, so the browser never needs
 * the inFakt API key - this backend is the only thing that ever holds it.
 *
 * Two ways to reach a document, in order:
 *
 *  1. `invoice_uuid` is set (every invoice this pipeline created or an operator
 *     adopted through the crash-window flow). The PDF endpoint is uuid-keyed, so
 *     this is a direct fetch.
 *  2. `invoice_uuid` is null but `invoice_number` is set - the shape of the 24
 *     historical rows backfilled straight into the ledger, which never went
 *     through `adopt` and so never got a uuid. `findInvoiceByNumber` resolves
 *     the uuid via inFakt's `q[number_eq]` filter first.
 *
 * A row with neither is a 404, not a broken PDF: there is no reliable inFakt
 * identifier to fetch anything with, and this route must never hand back a link
 * that only fails once clicked.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);
  const { id } = req.params;

  const [row] = (await infakt.listInfaktInvoices({ id: [id] })) as unknown as LedgerRow[];
  if (!row) {
    throw new MedusaError(MedusaError.Types.NOT_FOUND, `No invoice row ${id}.`);
  }

  const invoiceUuid = row.invoice_uuid ?? null;
  const invoiceNumber = row.invoice_number ?? null;
  if (!(invoiceUuid || invoiceNumber)) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      "This row has neither an inFakt uuid nor an invoice number - there is no document to fetch.",
    );
  }

  if (!(await infakt.getEffectiveOptions()).enabled) {
    res.status(409).json({
      error: "the plugin is disabled (no `apiKey` configured) - there is no inFakt to fetch a PDF from",
      id,
    });
    return;
  }

  const client = await infakt.getApiClient();
  const uuid = invoiceUuid ?? (await resolveUuidByNumber(client, invoiceNumber as string));

  const pdf = await client.getInvoicePdf(uuid);
  const filename = `${(invoiceNumber ?? uuid).replaceAll(UNSAFE_FILENAME_CHARS, "-")}.pdf`;
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.status(200).send(Buffer.from(pdf));
}

/**
 * Resolve a uuid from an invoice number via inFakt's `q[number_eq]` filter.
 *
 * inFakt reporting no match is a clean 404 for this row, not a server error:
 * the number on the row is stale, or was never a real inFakt number to begin
 * with. Every other inFakt failure propagates as-is, exactly like the adopt
 * route's read of an invoice by uuid.
 */
async function resolveUuidByNumber(client: InfaktClient, number: string): Promise<string> {
  const found = await client.findInvoiceByNumber(number);
  if (!found) {
    throw new MedusaError(
      MedusaError.Types.NOT_FOUND,
      `inFakt has no invoice numbered ${number}.`,
    );
  }
  return found.uuid;
}
