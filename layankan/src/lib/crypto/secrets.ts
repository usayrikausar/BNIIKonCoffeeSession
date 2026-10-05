import "server-only";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM envelope for channel credentials (WhatsApp tokens, API keys).
 *
 * ENCRYPTION_KEYS="k1:<base64 32 bytes>,k2:<base64 32 bytes>"
 * ENCRYPTION_KEY_CURRENT="k2"
 *
 * Each ciphertext records the key id that produced it, so keys can be rotated
 * without downtime: add a new key, make it current, re-encrypt rows in the
 * background, then remove the old key. The tenant/connection ids are bound as
 * additional authenticated data so a ciphertext copied to another tenant's row
 * fails to decrypt.
 */

export interface Keyring {
  current: string;
  keys: Map<string, Buffer>;
}

export function parseKeyring(spec: string | undefined, current: string | undefined): Keyring {
  if (!spec) throw new Error("ENCRYPTION_KEYS is not set");
  const keys = new Map<string, Buffer>();
  for (const part of spec.split(",").map((s) => s.trim()).filter(Boolean)) {
    const idx = part.indexOf(":");
    if (idx < 1) throw new Error("ENCRYPTION_KEYS entries must look like id:base64key");
    const id = part.slice(0, idx);
    const key = Buffer.from(part.slice(idx + 1), "base64");
    if (key.length !== 32) throw new Error(`Encryption key "${id}" must be 32 bytes (base64)`);
    keys.set(id, key);
  }
  const cur = current || [...keys.keys()].pop();
  if (!cur || !keys.has(cur)) throw new Error("ENCRYPTION_KEY_CURRENT does not match any key in ENCRYPTION_KEYS");
  return { current: cur, keys };
}

export function keyringFromEnv(): Keyring {
  return parseKeyring(process.env.ENCRYPTION_KEYS, process.env.ENCRYPTION_KEY_CURRENT);
}

export interface Sealed {
  keyId: string;
  ciphertext: string; // base64(iv[12] | tag[16] | data)
}

export function seal(plaintext: string, aad: string, ring: Keyring = keyringFromEnv()): Sealed {
  const key = ring.keys.get(ring.current)!;
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const data = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return { keyId: ring.current, ciphertext: Buffer.concat([iv, tag, data]).toString("base64") };
}

export function open(sealed: Sealed, aad: string, ring: Keyring = keyringFromEnv()): string {
  const key = ring.keys.get(sealed.keyId);
  if (!key) throw new Error(`Unknown encryption key id "${sealed.keyId}" — was it removed before re-encryption finished?`);
  const buf = Buffer.from(sealed.ciphertext, "base64");
  if (buf.length < 29) throw new Error("ciphertext too short");
  const decipher = createDecipheriv("aes-256-gcm", key, buf.subarray(0, 12));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString("utf8");
}

/** Re-encrypt under the current key (for background key rotation). */
export function reseal(sealed: Sealed, aad: string, ring: Keyring = keyringFromEnv()): Sealed {
  if (sealed.keyId === ring.current) return sealed;
  return seal(open(sealed, aad, ring), aad, ring);
}

/** AAD binding a payment-gateway key to its tenant + payment account + name. */
export function paymentCredentialAad(tenantId: string, accountId: string, name: string): string {
  return `layankan:paycred:${tenantId}:${accountId}:${name}`;
}

/** AAD binding a credential to its tenant + connection + name. */
export function credentialAad(tenantId: string, connectionId: string, name: string): string {
  return `layankan:cred:${tenantId}:${connectionId}:${name}`;
}
