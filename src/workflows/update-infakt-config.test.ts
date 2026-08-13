import { describe, expect, it, vi } from "vitest";
import { revertInfaktConfig, runUpdateInfaktConfig } from "./update-infakt-config";
import type { ConfigOverrideService } from "./update-infakt-config";

/**
 * As with `set-invoicing-paused.test.ts`, the step's body is tested directly
 * rather than through the workflow: what matters is that the raw previous
 * override row is captured BEFORE the write, and that compensation restores
 * that exact row - `api_key_ciphertext` included, and never re-encrypted.
 */

const NO_OVERRIDES = {
  api_key_ciphertext: null,
  currency: null,
  environment: null,
  ksef_mode: null,
  trigger_event: null,
};

const service = (
  previous: Record<string, unknown> = NO_OVERRIDES,
): ConfigOverrideService & {
  updateConfigOverrides: ReturnType<typeof vi.fn>;
  setConfigOverridesRaw: ReturnType<typeof vi.fn>;
} => ({
  getConfigOverrides: vi.fn().mockResolvedValue(previous),
  setConfigOverridesRaw: vi.fn(() => Promise.resolve()),
  updateConfigOverrides: vi.fn(() => Promise.resolve()),
});

describe("runUpdateInfaktConfig", () => {
  it("writes the patch and reports applied", async () => {
    const infakt = service();
    const { result } = await runUpdateInfaktConfig({ currency: "EUR" }, infakt);
    expect(result).toEqual({ applied: true });
    expect(infakt.updateConfigOverrides).toHaveBeenCalledWith({ currency: "EUR" });
  });

  it("captures the previous raw override row BEFORE writing, for compensation", async () => {
    const previous = { ...NO_OVERRIDES, currency: "PLN" };
    const infakt = service(previous);
    const { compensation } = await runUpdateInfaktConfig({ currency: "EUR" }, infakt);
    expect(compensation).toEqual({ previous });
  });

  it("does not let a validation failure inside updateConfigOverrides swallow the capture", async () => {
    const infakt = service();
    infakt.updateConfigOverrides.mockRejectedValueOnce(new Error("invalid"));
    await expect(runUpdateInfaktConfig({ ksefMode: "sometimes" }, infakt)).rejects.toThrow(
      "invalid",
    );
    // getConfigOverrides still ran before the throw - a caller that catches this
    // and does not run compensation (the workflow does, on any step failure)
    // still has a correct "previous" value on hand.
    expect(infakt.getConfigOverrides).toHaveBeenCalled();
  });
});

describe("revertInfaktConfig", () => {
  it("restores the captured raw override row directly, bypassing validation and encryption", async () => {
    const infakt = service();
    const previous = { ...NO_OVERRIDES, api_key_ciphertext: "iv.tag.ciphertext" };
    await revertInfaktConfig({ previous }, infakt);
    expect(infakt.setConfigOverridesRaw).toHaveBeenCalledWith(previous);
  });

  it("does nothing when the step never wrote (no compensation data)", async () => {
    const infakt = service();
    await revertInfaktConfig(undefined, infakt);
    expect(infakt.setConfigOverridesRaw).not.toHaveBeenCalled();
  });

  it("round-trips: write then revert leaves the raw row exactly as it started", async () => {
    const previous = { ...NO_OVERRIDES, currency: "PLN" };
    const infakt = service(previous);
    const { compensation } = await runUpdateInfaktConfig({ currency: "EUR" }, infakt);
    await revertInfaktConfig(compensation, infakt);
    expect(infakt.updateConfigOverrides).toHaveBeenCalledWith({ currency: "EUR" });
    expect(infakt.setConfigOverridesRaw).toHaveBeenCalledWith(previous);
  });
});
