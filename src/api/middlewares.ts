import { defineMiddlewares } from "@medusajs/framework/http";

/**
 * Route middleware for the inFakt plugin.
 *
 * Nothing is registered, and that is the point of the file existing: it is the
 * documented place where someone would reach for `AUTHENTICATE = false` or a
 * relaxed matcher, and the reason not to belongs here where they will look.
 *
 * Every route this plugin adds lives under `/admin`, which Medusa authenticates by
 * default, and that default is load-bearing:
 *
 * - The action routes adopt, clear and skip invoices. A cleared crash-window marker
 *   lets a real invoice be issued, and a skip is a decision not to issue a legally
 *   required document. Neither belongs behind anything less than an authenticated
 *   admin session.
 * - The overview route reports the plugin's configuration. It is filtered through
 *   `toPublicInfaktOptions` so the API key can never appear in a response, but it
 *   still describes how a merchant's invoicing is wired.
 *
 * If a webhook from inFakt is ever added (their KSeF docs recommend one to avoid
 * polling `status.json`), it will need its own unauthenticated route with signature
 * verification - not a relaxation of these.
 */
export default defineMiddlewares({
  routes: [],
});
