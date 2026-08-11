import { InfaktApiError } from "./errors";
import { INFAKT_ENDPOINTS } from "./types";
import type {
  InfaktAsyncTask,
  InfaktAsyncTaskStatus,
  InfaktClientOptions,
  InfaktEnvironment,
  InfaktInvoice,
  InfaktInvoicePayload,
  InfaktKsefIntegration,
  InfaktKsefStatus,
} from "./types";

const DEFAULT_TIMEOUT_MS = 60_000;

interface RequestOptions {
  query?: Record<string, string | undefined>;
  body?: unknown;
}

// ---------- Raw (snake_case) API response shapes ----------

interface AsyncTaskResponse {
  invoice_task_reference_number: string;
  processing_code?: number;
  processing_description?: string;
}

interface AsyncTaskStatusResponse {
  processing_code: number;
  processing_description?: string;
  invoice_uuid?: string | null;
  /** Not shown in the documented examples; mapped defensively when present. */
  invoice_number?: string | null;
  invoice_errors?: Record<string, unknown>;
}

interface InvoiceServiceResponse {
  name?: string | null;
  quantity?: number | string | null;
  gross_price?: number | null;
}

interface InvoiceResponse {
  uuid: string;
  number?: string | null;
  status?: string | null;
  gross_price?: number | null;
  currency?: string | null;
  invoice_date?: string | null;
  client_tax_code?: string | null;
  client_email?: string | null;
  client_first_name?: string | null;
  client_last_name?: string | null;
  client_company_name?: string | null;
  services?: InvoiceServiceResponse[] | null;
}

interface InvoiceListResponse {
  entities?: InvoiceResponse[];
  metainfo?: { count?: number; total_count?: number };
}

interface KsefStatusResponse {
  status: string;
  ksef_number?: string | null;
  status_description?: string | null;
  request_uuid?: string | null;
}

interface KsefIntegrationResponse {
  active?: boolean | null;
  incomes_last_fetched_at?: string | null;
  costs_last_fetched_at?: string | null;
}

/**
 * Async invoice-task processing codes, per the official interactive docs
 * (docs.infakt.pl, Faktury VAT, "Sprawdz status przetwarzania"):
 *
 *   100 - Zlecenie przyjete (accepted)
 *   120 - Zlecenie czeka na przetworzenie (queued)
 *   140 - Zlecenie jest w trakcie przetwarzania (processing)
 *   200 - action processed, e.g. "Faktura zostala oznaczona jako zaplacona"
 *         (terminal success for action tasks such as mark-as-paid)
 *   201 - Faktura stworzona (terminal success for create tasks;
 *         `invoice_uuid` is present in the response)
 *   422 - Nie udalo sie stworzyc faktury / oznaczyc jako zaplaconej
 *         (terminal failure; field errors in `invoice_errors`)
 *
 * Derivation: done = 200/201 (the documented terminal successes); failed = any
 * code >= 400 (422 is the only documented failure code, but the codes follow
 * HTTP semantics, so the whole 4xx/5xx range is treated as terminal failure).
 * Everything else (100/120/140) is pending.
 */
const isTaskDone = (code: number): boolean => code === 200 || code === 201;
const isTaskFailed = (code: number): boolean => code >= 400;

const buildQuery = (q: RequestOptions["query"]): string => {
  if (!q) {
    return "";
  }
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) {
    if (v === undefined) {
      continue;
    }
    params.append(k, v);
  }
  const s = params.toString();
  return s ? `?${s}` : "";
};

/**
 * Build a short human-readable message from an inFakt error body. inFakt errors
 * come as `{ "error": "..." }` or `{ "errors": { field: [msgs] } }`
 * (validation). Only the response body is used - never the request payload,
 * which carries buyer PII.
 */
const messageFromErrorBody = (body: unknown, fallback: string): string => {
  if (typeof body !== "object" || body === null) {
    return fallback;
  }
  const rec = body as Record<string, unknown>;
  if (typeof rec.error === "string" && rec.error.length > 0) {
    return rec.error;
  }
  if (typeof rec.errors === "object" && rec.errors !== null) {
    const parts: string[] = [];
    for (const [field, msgs] of Object.entries(rec.errors)) {
      const text = Array.isArray(msgs) ? msgs.join(", ") : String(msgs);
      parts.push(`${field}: ${text}`);
      if (parts.length >= 3) {
        break;
      }
    }
    if (parts.length > 0) {
      return parts.join("; ");
    }
  }
  return fallback;
};

const buildError = async (res: Response): Promise<InfaktApiError> => {
  const contentType = res.headers.get("content-type") ?? "";
  let body: unknown;
  try {
    body = contentType.includes("json") ? await res.json() : await res.text();
  } catch {
    body = undefined;
  }
  return new InfaktApiError({
    body,
    httpStatus: res.status,
    message: messageFromErrorBody(body, `inFakt HTTP ${res.status} ${res.statusText}`),
  });
};

const toNumber = (value: number | string | null | undefined): number | undefined => {
  if (value === null || value === undefined) {
    return undefined;
  }
  const parsed = typeof value === "number" ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const mapInvoice = (raw: InvoiceResponse): InfaktInvoice => ({
  clientCompanyName: raw.client_company_name ?? undefined,
  clientEmail: raw.client_email ?? undefined,
  clientFirstName: raw.client_first_name ?? undefined,
  clientLastName: raw.client_last_name ?? undefined,
  clientTaxCode: raw.client_tax_code ?? undefined,
  currency: raw.currency ?? undefined,
  grossPrice: raw.gross_price ?? undefined,
  invoiceDate: raw.invoice_date ?? undefined,
  number: raw.number ?? undefined,
  services: raw.services
    ? raw.services.map((service) => ({
        grossPrice: service.gross_price ?? undefined,
        name: service.name ?? "",
        quantity: toNumber(service.quantity) ?? 0,
      }))
    : undefined,
  status: raw.status ?? undefined,
  uuid: raw.uuid,
});

/**
 * Zero-dependency inFakt API v3 client.
 *
 * Only the endpoints this plugin needs are wrapped, each mapped to a camelCase
 * shape so no snake_case leaks past this module. Everything is a plain `fetch`
 * with an `AbortController` timeout; there is no retry here on purpose - the
 * worker owns retry policy, and a client that silently retried a POST would
 * defeat the whole no-duplicate-invoice design (inFakt has no idempotency key).
 */
export class InfaktClient {
  private readonly apiKey: string;
  private readonly env: InfaktEnvironment;
  private readonly timeoutMs: number;

  constructor(options: InfaktClientOptions) {
    if (!options.apiKey) {
      // Deliberately a plain Error, not a MedusaError: this module is a
      // standalone API client with no Medusa imports, so it stays usable (and
      // testable) outside a Medusa container. The option that feeds this is
      // already validated at boot by the module loader, so reaching this line at
      // all means a programming error inside the plugin, not a request Medusa
      // needs to map to an HTTP status.
      // eslint-disable-next-line @medusajs/use-medusa-error-not-generic-error
      throw new Error("InfaktClient: apiKey is required.");
    }
    this.apiKey = options.apiKey;
    this.env = options.environment ?? "production";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  // ---------- Invoices ----------

  /**
   * POST /async/invoices.json - create an invoice asynchronously. The payload is
   * wrapped as `{ "invoice": { ... } }`. Poll `getInvoiceTaskStatus` with the
   * returned reference number until the task settles.
   *
   * This is the one destructive call in the plugin: a successful POST issues a
   * real, numbered invoice under Polish law. There is no idempotency key, so
   * every caller MUST persist its intent before invoking this (see the
   * crash-window design in the README).
   */
  async createInvoiceAsync(invoice: InfaktInvoicePayload): Promise<InfaktAsyncTask> {
    const raw = await this.request<AsyncTaskResponse>("POST", "/async/invoices.json", {
      body: { invoice },
    });
    return {
      invoiceTaskReferenceNumber: raw.invoice_task_reference_number,
      processingCode: raw.processing_code,
      processingDescription: raw.processing_description,
    };
  }

  /** GET /async/invoices/status/{reference}.json - poll an async invoice task. */
  async getInvoiceTaskStatus(referenceNumber: string): Promise<InfaktAsyncTaskStatus> {
    const raw = await this.request<AsyncTaskStatusResponse>(
      "GET",
      `/async/invoices/status/${encodeURIComponent(referenceNumber)}.json`,
    );
    const code = raw.processing_code;
    return {
      done: isTaskDone(code),
      failed: isTaskFailed(code),
      invoiceNumber: raw.invoice_number ?? undefined,
      invoiceUuid: raw.invoice_uuid ?? undefined,
      processingCode: code,
      processingDescription: raw.processing_description,
    };
  }

  /** GET /invoices/{uuid}.json - the detail response, including line positions. */
  async getInvoice(uuid: string): Promise<InfaktInvoice> {
    const raw = await this.request<InvoiceResponse>(
      "GET",
      `/invoices/${encodeURIComponent(uuid)}.json`,
    );
    return mapInvoice(raw);
  }

  /**
   * GET /invoices.json - the invoice list, used by the reconciliation tool to
   * find an invoice that already exists for an order. Paged via `offset`/`limit`
   * (inFakt caps `limit` at 100).
   */
  async listInvoices(options?: { offset?: number; limit?: number }): Promise<InfaktInvoice[]> {
    const raw = await this.request<InvoiceListResponse>("GET", "/invoices.json", {
      query: {
        limit: options?.limit === undefined ? undefined : String(options.limit),
        offset: options?.offset === undefined ? undefined : String(options.offset),
      },
    });
    return (raw?.entities ?? []).map(mapInvoice);
  }

  /**
   * GET /invoices/{uuid}/pdf.json - the response is a raw binary PDF
   * (github.com/infakt/API readme.md, "Pobranie PDF").
   *
   * Downloading the PDF flips the invoice status to "printed" on the inFakt
   * side. That is a side effect, not a mistake: it is how inFakt records that
   * the document left the system.
   */
  async getInvoicePdf(
    uuid: string,
    options?: { documentType?: string; locale?: string },
  ): Promise<Uint8Array> {
    const res = await this.send("GET", `/invoices/${encodeURIComponent(uuid)}/pdf.json`, {
      query: {
        document_type: options?.documentType ?? "original",
        locale: options?.locale ?? "pl",
      },
    });
    if (!res.ok) {
      throw await buildError(res);
    }
    return new Uint8Array(await res.arrayBuffer());
  }

  /**
   * POST /async/invoices/{uuid}/paid.json - mark an invoice as paid.
   * Asynchronous: HTTP 201 means the task was accepted, not that the invoice is
   * paid. `paidDate` (YYYY-MM-DD) must not precede the invoice date.
   */
  async markPaid(uuid: string, paidDate?: string): Promise<void> {
    await this.request("POST", `/async/invoices/${encodeURIComponent(uuid)}/paid.json`, {
      body: paidDate ? { paid_date: paidDate } : {},
    });
  }

  // ---------- KSeF ----------

  /**
   * POST /invoices/{uuid}/send_to_ksef.json - submit the invoice to KSeF.
   *
   * Sent with no body (the optional `inform_via_email` block is not used - the
   * plugin does not email buyers on the merchant's behalf). Track progress via
   * `getKsefStatus`. Returns HTTP 422 when the account has no active KSeF
   * integration, and also when the invoice was already submitted.
   */
  async sendToKsef(uuid: string): Promise<void> {
    await this.request("POST", `/invoices/${encodeURIComponent(uuid)}/send_to_ksef.json`);
  }

  /** GET /ksef/documents/{uuid}/status.json - poll the KSeF submission. */
  async getKsefStatus(uuid: string): Promise<InfaktKsefStatus> {
    const raw = await this.request<KsefStatusResponse>(
      "GET",
      `/ksef/documents/${encodeURIComponent(uuid)}/status.json`,
    );
    return {
      ksefNumber: raw.ksef_number ?? undefined,
      requestUuid: raw.request_uuid ?? undefined,
      status: raw.status,
      statusDescription: raw.status_description ?? undefined,
    };
  }

  /**
   * GET /ksef/integration.json - is the account's KSeF integration live?
   *
   * Falls back to `/ksef2/integration.json` when the legacy namespace answers
   * 403/404. The two namespaces need different scopes - the legacy one wants
   * `api:ksef:integration:write`, KSeF 2.0 only `api:invoices:read` - so an API
   * key scoped for invoicing alone can read the status from `/ksef2/` while
   * being refused by `/ksef/` (github.com/infakt/API ksef.md).
   */
  async getKsefIntegration(): Promise<InfaktKsefIntegration> {
    try {
      return this.mapKsefIntegration(
        await this.request<KsefIntegrationResponse>("GET", "/ksef/integration.json"),
      );
    } catch (error) {
      const status = error instanceof InfaktApiError ? error.httpStatus : 0;
      if (status !== 403 && status !== 404) {
        throw error;
      }
      return this.mapKsefIntegration(
        await this.request<KsefIntegrationResponse>("GET", "/ksef2/integration.json"),
      );
    }
  }

  private mapKsefIntegration(raw: KsefIntegrationResponse | undefined): InfaktKsefIntegration {
    return {
      active: raw?.active === true,
      costsLastFetchedAt: raw?.costs_last_fetched_at ?? undefined,
      incomesLastFetchedAt: raw?.incomes_last_fetched_at ?? undefined,
    };
  }

  // ---------- Core ----------

  private async send(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: RequestOptions = {},
  ): Promise<Response> {
    const url = `${INFAKT_ENDPOINTS[this.env]}${path}${buildQuery(opts.query)}`;
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-inFakt-ApiKey": this.apiKey,
    };
    if (opts.body !== undefined) {
      headers["Content-Type"] = "application/json";
    }

    const init: RequestInit = { headers, method };
    if (opts.body !== undefined) {
      init.body = JSON.stringify(opts.body);
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: controller.signal });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new InfaktApiError({
        httpStatus: 0,
        message: `inFakt request failed: ${reason}`,
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  private async request<T = unknown>(
    method: "GET" | "POST" | "PUT" | "DELETE",
    path: string,
    opts: RequestOptions = {},
  ): Promise<T> {
    const res = await this.send(method, path, opts);
    if (!res.ok) {
      throw await buildError(res);
    }
    if (res.status === 204) {
      return undefined as T;
    }
    const contentType = res.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) {
      return undefined as T;
    }
    try {
      return (await res.json()) as T;
    } catch {
      return undefined as T;
    }
  }
}
