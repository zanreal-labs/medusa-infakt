import { describe, expect, it } from "vitest";
import {
  ADMIN_FEED_CHANNEL,
  ADMIN_FEED_TEMPLATE,
  buildNeedsReviewNotification,
  NEEDS_REVIEW_TRIGGER,
} from "./notify";

describe("buildNeedsReviewNotification", () => {
  it("targets the built-in admin feed channel and template", () => {
    const n = buildNeedsReviewNotification({ attempts: 1, message: "boom", orderId: "order_1" });
    expect(n.channel).toBe(ADMIN_FEED_CHANNEL);
    expect(n.channel).toBe("feed");
    expect(n.template).toBe(ADMIN_FEED_TEMPLATE);
    expect(n.template).toBe("admin-ui");
    expect(n.to).toBe("");
  });

  it("carries a title and a description that names the order and the reason", () => {
    const n = buildNeedsReviewNotification({
      attempts: 2,
      message: "inFakt rejected the invoice",
      orderId: "order_42",
    });
    expect(n.data.title).toBe("Invoice needs review");
    expect(n.data.description).toContain("order_42");
    expect(n.data.description).toContain("inFakt rejected the invoice");
  });

  it("deep-links to the order so the operator lands where it can be resolved", () => {
    const n = buildNeedsReviewNotification({ attempts: 0, message: "x", orderId: "order_7" });
    expect(n.resource_id).toBe("order_7");
    expect(n.resource_type).toBe("order");
    expect(n.trigger_type).toBe(NEEDS_REVIEW_TRIGGER);
  });

  it("folds the attempt count into the idempotency key so a re-park re-alerts", () => {
    const first = buildNeedsReviewNotification({ attempts: 1, message: "x", orderId: "order_9" });
    const again = buildNeedsReviewNotification({ attempts: 1, message: "x", orderId: "order_9" });
    const afterRetry = buildNeedsReviewNotification({
      attempts: 3,
      message: "x",
      orderId: "order_9",
    });
    // Same transition collapses to one notification; a later re-park is a new one.
    expect(first.idempotency_key).toBe(again.idempotency_key);
    expect(afterRetry.idempotency_key).not.toBe(first.idempotency_key);
  });
});
