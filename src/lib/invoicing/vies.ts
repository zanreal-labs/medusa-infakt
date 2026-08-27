/**
 * VIES - the EU's VAT number validation service.
 *
 * The entire reason this file exists is the third outcome. A VAT number check
 * has three answers, not two:
 *
 *  - `valid`   - the number is registered. A reverse charge may be applied.
 *  - `invalid` - the number is not registered. The buyer is a consumer as far
 *                as we are concerned, and destination VAT is due.
 *  - `unavailable` - we do not know. VIES is down, or the member state's own
 *                node is down, which happens routinely and per-country.
 *
 * Collapsing `unavailable` into `invalid` charges VAT to a business that should
 * have been zero-rated. Collapsing it into `valid` zero-rates a supply with no
 * evidence, and the liability for that lands on us, not the buyer. So the type
 * below keeps the three apart and refuses to let a caller treat a failed lookup
 * as an answer - see `regime.ts` for what is done with each.
 *
 * NOT VERIFIED: the REST base URL below is the documented endpoint as of
 * writing, but it could not be confirmed against live EU documentation while
 * this was built (see the PR body). It is deliberately a configurable option so
 * a wrong guess is a settings change, not a release.
 */

/** The EU Commission's public REST endpoint for VIES lookups. */
export const DEFAULT_VIES_BASE_URL = "https://ec.europa.eu/taxation_customs/vies/rest-api";

/** VIES is slow and flaky by reputation; a short timeout keeps checkout responsive. */
export const DEFAULT_VIES_TIMEOUT_MS = 8000;

export type ViesOutcome =
  | {
      status: "valid";
      /** Registered name, when VIES discloses it. Some member states do not. */
      name?: string;
      /** Registered address, when VIES discloses it. */
      address?: string;
      /** ISO timestamp of the check. Persisted as the audit trail. */
      checkedAt: string;
      /**
       * VIES's own proof-of-consultation reference, returned only when the
       * request identifies the requester. This is the artifact a tax authority
       * asks for when it wants evidence that a zero rating was justified at the
       * time of supply, so it is captured whenever it is offered.
       */
      consultationNumber?: string;
    }
  | { status: "invalid"; checkedAt: string }
  | { status: "unavailable"; reason: string };

export interface ViesLookupOptions {
  baseUrl?: string;
  timeoutMs?: number;
  /**
   * Our own VAT id, split into prefix and number. Supplying it asks VIES for a
   * consultation number. Optional because a lookup still works without it, and a
   * misconfigured requester should degrade to "no proof recorded" rather than to
   * "no validation at all".
   */
  requester?: { countryCode: string; vatNumber: string };
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchImpl?: typeof fetch;
}

interface ViesResponseBody {
  valid?: boolean;
  name?: string;
  address?: string;
  requestDate?: string;
  requestIdentifier?: string;
  userError?: string;
}

/**
 * Ask VIES whether a VAT number is registered.
 *
 * Never throws. Every failure path - network error, timeout, non-2xx, malformed
 * body, a `userError` VIES reports in a 200 - resolves to `unavailable` with a
 * reason. A validation lookup must not be able to take down the checkout it is
 * called from, and an exception escaping here would do exactly that.
 *
 * The reason strings are safe to persist and display: they name the transport
 * failure or VIES's own error code, never the number being checked.
 */
export async function lookupVies(
  countryPrefix: string,
  vatNumber: string,
  options: ViesLookupOptions = {},
): Promise<ViesOutcome> {
  const base = (options.baseUrl ?? DEFAULT_VIES_BASE_URL).replace(/\/+$/u, "");
  const timeoutMs = options.timeoutMs ?? DEFAULT_VIES_TIMEOUT_MS;
  const doFetch = options.fetchImpl ?? fetch;

  const url =
    `${base}/ms/${encodeURIComponent(countryPrefix)}/vat/${encodeURIComponent(vatNumber)}` +
    requesterQuery(options.requester);

  const controller = new AbortController();
  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    const res = await doFetch(url, {
      headers: { accept: "application/json" },
      signal: controller.signal,
    });

    if (!res.ok) {
      return { reason: `VIES returned HTTP ${res.status}`, status: "unavailable" };
    }

    const body = (await res.json()) as ViesResponseBody;

    // VIES reports member-state outages as a 200 with a userError code rather
    // than an HTTP error, so this check is what separates "the DE node is down"
    // from "this number is not registered". Without it every outage would read
    // as a definitive "invalid".
    if (body.userError && body.userError !== "VALID" && body.userError !== "INVALID") {
      return { reason: `VIES reported ${body.userError}`, status: "unavailable" };
    }

    if (body.valid !== true && body.valid !== false) {
      return { reason: "VIES response did not state validity", status: "unavailable" };
    }

    const checkedAt = body.requestDate ?? new Date().toISOString();
    if (!body.valid) {
      return { checkedAt, status: "invalid" };
    }

    return {
      checkedAt,
      status: "valid",
      ...(body.name ? { name: body.name } : {}),
      ...(body.address ? { address: body.address } : {}),
      ...(body.requestIdentifier ? { consultationNumber: body.requestIdentifier } : {}),
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === "AbortError"
        ? `VIES did not respond within ${timeoutMs}ms`
        : `VIES request failed: ${error instanceof Error ? error.name : "unknown error"}`;
    return { reason, status: "unavailable" };
  } finally {
    clearTimeout(timer);
  }
}

function requesterQuery(requester: ViesLookupOptions["requester"]): string {
  if (!requester) {
    return "";
  }
  const params = new URLSearchParams({
    requesterMemberStateCode: requester.countryCode,
    requesterNumber: requester.vatNumber,
  });
  return `?${params.toString()}`;
}

/**
 * The shape cached on an order once a VAT id has been checked.
 *
 * Cached deliberately, and cached at checkout rather than at invoicing time.
 * The invoice is built minutes to hours after the order, by a background worker;
 * if that worker is the first thing to call VIES then a routine member-state
 * outage strands an order the customer has already paid for. Checking while the
 * customer is still on the page also means a rejected number can be corrected
 * by the person who typed it.
 *
 * `checkedAt` is kept so a stale result can be re-checked, and
 * `consultationNumber` because it is the audit artifact.
 */
export interface CachedViesResult {
  status: "valid" | "invalid" | "unavailable";
  checkedAt?: string;
  consultationNumber?: string;
}

/** Metadata keys the default reader looks for, in order. */
const VIES_METADATA_KEYS = ["vies", "vies_result", "viesResult"] as const;

/**
 * Read a cached VIES result off order metadata.
 *
 * Tolerant by design: a storefront that stores `{ valid: true }`, `"valid"`, or
 * the full object should all be understood, because the alternative is that a
 * storefront integration mistake silently downgrades every B2B order to a
 * consumer invoice with no signal that anything is wrong.
 */
export function readCachedVies(
  metadata: Record<string, unknown> | null | undefined,
): CachedViesResult | null {
  if (!metadata) {
    return null;
  }
  for (const key of VIES_METADATA_KEYS) {
    const raw = metadata[key];
    if (raw === undefined || raw === null) {
      continue;
    }
    if (typeof raw === "boolean") {
      return { status: raw ? "valid" : "invalid" };
    }
    if (typeof raw === "string") {
      const normalized = raw.trim().toLowerCase();
      if (normalized === "valid" || normalized === "invalid" || normalized === "unavailable") {
        return { status: normalized };
      }
      continue;
    }
    if (typeof raw === "object") {
      const parsed = readCachedViesObject(raw as Record<string, unknown>);
      if (parsed) {
        return parsed;
      }
    }
  }
  return null;
}

function readCachedViesObject(raw: Record<string, unknown>): CachedViesResult | null {
  const statusValue = typeof raw.status === "string" ? raw.status.trim().toLowerCase() : null;
  const status =
    statusValue === "valid" || statusValue === "invalid" || statusValue === "unavailable"
      ? statusValue
      : typeof raw.valid === "boolean"
        ? raw.valid
          ? "valid"
          : "invalid"
        : null;
  if (!status) {
    return null;
  }
  return {
    status,
    ...(typeof raw.checkedAt === "string" ? { checkedAt: raw.checkedAt } : {}),
    ...(typeof raw.consultationNumber === "string"
      ? { consultationNumber: raw.consultationNumber }
      : {}),
  };
}
