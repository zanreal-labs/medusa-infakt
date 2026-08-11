import { nextStep } from "./state-machine";
import type { InvoiceStateRow } from "./state-machine";

/**
 * What an operator is allowed to do to a parked invoice, and what each action
 * writes.
 *
 * Pure, so the rules that keep a human from accidentally issuing a duplicate
 * invoice are unit-tested rather than argued about in a code review.
 *
 * There are exactly four actions, and the split between them is the whole point:
 *
 *  - `retry` - put the row back in the queue. Refused when the row sits in the
 *    create crash window, because the next step there would be the one call that
 *    can issue a second real invoice.
 *  - `adopt` - the answer to the crash window. The operator finds the stray
 *    invoice in inFakt and hands over its uuid; the row takes it over and
 *    continues from the KSeF step. No create happens.
 *  - `clear` - the other answer to the crash window: the operator checked inFakt
 *    and there is NO stray invoice, so the create may safely be attempted again.
 *    Requires an explicit confirmation flag, because getting this wrong is how a
 *    customer receives two invoices for one order.
 *  - `skip` - this order should not be invoiced at all, with a reason on the
 *    record.
 *
 * Nothing here deletes or rewrites an invoice that already exists in inFakt. A
 * document that has been issued can only be undone by a corrective invoice, which
 * is a legal act and not a button in an admin panel.
 */

export type OperatorAction = "retry" | "adopt" | "clear" | "skip";

export interface OperatorActionInput {
  action: OperatorAction;
  /** Required for `adopt`: the uuid of the inFakt invoice to take over. */
  invoiceUuid?: string;
  /** Recorded verbatim for `skip`. */
  reason?: string;
  /** Required for `clear`: the operator asserts inFakt holds no stray invoice. */
  confirmNoDuplicate?: boolean;
  /** Known invoice number for an adopted invoice, when the caller looked it up. */
  invoiceNumber?: string | null;
}

export type OperatorActionResult =
  | { ok: true; patch: Record<string, unknown>; note: string }
  | { ok: false; reason: string };

/** True when the row's next move would be the un-retryable create. */
export function isInCrashWindow(row: InvoiceStateRow, emitEvent: boolean): boolean {
  return nextStep(row, { emitEvent }).crashWindow === true;
}

export function planOperatorAction(
  row: InvoiceStateRow,
  input: OperatorActionInput,
  config: { emitEvent: boolean },
): OperatorActionResult {
  switch (input.action) {
    case "retry": {
      return planRetry(row, config.emitEvent);
    }
    case "adopt": {
      return planAdopt(row, input);
    }
    case "clear": {
      return planClear(row, input);
    }
    case "skip": {
      return planSkip(input);
    }
    default: {
      const exhaustive: never = input.action;
      return { ok: false, reason: `unknown action ${String(exhaustive)}` };
    }
  }
}

function planRetry(row: InvoiceStateRow, emitEvent: boolean): OperatorActionResult {
  if (row.status === "done") {
    return { ok: false, reason: "this invoice is already issued - there is nothing to retry" };
  }
  if (isInCrashWindow(row, emitEvent)) {
    // Deliberately a refusal, not a warning that can be clicked through. inFakt has
    // no idempotency key, so retrying here can issue a second real numbered invoice.
    return {
      ok: false,
      reason:
        "refusing to retry: a previous create may already have reached inFakt. Look for a stray invoice in inFakt, then either adopt it (link an existing invoice) or, if there is none, clear the row with the explicit no-duplicate confirmation.",
    };
  }
  return {
    note: "queued for the next worker tick",
    ok: true,
    patch: {
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      status: "processing",
    },
  };
}

function planAdopt(row: InvoiceStateRow, input: OperatorActionInput): OperatorActionResult {
  const uuid = input.invoiceUuid?.trim();
  if (!uuid) {
    return { ok: false, reason: "an inFakt invoice uuid is required to adopt an existing invoice" };
  }
  if (row.invoice_uuid && row.invoice_uuid !== uuid) {
    // Re-pointing a row at a different invoice would orphan the first one while
    // making the ledger claim the order was invoiced by the second. Both documents
    // exist in inFakt; only a human working in inFakt can reconcile that.
    return {
      ok: false,
      reason: `this row is already linked to invoice ${row.invoice_uuid} - re-pointing it at another invoice would orphan the first one. Resolve the duplicate in inFakt instead.`,
    };
  }
  return {
    note: `adopted inFakt invoice ${uuid}; the worker will continue from here`,
    ok: true,
    patch: {
      adopted_at: new Date(),
      attempts: 0,
      invoice_number: input.invoiceNumber ?? null,
      invoice_uuid: uuid,
      last_error: null,
      next_attempt_at: null,
      status: "processing",
      // Without this the row would immediately fall back into the crash window on
      // the next tick, since a set marker with no task reference is what defines it.
      task_reference: row.task_reference ?? `adopted:${uuid}`,
    },
  };
}

function planClear(row: InvoiceStateRow, input: OperatorActionInput): OperatorActionResult {
  if (input.confirmNoDuplicate !== true) {
    return {
      ok: false,
      reason:
        "clearing the crash-window marker lets the invoice create run again. Confirm explicitly that you checked inFakt and there is NO invoice for this order.",
    };
  }
  if (row.invoice_uuid) {
    return {
      ok: false,
      reason: `this row already has invoice ${row.invoice_uuid} - clearing it would issue a second one. Use retry instead.`,
    };
  }
  return {
    note: "crash-window marker cleared; the create will be attempted again",
    ok: true,
    patch: {
      attempts: 0,
      last_error: null,
      next_attempt_at: null,
      status: "processing",
      submit_started_at: null,
      task_reference: null,
    },
  };
}

function planSkip(input: OperatorActionInput): OperatorActionResult {
  const reason = input.reason?.trim();
  if (!reason) {
    // A skipped invoice is a decision not to issue a legal document. It gets a
    // reason on the record, always.
    return { ok: false, reason: "a reason is required to skip an order" };
  }
  return {
    note: "marked as skipped",
    ok: true,
    patch: {
      completed_at: new Date(),
      last_error: null,
      next_attempt_at: null,
      skip_reason: `skipped by an operator: ${reason}`,
      status: "skipped",
    },
  };
}
