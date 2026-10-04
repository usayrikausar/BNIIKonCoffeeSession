import { NextResponse, type NextRequest } from "next/server";
import { apiUser, visibleConversation } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendOutbound } from "@/lib/agent/engine";
import type { ChannelConnection, ChannelKind } from "@/lib/channels/types";

/** Owner/staff manual reply. Replying implies taking over (AI pauses). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { supabase, user } = await apiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const conv = await visibleConversation(supabase, id);
  if (!conv) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const { body } = (await req.json().catch(() => ({}))) as { body?: string };
  const text = typeof body === "string" ? body.trim().slice(0, 4000) : "";
  if (!text) return NextResponse.json({ error: "empty" }, { status: 400 });

  // Authorised via RLS above; privileged write scoped to that tenant below.
  const admin = createAdminClient();
  if (conv.status !== "human") {
    await admin.from("conversations").update({ status: "human" }).eq("tenant_id", conv.tenant_id).eq("id", id);
  }
  let connection: ChannelConnection | null = null;
  if (conv.channel_connection_id) {
    const { data } = await admin
      .from("channel_connections")
      .select("id, tenant_id, channel, provider, phone_number_id, waba_id, display_phone_number, settings")
      .eq("tenant_id", conv.tenant_id)
      .eq("id", conv.channel_connection_id)
      .maybeSingle();
    connection = data as ChannelConnection | null;
  }
  const contact = Array.isArray(conv.contact) ? conv.contact[0] : conv.contact;
  const msg = await sendOutbound(admin, {
    tenantId: conv.tenant_id,
    conversationId: id,
    body: text,
    sender: "human",
    sentBy: user.id,
    connection,
    channel: conv.channel as ChannelKind,
    contactExternalId: (contact as { external_id?: string } | null)?.external_id ?? "",
  });
  return NextResponse.json({ message: msg, status: "human" });
}
