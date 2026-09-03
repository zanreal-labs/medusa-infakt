import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { INFAKT_SIGNATURE_HEADER, verifyInfaktSignature } from "./webhook-signature";

const SECRET = "3e18cd8c09a3b729958bf393b459b761";
const sign = (body: string, secret = SECRET): string =>
  createHmac("sha256", secret).update(body).digest("hex");

describe("verifyInfaktSignature", () => {
  it("uses the header name inFakt sends, lower-cased as Express normalizes it", () => {
    expect(INFAKT_SIGNATURE_HEADER).toBe("x-infakt-signature");
  });

  it("accepts the hex HMAC-SHA256 of the raw body, as inFakt's own sample computes it", () => {
    const body = JSON.stringify({ verification_code: "abc" });
    expect(verifyInfaktSignature(body, sign(body), SECRET)).toBe(true);
    expect(verifyInfaktSignature(Buffer.from(body, "utf-8"), sign(body), SECRET)).toBe(true);
  });

  it("accepts an upper-cased digest and one padded with whitespace", () => {
    const body = '{"event":{"name":"send_to_ksef_success"}}';
    expect(verifyInfaktSignature(body, `  ${sign(body).toUpperCase()}  `, SECRET)).toBe(true);
  });

  it("rejects a digest computed under a different secret", () => {
    const body = '{"event":{"name":"send_to_ksef_success"}}';
    expect(verifyInfaktSignature(body, sign(body, "rotated"), SECRET)).toBe(false);
  });

  it("rejects a signature over different bytes - re-serialised JSON is not the raw body", () => {
    const raw = '{"a":1, "b":2}';
    const reserialized = JSON.stringify({ a: 1, b: 2 });
    expect(raw).not.toBe(reserialized);
    expect(verifyInfaktSignature(raw, sign(reserialized), SECRET)).toBe(false);
  });

  it("rejects a missing, blank, truncated or non-hex header rather than throwing", () => {
    const body = "{}";
    expect(verifyInfaktSignature(body, undefined, SECRET)).toBe(false);
    expect(verifyInfaktSignature(body, "", SECRET)).toBe(false);
    expect(verifyInfaktSignature(body, sign(body).slice(0, 40), SECRET)).toBe(false);
    expect(verifyInfaktSignature(body, "not-a-hex-digest", SECRET)).toBe(false);
    expect(verifyInfaktSignature(body, `${sign(body)}00`, SECRET)).toBe(false);
  });
});
