import { describe, expect, it } from "vitest";
import { encryptSecret } from "../crypto/secret-box";
import { resolveInfaktOptions } from "../options";
import type { InfaktPluginOptions } from "../options";
import {
  mergeEffectiveOptions,
  NO_CONFIG_OVERRIDES,
  validateCurrencyOverride,
  validateEnvironmentOverride,
  validateKsefModeOverride,
  validateTriggerEventOverride,
} from "./effective-config";
import type { InfaktConfigOverrides } from "./effective-config";

const boot = (overrides: Partial<InfaktPluginOptions> = {}) =>
  resolveInfaktOptions({ apiKey: "boot-key", ...overrides });

describe("mergeEffectiveOptions: null overrides change nothing", () => {
  it("reproduces the boot configuration exactly when every override is null", () => {
    const resolved = boot({ currency: "EUR", ksef: { mode: "all" }, triggerEvent: "order.placed" });
    const effective = mergeEffectiveOptions(resolved, NO_CONFIG_OVERRIDES);
    expect(effective).toEqual(resolved);
  });
});

describe("mergeEffectiveOptions: each field can be overridden independently", () => {
  it("overrides currency", () => {
    const effective = mergeEffectiveOptions(boot({ currency: "PLN" }), {
      ...NO_CONFIG_OVERRIDES,
      currency: "EUR",
    });
    expect(effective.currency).toBe("EUR");
  });

  it("overrides ksef mode and recomputes ksefPossible", () => {
    const effective = mergeEffectiveOptions(boot({ ksef: { mode: "never" } }), {
      ...NO_CONFIG_OVERRIDES,
      ksef_mode: "all",
    });
    expect(effective.ksefMode).toBe("all");
    expect(effective.ksefPossible).toBe(true);

    const backToNever = mergeEffectiveOptions(boot({ ksef: { mode: "all" } }), {
      ...NO_CONFIG_OVERRIDES,
      ksef_mode: "never",
    });
    expect(backToNever.ksefPossible).toBe(false);
  });

  it("overrides the trigger event", () => {
    const effective = mergeEffectiveOptions(boot({ triggerEvent: "payment.captured" }), {
      ...NO_CONFIG_OVERRIDES,
      trigger_event: "order.placed",
    });
    expect(effective.triggerEvent).toBe("order.placed");
  });

  it("overrides the environment", () => {
    const effective = mergeEffectiveOptions(boot({ environment: "production" }), {
      ...NO_CONFIG_OVERRIDES,
      environment: "sandbox",
    });
    expect(effective.environment).toBe("sandbox");
  });

  it("does not recompute ksefRequireActive from an environment override", () => {
    // Boot resolved requireActive true by production's default. Overriding the
    // environment to sandbox does not silently flip it - that field is not
    // admin-editable, so it always reflects boot configuration.
    const effective = mergeEffectiveOptions(boot({ environment: "production" }), {
      ...NO_CONFIG_OVERRIDES,
      environment: "sandbox",
    });
    expect(effective.ksefRequireActive).toBe(true);
  });
});

describe("mergeEffectiveOptions: apiKey override", () => {
  const overridesWithKey = (plaintext: string, key: string): InfaktConfigOverrides => ({
    ...NO_CONFIG_OVERRIDES,
    api_key_ciphertext: encryptSecret(plaintext, key),
  });

  it("decrypts and uses the override when the encryption key matches", () => {
    const resolved = boot({ apiKey: "boot-key", settingsEncryptionKey: "correct-key" });
    const effective = mergeEffectiveOptions(
      resolved,
      overridesWithKey("admin-set-key", "correct-key"),
    );
    expect(effective.apiKey).toBe("admin-set-key");
    expect(effective.enabled).toBe(true);
  });

  it("enables the plugin from an admin-set key alone, with no boot apiKey", () => {
    const resolved = resolveInfaktOptions({ settingsEncryptionKey: "correct-key" });
    expect(resolved.enabled).toBe(false);
    const effective = mergeEffectiveOptions(
      resolved,
      overridesWithKey("admin-set-key", "correct-key"),
    );
    expect(effective.enabled).toBe(true);
    expect(effective.apiKey).toBe("admin-set-key");
  });

  it("falls back to the boot key when no settingsEncryptionKey is configured", () => {
    const resolved = boot({ apiKey: "boot-key" });
    const effective = mergeEffectiveOptions(
      resolved,
      overridesWithKey("admin-set-key", "correct-key"),
    );
    expect(effective.apiKey).toBe("boot-key");
  });

  it("falls back to the boot key when the encryption key was rotated", () => {
    const resolved = boot({ apiKey: "boot-key", settingsEncryptionKey: "new-key" });
    const effective = mergeEffectiveOptions(resolved, overridesWithKey("admin-set-key", "old-key"));
    expect(effective.apiKey).toBe("boot-key");
  });

  it("falls back to the boot key on a corrupt ciphertext, never throwing", () => {
    const resolved = boot({ apiKey: "boot-key", settingsEncryptionKey: "correct-key" });
    const effective = mergeEffectiveOptions(resolved, {
      ...NO_CONFIG_OVERRIDES,
      api_key_ciphertext: "not-a-real-payload",
    });
    expect(effective.apiKey).toBe("boot-key");
  });

  it("leaves the plugin disabled when neither a boot key nor a decryptable override exists", () => {
    const resolved = resolveInfaktOptions({});
    const effective = mergeEffectiveOptions(resolved, NO_CONFIG_OVERRIDES);
    expect(effective.enabled).toBe(false);
    expect(effective.apiKey).toBeNull();
  });
});

describe("validateCurrencyOverride", () => {
  it("normalizes case and trims", () => {
    expect(validateCurrencyOverride("  eur  ")).toBe("EUR");
  });

  it("rejects anything that is not a 3-letter code", () => {
    expect(() => validateCurrencyOverride("EURO")).toThrow(/currency/u);
    expect(() => validateCurrencyOverride("")).toThrow(/currency/u);
  });
});

describe("validateKsefModeOverride", () => {
  it("accepts every valid mode", () => {
    expect(validateKsefModeOverride("nip-only")).toBe("nip-only");
    expect(validateKsefModeOverride("all")).toBe("all");
    expect(validateKsefModeOverride("never")).toBe("never");
  });

  it("rejects anything else, including an empty string", () => {
    expect(() => validateKsefModeOverride("")).toThrow(/ksef_mode/u);
    expect(() => validateKsefModeOverride("sometimes")).toThrow(/ksef_mode/u);
  });
});

describe("validateTriggerEventOverride", () => {
  it("accepts both supported events", () => {
    expect(validateTriggerEventOverride("payment.captured")).toBe("payment.captured");
    expect(validateTriggerEventOverride("order.placed")).toBe("order.placed");
  });

  it("rejects anything else", () => {
    expect(() => validateTriggerEventOverride("order.shipped")).toThrow(/trigger_event/u);
  });
});

describe("validateEnvironmentOverride", () => {
  it("accepts both environments", () => {
    expect(validateEnvironmentOverride("production")).toBe("production");
    expect(validateEnvironmentOverride("sandbox")).toBe("sandbox");
  });

  it("rejects anything else", () => {
    expect(() => validateEnvironmentOverride("staging")).toThrow(/environment/u);
  });
});
