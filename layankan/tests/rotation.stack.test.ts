import { describe, expect, it } from "vitest";
import { createHmac, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { credentialAad, open, parseKeyring, seal } from "@/lib/crypto/secrets";
import { keyStatus, resealAll, supabaseCredentialStore } from "@/lib/crypto/rotation";

// Same local-only signing secret as tests/e2e/jwt.mjs (the throwaway E2E stack).
function sign(payload: Record<string, unknown>) {
  const b = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const h = b({ alg: "HS256", typ: "JWT" }), p = b({ exp: 4102444800, ...payload });
  return `${h}.${p}.${createHmac("sha256", "super-secret-jwt-token-with-at-least-32-characters").update(`${h}.${p}`).digest("base64url")}`;
}

// Key rotation against the REAL local database + REST API (not a mock).
// Runs only with the E2E stack up:  bash tests/e2e/stack.sh up && E2E_STACK=1 npx vitest run tests/rotation.stack.test.ts
const live = !!process.env.E2E_STACK;
const B = { tenant: "bbbbbbbb-0000-4000-8000-000000000001", conn: "eeeeeeee-0000-4000-8000-0000000000bb" };

describe.skipIf(!live)("key rotation on the real database", () => {
  it("re-encrypts stored credentials, skips unreadable ones, and reports when the old key can go", async () => {
    const db = createClient("http://127.0.0.1:54321", sign({ role: "service_role", iss: "supabase" }), { auth: { persistSession: false } });
    const k1 = randomBytes(32).toString("base64"), k2 = randomBytes(32).toString("base64");
    const oldRing = parseKeyring(`k1:${k1}`, "k1");
    const newRing = parseKeyring(`k1:${k1},k2:${k2}`, "k2");
    await db.from("channel_credentials").delete().eq("connection_id", B.conn);
    const names = ["rot_a", "rot_b", "rot_c"];
    for (const n of names) {
      const s = seal(`secret-${n}`, credentialAad(B.tenant, B.conn, n), oldRing);
      const { error } = await db.from("channel_credentials").insert({ tenant_id: B.tenant, connection_id: B.conn, name: n, key_id: s.keyId, ciphertext: s.ciphertext });
      expect(error).toBeNull();
    }
    // one row that can't be decrypted (tampered)
    await db.from("channel_credentials").insert({ tenant_id: B.tenant, connection_id: B.conn, name: "rot_bad", key_id: "k1", ciphertext: randomBytes(40).toString("base64") });

    const store = supabaseCredentialStore(db, { connectionId: B.conn }); // only this test's rows
    expect((await store.listStale("k2", 100, [])).length).toBe(4);
    const r = await resealAll(store, newRing, 2);
    expect(r).toMatchObject({ reencrypted: 3, failed: 1 });

    const { data } = await db.from("channel_credentials").select("name, key_id, ciphertext").eq("connection_id", B.conn);
    for (const row of data!.filter((x) => x.name !== "rot_bad")) {
      expect(row.key_id).toBe("k2");
      expect(open({ keyId: row.key_id, ciphertext: row.ciphertext }, credentialAad(B.tenant, B.conn, row.name), newRing)).toBe(`secret-${row.name}`);
    }
    // keyStatus reads the whole table: k1 is still used (by our unreadable row) → must NOT be offered for removal
    const status = await keyStatus(db, newRing);
    expect(status.rowsByKey.k2).toBeGreaterThanOrEqual(3);
    expect(status.safeToRemove).not.toContain("k1");
    expect(await resealAll(store, newRing)).toMatchObject({ reencrypted: 0, failed: 1 }); // re-run is a no-op
    await db.from("channel_credentials").delete().eq("connection_id", B.conn);
  });
});
