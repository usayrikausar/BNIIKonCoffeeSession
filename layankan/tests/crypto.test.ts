import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { open, parseKeyring, reseal, seal, credentialAad } from "@/lib/crypto/secrets";

const k1 = randomBytes(32).toString("base64");
const k2 = randomBytes(32).toString("base64");

describe("credential encryption", () => {
  const ring1 = parseKeyring(`k1:${k1}`, "k1");
  const aad = credentialAad("tenant-a", "conn-1", "access_token");

  it("round-trips", () => {
    const s = seal("EAAG-secret-token", aad, ring1);
    expect(s.ciphertext).not.toContain("EAAG");
    expect(open(s, aad, ring1)).toBe("EAAG-secret-token");
  });

  it("uses a fresh IV every time", () => {
    expect(seal("x", aad, ring1).ciphertext).not.toBe(seal("x", aad, ring1).ciphertext);
  });

  it("cannot be moved to another tenant's row (AAD binding)", () => {
    const s = seal("secret", aad, ring1);
    expect(() => open(s, credentialAad("tenant-b", "conn-1", "access_token"), ring1)).toThrow();
  });

  it("detects tampering", () => {
    const s = seal("secret", aad, ring1);
    const buf = Buffer.from(s.ciphertext, "base64");
    buf[buf.length - 1]! ^= 1;
    expect(() => open({ ...s, ciphertext: buf.toString("base64") }, aad, ring1)).toThrow();
  });

  it("rotates keys without downtime", () => {
    const old = seal("secret", aad, ring1);
    const ring2 = parseKeyring(`k1:${k1},k2:${k2}`, "k2");
    expect(open(old, aad, ring2)).toBe("secret"); // old ciphertext still readable
    const fresh = reseal(old, aad, ring2);
    expect(fresh.keyId).toBe("k2");
    const ring3 = parseKeyring(`k2:${k2}`, "k2"); // old key retired
    expect(open(fresh, aad, ring3)).toBe("secret");
    expect(() => open(old, aad, ring3)).toThrow(/Unknown encryption key/);
  });

  it("rejects malformed keyrings", () => {
    expect(() => parseKeyring("k1:short", "k1")).toThrow(/32 bytes/);
    expect(() => parseKeyring(`k1:${k1}`, "k9")).toThrow();
    expect(() => parseKeyring(undefined, undefined)).toThrow();
  });
});
