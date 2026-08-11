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
 *
 * The invoice ledger, newest first, optionally filtered by status. `needs_review`
 * is the reason this route exists: without a surface for it, a parked invoice is
 * invisible until a customer asks where theirs is.
 *
 * Each row is annotated with `in_crash_window`, so the UI can disable retry on the
 * rows where retrying could issue a duplicate rather than letting an operator find
 * out from the error message.
 */
export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);

  const requested = String(req.query.status ?? "").trim();
  const status = (VALID_STATUSES as readonly string[]).includes(requested) ? requested : undefined;
  const limit = parseNumber(req.query.limit, DEFAULT_LIMIT, MAX_LIMIT);
  const offset = parseNumber(req.query.offset, 0, Number.MAX_SAFE_INTEGER);

  const rows = (await infakt.listInfaktInvoices(status ? { status: [status] } : {}, {
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
