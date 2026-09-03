import { bigNumberToMinorUnits } from "./money";

/**
 * The fully-paid gate.
 *
 * Medusa has no `order.paid` event. `payment.captured` fires once per capture,
 * and an order can be captured in parts (multiple payment collections, a partial
 * capture, a split payment). Invoicing on the first capture would issue an
 * invoice for the full order total against a partial payment - the exact
 * mismatch the builder's total-match guard exists to prevent, arriving one layer
 * earlier.
 *
 * So the trigger only ENQUEUES. This gate is evaluated by the worker on every
 * tick, against freshly-read payment state, and defers the row until the whole
 * order total has been captured. A deferred order needs no second event: the
 * next tick re-reads and proceeds on its own.
 *
 * Everything is compared in integer minor units. Comparing decimals invites the
 * classic 133.44 !== 133.44000000000001 stall, where an order is paid in full
 * and the pipeline waits for it forever.
 */

export interface PaymentLike {
  captured_amount?: unknown;
  refunded_amount?: unknown;
  canceled_at?: unknown;
}

export interface PaymentCollectionLike {
  amount?: unknown;
  /** Read for completeness; authorization alone never satisfies the gate. */
  authorized_amount?: unknown;
  captured_amount?: unknown;
  refunded_amount?: unknown;
  status?: string;
  payments?: PaymentLike[] | null;
}

export interface PaidGateOrder {
  total?: unknown;
  payment_collections?: PaymentCollectionLike[] | null;
}

export interface PaidGateResult {
  fullyPaid: boolean;
  /** Captured net of refunds, integer minor units. */
  capturedMinor: number;
  /** Order total, integer minor units; null when unreadable. */
  totalMinor: number | null;
  reason: string;
}

/**
 * Sum captures net of refunds across an order's payment collections.
 *
 * Prefers each collection's own `captured_amount`, and falls back to summing its
 * payments when the aggregate is absent (some read paths do not populate it).
 * Refunds are subtracted at whichever level they were found, so a fully refunded
 * order does not read as paid.
 *
 * Canceled payments are skipped: a canceled payment's `captured_amount` can
 * still be non-zero from before the cancellation.
 *
 * The defaults below only ever move the answer AWAY from "paid": an absent
 * refund really is no refund, and an unreadable capture counts for nothing, so
 * the worst case is an order deferred for another tick rather than an invoice
 * issued against a payment that did not happen. The order total is the one value
 * that must never be defaulted, and `evaluatePaidGate` refuses it outright.
 */
export function capturedMinorUnits(order: PaidGateOrder): number {
  let captured = 0;
  for (const collection of order.payment_collections ?? []) {
    if (collection.status === "canceled" || collection.status === "failed") {
      continue;
    }
    const aggregate = bigNumberToMinorUnits(collection.captured_amount);
    if (aggregate !== null) {
      const refunded = bigNumberToMinorUnits(collection.refunded_amount) ?? 0;
      captured += aggregate - refunded;
      continue;
    }
    for (const payment of collection.payments ?? []) {
      if (payment.canceled_at) {
        continue;
      }
      const paymentCaptured = bigNumberToMinorUnits(payment.captured_amount) ?? 0;
      const paymentRefunded = bigNumberToMinorUnits(payment.refunded_amount) ?? 0;
      captured += paymentCaptured - paymentRefunded;
    }
  }
  return captured;
}

/**
 * Sum refunds across an order's payment collections, in integer minor units.
 *
 * A companion to `capturedMinorUnits`, not a variant of it: that function nets
 * refunds off captures and answers "how much money is on the books", which is
 * the only question the invoicing gate asks. The settlement reconciliation asks
 * a different one - "did any of it come BACK?" - because an invoice inFakt has
 * settled against an order that was refunded is a discrepancy a human has to
 * resolve, and a net figure cannot tell a partial refund apart from a partial
 * capture.
 *
 * Walks the same structures with the same defaults, and skips the same canceled
 * collections and payments, so the two figures always describe the same set of
 * payments. An unreadable refund counts as zero, which - here - is the reading
 * that raises no alarm.
 */
export function refundedMinorUnits(order: PaidGateOrder): number {
  let refunded = 0;
  for (const collection of order.payment_collections ?? []) {
    if (collection.status === "canceled" || collection.status === "failed") {
      continue;
    }
    const aggregate = bigNumberToMinorUnits(collection.captured_amount);
    if (aggregate !== null) {
      refunded += bigNumberToMinorUnits(collection.refunded_amount) ?? 0;
      continue;
    }
    for (const payment of collection.payments ?? []) {
      if (payment.canceled_at) {
        continue;
      }
      refunded += bigNumberToMinorUnits(payment.refunded_amount) ?? 0;
    }
  }
  return refunded;
}

/**
 * Has the buyer paid the whole order?
 *
 * A zero or non-positive total counts as paid rather than deferring forever: a
 * fully discounted or zero-value order is still a document the merchant may be
 * required to issue, and the builder's amount check is the right place for a
 * total that makes no sense - not a payment gate that would park the row with no
 * explanation.
 *
 * An unreadable total is NOT treated as paid: that is a data problem, and
 * proceeding would hand the builder an unverifiable amount.
 */
export function evaluatePaidGate(order: PaidGateOrder): PaidGateResult {
  const totalMinor = bigNumberToMinorUnits(order.total);
  const capturedMinor = capturedMinorUnits(order);

  if (totalMinor === null) {
    return {
      capturedMinor,
      fullyPaid: false,
      reason: "order total is unreadable - cannot verify payment",
      totalMinor: null,
    };
  }
  if (totalMinor <= 0) {
    return {
      capturedMinor,
      fullyPaid: true,
      reason: "order total is zero or negative - nothing to capture",
      totalMinor,
    };
  }
  if (capturedMinor >= totalMinor) {
    return {
      capturedMinor,
      fullyPaid: true,
      reason: `captured ${capturedMinor} of ${totalMinor} (minor units)`,
      totalMinor,
    };
  }
  return {
    capturedMinor,
    fullyPaid: false,
    reason: `captured ${capturedMinor} of ${totalMinor} (minor units) - not fully paid yet`,
    totalMinor,
  };
}
