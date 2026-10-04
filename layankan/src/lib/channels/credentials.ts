import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { credentialAad, open, seal } from "@/lib/crypto/secrets";

/**
 * Encrypted per-tenant channel credentials. Rotation is zero-downtime:
 * the new value is inserted first, then the previous row is retired, so a
 * concurrent sender always finds a valid current credential.
 */
export async function putCredential(tenantId: string, connectionId: string, name: string, value: string) {
  const db = createAdminClient();
  const sealed = seal(value, credentialAad(tenantId, connectionId, name));
  const { data: prev } = await db
    .from("channel_credentials")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("connection_id", connectionId)
    .eq("name", name)
    .eq("is_current", true)
    .is("revoked_at", null);
  // Retire old first (partial unique index allows one current), then insert.
  if (prev?.length) {
    await db
      .from("channel_credentials")
      .update({ is_current: false })
      .in("id", prev.map((p) => p.id));
  }
  const { error } = await db.from("channel_credentials").insert({
    tenant_id: tenantId,
    connection_id: connectionId,
    name,
    key_id: sealed.keyId,
    ciphertext: sealed.ciphertext,
  });
  if (error) {
    // Roll back so the old credential keeps working.
    if (prev?.length) await db.from("channel_credentials").update({ is_current: true }).in("id", prev.map((p) => p.id));
    throw new Error(`Could not store credential: ${error.message}`);
  }
  if (prev?.length) {
    await db.from("channel_credentials").update({ revoked_at: new Date().toISOString() }).in("id", prev.map((p) => p.id));
  }
}

export async function getCredential(tenantId: string, connectionId: string, name: string): Promise<string | null> {
  const db = createAdminClient();
  const { data } = await db
    .from("channel_credentials")
    .select("key_id, ciphertext")
    .eq("tenant_id", tenantId)
    .eq("connection_id", connectionId)
    .eq("name", name)
    .eq("is_current", true)
    .is("revoked_at", null)
    .maybeSingle();
  if (!data) return null;
  return open({ keyId: data.key_id, ciphertext: data.ciphertext }, credentialAad(tenantId, connectionId, name));
}
