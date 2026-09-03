import { defineMiddlewares } from "@medusajs/framework/http";

/**
 * Route middleware for the inFakt plugin.
 *
 * One entry, and it grants nothing: it is the place someone would reach for
 * `AUTHENTICATE = false` or a relaxed matcher, and the reason not to belongs here
 * where they will look.
 *
 * Almost every route this plugin adds lives under `/admin`, which Medusa
 * authenticates by default, and that default is load-bearing:
 *
 * - The action routes adopt, clear and skip invoices. A cleared crash-window marker
 *   lets a real invoice be issued, and a skip is a decision not to issue a legally
 *   required document. Neither belongs behind anything less than an authenticated
 *   admin session.
 * - The overview route reports the plugin's configuration. It is filtered through
 *   `toPublicInfaktOptions` so the API key can never appear in a response, but it
 *   still describes how a merchant's invoicing is wired.
 *
 * ## The one exception, and why it is not an exception to any of that
 *
 * `POST /hooks/infakt/ksef` is inFakt's KSeF status webhook. inFakt's own KSeF
 * documentation asks for one instead of polling `status.json`, and filing a B2B
 * invoice has been mandatory in Poland since April 2026 - it is the one step here
 * with a legal deadline behind it.
 *
 * It is an unauthenticated route OF ITS OWN, exactly as this file has said it
 * would have to be, and not a relaxation of anything above:
 *
 * - Different prefix. `/hooks` is a custom prefix Medusa applies no auth to, so
 *   the `/admin` matcher is untouched and no admin route becomes reachable.
 * - Different credential. The route verifies `X-Infakt-Signature`, the hex
 *   HMAC-SHA256 of the raw body under the per-webhook secret inFakt generates in
 *   its panel, in constant time, and answers 401 to a missing, malformed or wrong
 *   one - and to every request at all when no `webhookSecret` is configured.
 * - Different authority. It carries no decision. A verified delivery is treated
 *   as a trigger, never as a fact: the route re-reads the KSeF status from
 *   inFakt's API and drives the same `poll-ksef` step the cron drives, so the
 *   persisted state machine stays the only source of truth and a forged delivery
 *   could at worst cause a status read.
 *
 * The entry below therefore adds no middleware. It exists only for
 * `preserveRawBody`: an HMAC is over the bytes inFakt sent, and Express discards
 * those once the JSON is parsed. Without it the route fails closed - see
 * `src/api/hooks/infakt/ksef/route.ts`.
 */
export default defineMiddlewares({
  routes: [
    {
      /**
       * `sizeLimit` is deliberately small. The documented payload is a handful of
       * uuids, timestamps and a status description; anything approaching a
       * megabyte on an unauthenticated route is not a KSeF notification, and the
       * limit is enforced before the body reaches the signature check.
       */
      bodyParser: { preserveRawBody: true, sizeLimit: "64kb" },
      matcher: "/hooks/infakt/ksef",
      methods: ["POST"],
    },
  ],
});
