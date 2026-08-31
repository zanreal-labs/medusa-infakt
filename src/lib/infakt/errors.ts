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

/**
 * A human-readable description of anything that was thrown.
 *
 * `error instanceof Error ? error.message : String(error)` is the idiom used all
 * over this plugin, and it has one hole that cost real time in a sibling plugin,
 * medusa-allegro: a thrown value that is an object but not an `Error` renders as
 * the literal string `[object Object]`, which names nothing and is
 * indistinguishable from a bug in the logger.
 *
 * That is not hypothetical. In medusa-allegro, `updateOrderWorkflow` rejected an
 * address repair and the failure reached the log as:
 *
 *   could not fill shipping_address, billing_address on Medusa order ...: [object Object]
 *
 * The cause had to be found by reading Medusa's source instead. `describeError`
 * was written there (`src/lib/allegro/errors.ts`, PR #21) to close that hole, and
 * is ported here verbatim since the two plugins are separate npm packages that
 * cannot import from each other. It handles every shape rather than the two
 * common ones: an `Error` (including subclasses that fail a cross-realm
 * `instanceof`, which is exactly how an `InfaktApiError` could fail one), an
 * object carrying a `message`, a workflow rejection carrying `errors[]`, and
 * anything else via a JSON attempt that cannot itself throw.
 */
export const describeError = (error: unknown): string => {
  if (typeof error === "string") {
    return error;
  }
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (error && typeof error === "object") {
    const record = error as Record<string, unknown>;

    // Medusa's workflow engine rejects with `{ errors: [{ error }] }` rather than
    // with the underlying error itself, so the useful message is one level in.
    const nested = Array.isArray(record.errors) ? record.errors : undefined;
    if (nested?.length) {
      const inner = nested
        .map((entry) => {
          const wrapped = (entry as { error?: unknown })?.error ?? entry;
          return describeError(wrapped);
        })
        .filter(Boolean)
        .join("; ");
      if (inner) {
        return inner;
      }
    }

    // Covers a subclass whose prototype chain does not survive a realm boundary,
    // which is exactly how an InfaktApiError can fail `instanceof Error`.
    if (typeof record.message === "string" && record.message) {
      return record.code ? `${record.message} (${String(record.code)})` : record.message;
    }

    try {
      const json = JSON.stringify(error);
      if (json && json !== "{}") {
        return json;
      }
    } catch {
      // A circular or non-serialisable object falls through to the constructor
      // name, which at least names the type rather than claiming nothing.
    }
    return `a non-serialisable ${record.constructor?.name ?? "object"} was thrown`;
  }
  return String(error);
};
