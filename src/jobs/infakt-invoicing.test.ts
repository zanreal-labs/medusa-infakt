import type { MedusaContainer } from "@medusajs/framework/types";
import { ContainerRegistrationKeys } from "@medusajs/framework/utils";
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
