/**
 * inFakt API v3.
 *
 * Docs: https://github.com/infakt/API (readme.md, ksef.md)
 * Interactive docs: https://docs.infakt.pl
 *
 * Environments:
 *   - Production: https://api.infakt.pl/api/v3
 *   - Sandbox:    https://api.sandbox-infakt.pl/api/v3
 *
 * Auth: a static API key sent in the `X-inFakt-ApiKey` header. There is no
 * OAuth flow and no per-request signature, so the key is the whole credential -
 * it belongs in an environment variable read by `medusa-config.ts`.
 *
 * All money amounts are integers in grosze (1/100 PLN), e.g. 500000 = 5000,00 zl.
 *
 * Rate limits per IP (github.com/infakt/API readme.md, "Limity"):
 *   - GET:              300 requests / 60 s
 *   - POST/PUT/DELETE:  150 requests / 60 s
 *
 * This client does NOT throttle. That is deliberate: the only caller is the
 * plugin's worker, which processes rows strictly sequentially in batches of 20,
 * so a run's worst case is a few dozen requests spread over seconds. Adding a
 * client-side limiter would hide a future parallel caller's mistake instead of
 * making it fail visibly.
 */

export type InfaktEnvironment = "production" | "sandbox";

export const INFAKT_ENDPOINTS: Record<InfaktEnvironment, string> = {
  production: "https://api.infakt.pl/api/v3",
  sandbox: "https://api.sandbox-infakt.pl/api/v3",
};

/** One invoice line. Money amounts are integers in grosze. */
export interface InfaktServicePayload {
  name: string;
  /** VAT rate symbol, e.g. "23". */
  tax_symbol: string;
  quantity: number;
  /** Unit label, e.g. "szt." */
  unit?: string;
  /**
   * Total gross for the line, integer grosze. Provide `gross_price` WITHOUT
   * `unit_net_price`/`net_price` to have inFakt derive net from gross; when a
   * net amount is present the invoice is always computed from net instead,
   * which reintroduces the rounding drift this plugin exists to avoid.
   */
  gross_price?: number;
  /** Net price per unit, integer grosze. */
  unit_net_price?: number;
}

/**
 * Invoice body for `POST /async/invoices.json`. The client wraps it as
 * `{ "invoice": { ... } }` - pass the bare object here.
 */
export interface InfaktInvoicePayload {
  currency?: string;
  /** YYYY-MM-DD */
  invoice_date?: string;
  /** YYYY-MM-DD */
  sale_date?: string;
  /** YYYY-MM-DD */
  payment_date?: string;
  /** e.g. "transfer" */
  payment_method?: string;
  client_company_name?: string;
  client_first_name?: string;
  client_last_name?: string;
  client_business_activity_kind?: "self_employed" | "other_business" | "private_person";
  /**
   * The buyer's tax identifier.
   *
   * Polish NIPs go here as bare digits. A foreign EU VAT id goes here in its
   * prefixed form (`DE123456789`) - inFakt accepts that, and live invoices on
   * this account already carry prefixed values such as `PL8990100726`, so the
   * field is a tax-code field rather than a NIP-only one despite the name.
   */
  client_tax_code?: string;
  client_street?: string;
  client_city?: string;
  client_post_code?: string;
  /** ISO country code, e.g. "PL". */
  client_country?: string;
  client_email?: string;
  /**
   * Free-text annotation printed on the invoice.
   *
   * This is where a reverse-charge or export-of-services statement lives. inFakt
   * has no dedicated field for either: its `oo` ("odwrotne obciazenie") rate
   * symbol was withdrawn on 2019-11-01 along with the domestic reverse charge,
   * and the account's live rate table confirms it is still expired. So the legal
   * annotation that art. 106e ust. 1 pkt 18 requires is carried as text, and the
   * rate itself is expressed as the `np` symbol on each line.
   */
  notes?: string;
  /**
   * `service` or `merchandise`. Documented by inFakt as applying to foreign
   * invoices ("dla zagranicznych"), so it is set on every cross-border document
   * and left alone domestically.
   */
  sale_type?: "service" | "merchandise";
  services: InfaktServicePayload[];
}

/**
 * One line on an OSS invoice.
 *
 * Structurally different from `InfaktServicePayload` in the one way that
 * matters: there is no `tax_symbol`. An OSS line carries `tax_rate`, the
 * destination member state's own rate, sourced from inFakt's
 * `/moss_vat_rates.json`. A Polish rate symbol would be meaningless on a
 * document that declares tax owed to another country.
 */
export interface InfaktOssServicePayload {
  name: string;
  quantity: number;
  unit?: string;
  /** Destination-country VAT rate, e.g. "19". Required by inFakt. */
  tax_rate: string;
  /** Net for the whole line, integer minor units. */
  net_price?: number;
  /** Net per unit, integer minor units. */
  unit_net_price?: number;
  /** Gross for the whole line, integer minor units. */
  gross_price?: number;
  /** VAT amount for the line, integer minor units. */
  tax_price?: number;
}

/**
 * Invoice body for `POST /async/oss_invoices.json`.
 *
 * A separate document family from the VAT invoice, not a variant of it: its own
 * endpoint, its own field set, its own numbering. That last point is why this
 * type exists behind an explicit opt-in - see `options.ts` and the PR body.
 */
export interface InfaktOssInvoicePayload {
  /** Destination EU member state, never PL. */
  country: string;
  currency: string;
  /** OSS is a B2C procedure; inFakt requires a natural person's name. */
  client_first_name: string;
  client_last_name: string;
  client_email?: string;
  client_street?: string;
  client_city?: string;
  client_post_code?: string;
  /** `electronic` for software and license keys. */
  service_type: "electronic" | "broadcasting" | "telecommunications";
  sale_type: "service" | "merchandise";
  /** inFakt requires a stated place of supply. */
  service_place_primary: string;
  /** YYYY-MM-DD */
  issue_date?: string;
  /** YYYY-MM-DD */
  service_date?: string;
  /** YYYY-MM-DD */
  payment_date?: string;
  notes?: string;
  /** Totals, integer minor units. */
  net_price?: number;
  gross_price?: number;
  tax_price?: number;
  services: InfaktOssServicePayload[];
}

/** One row of `GET /moss_vat_rates.json`. */
export interface InfaktMossRate {
  id: number;
  country: string;
  /** Percentage as a number, e.g. 19. */
  value: number;
  /** True for a member state's reduced rate. */
  reduced: boolean;
}

/** Accepted async task, returned by `POST /async/invoices.json` (HTTP 201/202). */
export interface InfaktAsyncTask {
  invoiceTaskReferenceNumber: string;
  processingCode?: number;
  processingDescription?: string;
}

/** Result of `GET /async/invoices/status/{reference}.json`. */
export interface InfaktAsyncTaskStatus {
  processingCode: number;
  processingDescription?: string;
  /** UUID of the created invoice - present once the task succeeded. */
  invoiceUuid?: string;
  /** Invoice number, if the API provides it. */
  invoiceNumber?: string;
  /** Task finished successfully (the invoice exists). */
  done: boolean;
  /** Task terminally failed. */
  failed: boolean;
}

/** Subset of `GET /invoices/{uuid}.json` mapped to camelCase. */
export interface InfaktInvoice {
  uuid: string;
  number?: string;
  /** e.g. "draft" | "sent" | "printed" | "paid". */
  status?: string;
  /** Integer grosze. */
  grossPrice?: number;
  currency?: string;
  /** YYYY-MM-DD, as issued. */
  invoiceDate?: string;
  clientTaxCode?: string;
  clientEmail?: string;
  clientFirstName?: string;
  clientLastName?: string;
  clientCompanyName?: string;
  /** Line positions; present on the per-invoice detail response. */
  services?: { name: string; quantity: number; grossPrice?: number }[];
}

/**
 * Result of `GET /ksef2/documents/{uuid}/status.json`.
 *
 * `status` is one of "sent" (accepted, still processing), "success"
 * (`ksefNumber` assigned) or "error" (`statusDescription` carries the KSeF
 * validation detail). github.com/infakt/API ksef.md, "Sprawdzanie statusu".
 */
export interface InfaktKsefStatus {
  status: string;
  /** KSeF-assigned number, present once status is "success". */
  ksefNumber?: string;
  statusDescription?: string;
  requestUuid?: string;
}

/**
 * Result of `GET /ksef2/integration.json`.
 *
 * `active: false` means the inFakt account has no working KSeF authorization
 * token, so every `sendToKsef` call will be rejected with HTTP 422. This is the
 * one pre-flight check the plugin performs at startup, because a store that
 * silently stops filing B2B invoices is breaking a legal obligation rather than
 * just dropping a sync.
 */
export interface InfaktKsefIntegration {
  active: boolean;
  incomesLastFetchedAt?: string;
  costsLastFetchedAt?: string;
}

export interface InfaktClientOptions {
  apiKey: string;
  /** Default "production". */
  environment?: InfaktEnvironment;
  /** Default request timeout (ms). Default 60_000. */
  timeoutMs?: number;
}
