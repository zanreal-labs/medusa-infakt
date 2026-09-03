import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies the `X-Infakt-Signature` header inFakt puts on a webhook delivery.
 *
 * inFakt documents exactly one scheme and this implements exactly that one, with
 * nothing invented around it: the header is the **hex** HMAC-SHA256 of the **raw
 * request body** under the per-webhook secret inFakt generates and shows in the
 * webhook's details in the panel. Their own samples are
 * `OpenSSL::HMAC.hexdigest(OpenSSL::Digest.new('sha256'), secret_key, payload)`
 * and `createHmac("sha256", secret).update(payload).digest("hex")`, and the docs
 * say a failed verification must answer 401.
 *
 * Two things inFakt does NOT document, and which this therefore does not pretend
 * to have: a timestamp, and any replay window. So this is a proof of authenticity
 * and nothing more - a delivery captured off the wire and replayed verifies
 * exactly as it did the first time. That is only survivable because of what the
 * route does with a verified call: it treats the body as a trigger, re-reads the
 * status from inFakt's API, and drives the same state machine the poll drives.
 * See `src/api/hooks/infakt/ksef/route.ts`.
 *
 * ## Raw body, not the parsed one
 *
 * The digest is over the bytes inFakt sent. Re-serialising `req.body` would
 * reorder keys, drop insignificant whitespace and rewrite number formatting, and
 * every one of those changes the digest - so a caller with no raw body must fail
 * closed rather than approximate one. The route's matcher sets
 * `bodyParser: { preserveRawBody: true }` in `src/api/middlewares.ts` to make
 * `req.rawBody` exist at all.
 */

/** The header inFakt signs with. Express lower-cases every header key. */
export const INFAKT_SIGNATURE_HEADER = "x-infakt-signature";

/**
 * Is `signature` a valid inFakt signature over `rawBody` under `secret`?
 *
 * False for every failure - a missing header, a malformed one, the wrong digest -
 * because the caller's response to all three is identical (401) and a thrown
 * error here would only invite a catch that turns a bad signature into a 500.
 *
 * The comparison is constant-time on the digest BYTES rather than on the hex
 * text. `timingSafeEqual` throws on a length mismatch, so the length is checked
 * first; that leaks only the length of a digest whose length is fixed and public.
 * A header that is not valid hex decodes short and fails on that same check.
 */
export function verifyInfaktSignature(
  rawBody: Buffer | string,
  signature: string | undefined,
  secret: string,
): boolean {
  if (!signature) {
    return false;
  }
  const expected = createHmac("sha256", secret)
    .update(typeof rawBody === "string" ? Buffer.from(rawBody, "utf-8") : rawBody)
    .digest();
  // Lower-cased because hex has two spellings of the same bytes and inFakt's
  // samples do not all agree on which one they emit.
  const provided = Buffer.from(signature.trim().toLowerCase(), "hex");
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}
