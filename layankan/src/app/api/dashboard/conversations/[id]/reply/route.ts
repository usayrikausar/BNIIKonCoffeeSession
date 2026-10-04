import { NextResponse, type NextRequest } from "next/server";
import { apiUser, visibleConversation } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { loadConnection, sendOutbound } from "@/lib/agent/engine";
import type { ChannelKind } from "@/lib/channels/types";
import { ServiceWindowClosedError } from "@/lib/channels/whatsapp/policy";
import { templatePreview } from "@/lib/followup/plan";

/**
 * Owner/staff manual reply. Replying implies taking over (AI pauses).
 * WhatsApp: free text only inside the 24h window; otherwise send an approved template.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { supabase, user } = await apiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const conv = await visibleConversation(supabase, id);
  if (!conv) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const input = (await req.json().catch(() => ({}))) as {
    body?: string;
    template?: { name?: string; language?: string; variables?: unknown };
  };
  const text = typeof input.body === "string" ? input.body.trim().slice(0, 4000) : "";

  let template: { name: string; language: string; variables: string[] } | null = null;
  let body = text;
  if (input.template?.name) {
    // Only templates this workspace registered as approved (RLS-scoped read).
    const { data: tpl } = await supabase
      .from("message_templates")
      .select("name, language, body_text, variable_count, status")
      .eq("tenant_id", conv.tenant_id)
      .eq("name", input.template.name)
      .eq("language", input.template.language ?? "ms")
      .maybeSingle();
    if (!tpl || tpl.status !== "APPROVED") return NextResponse.json({ error: "unknown_template" }, { status: 400 });
    const vars = Array.isArray(input.template.variables) ? input.template.variables.map((v) => String(v ?? "").slice(0, 200)) : [];
    if (vars.length < tpl.variable_count) return NextResponse.json({ error: "missing_variables" }, { status: 400 });
    template = { name: tpl.name, language: tpl.language, variables: vars.slice(0, tpl.variable_count) };
    body = templatePreview(tpl.body_text, tpl.name, template.variables);
  }
  if (!body) return NextResponse.json({ error: "empty" }, { status: 400 });

  // Authorised via RLS above; privileged write scoped to that tenant below.
  const admin = createAdminClient();
  const { data: full } = await admin
    .from("conversations")
    .select("last_inbound_at")
    .eq("tenant_id", conv.tenant_id)
    .eq("id", id)
    .single();
  const connection = await loadConnection(admin, conv.tenant_id, conv.channel_connection_id as string | null);
  const contact = Array.isArray(conv.contact) ? conv.contact[0] : conv.contact;
  try {
    const msg = await sendOutbound(admin, {
      tenantId: conv.tenant_id,
      conversationId: id,
      body,
      sender: "human",
      sentBy: user.id,
      connection,
      channel: conv.channel as ChannelKind,
      contactExternalId: (contact as { external_id?: string } | null)?.external_id ?? "",
      lastInboundAt: full?.last_inbound_at ?? null,
      template,
    });
    if (conv.status !== "human") {
      await admin.from("conversations").update({ status: "human" }).eq("tenant_id", conv.tenant_id).eq("id", id);
    }
    return NextResponse.json({ message: msg, status: "human" });
  } catch (e) {
    if (e instanceof ServiceWindowClosedError) return NextResponse.json({ error: "window_closed" }, { status: 409 });
    return NextResponse.json({ error: "send_failed" }, { status: 502 });
  }
}
