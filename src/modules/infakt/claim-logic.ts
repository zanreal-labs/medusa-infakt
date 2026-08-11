/**
 * Pure helpers for the worker's single-flight claim, split out of the service so
 * the window arithmetic is unit-testable without a database.
 */

/**
 * The instant before which a `running` claim is considered abandoned.
 *
 * A run that dies without releasing (SIGKILL, an OOM, a container rescheduled
 * mid-tick) leaves `status = 'running'` behind forever. Without a takeover window
 * the invoicing pipeline would wedge permanently on the first crash, which for
 * this plugin means B2B invoices silently not being filed.
 */
export function staleClaimCutoff(now: Date, windowMs: number): Date {
  return new Date(now.getTime() - windowMs);
}

/** Is a claim of this age still live, i.e. genuinely held by a running process? */
export function isClaimActive(status: string, claimAgeMs: number, windowMs: number): boolean {
  return status === "running" && claimAgeMs <= windowMs;
}

/**
 * The run's persisted health, given what it produced.
 *
 * Rows parked in needs_review make the run "error", not "ok", even though the run
 * itself completed. They require a human, and ops tooling showing a healthy run
 * next to stuck invoices is how a legal filing obligation gets missed quietly.
 * Deferred rows do NOT count: waiting on inFakt, on KSeF, or on a buyer to pay is
 * the pipeline working as designed.
 */
export function runHealth(summary: { failed: number; review: number }): {
  status: "ok" | "error";
  lastError: string | null;
} {
  if (summary.review > 0 || summary.failed > 0) {
    return {
      lastError: `${summary.failed} failed, ${summary.review} sent to review`,
      status: "error",
    };
  }
  return { lastError: null, status: "ok" };
}
