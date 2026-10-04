import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { getAdapter } from "@/lib/channels/registry";
import type { ChannelConnection } from "@/lib/channels/types";
import { normalizeWaId } from "@/lib/channels/whatsapp/policy";

/**
 * Owner alerts + daily summaries over WhatsApp are sent FROM the platform's
 * own number (the active WhatsApp connection of PLATFORM_TENANT_ID — by
 * default Layankan itself) TO the business owner's number, using approved
 * templates (owners rarely have an open 24h window with us).
 */
async function platformConnection(db: SupabaseClient): Promise<ChannelConnection | null> {
  const { data } = await db
    .from("channel_connections")
    .select("id, tenant_id, channel, provider, phone_number_id, waba_id, display_phone_number, settings")
    .eq("tenant_id", env.platformTenantId())
    .eq("channel", "whatsapp")
    .eq("is_active", true)
    .maybeSingle();
  return (data as ChannelConnection | null) ?? null;
}

export async function sendOwnerWhatsApp(
  db: SupabaseClient,
  args: {
    tenantId: string;
    conversationId?: string | null;
    kind: "handoff" | "daily_summary";
    to: string;
    template: string;
    variables: string[];
  },
): Promise<{ ok: boolean; skipped?: string }> {
  const to = normalizeWaId(args.to);
  if (!to) return { ok: false, skipped: "invalid owner number" };
  const conn = await platformConnection(db);
  if (!conn) return { ok: false, skipped: "platform WhatsApp not connected" };
  const res = await getAdapter(conn.provider).sendMessage(conn, {
    to,
    body: "",
    template: { name: args.template, language: env.waTemplateLanguage(), variables: args.variables },
  });
  await db.from("notifications").insert({
    tenant_id: args.tenantId,
    conversation_id: args.conversationId ?? null,
    kind: args.kind,
    transport: "whatsapp",
    recipient: to,
    status: res.status === "failed" ? "failed" : "sent",
    error: res.error ?? null,
    provider_message_id: res.providerMessageId,
    sent_at: res.status === "failed" ? null : new Date().toISOString(),
  });
  return { ok: res.status !== "failed" };
}
