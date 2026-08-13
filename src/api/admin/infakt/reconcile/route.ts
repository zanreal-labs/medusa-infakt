import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { ContainerRegistrationKeys, MedusaError } from "@medusajs/framework/utils";
import type { InfaktClient } from "../../../../lib/infakt";
import { decideKsef } from "../../../../lib/invoicing/ksef";
import type { MatchInvoiceCandidate } from "../../../../lib/invoicing/matching";
import { isCalendarDate } from "../../../../lib/invoicing/money";
import type { MedusaOrderLike } from "../../../../lib/invoicing/order-mapper";
import {
  applyPositionConfirmation,
  INVOICE_PAGE_SIZE,
  MAX_INVOICE_PAGES,
  planAdoptions,
  rejectAlreadyLinked,
  resolveDateTolerance,
  summarizePlan,
  toReconcileOrder,
  invoiceIsCompany,
} from "../../../../lib/invoicing/reconcile";
import type { AdoptionPlanEntry, ReconcileOrder } from "../../../../lib/invoicing/reconcile";
import type { ResolvedInfaktOptions } from "../../../../lib/options";
import { INFAKT_MODULE } from "../../../../modules/infakt";
import type InfaktModuleService from "../../../../modules/infakt/service";
import { adoptInvoicesWorkflow } from "../../../../workflows/adopt-invoices";
import type { AdoptInvoiceInput, AdoptInvoicesResult } from "../../../../workflows/adopt-invoices";

/**
 * GET  /admin/infakt/reconcile?from=2026-07-01&to=2026-08-12
 * POST /admin/infakt/reconcile  { from, to, tolerance_days?, apply?, order_ids? }
 *
 * Adopt invoices that already exist in inFakt onto the orders they belong to.
 *
 * This is the answer to a store whose history was invoiced somewhere else: the
 * documents are real and filed, only this plugin's ledger does not know about
 * them. The invoices are read from the inFakt API and matched to Medusa orders on
 * ORDER DATA alone - issue date against the order's day, buyer identity, and the
 * gross total to the grosz. No other system is consulted, and none needs to exist.
 *
 * ## Dry run by default
 *
 * Both methods answer with the same report, and both write nothing unless the POST
 * body carries BOTH `apply: true` and an explicit `order_ids` list. There is no
 * "adopt everything" switch: the caller has to name each order, having seen the
 * evidence for it, and the server re-derives the match for that order before
 * writing anything - so a plan that has gone stale between the preview and the
 * click cannot be applied from the client's copy of it.
 *
 * ## Nothing is issued
 *
 * No invoice is created, nothing is sent to KSeF, and no `infakt.invoice.issued`
 * event is emitted. Adoption records a document that already exists; see
 * `src/workflows/adopt-invoices.ts` for why the row lands terminal.
 *
 * ## What it will not touch
 *
 * An order that already has a ledger row is out of scope entirely - not re-matched,
 * not updated, not reported as adoptable. That is the idempotency guarantee, and it
 * rests on the same unique `order_id` the enqueue path does, so a re-run writes
 * nothing.
 */

const ORDER_PAGE_SIZE = 200;
const MAX_ORDER_PAGES = 10;

interface ReconcileBody {
  from?: string;
  to?: string;
  tolerance_days?: number | string;
  apply?: boolean;
  order_ids?: string[];
}

interface GraphQuery {
  graph: (input: {
    entity: string;
    fields: string[];
    filters?: Record<string, unknown>;
    pagination?: Record<string, unknown>;
  }) => Promise<{ data?: unknown[] }>;
}

const ORDER_FIELDS = [
  "id",
  "display_id",
  "status",
  "currency_code",
  "total",
  "email",
  "created_at",
  "canceled_at",
  "metadata",
  "items.*",
  "billing_address.*",
  "shipping_address.*",
];

/** A YYYY-MM-DD bound, rejected loudly rather than silently defaulted. */
function readDay(value: unknown, field: string): string {
  const day = String(value ?? "").trim();
  if (!isCalendarDate(day)) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      `\`${field}\` must be a calendar date in YYYY-MM-DD form.`,
    );
  }
  return day;
}

/** Shift a YYYY-MM-DD day by whole days, staying in YYYY-MM-DD. */
function shiftDay(day: string, days: number): string {
  const shifted = new Date(`${day}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + days);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Every order placed in the window that this plugin has no record of.
 *
 * Soft-deleted orders never appear: Medusa's query layer excludes them, and an
 * order somebody deleted is not one to go looking for an invoice for.
 */
async function readOrders(
  query: GraphQuery,
  window: { from: string; to: string },
): Promise<{ orders: MedusaOrderLike[]; truncated: boolean }> {
  const orders: MedusaOrderLike[] = [];
  for (let page = 0; page < MAX_ORDER_PAGES; page += 1) {
    const { data } = await query.graph({
      entity: "order",
      fields: ORDER_FIELDS,
      filters: {
        created_at: {
          $gte: `${window.from}T00:00:00.000Z`,
          $lte: `${window.to}T23:59:59.999Z`,
        },
      },
      pagination: { order: { created_at: "ASC" }, skip: page * ORDER_PAGE_SIZE, take: ORDER_PAGE_SIZE },
    });
    const batch = (data ?? []) as MedusaOrderLike[];
    orders.push(...batch);
    if (batch.length < ORDER_PAGE_SIZE) {
      return { orders, truncated: false };
    }
  }
  return { orders, truncated: true };
}

/**
 * Every invoice inFakt issued in the window, padded either side by the date
 * tolerance so an invoice dated just outside it can still match an order inside it.
 *
 * Read with `q[invoice_date_gteq]` / `q[invoice_date_lteq]`, which is the only
 * server-side narrowing inFakt offers that helps here - it has no filter for the
 * gross total, and none for the buyer's email or name.
 */
async function readInvoices(
  client: Pick<InfaktClient, "listInvoices">,
  window: { from: string; to: string },
): Promise<{ invoices: MatchInvoiceCandidate[]; truncated: boolean }> {
  const invoices: MatchInvoiceCandidate[] = [];
  for (let page = 0; page < MAX_INVOICE_PAGES; page += 1) {
    const batch = await client.listInvoices({
      issuedFrom: window.from,
      issuedTo: window.to,
      limit: INVOICE_PAGE_SIZE,
      offset: page * INVOICE_PAGE_SIZE,
      order: "invoice_date asc",
    });
    invoices.push(
      ...batch.map((invoice) => ({
        clientCompanyName: invoice.clientCompanyName,
        clientEmail: invoice.clientEmail,
        clientFirstName: invoice.clientFirstName,
        clientLastName: invoice.clientLastName,
        clientTaxCode: invoice.clientTaxCode,
        currency: invoice.currency,
        grossPrice: invoice.grossPrice,
        invoiceDate: invoice.invoiceDate,
        number: invoice.number,
        services: (invoice.services ?? []).map((service) => ({
          name: service.name,
          quantity: service.quantity,
        })),
        uuid: invoice.uuid,
      })),
    );
    if (batch.length < INVOICE_PAGE_SIZE) {
      return { invoices, truncated: false };
    }
  }
  return { invoices, truncated: true };
}

/**
 * Fetch the detail response for every proposed invoice that was matched without
 * line positions, so the report can say whether they confirm it.
 *
 * At most one GET per proposed adoption, and only ever an upgrade from `medium` to
 * `high` - a failed read leaves the entry exactly as the list response classified
 * it rather than failing the whole report.
 */
async function confirmPositions(
  entries: AdoptionPlanEntry[],
  orders: Map<string, ReconcileOrder>,
  client: Pick<InfaktClient, "getInvoice">,
): Promise<AdoptionPlanEntry[]> {
  const confirmed: AdoptionPlanEntry[] = [];
  for (const entry of entries) {
    const order = orders.get(entry.orderId);
    if (entry.decision !== "adopt" || !entry.evidence || entry.evidence.positions_confirmed || !order) {
      confirmed.push(entry);
      continue;
    }
    try {
      const detail = await client.getInvoice(entry.evidence.invoice_uuid);
      confirmed.push(
        applyPositionConfirmation(
          entry,
          order,
          (detail.services ?? []).map((service) => ({
            name: service.name,
            quantity: service.quantity,
          })),
        ),
      );
    } catch {
      confirmed.push(entry);
    }
  }
  return confirmed;
}

/** Invoices already recorded on some ledger row, by uuid and by number. */
async function readLinkedInvoices(
  infakt: InfaktModuleService,
  entries: AdoptionPlanEntry[],
): Promise<{ uuids: string[]; numbers: string[] }> {
  const uuids = entries.map((entry) => entry.invoice?.uuid).filter((uuid): uuid is string => !!uuid);
  const numbers = entries
    .map((entry) => entry.invoice?.number)
    .filter((number): number is string => !!number);
  // Two plain queries rather than one `$or`: the generated list method's filter
  // shape is the module's contract, and a hand-rolled boolean tree is exactly the
  // kind of thing that quietly stops filtering (and starts returning the whole
  // table) on a framework upgrade.
  const rows = [
    ...(uuids.length > 0
      ? await infakt.listInfaktInvoices({ invoice_uuid: uuids }, { take: uuids.length })
      : []),
    ...(numbers.length > 0
      ? await infakt.listInfaktInvoices({ invoice_number: numbers }, { take: numbers.length })
      : []),
  ] as unknown as { invoice_uuid?: string | null; invoice_number?: string | null }[];
  return {
    numbers: rows.map((row) => row.invoice_number).filter((value): value is string => !!value),
    uuids: rows.map((row) => row.invoice_uuid).filter((value): value is string => !!value),
  };
}

interface ReconcileReport {
  window: { from: string; to: string; tolerance_days: number };
  summary: ReturnType<typeof summarizePlan> & { invoices_considered: number };
  truncated: boolean;
  entries: AdoptionPlanEntry[];
}

/** Build the plan. Reads inFakt and Medusa; writes nothing, ever. */
async function buildReport(
  req: MedusaRequest,
  infakt: InfaktModuleService,
  options: ResolvedInfaktOptions,
  params: { from: string; to: string; toleranceDays: number },
): Promise<{ report: ReconcileReport; orders: Map<string, ReconcileOrder> }> {
  const query = req.scope.resolve<GraphQuery>(ContainerRegistrationKeys.QUERY);
  const client = await infakt.getApiClient();

  const { orders: rawOrders, truncated: ordersTruncated } = await readOrders(query, params);
  // Never queried with an empty id list: an empty filter means "every row" to the
  // generated list method, and treating the whole ledger as "already ledgered"
  // would silently report nothing to adopt.
  const ledgered = new Set(
    rawOrders.length === 0
      ? []
      : (
          (await infakt.listInfaktInvoices(
            { order_id: rawOrders.map((order) => order.id) },
            { take: rawOrders.length },
          )) as unknown as { order_id: string }[]
        ).map((row) => row.order_id),
  );

  const orders = rawOrders
    .filter((order) => !ledgered.has(order.id))
    .map((order) => toReconcileOrder(order, options.nipExtractor, options.currency));

  const { invoices, truncated: invoicesTruncated } = await readInvoices(client, {
    from: shiftDay(params.from, -params.toleranceDays),
    to: shiftDay(params.to, params.toleranceDays),
  });

  const byOrderId = new Map(orders.map((order) => [order.orderId, order]));
  let entries = planAdoptions(orders, invoices, { dateToleranceDays: params.toleranceDays });
  entries = await confirmPositions(entries, byOrderId, client);
  entries = rejectAlreadyLinked(entries, await readLinkedInvoices(infakt, entries));

  return {
    orders: byOrderId,
    report: {
      entries,
      summary: { ...summarizePlan(entries), invoices_considered: invoices.length },
      truncated: ordersTruncated || invoicesTruncated,
      window: { from: params.from, to: params.to, tolerance_days: params.toleranceDays },
    },
  };
}

/**
 * Guard exactly as the single-invoice adopt action does: refused-with-a-reason,
 * never the API client getter's throw. The pause switch is deliberately NOT
 * consulted - adoption issues nothing, and an operator reconciling history is very
 * likely to be doing it with invoicing paused.
 */
async function requireEnabled(
  infakt: InfaktModuleService,
  res: MedusaResponse,
): Promise<ResolvedInfaktOptions | null> {
  const options = await infakt.getEffectiveOptions();
  if (!options.enabled) {
    res.status(409).json({
      error: "the plugin is disabled (no `apiKey` configured) - there is no inFakt to adopt from",
    });
    return null;
  }
  return options;
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);
  const options = await requireEnabled(infakt, res);
  if (!options) {
    return;
  }

  const params = {
    from: readDay(req.query.from, "from"),
    to: readDay(req.query.to, "to"),
    toleranceDays: resolveDateTolerance(req.query.tolerance_days),
  };
  const { report } = await buildReport(req, infakt, options, params);
  res.json({ ...report, applied: false });
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);
  const options = await requireEnabled(infakt, res);
  if (!options) {
    return;
  }

  const body = (req.body ?? {}) as ReconcileBody;
  const params = {
    from: readDay(body.from, "from"),
    to: readDay(body.to, "to"),
    toleranceDays: resolveDateTolerance(body.tolerance_days),
  };
  const { report } = await buildReport(req, infakt, options, params);

  const requested = Array.isArray(body.order_ids) ? body.order_ids.map(String) : [];
  if (body.apply !== true) {
    res.json({ ...report, applied: false });
    return;
  }
  if (requested.length === 0) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "`order_ids` must name the orders to adopt. Applying every match at once is deliberately not possible.",
    );
  }

  const wanted = new Set(requested);
  const adoptions = report.entries
    .filter((entry) => wanted.has(entry.orderId) && entry.decision === "adopt")
    .map((entry) => toAdoption(entry, options));

  const refused = requested.filter(
    (orderId) => !adoptions.some((adoption) => adoption.orderId === orderId),
  );

  const { result } = (await adoptInvoicesWorkflow(req.scope).run({
    input: { adoptions },
  })) as { result: AdoptInvoicesResult };

  res.json({
    ...report,
    adopted: result.adopted,
    applied: true,
    // Named orders whose match did not survive the re-derivation. Reported rather
    // than quietly dropped: the operator saw something the server no longer agrees
    // with, and that is worth knowing.
    refused,
    skipped: result.skipped,
  });
}

/** Freeze the KSeF decision for an adopted document, from ITS tax code. */
function toAdoption(entry: AdoptionPlanEntry, options: ResolvedInfaktOptions): AdoptInvoiceInput {
  const { isCompany, nip } = invoiceIsCompany(entry.invoiceTaxCode);
  const decision = decideKsef(
    { isCompany, nip, orderId: entry.orderId },
    options.ksefMode,
    options.ksefDecide,
  );
  return {
    evidence: JSON.stringify(entry.evidence),
    invoiceDate: entry.invoice?.invoiceDate ?? null,
    invoiceNumber: entry.invoice?.number ?? null,
    invoiceUuid: entry.invoice?.uuid ?? "",
    isCompany,
    ksefDecisionReason: decision.reason,
    ksefRequired: decision.file,
    orderId: entry.orderId,
  };
}
