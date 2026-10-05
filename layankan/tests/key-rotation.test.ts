import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { credentialAad, open, parseKeyring, seal } from "@/lib/crypto/secrets";
import { resealAll, summarizeKeys, type CredentialRow, type CredentialStore } from "@/lib/crypto/rotation";

const k = () => randomBytes(32).toString("base64");
const K1 = k(), K2 = k();
const oldRing = parseKeyring(`k1:${K1}`, "k1");
const newRing = parseKeyring(`k1:${K1},k2:${K2}`, "k2");

function memoryStore(rows: CredentialRow[]): CredentialStore & { rows: CredentialRow[] } {
  return {
    rows,
    async listStale(current, limit, skip) {
      return rows.filter((r) => r.key_id !== current && !skip.includes(r.id)).slice(0, limit).map((r) => ({ ...r }));
    },
    async replace(row, next) {
      const live = rows.find((r) => r.id === row.id);
      if (!live || live.key_id !== row.key_id || live.ciphertext !== row.ciphertext) return false;
      Object.assign(live, next);
      return true;
    },
  };
}
const row = (id: string, secret: string, ring = oldRing): CredentialRow => {
  const s = seal(secret, credentialAad("t1", "c1", id), ring);
  return { id, key_id: s.keyId, ciphertext: s.ciphertext, aad: credentialAad("t1", "c1", id) };
};

describe("encryption key rotation", () => {
  it("re-encrypts every credential with the new key, keeping the secret values", async () => {
    const store = memoryStore(Array.from({ length: 5 }, (_, i) => row(`cred${i}`, `token-${i}`)));
    const r = await resealAll(store, newRing, 2); // small batches: exercises paging
    expect(r).toEqual({ reencrypted: 5, failed: 0, failedIds: [] });
    for (const [i, x] of store.rows.entries()) {
      expect(x.key_id).toBe("k2");
      expect(open({ keyId: x.key_id, ciphertext: x.ciphertext }, x.aad, newRing)).toBe(`token-${i}`);
    }
    // ...and the old key is now safe to remove
    expect(summarizeKeys(store.rows.map((x) => x.key_id), newRing)).toMatchObject({ stale: 0, safeToRemove: ["k1"], unreadableKeys: [] });
  });

  it("is safe to re-run and reports (never drops) rows it can't read", async () => {
    const bad = { ...row("tampered", "x"), ciphertext: Buffer.from("garbage-garbage-garbage-garbage-garbage").toString("base64") };
    const store = memoryStore([row("ok", "secret"), bad]);
    expect(await resealAll(store, newRing)).toMatchObject({ reencrypted: 1, failed: 1, failedIds: ["tampered"] });
    expect(await resealAll(store, newRing)).toMatchObject({ reencrypted: 0, failed: 1 });
    expect(store.rows.find((x) => x.id === "tampered")!.key_id).toBe("k1"); // untouched
    expect(summarizeKeys(store.rows.map((x) => x.key_id), newRing).safeToRemove).toEqual([]); // k1 still in use → keep it
  });

  it("flags rows whose key was removed too early", () => {
    expect(summarizeKeys(["k0", "k2"], newRing)).toMatchObject({ unreadableKeys: ["k0"], stale: 1 });
  });

  it("does not overwrite a credential that was rotated while re-encrypting", async () => {
    const store = memoryStore([row("token", "old")]);
    const stale = (await store.listStale("k2", 10, []))[0]!;
    Object.assign(store.rows[0]!, row("token", "NEW-TOKEN", newRing)); // owner reconnected meanwhile
    expect(await store.replace(stale, { key_id: "k2", ciphertext: "x" })).toBe(false);
    expect(open({ keyId: store.rows[0]!.key_id, ciphertext: store.rows[0]!.ciphertext }, credentialAad("t1", "c1", "token"), newRing)).toBe("NEW-TOKEN");
  });
});
