import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import { MedusaError } from "@medusajs/framework/utils";
import { runSettlement } from "../../../../lib/invoicing/settlement-run";
import {
  isSettlementAutoFixable,
  SETTLEMENT_WINDOW_DAYS,
  settlementWindowStart,
  summarizeSettlement,
} from "../../../../lib/invoicing/settlement";
import type { SettlementDrift } from "../../../../lib/invoicing/settlement";
import { INFAKT_MODULE } from "../../../../modules/infakt";
import type InfaktModuleService from "../../../../modules/infakt/service";

/**
 * GET  /admin/infakt/settlement?days=90&full=true
 * POST /admin/infakt/settlement  { days?, full?, force?, order_ids? }
 *
 * Does inFakt agree that these orders were paid?
 *
 * ## The two methods are not the same shape as the reconcile endpoint's
 *
 * On `/admin/infakt/reconcile`, GET previews and POST can APPLY. Here nothing
 * can be applied, by design:
 *
 *  - **GET reads the ledger.** It calls nothing external and costs one query, so
 *    it is safe to poll and safe to leave open in a tab. What it renders is what
 *    the reconciliation last recorded.
 *  - **POST re-reads inFakt** for the rows in scope and updates the same four
 *    columns, then answers with the refreshed report. It is a REFRESH, not an
 *    action: it never marks an invoice paid, never writes payment state into
 *    Medusa, and never touches the issuing state machine.
 *
 * `apply: true` is refused outright rather than ignored. Auto-fixing does not
 * exist in this version, and a caller who asked for it must be told so - not
 * left believing a discrepancy was corrected. The report already names the rows
 * a future fix would touch (`auto_fixable`), which is the number to look at
 * before arming one.
 *
 * ## Adopted invoices are reported, never fixed
 *
 * An invoice an operator adopted existed before its ledger row did. Its payment
 * bookkeeping belongs to whoever issued it, so it is reported like any other row
 * and is excluded from `auto_fixable` whatever its drift code says.
 */

const MAX_ROWS = 5_000;

interface SettlementBody {
  days?: number | string;
  full?: boolean;
  force?: boolean;
  order_ids?: string[];
  /** Refused, always. See the docblock above. */
  apply?: boolean;
}

/** The ledger columns the report renders. */
interface LedgerRow {
  order_id: string;
  invoice_uuid?: string | null;
  invoice_number?: string | null;
  adopted_at?: Date | string | null;
  status?: string | null;
  created_at?: Date | string | null;
  settled_at?: Date | string | null;
  settlement_checked_at?: Date | string | null;
  settlement_drift?: string | null;
  settlement_paid_minor?: number | string | null;
}

const toIso = (value: Date | string | null | undefined): string | null =>
  value ? new Date(value).toISOString() : null;

/**
 * Whole days, bounded and rejected loudly rather than silently defaulted.
 *
 * The upper bound is not arithmetic hygiene: `days` decides how much of the
 * ledger a POST re-reads from inFakt, and an unbounded value from a query string
 * is an unbounded number of API requests. A full pass is available, but it has to
 * be asked for by name (`full`), which is the point.
 */
function readDays(value: unknown, fallback = SETTLEMENT_WINDOW_DAYS): number {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const days = Number(value);
  if (!Number.isFinite(days) || !Number.isInteger(days) || days < 1 || days > 3_650) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "`days` must be a whole number of days between 1 and 3650.",
    );
  }
  return days;
}

const isTrue = (value: unknown): boolean => value === true || value === "true";

interface SettlementReportEntry {
  order_id: string;
  invoice_uuid: string | null;
  invoice_number: string | null;
  adopted: boolean;
  status: string | null;
  settled_at: string | null;
  checked_at: string | null;
  /** How long ago this row was last read from inFakt. Null when never. */
  checked_age_seconds: number | null;
  drift: SettlementDrift | null;
  auto_fixable: boolean;
  paid_minor: number | null;
}

/**
 * Build the report from the ledger. Reads the database and nothing else.
 *
 * `never_checked` and `oldest_checked_age_seconds` are the two numbers that make
 * a stopped reconciliation visible. Without them a ledger nobody has read since
 * Tuesday looks exactly like a perfectly settled one - which is the failure mode
 * this whole mechanism exists to stop being invisible.
 */
async function buildReport(
  infakt: InfaktModuleService,
  params: { days: number; full: boolean },
): Promise<Record<string, unknown>> {
  const now = new Date();
  const rows = (await infakt.listSettlementLedger({
    createdAfter: params.full ? null : settlementWindowStart(now, params.days),
    limit: MAX_ROWS,
  })) as unknown as LedgerRow[];

  let neverChecked = 0;
  let oldestCheckedAge: number | null = null;

  const entries: SettlementReportEntry[] = rows.map((row) => {
    const adopted = Boolean(row.adopted_at);
    const drift = (row.settlement_drift ?? null) as SettlementDrift | null;
    const checkedAt = row.settlement_checked_at ? new Date(row.settlement_checked_at) : null;
    const ageSeconds = checkedAt
      ? Math.max(0, Math.round((now.getTime() - checkedAt.getTime()) / 1000))
      : null;
    if (ageSeconds === null) {
      neverChecked += 1;
    } else if (oldestCheckedAge === null || ageSeconds > oldestCheckedAge) {
      oldestCheckedAge = ageSeconds;
    }
    return {
      adopted,
      auto_fixable: isSettlementAutoFixable(drift, { adopted }),
      checked_age_seconds: ageSeconds,
      checked_at: toIso(row.settlement_checked_at),
      drift,
      invoice_number: row.invoice_number ?? null,
      invoice_uuid: row.invoice_uuid ?? null,
      order_id: row.order_id,
      paid_minor:
        row.settlement_paid_minor === null || row.settlement_paid_minor === undefined
          ? null
          : Math.round(Number(row.settlement_paid_minor)),
      settled_at: toIso(row.settled_at),
      status: row.status ?? null,
    };
  });

  return {
    entries,
    summary: {
      ...summarizeSettlement(
        entries.map((entry) => ({
          adopted: entry.adopted,
          drift: entry.drift,
          settledAt: entry.settled_at,
        })),
      ),
      never_checked: neverChecked,
      oldest_checked_age_seconds: oldestCheckedAge,
    },
    truncated: rows.length >= MAX_ROWS,
    window: { days: params.full ? null : params.days, full: params.full },
  };
}

/**
 * The plugin has to be configured for any of this to mean anything, but the
 * PAUSE switch is deliberately not consulted - reading a settlement report
 * issues nothing, and an operator reconciling their books is very likely to be
 * doing it with invoicing paused. Same reasoning as `/admin/infakt/reconcile`.
 */
async function requireConfigured(
  infakt: InfaktModuleService,
  res: MedusaResponse,
): Promise<boolean> {
  const options = await infakt.getEffectiveOptions();
  if (!options.enabled) {
    res.status(409).json({
      error: "the plugin is disabled (no `apiKey` configured) - there is no inFakt to reconcile against",
    });
    return false;
  }
  return true;
}

export async function GET(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);
  if (!(await requireConfigured(infakt, res))) {
    return;
  }
  const params = { days: readDays(req.query.days), full: isTrue(req.query.full) };
  res.json({ ...(await buildReport(infakt, params)), refreshed: false });
}

export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);
  if (!(await requireConfigured(infakt, res))) {
    return;
  }

  const body = (req.body ?? {}) as SettlementBody;
  if (body.apply === true) {
    throw new MedusaError(
      MedusaError.Types.INVALID_DATA,
      "`apply` is not supported: this endpoint reports settlement drift and never corrects it. " +
        "An invoice that inFakt has not settled has to be settled there, by a human who has seen why.",
    );
  }

  const params = { days: readDays(body.days), full: body.full === true };
  const orderIds = Array.isArray(body.order_ids) ? body.order_ids.map(String) : undefined;

  const run = await runSettlement(req.scope, {
    force: true,
    full: params.full,
    // An operator asking for this explicitly is the one caller allowed to run it
    // while invoicing is paused.
    ignorePause: true,
    orderIds,
    source: "medusa-infakt/admin-settlement",
    windowDays: params.days,
  });

  res.json({
    ...(await buildReport(infakt, params)),
    checked: run.summary.checked,
    refreshed: true,
    run_skipped: run.skippedRun ?? null,
    skipped: run.skipped,
  });
}
