import type { MedusaRequest, MedusaResponse } from "@medusajs/framework/http";
import type { Logger } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
import {
  INFAKT_SIGNATURE_HEADER,
  verifyInfaktSignature,
} from "../../../../lib/crypto/webhook-signature";
import { describeError } from "../../../../lib/infakt/errors";
import {
  awaitingKsefStatus,
  classifyInfaktWebhook,
  ksefWebhookNudge,
} from "../../../../lib/invoicing/ksef-webhook";
import { runInvoicingNow } from "../../../../lib/invoicing/run";
import type { InvoiceStateRow } from "../../../../lib/invoicing/state-machine";
import { INFAKT_MODULE } from "../../../../modules/infakt";
import type InfaktModuleService from "../../../../modules/infakt/service";

/**
 * POST /hooks/infakt/ksef - inFakt's KSeF status webhook.
 *
 * The ONLY unauthenticated route this plugin has, and the only one outside
 * `/admin`. It exists because filing a B2B invoice to KSeF has been legally
 * mandatory in Poland since April 2026 and was, until this route, the one step in
 * the pipeline whose completion the plugin learned about by asking repeatedly.
 * inFakt's own KSeF documentation asks for a webhook instead. The poll has not
 * gone anywhere - it is the backstop, and it is what actually reads the status
 * even when the webhook fires.
 *
 * ## Why this is not a relaxation of the `/admin` auth
 *
 * It cannot be one: it is a different prefix, with a different credential, doing
 * a different thing. `/admin` is authenticated by Medusa's admin session and
 * carries actions that decide whether a legal document is issued at all. This
 * carries no decision. See `src/api/middlewares.ts` for the matcher, which adds
 * `preserveRawBody` and nothing else - no `AUTHENTICATE = false`, and no widened
 * matcher on anything that already exists.
 *
 * ## Why `/hooks` and not `/webhooks`
 *
 * `/hooks` is the prefix the reference deployment already publishes to the
 * internet (a Traefik IngressRoute on `store-api.zanreal.app`), while everything
 * else - `/admin` included - has no public DNS record at all. Mounting here means
 * the route is reachable with no ingress change; `/webhooks` would have needed a
 * new public rule for one path. Nothing about the code depends on the prefix, and
 * a host that publishes a different one only has to say so in inFakt's panel.
 *
 * ## The four things this does, in order
 *
 *  1. **Refuse without a secret.** No `webhookSecret` option, 401. An endpoint
 *     that advances a legally significant document on anyone's say-so is worse
 *     than one nobody has wired up yet.
 *  2. **Verify the signature** over the RAW body, constant-time. A missing,
 *     malformed or wrong `X-Infakt-Signature` is 401, which is what inFakt's docs
 *     say a failed verification must answer, and nothing is looked up first - a
 *     401 must not be able to tell an attacker whether an invoice exists.
 *  3. **Answer the activation handshake.** inFakt POSTs a random
 *     `verification_code` when an operator presses "Zweryfikuj" and requires the
 *     same string back; a webhook that never answers it is never delivered to.
 *  4. **Nudge, then re-read.** Locate the row by the invoice uuid in the body,
 *     and if it is genuinely waiting on `poll-ksef`, clear its `next_attempt_at`
 *     and run the SAME pipeline the cron runs, narrowed to that one order. The
 *     status comes from inFakt's API, not from the payload.
 *
 * ## Idempotent by construction
 *
 * inFakt retries a delivery until it is answered 200 or 201, so duplicates are
 * routine rather than exceptional. The second delivery of an event finds a row
 * that `awaitingKsefStatus` no longer considers due - it has a `ksef_number`, or
 * it is `done`, or an operator parked it - and does nothing. Two deliveries racing
 * each other are serialised one level down by the module's single-flight claim,
 * exactly as a cron tick and a payment subscriber already are.
 *
 * ## Always 2xx once authentic
 *
 * An unknown invoice, an event this plugin does not care about, a run that could
 * not acquire the claim: all 200. Answering an error would spend inFakt's retry
 * budget - six failures raise an email, ten switch the webhook off - on a
 * condition no retry can change, and would eventually disable the delivery of the
 * events that do matter. The response body is the same `{ ok: true }` either way,
 * so it never reports whether an invoice exists.
 */
export async function POST(req: MedusaRequest, res: MedusaResponse): Promise<void> {
  const logger = req.scope.resolve<Logger>(ContainerRegistrationKeys.LOGGER);
  const infakt = req.scope.resolve<InfaktModuleService>(INFAKT_MODULE);

  // Boot option, not an effective one: this is the credential inFakt generated
  // for the webhook, and unlike `apiKey` there is no admin override for it.
  const secret = infakt.resolvedOptions.webhookSecret;
  if (!secret) {
    logger.warn(
      "[medusa-infakt] refused a KSeF webhook delivery: no `webhookSecret` option is configured. " +
        "Copy the secret from the webhook's details in inFakt (Ustawienia -> Inne opcje -> Webhooki) " +
        "and wire it through the plugin option. Invoices are still filed by the KSeF poll meanwhile.",
    );
    res.status(401).json({ ok: false });
    return;
  }

  // Fail closed rather than re-serialising `req.body`: a digest over
  // re-serialised JSON is a digest over different bytes, so an approximation here
  // would reject every genuine delivery while looking like a signing problem at
  // inFakt's end. A missing raw body means the matcher in `middlewares.ts` is not
  // in effect, which is a deployment fault worth saying out loud.
  const { rawBody } = req as MedusaRequest & { rawBody?: Buffer | string };
  if (rawBody === undefined || rawBody === null) {
    logger.error(
      "[medusa-infakt] refused a KSeF webhook delivery: the raw request body was not preserved, so the " +
        "signature cannot be verified. The `/hooks/infakt/ksef` matcher in this plugin's `middlewares.ts` " +
        "sets `bodyParser.preserveRawBody`; something is overriding it.",
    );
    res.status(401).json({ ok: false });
    return;
  }

  const header = req.headers[INFAKT_SIGNATURE_HEADER];
  const signature = typeof header === "string" ? header : undefined;
  if (!verifyInfaktSignature(rawBody, signature, secret)) {
    // No invoice has been looked up at this point, and deliberately so.
    logger.warn(
      "[medusa-infakt] rejected a KSeF webhook delivery with a missing or invalid X-Infakt-Signature.",
    );
    res.status(401).json({ ok: false });
    return;
  }

  const request = classifyInfaktWebhook(req.body);

  if (request.kind === "verification") {
    // Echoed verbatim. This is inFakt activating the webhook, not an event.
    logger.info("[medusa-infakt] answered the inFakt webhook activation challenge.");
    res.status(200).json({ verification_code: request.verificationCode });
    return;
  }

  if (request.kind === "ignored") {
    logger.debug?.(`[medusa-infakt] ignored a KSeF webhook delivery: ${request.reason}.`);
    res.status(200).json({ ok: true });
    return;
  }

  // Awaited before the response, not fired off behind it, so nothing outlives the
  // request. The cost is one status read against inFakt: the webhook only fires
  // once KSeF has reached a terminal state, so the ride in `poll-ksef` settles on
  // its very first call rather than sleeping through a backoff.
  await advance(req, infakt, logger, request.invoiceUuid, request.event);
  res.status(200).json({ ok: true });
}

/**
 * Find the row this event names and, if it is waiting for exactly this news, make
 * it due and run it.
 *
 * The lookup is by `invoice_uuid`, which is what inFakt knows about; the order id
 * the runner needs comes off the row. That column is not indexed, and does not
 * need to be: there is at most one delivery per invoice per terminal transition,
 * against a table with one row per order.
 *
 * Every failure is swallowed. The row is untouched by a failure here and the cron
 * still owns it, so the worst case is the five-minute wait this route exists to
 * avoid - which is exactly where the plugin was before it existed. Throwing
 * instead would answer inFakt a 5xx and spend the retry budget that protects the
 * deliveries that matter.
 */
async function advance(
  req: MedusaRequest,
  infakt: InfaktModuleService,
  logger: Logger,
  invoiceUuid: string,
  event: string,
): Promise<void> {
  try {
    const [found] = await infakt.listInfaktInvoices({ invoice_uuid: [invoiceUuid] });
    const row = found as unknown as (InvoiceStateRow & { id: string; order_id: string }) | undefined;
    if (!row) {
      // Not a warning. An inFakt account is shared with invoices this plugin
      // never issued - anything raised by hand, or by another integration - and
      // every one of those is delivered here too.
      logger.debug?.(
        `[medusa-infakt] a ${event} webhook named inFakt invoice ${invoiceUuid}, which this store did not issue.`,
      );
      return;
    }

    if (!awaitingKsefStatus(row, infakt.resolvedOptions.emitIssuedEvent)) {
      // The overwhelmingly common second delivery, and the whole of the
      // duplicate-safety story: the row already has its KSeF number, or is done,
      // or an operator parked it.
      logger.debug?.(
        `[medusa-infakt] a ${event} webhook for order ${row.order_id} needed no action - the row is not waiting on KSeF.`,
      );
      return;
    }

    const nudge = ksefWebhookNudge(row);
    if (nudge) {
      await infakt.updateInfaktInvoices({ id: row.id, ...nudge });
    }
    logger.info(
      `[medusa-infakt] inFakt reported ${event} for order ${row.order_id}; re-reading the KSeF status now.`,
    );
    await runInvoicingNow(req.scope, {
      orderId: row.order_id,
      source: "medusa-infakt/ksef-webhook",
    });
  } catch (error) {
    logger.warn(
      `[medusa-infakt] could not act on a ${event} webhook for inFakt invoice ${invoiceUuid}: ` +
        `${describeError(error)}. The invoicing worker still owns the row.`,
    );
  }
}
