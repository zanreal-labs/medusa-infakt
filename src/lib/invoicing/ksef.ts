/**
 * Who gets filed to KSeF.
 *
 * Krajowy System e-Faktur is Poland's mandatory national e-invoicing system.
 * From April 2026 a B2B invoice - one issued to a buyer identified by a NIP -
 * must be filed there; penalties for not filing start in January 2027. A
 * consumer invoice (no NIP) is outside the system.
 *
 * That legal shape is why the default mode is `nip-only` and why it is not a
 * boolean: "file everything" and "file nothing" are both wrong defaults, and a
 * store that quietly stops filing looks identical to one that never had B2B
 * orders. The decision is recorded per invoice, with its reason, so an audit can
 * answer "why was this one not filed?" without re-deriving it from config that
 * may have changed since.
 */

export type KsefMode = "nip-only" | "all" | "never";

export interface KsefDecisionInput {
  /** True when the built invoice carries a NIP (`other_business`). */
  isCompany: boolean;
  /** The normalized NIP, when there is one. */
  nip?: string;
  orderId: string;
}

export interface KsefDecision {
  /** Whether this invoice must be submitted to KSeF. */
  file: boolean;
  /** Audit trail, persisted on the invoice row. Contains no buyer PII. */
  reason: string;
}

export type KsefDecider = (input: KsefDecisionInput) => boolean;

/**
 * Decide whether one invoice is filed to KSeF.
 *
 * A custom `decide` predicate, when configured, overrides the mode entirely -
 * including `never`. That is intentional: `never` exists as a development
 * kill-switch, and an operator who has written a predicate has made a more
 * specific statement than the mode does. The reason string records which of the
 * two answered, so the override is visible in the audit trail rather than
 * looking like the mode misbehaved.
 */
export function decideKsef(
  input: KsefDecisionInput,
  mode: KsefMode,
  decide?: KsefDecider,
): KsefDecision {
  if (decide) {
    const file = decide(input) === true;
    return {
      file,
      reason: file
        ? "custom ksef.decide predicate selected this invoice for KSeF"
        : "custom ksef.decide predicate excluded this invoice from KSeF",
    };
  }

  if (mode === "never") {
    return {
      file: false,
      reason: 'ksef.mode is "never" - filing disabled for this deployment',
    };
  }

  if (mode === "all") {
    return { file: true, reason: 'ksef.mode is "all" - every invoice is filed' };
  }

  if (!input.isCompany) {
    return { file: false, reason: "buyer has no tax id - consumer invoice, outside KSeF" };
  }

  // A foreign business buyer is filed too. That is the owner's standing
  // instruction - "everything with a tax id goes to KSeF, even abroad" - and the
  // reason is spelled differently so the audit trail does not later claim a
  // German VAT number was a NIP. Filing is not delivery: a foreign buyer cannot
  // collect the invoice from KSeF, so the pipeline also emails it. See
  // `deliverCrossBorderInvoice` in pipeline.ts.
  return input.nip
    ? { file: true, reason: "buyer has a Polish NIP - B2B invoice, mandatory in KSeF" }
    : {
        file: true,
        reason: "buyer has a foreign tax id - filed to KSeF, and delivered to the buyer by email",
      };
}

/**
 * Is `ksef.requireActive` in force for this configuration?
 *
 * Defaults to true in production and false in sandbox. A sandbox deployment is
 * usually exercising the invoice path with no KSeF token attached at all, so
 * demanding an active integration there turns every developer's first run into a
 * hard failure. Production is the opposite: an inactive integration means B2B
 * invoices silently pile up in needs_review while a legal deadline passes, so
 * the default is to fail loudly at startup.
 */
export function resolveRequireActive(
  requireActive: boolean | undefined,
  environment: "production" | "sandbox",
): boolean {
  if (requireActive !== undefined) {
    return requireActive;
  }
  return environment === "production";
}

/**
 * Could this configuration ever need KSeF?
 *
 * `mode: "never"` with no custom predicate cannot, so the startup check is
 * pointless there and would only produce a scary log line for a deployment that
 * opted out on purpose. Any other combination might, so the check runs.
 */
export function ksefPossible(mode: KsefMode, decide?: KsefDecider): boolean {
  return mode !== "never" || decide !== undefined;
}
