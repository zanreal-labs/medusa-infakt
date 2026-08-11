import { model } from "@medusajs/framework/utils";

/**
 * Single-row status board for the invoicing worker. There is exactly one logical
 * row (see `InfaktModuleService.getRunState`, which creates the singleton on
 * first access) - a status board, not a history table.
 *
 * The row does double duty as the worker's single-flight lock: `status`,
 * `claim_token` and `claimed_at` are written together by one atomic conditional
 * UPDATE and released by another. See `InfaktModuleService.claimRun`.
 *
 * The lock is not a nicety. Two overlapping worker runs reading the same due row
 * would both pass the crash-window check, both write `submit_started_at`, and
 * both POST a create - two real numbered invoices for one order, with no way to
 * undo either.
 */
const InfaktRunState = model.define("infakt_run_state", {
  /**
   * Opaque token identifying the run that currently holds the claim, written by
   * the same atomic UPDATE that sets `status = 'running'`.
   *
   * It exists so a run can release ONLY its own claim: after a stale takeover two
   * processes believe they are running, and the loser must not be able to clear
   * the winner's lock or overwrite its status.
   */
  claim_token: model.text().nullable(),
  /**
   * When the current claim was taken. The stale-takeover window is measured from
   * here rather than from `updated_at`, which the run's own progress writes keep
   * bumping - a wedged run has to expire on a fixed budget.
   */
  claimed_at: model.dateTime().nullable(),
  id: model.id().primaryKey(),
  /**
   * Whether the inFakt account's KSeF integration was active at the last check,
   * null when never checked. Surfaced in the admin UI, because a store whose
   * integration lapsed looks exactly like a store with no B2B orders until
   * someone goes looking.
   */
  ksef_active: model.boolean().nullable(),
  ksef_checked_at: model.dateTime().nullable(),
  /** Why the KSeF check could not be completed (network, scope, HTTP error). */
  ksef_error: model.text().nullable(),
  last_error: model.text().nullable(),
  last_run_at: model.dateTime().nullable(),
  /** Rows advanced by the most recent run. */
  processed: model.number().default(0),
  /**
   * "error" whenever the last run left rows in needs_review, not just when the
   * run itself threw. A run that quietly parks invoices a human must handle is
   * not a healthy run, and ops tooling must not show green next to it.
   */
  status: model.enum(["idle", "running", "ok", "error"]).default("idle"),
});

export default InfaktRunState;
