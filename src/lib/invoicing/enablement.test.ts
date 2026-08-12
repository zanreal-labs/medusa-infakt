import { describe, expect, it } from "vitest";
import { isInvoicingForceDisabledByEnv, resolveEffectiveEnablement } from "./enablement";

describe("isInvoicingForceDisabledByEnv", () => {
  it("is false when the variable is absent or blank", () => {
    expect(isInvoicingForceDisabledByEnv({})).toBe(false);
    expect(isInvoicingForceDisabledByEnv({ INFAKT_INVOICING_DISABLED: "" })).toBe(false);
    expect(isInvoicingForceDisabledByEnv({ INFAKT_INVOICING_DISABLED: "   " })).toBe(false);
  });

  it("is false for anything that is not one of the recognized truthy spellings", () => {
    for (const value of ["0", "false", "no", "off", "disabled"]) {
      expect(isInvoicingForceDisabledByEnv({ INFAKT_INVOICING_DISABLED: value })).toBe(false);
    }
  });

  it("is true for 1, true and yes, case-insensitively and trimmed", () => {
    for (const value of ["1", "true", "TRUE", "  true  ", "yes", "Yes"]) {
      expect(isInvoicingForceDisabledByEnv({ INFAKT_INVOICING_DISABLED: value })).toBe(true);
    }
  });
});

describe("resolveEffectiveEnablement", () => {
  it("is active only when apiKey is configured, not paused, and not env-forced", () => {
    const result = resolveEffectiveEnablement({
      apiKeyConfigured: true,
      envForceDisabled: false,
      invoicingPaused: false,
    });
    expect(result).toMatchObject({ effectiveEnabled: true, reason: "active" });
  });

  it("reports no_api_key when apiKey is absent, regardless of the other two", () => {
    for (const invoicingPaused of [true, false]) {
      const result = resolveEffectiveEnablement({
        apiKeyConfigured: false,
        envForceDisabled: false,
        invoicingPaused,
      });
      expect(result).toMatchObject({ effectiveEnabled: false, reason: "no_api_key" });
    }
  });

  it("reports paused when apiKey is present but the switch is off", () => {
    const result = resolveEffectiveEnablement({
      apiKeyConfigured: true,
      envForceDisabled: false,
      invoicingPaused: true,
    });
    expect(result).toMatchObject({ effectiveEnabled: false, reason: "paused" });
  });

  it("env_force_disabled outranks everything, including an admin having unpaused invoicing", () => {
    const result = resolveEffectiveEnablement({
      apiKeyConfigured: true,
      envForceDisabled: true,
      invoicingPaused: false,
    });
    expect(result).toMatchObject({ effectiveEnabled: false, reason: "env_force_disabled" });
  });

  it("env_force_disabled outranks a missing apiKey too - the reason is unambiguous", () => {
    const result = resolveEffectiveEnablement({
      apiKeyConfigured: false,
      envForceDisabled: true,
      invoicingPaused: true,
    });
    expect(result).toMatchObject({ effectiveEnabled: false, reason: "env_force_disabled" });
  });

  it("always echoes the three inputs back, whatever the outcome", () => {
    const result = resolveEffectiveEnablement({
      apiKeyConfigured: true,
      envForceDisabled: false,
      invoicingPaused: true,
    });
    expect(result).toMatchObject({
      apiKeyConfigured: true,
      envForceDisabled: false,
      invoicingPaused: true,
    });
  });
});
