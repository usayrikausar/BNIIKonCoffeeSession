import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { ChannelKind } from "@/lib/channels/types";

export interface PublicTenant {
  id: string;
  slug: string;
  name: string;
  status: "draft" | "live" | "suspended";
  default_locale: "ms" | "en";
}

export async function getTenantBySlug(db: SupabaseClient, slug: string): Promise<PublicTenant | null> {
  if (!/^[a-z0-9-]{3,48}$/.test(slug)) return null;
  const { data } = await db
    .from("tenants")
    .select("id, slug, name, status, default_locale")
    .eq("slug", slug)
    .maybeSingle();
  return (data as PublicTenant | null) ?? null;
}

/** Active connection for a channel (web always exists implicitly). */
export async function activeConnectionId(db: SupabaseClient, tenantId: string, channel: ChannelKind): Promise<string | null> {
  const { data } = await db
    .from("channel_connections")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("channel", channel)
    .eq("is_active", true)
    .maybeSingle();
  return data?.id ?? null;
}

/**
 * One open conversation per contact per channel. Returns its id, creating the
 * contact and conversation on first contact. All queries tenant-scoped.
 */
export async function findOrCreateConversation(
  db: SupabaseClient,
  args: {
    tenantId: string;
    channel: ChannelKind;
    externalId: string;
    isTest?: boolean;
    visitorTokenHash?: string | null;
    contactName?: string | null;
  },
): Promise<{ conversationId: string; created: boolean }> {
  const { data: contact, error: cErr } = await db
    .from("contacts")
    .upsert(
      {
        tenant_id: args.tenantId,
        channel: args.channel,
        external_id: args.externalId,
        ...(args.contactName ? { name: args.contactName } : {}),
      },
      { onConflict: "tenant_id,channel,external_id", ignoreDuplicates: false },
    )
    .select("id")
    .single();
  if (cErr || !contact) throw new Error(`contact upsert failed: ${cErr?.message}`);

  const { data: existing } = await db
    .from("conversations")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("contact_id", contact.id)
    .eq("channel", args.channel)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (existing) return { conversationId: existing.id, created: false };

  const { data: conv, error } = await db
    .from("conversations")
    .insert({
      tenant_id: args.tenantId,
      contact_id: contact.id,
      channel: args.channel,
      channel_connection_id: await activeConnectionId(db, args.tenantId, args.channel),
      is_test: args.isTest ?? false,
      visitor_token_hash: args.visitorTokenHash ?? null,
    })
    .select("id")
    .single();
  if (error || !conv) throw new Error(`conversation insert failed: ${error?.message}`);
  return { conversationId: conv.id, created: true };
}

/** Messages a customer is allowed to see (never internal/system notes beyond replies). */
export async function listVisibleMessages(db: SupabaseClient, tenantId: string, conversationId: string, after?: string | null) {
  let q = db
    .from("messages")
    .select("id, sender, body, created_at")
    .eq("tenant_id", tenantId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(200);
  if (after) q = q.gt("created_at", after);
  const { data } = await q;
  return (data ?? []).map((m) => ({
    id: m.id as string,
    from: m.sender === "customer" ? ("customer" as const) : ("business" as const),
    body: m.body as string,
    at: m.created_at as string,
  }));
}
