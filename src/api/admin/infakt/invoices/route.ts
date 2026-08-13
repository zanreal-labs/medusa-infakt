import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { isInCrashWindow } from "../../../../lib/invoicing/operator-actions";
import type { InvoiceStateRow } from "../../../../lib/invoicing/state-machine";
import { INFAKT_MODULE } from "../../../../modules/infakt";
import type InfaktModuleService from "../../../../modules/infakt/service";

const VALID_STATUSES = ["pending", "processing", "done", "skipped", "needs_review"] as const;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const parseNumber = (raw: unknown, fallback: number, max: number): number => {
  const value = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.min(value, max);
};

/**
 * GET /admin/infakt/invoices?status=needs_review&limit=50&offset=0
 * GET /admin/infakt/invoices?order_id=order_01...
 *
 * The invoice ledger, newest first, optionally filtered by status - or narrowed to
 * a single order with `order_id`, which is how the order-detail widget reads the
 * one row it renders.
 *
 * Never touches `apiClient`, so it answers 200 in every state: an unconfigured,
 * paused or empty plugin returns `{ invoices: [] }`, not a 500. When `order_id`
 * matches no row (the order was never queued) the same empty payload is returned,
 * which the widget renders as "not queued" rather than treating as an error.
 *
 * Each row is annotated with `in_crash_window`, so the UI can disable retry on the
 * rows where retrying could issue a duplicate rather than letting an operator find
 * out from the error message.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);

  const orderId = String(req.query.order_id ?? "").trim();
  const requested = String(req.query.status ?? "").trim();
  const status = (VALID_STATUSES as readonly string[]).includes(requested) ? requested : undefined;
  const limit = parseNumber(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const offset = parseNumber(req.query.offset, 0, Number.MAX_SAFE_INTEGER);

  // `order_id` is an exact lookup and takes precedence over a status filter: the
  // widget asks for one order's row, and mixing in a status filter could hide it.
  let filters: Record<string, unknown> = {};
  if (orderId) {
    filters = { order_id: [orderId] };
  } else if (status) {
    filters = { status: [status] };
  }

  const rows = (await infakt.listInfaktInvoices(filters, {
    order: { created_at: "DESC" },
    skip: offset,
    take: limit,
  })) as unknown as (InvoiceStateRow & { id: string; order_id: string })[];

  res.json({
    invoices: rows.map((row) => ({
      ...row,
      in_crash_window: isInCrashWindow(row, true),
    })),
    limit,
    offset,
  });
}
