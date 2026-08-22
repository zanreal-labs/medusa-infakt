import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys, Modules } from "@medusajs/framework/utils";
import { describe, expect, it, vi } from "vitest";
import { INFAKT_MODULE } from "../modules/infakt";
import infaktInvoicingJob from "./infakt-invoicing";

/**
 * The job's own gates. Claiming and per-row processing are covered by
 * `claim-logic.test.ts` and `pipeline.test.ts`; what only exists here is the
 * order of the gates - the job asks for the CURRENT effective enablement on
 * every tick and refuses to go any further when it says no, regardless of which
 * of the three reasons applies, and then refuses again when KSeF is required but
 * the account is not ready (see "the KSeF readiness gate" at the bottom).
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
    claimRun: vi.fn().mockResolvedValue({ acquired: true, token: "tok" }),
    getApiClient: vi.fn().mockResolvedValue({}),
    getEffectiveEnablement: vi.fn().mockResolvedValue({ effectiveEnabled: true, reason: "active" }),
    getEffectiveOptions: vi.fn().mockResolvedValue({
      currency: "PLN",
      emitIssuedEvent: true,
      ksefMode: "nip-only",
      ksefPossible: false,
      ksefRequireActive: false,
      nipExtractor: () => {},
      taxSymbol: "23",
    }),
    // One due row whose order no longer exists -> the pipeline throws a review
    // signal -> the worker parks it and alerts.
    listDueInvoices: vi
      .fn()
      .mockResolvedValue([{ attempts: 0, id: "inv_1", order_id: "order_1", status: "pending" }]),
    releaseRun,
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

/**
 * The KSeF readiness gate (`ensureKsefReady`).
 *
 * `ksef.requireActive` is fail-closed on purpose: the run refuses outright rather
 * than letting B2B rows pile up in `needs_review` while a filing deadline passes.
 * That makes the probe itself load-bearing - a probe that cannot answer must
 * refuse, and a probe that answers "active" must let the run through. inFakt
 * retiring the KSeF 1.0 namespace turned every probe into an error, so these
 * decisions are pinned here rather than left to the client tests alone.
 */
const ksefHarness = (opts: {
  verify?: unknown;
  runState?: Record<string, unknown>;
  requireActive?: boolean;
}) => {
  const log = logger();
  const releaseRun = vi.fn().mockResolvedValue(true);
  const listDueInvoices = vi.fn().mockResolvedValue([]);
  const verifyKsefIntegration =
    opts.verify === undefined
      ? vi.fn().mockResolvedValue({ active: true })
      : (opts.verify as ReturnType<typeof vi.fn>);
  const infakt = {
    claimRun: vi.fn().mockResolvedValue({ acquired: true, token: "tok" }),
    getApiClient: vi.fn().mockResolvedValue({}),
    getEffectiveEnablement: vi.fn().mockResolvedValue({ effectiveEnabled: true, reason: "active" }),
    getEffectiveOptions: vi.fn().mockResolvedValue({
      currency: "PLN",
      emitIssuedEvent: true,
      ksefMode: "nip-only",
      ksefPossible: true,
      ksefRequireActive: opts.requireActive ?? true,
      nipExtractor: () => {},
      taxSymbol: "23",
    }),
    getRunState: vi.fn().mockResolvedValue(opts.runState ?? {}),
    listDueInvoices,
    releaseRun,
    verifyKsefIntegration,
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
  return { container, listDueInvoices, log, releaseRun, verifyKsefIntegration };
};

describe("infaktInvoicingJob: the KSeF readiness gate", () => {
  it("drains the queue when the probe says the integration is active", async () => {
    const { container, listDueInvoices, releaseRun } = ksefHarness({
      verify: vi.fn().mockResolvedValue({
        active: true,
        costsLastFetchedAt: "2026-08-21T22:48:56.949+02:00",
      }),
    });

    await expect(infaktInvoicingJob(container)).resolves.toBeUndefined();

    expect(listDueInvoices).toHaveBeenCalledTimes(1);
    expect(releaseRun).toHaveBeenCalledWith("tok", expect.objectContaining({ status: "ok" }));
  });

  it("refuses the whole run when the account is not integrated with KSeF", async () => {
    const { container, listDueInvoices, log, releaseRun } = ksefHarness({
      verify: vi.fn().mockResolvedValue({ active: false }),
    });

    await expect(infaktInvoicingJob(container)).rejects.toThrow(/KSeF is required but not ready/u);

    // No invoice is created: the queue is never even read.
    expect(listDueInvoices).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("REFUSING TO RUN"));
    expect(releaseRun).toHaveBeenCalledWith("tok", expect.objectContaining({ status: "error" }));
  });

  it("refuses the run when the probe itself fails, rather than assuming it is fine", async () => {
    const { container, listDueInvoices, log } = ksefHarness({
      verify: vi.fn().mockResolvedValue({
        active: false,
        error: "API KSeF 1.0 zostalo wylaczone. Prosze przejsc na KSeF 2.0.",
      }),
    });

    await expect(infaktInvoicingJob(container)).rejects.toThrow(/the check itself failed/u);

    expect(listDueInvoices).not.toHaveBeenCalled();
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("the check itself failed"));
  });

  it("skips the probe entirely when KSeF can never be required", async () => {
    const { container, listDueInvoices, verifyKsefIntegration } = ksefHarness({
      requireActive: false,
      verify: vi.fn(),
    });

    await expect(infaktInvoicingJob(container)).resolves.toBeUndefined();

    expect(verifyKsefIntegration).not.toHaveBeenCalled();
    expect(listDueInvoices).toHaveBeenCalledTimes(1);
  });

  it("reuses a recent active answer instead of probing on every tick", async () => {
    const { container, listDueInvoices, verifyKsefIntegration } = ksefHarness({
      runState: { ksef_active: true, ksef_checked_at: new Date() },
      verify: vi.fn(),
    });

    await expect(infaktInvoicingJob(container)).resolves.toBeUndefined();

    expect(verifyKsefIntegration).not.toHaveBeenCalled();
    expect(listDueInvoices).toHaveBeenCalledTimes(1);
  });

  it("re-probes immediately while the last answer was inactive", async () => {
    const verify = vi.fn().mockResolvedValue({ active: true });
    const { container, verifyKsefIntegration } = ksefHarness({
      runState: { ksef_active: false, ksef_checked_at: new Date() },
      verify,
    });

    await expect(infaktInvoicingJob(container)).resolves.toBeUndefined();

    expect(verifyKsefIntegration).toHaveBeenCalledTimes(1);
  });
});
