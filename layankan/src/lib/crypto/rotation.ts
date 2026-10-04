import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { credentialAad, keyringFromEnv, reseal, type Keyring } from "./secrets";

// Encryption-key rotation for stored channel credentials (WhatsApp tokens,
// API keys). Steps for the operator (also in EXIT_RUNBOOK.md):
//   1. add a new key to ENCRYPTION_KEYS and make it ENCRYPTION_KEY_CURRENT, redeploy
//   2. /admin → Encryption keys → "Re-encrypt with current key"
//   3. when /admin says the old key is unused, remove it from ENCRYPTION_KEYS, redeploy
// Old ciphertexts stay readable until step 3, so nothing breaks in between.

export interface KeyStatus {
  current: string;
  configured: string[];
  /** Credential rows per key id (all rows, including retired ones kept for audit). */
  rowsByKey: Record<string, number>;
  /** Rows not yet on the current key. */
  stale: number;
  /** Configured, not current, used by no row → can be removed from ENCRYPTION_KEYS. */
  safeToRemove: string[];
  /** Rows encrypted with a key that is NOT configured: unreadable. Must be 0. */
  unreadableKeys: string[];
}

/** Pure: summarise key usage. */
export function summarizeKeys(rowKeyIds: string[], ring: Pick<Keyring, "current" | "keys">): KeyStatus {
  const rowsByKey: Record<string, number> = {};
  for (const k of rowKeyIds) rowsByKey[k] = (rowsByKey[k] ?? 0) + 1;
  const configured = [...ring.keys.keys()];
  return {
    current: ring.current,
    configured,
    rowsByKey,
    stale: rowKeyIds.filter((k) => k !== ring.current).length,
    safeToRemove: configured.filter((k) => k !== ring.current && !rowsByKey[k]),
    unreadableKeys: Object.keys(rowsByKey).filter((k) => !ring.keys.has(k)),
  };
}

export interface CredentialRow {
  id: string;
  tenant_id: string;
  connection_id: string;
  name: string;
  key_id: string;
  ciphertext: string;
}

/** Storage the re-encryption needs (Supabase in production, in-memory in tests). */
export interface CredentialStore {
  /** Up to `limit` rows NOT on `currentKey`, skipping ids in `skip`. */
  listStale(currentKey: string, limit: number, skip: string[]): Promise<CredentialRow[]>;
  /** Replace one row's ciphertext only if it is still exactly `expected` (no lost updates). */
  replace(row: CredentialRow, next: { key_id: string; ciphertext: string }): Promise<boolean>;
}

/**
 * Re-encrypt every stored credential with the current key. Idempotent and
 * safe to re-run; a row that changed meanwhile (e.g. a token was rotated) is
 * left alone because the new value was already written with the current key.
 * Never logs or returns secret values.
 */
export async function resealAll(store: CredentialStore, ring: Keyring = keyringFromEnv(), batch = 200) {
  let done = 0;
  const failed: string[] = [];
  for (;;) {
    const rows = await store.listStale(ring.current, batch, failed);
    if (!rows.length) break;
    for (const row of rows) {
      try {
        const next = reseal({ keyId: row.key_id, ciphertext: row.ciphertext }, credentialAad(row.tenant_id, row.connection_id, row.name), ring);
        if (await store.replace(row, { key_id: next.keyId, ciphertext: next.ciphertext })) done++;
      } catch {
        failed.push(row.id); // unknown key / tampered row: reported, never silently dropped
      }
    }
  }
  return { reencrypted: done, failed: failed.length, failedIds: failed };
}

/** `scope.connectionId` limits the store to one connection (used by tests and one-off repairs). */
export function supabaseCredentialStore(db: SupabaseClient, scope: { connectionId?: string } = {}): CredentialStore {
  return {
    async listStale(currentKey, limit, skip) {
      let q = db
        .from("channel_credentials")
        .select("id, tenant_id, connection_id, name, key_id, ciphertext")
        .neq("key_id", currentKey)
        .order("id")
        .limit(limit);
      if (scope.connectionId) q = q.eq("connection_id", scope.connectionId);
      if (skip.length) q = q.not("id", "in", `(${skip.join(",")})`);
      const { data, error } = await q;
      if (error) throw new Error(`list credentials: ${error.message}`);
      return (data ?? []) as CredentialRow[];
    },
    async replace(row, next) {
      const { data, error } = await db
        .from("channel_credentials")
        .update(next)
        .eq("id", row.id)
        .eq("key_id", row.key_id)
        .eq("ciphertext", row.ciphertext)
        .select("id");
      if (error) throw new Error(`update credential: ${error.message}`);
      return !!data?.length;
    },
  };
}

export async function keyStatus(db: SupabaseClient, ring: Keyring = keyringFromEnv()): Promise<KeyStatus> {
  const ids: string[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await db.from("channel_credentials").select("key_id").order("id").range(from, from + 999);
    if (error) throw new Error(`key status: ${error.message}`);
    ids.push(...(data ?? []).map((r) => r.key_id as string));
    if (!data || data.length < 1000) break;
  }
  return summarizeKeys(ids, ring);
}
