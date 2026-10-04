import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { recordInbound } from "@/lib/agent/engine";
import type { ChannelConnection, NormalizedEvent } from "@/lib/channels/types";
import { isOptOut, shouldApplyStatus } from "@/lib/channels/whatsapp/policy";
import { findOrCreateConversation } from "./conversations";

export interface PendingTurn {
  tenantId: string;
  conversationId: string;
  inboundMessageId: string;
}

/**
 * Channel-agnostic webhook ingestion. Every event is written to OUR database
 * right away (messages, delivery receipts, messages sent from the provider's
 * own dashboard). Returns the customer messages the agent should answer —
 * the caller runs those after acknowledging the webhook.
 */
export async function ingestEvents(db: SupabaseClient, conn: ChannelConnection, events: NormalizedEvent[]): Promise<PendingTurn[]> {
  const pending: PendingTurn[] = [];
  const tenantId = conn.tenant_id;
  for (const ev of events) {
    try {
      if (ev.kind === "message") {
        const { conversationId } = await findOrCreateConversation(db, {
          tenantId,
          channel: conn.channel,
          externalId: ev.contactExternalId,
          contactName: ev.contactName,
        });
        // Replies go back through the number/provider the customer actually used.
        await db.from("conversations").update({ channel_connection_id: conn.id }).eq("tenant_id", tenantId).eq("id", conversationId);
        const msg = await recordInbound(db, {
          tenantId,
          conversationId,
          body: ev.body,
          channel: conn.channel,
          provider: conn.provider,
          providerMessageId: ev.providerMessageId,
        });
        if (!msg) continue; // duplicate delivery of a webhook we already stored
        if (isOptOut(ev.body)) {
          await db.from("contacts").update({ opted_out_at: new Date().toISOString() })
            .eq("tenant_id", tenantId).eq("channel", conn.channel).eq("external_id", ev.contactExternalId);
        }
        pending.push({ tenantId, conversationId, inboundMessageId: msg.id });
      } else if (ev.kind === "status") {
        await applyStatus(db, tenantId, conn, ev.providerMessageId, ev.status, ev.error ?? null);
      } else if (ev.kind === "outbound_echo") {
        const known = await applyStatus(db, tenantId, conn, ev.providerMessageId, "delivered", null);
        if (!known && ev.body && ev.contactExternalId) await storeEcho(db, conn, ev);
      }
    } catch (e) {
      console.error(`[ingest] tenant=${tenantId} event=${ev.kind} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return pending;
}

/** Returns true if the provider id belongs to one of our messages/notifications. */
async function applyStatus(
  db: SupabaseClient,
  tenantId: string,
  conn: ChannelConnection,
  providerMessageId: string,
  status: string,
  error: string | null,
): Promise<boolean> {
  const { data: msg } = await db
    .from("messages")
    .select("id, status")
    .eq("tenant_id", tenantId)
    .eq("provider", conn.provider)
    .eq("provider_message_id", providerMessageId)
    .maybeSingle();
  if (msg) {
    if (shouldApplyStatus(msg.status, status)) {
      await db.from("messages").update({ status, error, status_updated_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", msg.id);
    }
    await db.from("message_status_events").insert({ tenant_id: tenantId, message_id: msg.id, status, detail: error ? { error } : {} });
    return true;
  }
  // Alerts we sent to business owners from the platform number.
  const { data: notif } = await db.from("notifications").select("id").eq("provider_message_id", providerMessageId).maybeSingle();
  if (notif) {
    if (status === "failed") await db.from("notifications").update({ status: "failed", error }).eq("id", notif.id);
    return true;
  }
  return false;
}

async function storeEcho(db: SupabaseClient, conn: ChannelConnection, ev: Extract<NormalizedEvent, { kind: "outbound_echo" }>) {
  const { conversationId } = await findOrCreateConversation(db, { tenantId: conn.tenant_id, channel: conn.channel, externalId: ev.contactExternalId });
  await db.from("messages").insert({
    tenant_id: conn.tenant_id,
    conversation_id: conversationId,
    direction: "outbound",
    sender: "human",
    body: ev.body.slice(0, 4000),
    channel: conn.channel,
    provider: conn.provider,
    provider_message_id: ev.providerMessageId,
    status: "sent",
    metadata: { source: "provider_dashboard" },
    created_at: ev.sentAt.toISOString(),
  });
}

export async function connectionById(db: SupabaseClient, id: string): Promise<ChannelConnection | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const { data } = await db
    .from("channel_connections")
    .select("id, tenant_id, channel, provider, phone_number_id, waba_id, display_phone_number, settings")
    .eq("id", id)
    .maybeSingle();
  return (data as ChannelConnection | null) ?? null;
}

/** Meta routes by phone_number_id. Prefer the active connection; fall back to any (mid-migration). */
export async function connectionByPhoneNumberId(db: SupabaseClient, phoneNumberId: string): Promise<ChannelConnection | null> {
  const { data } = await db
    .from("channel_connections")
    .select("id, tenant_id, channel, provider, phone_number_id, waba_id, display_phone_number, settings, is_active")
    .eq("provider", "meta_cloud")
    .eq("phone_number_id", phoneNumberId)
    .order("is_active", { ascending: false })
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as ChannelConnection | null) ?? null;
}
