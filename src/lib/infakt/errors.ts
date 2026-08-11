/**
 * Thrown for every non-2xx inFakt response and every failed request.
 *
 * `httpStatus` is the load-bearing field: the worker classifies retryable from
 * terminal failures on it (see `NON_RETRYABLE_STATUSES` in
 * `src/lib/invoicing/state-machine.ts`), and the KSeF step uses a 422 to
 * disambiguate "already sent" from "the account has no KSeF integration".
 *
 * `body` is the parsed response body only. The request payload is deliberately
 * never attached: it carries buyer name, address and NIP, and this error is
 * stringified into `InfaktInvoice.last_error`, which the admin UI displays.
 */
export class InfaktApiError extends Error {
  /** HTTP status of the failed response; 0 when the request never completed. */
  readonly httpStatus: number;
  /** Parsed response body (object when JSON, string otherwise), if any. */
  readonly body?: unknown;

  constructor(opts: { message: string; httpStatus: number; body?: unknown }) {
    super(opts.message);
    this.name = "InfaktApiError";
    this.httpStatus = opts.httpStatus;
    this.body = opts.body;
  }
}
