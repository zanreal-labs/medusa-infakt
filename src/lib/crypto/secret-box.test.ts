import { describe, expect, it } from "vitest";
import { decryptSecret, encryptSecret } from "./secret-box";

describe("secret-box", () => {
  it("round-trips a secret with the same key", () => {
    const payload = encryptSecret("infakt-live-key-123", "correct key material");
    expect(decryptSecret(payload, "correct key material")).toBe("infakt-live-key-123");
  });

  it("produces a different payload every call, even for the same secret", () => {
    const first = encryptSecret("same-secret", "key");
    const second = encryptSecret("same-secret", "key");
    expect(first).not.toBe(second);
    expect(decryptSecret(first, "key")).toBe("same-secret");
    expect(decryptSecret(second, "key")).toBe("same-secret");
  });

  it("refuses to decrypt with the wrong key", () => {
    const payload = encryptSecret("infakt-live-key-123", "correct key material");
    expect(() => decryptSecret(payload, "wrong key material")).toThrow();
  });

  it("refuses a malformed payload", () => {
    expect(() => decryptSecret("not-a-real-payload", "any key")).toThrow(/malformed/u);
    expect(() => decryptSecret("only.two-parts", "any key")).toThrow(/malformed/u);
  });

  it("refuses a tampered ciphertext", () => {
    const payload = encryptSecret("infakt-live-key-123", "correct key material");
    const [iv, tag, ciphertext] = payload.split(".");
    const tampered = `${iv}.${tag}.${ciphertext?.slice(0, -2)}AA`;
    expect(() => decryptSecret(tampered, "correct key material")).toThrow();
  });

  it("handles unicode secrets", () => {
    const payload = encryptSecret("żółć-key-ключ", "key material");
    expect(decryptSecret(payload, "key material")).toBe("żółć-key-ключ");
  });
});
