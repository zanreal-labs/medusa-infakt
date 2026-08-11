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
  /** True when the pipeline is inert because `startDate` is missing or invalid. */
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
