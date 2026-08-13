/**
 * Shapes the admin UI reads off this plugin's routes.
 *
 * Declared here rather than imported from `src/lib` and `src/modules`: the admin
 * bundle is compiled by Vite against `src/admin/tsconfig.json` and must not pull in
 * server code, which would drag `@medusajs/framework` into a browser bundle.
 */

export interface InfaktConfig {
  environment: "production" | "sandbox";
  startDate: string | null;
  currency: string;
  taxSymbol: string;
  triggerEvent: string;
  ksefMode: "nip-only" | "all" | "never";
  ksefRequireActive: boolean;
  ksefCustomPredicate: boolean;
  emitIssuedEvent: boolean;
  /** True when the plugin is inert because no `apiKey` is configured. */
  disabled: boolean;
}

export interface InfaktRunState {
  id: string;
  status: "idle" | "running" | "ok" | "error";
  last_run_at?: string | null;
  last_error?: string | null;
  processed?: number;
  ksef_active?: boolean | null;
  ksef_checked_at?: string | null;
  ksef_error?: string | null;
}

export type InvoiceStatus = "pending" | "processing" | "done" | "skipped" | "needs_review";

export interface InfaktInvoiceRow {
  id: string;
  order_id: string;
  status: InvoiceStatus;
  is_company: boolean;
  invoice_number?: string | null;
  invoice_uuid?: string | null;
  ksef_required?: boolean | null;
  ksef_decision_reason?: string | null;
  ksef_number?: string | null;
  ksef_status?: string | null;
  submit_started_at?: string | null;
  task_reference?: string | null;
  attempts: number;
  next_attempt_at?: string | null;
  last_error?: string | null;
  skip_reason?: string | null;
  completed_at?: string | null;
  adopted_at?: string | null;
  created_at?: string;
  /** Server-computed: retrying this row could issue a duplicate invoice. */
  in_crash_window: boolean;
}

export interface OverviewResponse {
  config: InfaktConfig;
  counts: Record<InvoiceStatus, number>;
  crash_window_count: number;
  run_state: InfaktRunState;
}

export interface InvoiceListResponse {
  invoices: InfaktInvoiceRow[];
  limit: number;
  offset: number;
}

export type EnablementReason = "env_force_disabled" | "no_api_key" | "paused" | "active";

/** One invoice inFakt holds, as the reconciliation report describes it. */
export interface ReconcileCandidate {
  uuid: string;
  number: string | null;
  invoiceDate: string | null;
  grossPrice: number | null;
}

/**
 * One order's reconciliation outcome, from `/admin/infakt/reconcile`.
 *
 * `decision` is the whole contract: only `adopt` may be applied, and only by
 * naming the order explicitly. `ambiguous` covers every case a human has to
 * settle - several invoices fit, or the one that fits is already recorded
 * against another order.
 */
export interface ReconcileEntry {
  orderId: string;
  displayId?: number | string | null;
  decision: "adopt" | "ambiguous" | "no_match";
  invoice?: ReconcileCandidate;
  confidence?: "high" | "medium";
  candidates: ReconcileCandidate[];
  reasons: string[];
}

export interface ReconcileResponse {
  window: { from: string; to: string; tolerance_days: number };
  summary: {
    scanned: number;
    adopt: number;
    ambiguous: number;
    no_match: number;
    invoices_considered: number;
  };
  /** The window held more orders or invoices than one pass reads. Narrow it. */
  truncated: boolean;
  entries: ReconcileEntry[];
  applied: boolean;
  adopted?: { order_id: string; invoice_number: string | null; invoice_uuid: string }[];
  skipped?: { order_id: string; reason: string }[];
  /** Named orders whose match did not survive the server's re-derivation. */
  refused?: string[];
}

/**
 * The raw admin-editable overrides, exactly as saved - null means "not
 * overridden, following `medusa-config.ts`". This is what the Settings page's
 * form fields are seeded from: seeding from `effective` instead would make the
 * form claim an override exists the moment the boot value happens to match it.
 */
export interface InfaktConfigOverrideValues {
  currency: string | null;
  ksef_mode: "nip-only" | "all" | "never" | null;
  trigger_event: "payment.captured" | "order.placed" | null;
  environment: "production" | "sandbox" | null;
}

/** The merged, currently-in-effect value of every admin-editable field. */
export interface InfaktEffectiveConfigValues {
  currency: string;
  ksef_mode: "nip-only" | "all" | "never";
  trigger_event: "payment.captured" | "order.placed";
  environment: "production" | "sandbox";
}

/**
 * The live picture behind the plugin's runtime enable switch and every other
 * admin-editable field, from `GET /admin/infakt/settings`. Distinct from
 * `InfaktConfig` (which is fixed at boot, from `medusa-config.ts` alone):
 * every field here can change without a restart, so this is fetched fresh
 * rather than derived from `InfaktConfig`.
 */
export interface InfaktSettings {
  invoicing_paused: boolean;
  env_force_disabled: boolean;
  api_key_configured: boolean;
  /** Whether an `apiKey` OVERRIDE specifically is saved - distinct from `api_key_configured`. */
  api_key_override_configured: boolean;
  effective_enabled: boolean;
  reason: EnablementReason;
  settings: InfaktConfigOverrideValues;
  effective: InfaktEffectiveConfigValues;
}
