import { NextResponse, type NextRequest } from "next/server";
import { apiTenant } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { findOrCreateConversation } from "@/lib/chat/conversations";
import { recordInbound, runAgentTurn } from "@/lib/agent/engine";
import { allow } from "@/lib/ratelimit";
import { HANDOFF_REASON_LABELS } from "@/lib/agent/handoff";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Owner's preview pane: the SAME engine as live chat, on a conversation
 * flagged is_test (hidden from inbox, summaries and alerts). Works in Draft.
 */
export async function POST(req: NextRequest) {
  const ctx = await apiTenant();
  if ("error" in ctx) return ctx.error;
  const admin = createAdminClient();
  const externalId = `test_${ctx.user.id}`;
  const body = (await req.json().catch(() => ({}))) as { message?: string; reset?: boolean };

  if (body.reset) {
    await admin.from("contacts").delete().eq("tenant_id", ctx.tenantId).eq("channel", "web").eq("external_id", externalId);
    return NextResponse.json({ messages: [], assessment: null });
  }
  const text = typeof body.message === "string" ? body.message.trim().slice(0, 2000) : "";
  if (!text) return NextResponse.json({ error: "empty" }, { status: 400 });
  if (!(await allow(admin, `test:${ctx.tenantId}`, 3600, 200))) return NextResponse.json({ error: "rate_limited" }, { status: 429 });

  const { conversationId } = await findOrCreateConversation(admin, { tenantId: ctx.tenantId, channel: "web", externalId, isTest: true });
  const inbound = await recordInbound(admin, { tenantId: ctx.tenantId, conversationId, body: text, channel: "web", provider: "web" });
  let handedOff = false;
  if (inbound) {
    const turn = await runAgentTurn(admin, { tenantId: ctx.tenantId, conversationId, inboundMessageId: inbound.id });
    handedOff = turn.handedOff;
    // In the preview we keep chatting after a handoff so the owner can keep testing.
    if (handedOff) await admin.from("conversations").update({ status: "ai" }).eq("tenant_id", ctx.tenantId).eq("id", conversationId);
  }

  const [{ data: messages }, { data: assessment }] = await Promise.all([
    admin.from("messages").select("id, sender, body, created_at").eq("tenant_id", ctx.tenantId).eq("conversation_id", conversationId).order("created_at"),
    admin
      .from("ai_assessments")
      .select("score, confidence, reason, captured, next_action, handoff_required, handoff_decision, error, latency_ms")
      .eq("tenant_id", ctx.tenantId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  const reasons = ((assessment?.handoff_decision as { reasons?: string[] } | null)?.reasons ?? []).map(
    (r) => HANDOFF_REASON_LABELS[r as keyof typeof HANDOFF_REASON_LABELS]?.ms ?? r,
  );
  return NextResponse.json({ messages: messages ?? [], assessment, handedOff, handoffReasons: reasons });
}
