import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/**
 * Encrypts one secret string at rest, for the one column in this plugin that
 * needs it: an admin-set `apiKey` override, persisted in `infakt_settings` so it
 * survives a restart without a redeploy.
 *
 * Everything else this plugin persists is operational metadata (statuses,
 * timestamps, reasons) - never a credential - so this is deliberately the only
 * place encryption exists at all. AES-256-GCM from Node's built-in `crypto` was
 * chosen specifically so this plugin pulls in no new dependency for it.
 *
 * The key material is whatever string the host passes as `settingsEncryptionKey`
 * (see `src/lib/options.ts`), hashed with SHA-256 into a 32-byte key. Hashing
 * rather than requiring an exact 32-byte value means an operator can set the
 * option to any passphrase-length string and it still produces a valid AES-256
 * key - the hash is a key-derivation step, not a weakening of it.
 */

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;

const deriveKey = (keyMaterial: string): Buffer =>
  createHash("sha256").update(keyMaterial, "utf-8").digest();

/**
 * Encrypt `plaintext` with `keyMaterial`.
 *
 * Returns `iv.tag.ciphertext`, each segment base64, joined with `.` so the whole
 * thing is one text column value. A fresh random IV every call, so encrypting the
 * same API key twice never produces the same payload - nothing about that is
 * meant to be comparable or deduplicated.
 */
export function encryptSecret(plaintext: string, keyMaterial: string): string {
  const key = deriveKey(keyMaterial);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv, tag, ciphertext].map((buffer) => buffer.toString("base64")).join(".");
}

/**
 * Decrypt a payload produced by `encryptSecret`.
 *
 * Throws on a malformed payload, a wrong key, or a tampered ciphertext - GCM's
 * authentication tag makes the last of those a throw rather than garbage output.
 * Callers that read this at a runtime decision point (not a request an operator
 * is watching) should treat every throw here the same way: fall back to the
 * boot-time `apiKey` rather than letting a rotated encryption key break invoicing.
 */
export function decryptSecret(payload: string, keyMaterial: string): string {
  const parts = payload.split(".");
  if (parts.length !== 3) {
    // eslint-disable-next-line @medusajs/use-medusa-error-not-generic-error -- this module deliberately has no dependency on @medusajs/framework, and every caller (see resolveEffectiveApiKey) already catches this and falls back rather than letting it reach an HTTP response.
    throw new Error("medusa-infakt: malformed encrypted secret payload.");
  }
  const [ivPart, tagPart, ciphertextPart] = parts as [string, string, string];
  const key = deriveKey(keyMaterial);
  const iv = Buffer.from(ivPart, "base64");
  const tag = Buffer.from(tagPart, "base64");
  const ciphertext = Buffer.from(ciphertextPart, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf-8");
}
