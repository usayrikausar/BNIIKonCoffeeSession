import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { filterProposals, purchaseMemory, type Proposal } from "./memory";
import type { MemoryNote } from "@/lib/agent/prompt";

/** The customer this contact belongs to, created on first need (1 contact → 1 customer; staff linking comes later). */
export async function ensureCustomer(db: SupabaseClient, tenantId: string, contactId: string, displayName?: string | null): Promise<string> {
  const { data: c } = await db.from("contacts").select("customer_id, name").eq("tenant_id", tenantId).eq("id", contactId).single();
  if (c?.customer_id) return c.customer_id as string;
  const { data: created, error } = await db.from("customers").insert({ tenant_id: tenantId, display_name: displayName ?? c?.name ?? null }).select("id").single();
  if (error || !created) throw new Error(`could not create customer: ${error?.message}`);
  // Only link if still unlinked (a parallel turn may have linked it first).
  const { data: linked } = await db.from("contacts").update({ customer_id: created.id }).eq("tenant_id", tenantId).eq("id", contactId).is("customer_id", null).select("customer_id");
  if (linked?.length) return created.id;
  await db.from("customers").delete().eq("tenant_id", tenantId).eq("id", created.id);
  const { data: again } = await db.from("contacts").select("customer_id").eq("tenant_id", tenantId).eq("id", contactId).single();
  return again!.customer_id as string;
}

/** Current memories for the AI (newest first, not deleted, not expired). */
export async function loadMemories(db: SupabaseClient, tenantId: string, contactId: string, limit = 10): Promise<(MemoryNote & { id: string })[]> {
  const { data: c } = await db.from("contacts").select("customer_id").eq("tenant_id", tenantId).eq("id", contactId).maybeSingle();
  if (!c?.customer_id) return [];
  const { data } = await db
    .from("customer_memories")
    .select("id, kind, content")
    .eq("tenant_id", tenantId).eq("customer_id", c.customer_id)
    .is("deleted_at", null).gt("expires_at", new Date().toISOString())
    .order("created_at", { ascending: false })
    .limit(limit);
  return (data ?? []) as (MemoryNote & { id: string })[];
}

/** Keep the AI's proposals that pass the filter. Returns what was kept and what was refused (for the audit log). */
export async function saveAiMemories(
  db: SupabaseClient,
  a: { tenantId: string; contactId: string; industry: string; proposals: Proposal[]; sourceMessageId: string | null; existing: string[] },
) {
  const { keep, rejected } = filterProposals(a.proposals, { industry: a.industry, existing: a.existing });
  if (keep.length) {
    const customerId = await ensureCustomer(db, a.tenantId, a.contactId);
    const { error } = await db.from("customer_memories").insert(
      keep.map((k) => ({ tenant_id: a.tenantId, customer_id: customerId, kind: k.kind, content: k.content, source: "ai", source_message_id: a.sourceMessageId })),
    );
    if (error) console.error(`[memory] tenant=${a.tenantId} could not save: ${error.message}`);
  }
  return { kept: keep, rejected };
}

/** R2 → R3: a VERIFIED payment becomes a purchase memory (only if the business turned memory on). */
export async function savePurchaseMemory(db: SupabaseClient, a: { tenantId: string; contactId: string; description: string; paidCents: number; timeZone: string }) {
  const { data: b } = await db.from("business_brains").select("memory").eq("tenant_id", a.tenantId).maybeSingle();
  if (!(b?.memory as { enabled?: boolean } | null)?.enabled) return;
  const customerId = await ensureCustomer(db, a.tenantId, a.contactId);
  await db.from("customer_memories").insert({
    tenant_id: a.tenantId, customer_id: customerId, kind: "purchase", source: "payment",
    content: purchaseMemory(a.description, a.paidCents, new Date(), a.timeZone),
  });
}

/** Hourly: memories past their 12-month retention are deleted for good (PDPA). */
export async function purgeExpiredMemories(db: SupabaseClient, now = new Date()) {
  const { data } = await db.from("customer_memories").delete().lt("expires_at", now.toISOString()).select("id");
  return data?.length ?? 0;
}
