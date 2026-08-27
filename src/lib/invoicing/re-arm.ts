import type { InvoiceBuyerInput } from "./builder";
import { ADDRESS_INCOMPLETE_PREFIX } from "./builder";
import { planOperatorAction } from "./operator-actions";
import type { OperatorActionConfig, OperatorActionResult } from "./operator-actions";
import type { InvoiceStateRow } from "./state-machine";

/**
 * Putting a parked invoice back in the queue when the thing blocking it has
 * objectively resolved itself.
 *
 * ## Why this exists at all
 *
 * `needs_review` is terminal on purpose - `listDueInvoices` excludes it, and so
 * does the payment fast path, so that only an operator restarts a parked row.
 * That is right for almost every reason a row parks. It is wrong for exactly one.
 *
 * An order arrived from Allegro before the buyer had finished the checkout form,
 * so it had no address and could not be invoiced. Minutes later the buyer
 * finished and the address existed at Allegro. Repairing the order's address
 * fixes the DATA and changes nothing about the invoice: the row stays parked
 * forever, and the next occurrence looks identical to a person watching - which
 * is precisely how the first one cost a day to find.
 *
 * ## Why only this one reason
 *
 * "The address is missing" is a claim about the world that the world can settle:
 * either the order now has a street, a city and a postal code, or it does not.
 * Nothing else that parks a row is like that. Two orders sharing an invoice
 * number is a question about which one is right. A VIES check that could not
 * confirm a VAT id is a question about what risk to accept. Those need a human,
 * and re-arming them automatically would be the same class of mistake as
 * auto-repairing a credential: a machine deciding something only a person can.
 *
 * So the match is deliberately narrow and anchored on the gate's own message
 * rather than on a loose guess at intent. If the gate's wording changes, this
 * stops matching and rows stay parked - which is the safe direction to fail.
 *
 * ## Why it delegates to `planRetry`
 *
 * Re-arming is exactly the operator `retry` action, so it IS that action rather
 * than a second implementation of it. That inherits the refusal that matters:
 * a row inside the create crash window is not retryable, because the next step
 * there is the one call that can issue a second real numbered invoice. An
 * automatic path must not be able to do what a human is forbidden from doing.
 */

/** Does this row's park reason say the address was missing? */
export function isParkedOnMissingAddress(row: InvoiceStateRow): boolean {
  return (
    row.status === "needs_review" && (row.last_error ?? "").startsWith(ADDRESS_INCOMPLETE_PREFIX)
  );
}

/** Are the three fields the invoice builder demands all present now? */
export function hasCompleteAddress(buyer: InvoiceBuyerInput | null | undefined): boolean {
  return Boolean(buyer?.street?.trim() && buyer?.city?.trim() && buyer?.postalCode?.trim());
}

/**
 * The patch that puts a row back in the queue, or null to leave it alone.
 *
 * Null for every row this does not apply to, and null is the default: a caller
 * that cannot decide leaves the row parked.
 */
export function planAddressReArm(
  row: InvoiceStateRow,
  buyer: InvoiceBuyerInput | null | undefined,
  config: OperatorActionConfig,
): OperatorActionResult | null {
  if (!isParkedOnMissingAddress(row)) {
    return null;
  }
  if (!hasCompleteAddress(buyer)) {
    return null;
  }
  return planOperatorAction(row, { action: "retry" }, config);
}
