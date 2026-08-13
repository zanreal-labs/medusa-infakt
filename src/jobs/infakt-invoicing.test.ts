import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { describe, expect, it, vi } from "vitest";
import { INFAKT_MODULE } from "../modules/infakt";
import infaktInvoicingJob from "./infakt-invoicing";

/**
 * Only the enablement gate at the top of the job. The rest of the run (claiming,
 * draining due rows, KSeF readiness) is covered by `claim-logic.test.ts` and
 * `pipeline.test.ts` - what is not covered anywhere else is that the job asks
 * for the CURRENT effective enablement on every tick and refuses to go any
 * further when it says no, regardless of which of the three reasons applies.
 */

const logger = () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() });

const harness = (enablement: { effectiveEnabled: boolean; reason: string }) => {
  const log = logger();
  const claimRun = vi.fn().mockResolvedValue({ acquired: false, reason: "not reached" });
  const infakt = {
    claimRun,
    getEffectiveEnablement: vi.fn().mockResolvedValue(enablement),
  };
  const container = {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.LOGGER) {
        return log;
      }
      if (key === INFAKT_MODULE) {
        return infakt;
      }
      throw new Error(`unexpected resolve(${key})`);
    },
  } as unknown as MedusaContainer;
  return { claimRun, container, log };
};

describe("infaktInvoicingJob: the enablement gate", () => {
  it("never claims the run when apiKey is not configured", async () => {
    const { claimRun, container } = harness({ effectiveEnabled: false, reason: "no_api_key" });
    await infaktInvoicingJob(container);
    expect(claimRun).not.toHaveBeenCalled();
  });

  it("never claims the run while invoicing is paused", async () => {
    const { claimRun, container } = harness({ effectiveEnabled: false, reason: "paused" });
    await infaktInvoicingJob(container);
    expect(claimRun).not.toHaveBeenCalled();
  });

  it("never claims the run when force-disabled by the environment", async () => {
    const { claimRun, container } = harness({
      effectiveEnabled: false,
      reason: "env_force_disabled",
    });
    await infaktInvoicingJob(container);
    expect(claimRun).not.toHaveBeenCalled();
  });

  it("does not log anything for a disabled/paused/forced-off tick - that would bury the real log lines every five minutes", async () => {
    const { container, log } = harness({ effectiveEnabled: false, reason: "paused" });
    await infaktInvoicingJob(container);
    expect(log.info).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(log.error).not.toHaveBeenCalled();
  });

  it("proceeds to claim the run once invoicing is effectively enabled", async () => {
    const { claimRun, container } = harness({ effectiveEnabled: true, reason: "active" });
    await infaktInvoicingJob(container);
    expect(claimRun).toHaveBeenCalledTimes(1);
  });

  it("checks enablement fresh on every call, not once at import time", async () => {
    const enablement = vi
      .fn()
      .mockResolvedValueOnce({ effectiveEnabled: false, reason: "paused" })
      .mockResolvedValueOnce({ effectiveEnabled: true, reason: "active" });
    const log = logger();
    const claimRun = vi.fn().mockResolvedValue({ acquired: false, reason: "not reached" });
    const infakt = { claimRun, getEffectiveEnablement: enablement };
    const container = {
      resolve: (key: string) => {
        if (key === ContainerRegistrationKeys.LOGGER) {
          return log;
        }
        if (key === INFAKT_MODULE) {
          return infakt;
        }
        throw new Error(`unexpected resolve(${key})`);
      },
    } as unknown as MedusaContainer;

    await infaktInvoicingJob(container);
    expect(claimRun).not.toHaveBeenCalled();
    await infaktInvoicingJob(container);
    expect(claimRun).toHaveBeenCalledTimes(1);
  });
});

/**
 * The parked-invoice alert. A `needs_review` row is a failure an operator has to
 * be told about - there is no bulk queue to hunt through - so the worker raises a
 * Medusa admin-feed notification when it parks one, and must never let that alert's
 * failure break the run.
 */
const reviewHarness = (options: { notification?: unknown } = {}) => {
  const log = logger();
  const updateInfaktInvoices = vi.fn(() => Promise.resolve());
  const releaseRun = vi.fn().mockResolvedValue(true);
  const infakt = {
    apiClient: {},
    claimRun: vi.fn().mockResolvedValue({ acquired: true, token: "tok" }),
    getEffectiveEnablement: vi.fn().mockResolvedValue({ effectiveEnabled: true, reason: "active" }),
    // One due row whose order no longer exists -> the pipeline throws a review
    // signal -> the worker parks it and alerts.
    listDueInvoices: vi
      .fn()
      .mockResolvedValue([{ attempts: 0, id: "inv_1", order_id: "order_1", status: "pending" }]),
    releaseRun,
    resolvedOptions: {
      currency: "PLN",
      emitIssuedEvent: true,
      ksefMode: "nip-only",
      ksefPossible: false,
      ksefRequireActive: false,
      nipExtractor: () => {},
      taxSymbol: "23",
    },
    updateInfaktInvoices,
  };
  const notification = options.notification ?? {
    createNotifications: vi.fn().mockResolvedValue({}),
  };
  const query = { graph: vi.fn().mockResolvedValue({ data: [] }) };
  const container = {
    resolve: (key: string) => {
      if (key === ContainerRegistrationKeys.LOGGER) {
        return log;
      }
      if (key === ContainerRegistrationKeys.QUERY) {
        return query;
      }
      if (key === INFAKT_MODULE) {
        return infakt;
      }
      if (key === Modules.NOTIFICATION) {
        if (options.notification === "throw-on-resolve") {
          throw new Error("notification module not registered");
        }
        return notification;
      }
      throw new Error(`unexpected resolve(${key})`);
    },
  } as unknown as MedusaContainer;
  return { container, log, notification, releaseRun, updateInfaktInvoices };
};

describe("infaktInvoicingJob: the needs_review alert", () => {
  it("parks the row and raises an admin-feed notification deep-linked to the order", async () => {
    const notification = { createNotifications: vi.fn().mockResolvedValue({}) };
    const { container, updateInfaktInvoices } = reviewHarness({ notification });

    await infaktInvoicingJob(container);

    expect(updateInfaktInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inv_1", status: "needs_review" }),
    );
    expect(notification.createNotifications).toHaveBeenCalledTimes(1);
    expect(notification.createNotifications).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: "feed",
        resource_id: "order_1",
        resource_type: "order",
        template: "admin-ui",
      }),
    );
  });

  it("still finishes the run when the notification module is not registered", async () => {
    const { container, log, releaseRun, updateInfaktInvoices } = reviewHarness({
      notification: "throw-on-resolve",
    });

    await expect(infaktInvoicingJob(container)).resolves.toBeUndefined();

    // The row is still parked, the run still releases its claim, and the missing
    // alert is a warning - not a thrown, unhandled failure.
    expect(updateInfaktInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inv_1", status: "needs_review" }),
    );
    expect(releaseRun).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalled();
  });

  it("still finishes the run when creating the notification itself fails", async () => {
    const notification = {
      createNotifications: vi.fn().mockRejectedValue(new Error("provider down")),
    };
    const { container, releaseRun, updateInfaktInvoices } = reviewHarness({ notification });

    await expect(infaktInvoicingJob(container)).resolves.toBeUndefined();

    expect(updateInfaktInvoices).toHaveBeenCalledWith(
      expect.objectContaining({ id: "inv_1", status: "needs_review" }),
    );
    expect(releaseRun).toHaveBeenCalledTimes(1);
  });
});
