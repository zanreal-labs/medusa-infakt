import type { InfaktInvoiceRow } from "./types";

/**
 * The order's invoicing milestones, derived from the one ledger row the widget
 * already loaded - nothing here fetches, writes or infers anything new.
 *
 * ## Why this exists at all
 *
 * The Medusa 2.18 admin order "Activity" timeline is a closed set. Its
 * `useActivityItems(order)` builds entries ONLY from payments, fulfillments and
 * `order_change` rows whose type is one of a fixed list (edit / claim / exchange
 * / return / transfer / update_order); `const notes = []` is a hardcoded dead
 * placeholder. A plugin cannot inject a visible entry there without forking the
 * dashboard bundle. So the sanctioned surface for "when was this invoice issued,
 * and when was it filed to KSeF" is the plugin's OWN order widget, reading the
 * plugin's own data - which is what this function feeds.
 *
 * ## Idempotency is the whole game
 *
 * Each entry carries a STABLE `key` derived from the persisted identifiers on the
 * row, never from render time. Deriving the same row twice - a sweep re-reading a
 * row it already saw, a re-render, a re-mount - yields entries whose keys are
 * byte-for-byte identical, so any caller keying by `entry.key` (e.g.
 * `new Map(entries.map((e) => [e.key, e]))`) collapses the re-runs to exactly one
 * entry. This is the same one-per-order guarantee the ledger's unique `order_id`
 * gives the pipeline, carried through to the read side.
 *
 * ## No PII, by construction
 *
 * The row itself excludes buyer name / email / NIP (see the model doc), and this
 * function only ever reads invoice_number, invoice_uuid, order_id, ksef_number
 * and ksef_status. Nothing it emits can carry buyer data.
 */

export interface TimelineEntry {
  /** Stable across re-derivations of the same persisted row; dedupe key. */
  key: string;
  /** Already-translated, human-readable label. */
  title: string;
  /** ISO timestamp for the milestone, or null when the row never recorded one. */
  timestamp: string | null;
}

/**
 * The minimal translator shape this module needs: `(key, defaultValue, options)`,
 * the same call `i18next`'s `TFunction` answers. Kept as its own tiny type so the
 * derivation stays testable outside any React render - the default below returns
 * the English `defaultValue` with `{{token}}` interpolation applied, so a caller
 * with no `t` (the unit tests) still gets sensible, deterministic titles.
 */
export type Translate = (
  key: string,
  defaultValue: string,
  options?: Record<string, unknown>,
) => string;

const identityT: Translate = (_key, defaultValue, options) => {
  if (!options) {
    return defaultValue;
  }
  return defaultValue.replace(/\{\{(\w+)\}\}/g, (whole, name: string) =>
    name in options ? String(options[name]) : whole,
  );
};

/**
 * Normalize the model's timestamp columns (a `Date` on the server, a string once
 * it has crossed the JSON boundary the widget reads through) to a plain ISO
 * string or null. Keeps `TimelineEntry.timestamp` a stable, comparable value.
 */
const toIso = (value?: string | Date | null): string | null => {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  return value;
};

/**
 * A KSeF filing counts as having actually happened only when inFakt gave back a
 * number (the filing succeeded) or the last status seen says it left for KSeF.
 * `ksef_status` is one of "sent" / "success" / "error" (see the model), so an
 * "error" - or a null status with no number - is NOT a filing and emits nothing.
 */
const KSEF_FILED_STATUSES = new Set(["sent", "success"]);

const wasFiledToKsef = (row: InfaktInvoiceRow): boolean =>
  Boolean(row.ksef_number) || (row.ksef_status ? KSEF_FILED_STATUSES.has(row.ksef_status) : false);

/**
 * Build the milestone list for one row, oldest-first (issuance, then its KSeF
 * filing - the order they happen in). Returns `[]` for any row that is not yet a
 * real, issued invoice, so a pending / processing / needs_review / skipped row
 * contributes no history at all.
 */
export const buildInvoiceTimeline = (
  row: InfaktInvoiceRow,
  t: Translate = identityT,
): TimelineEntry[] => {
  const entries: TimelineEntry[] = [];

  // Issuance: only once the invoice is genuinely issued - a terminal `done` row
  // that carries an inFakt identifier. A `done` row with neither a number nor a
  // uuid is not an issued invoice (nothing to point at), and every non-terminal
  // or `skipped` status is, by definition, not issued.
  const isIssued = row.status === "done" && Boolean(row.invoice_number || row.invoice_uuid);
  if (isIssued) {
    const numberLabel =
      row.invoice_number ?? t("infakt.orderWidget.history.numberPending", "(number pending)");
    entries.push({
      // The number is the natural, stable identity of an issued invoice; the uuid
      // covers the number-still-pending window; order_id is the last-resort floor
      // (a row can only be `done` for one order, so it is always unique).
      key: row.invoice_number ?? row.invoice_uuid ?? row.order_id,
      timestamp: toIso(row.completed_at),
      title: t("infakt.orderWidget.history.invoiceIssued", "Invoice {{number}} issued", {
        number: numberLabel,
      }),
    });
  }

  // KSeF filing: only when it actually filed, and never for a consumer invoice
  // (`ksef_required === false`), which is outside KSeF by law and will never file.
  if (row.ksef_required !== false && wasFiledToKsef(row)) {
    const detail = row.ksef_number ?? row.ksef_status ?? null;
    entries.push({
      // `ksef:` namespaces this apart from the issuance key even in the unlikely
      // event the same string served both. The KSeF number is the stable identity
      // once present; before it, the invoice number, then order_id, keep the key
      // constant across re-derivations of the same row.
      key: `ksef:${row.ksef_number ?? row.invoice_number ?? row.order_id}`,
      // `ksef_sent_at` is written before the submit; it is the honest "left for
      // KSeF" time. Fall back to the issuance time only when it is absent.
      timestamp: toIso(row.ksef_sent_at) ?? toIso(row.completed_at),
      title: detail
        ? t("infakt.orderWidget.history.ksefFiledDetail", "Sent to KSeF: {{detail}}", { detail })
        : t("infakt.orderWidget.history.ksefFiled", "Sent to KSeF"),
    });
  }

  return entries;
};
