import { NextResponse, type NextRequest } from "next/server";
import { apiUser, visibleConversation } from "@/lib/api/auth";
import { canTakeOver } from "@/lib/chat/assignment";

const TRANSITIONS: Record<string, { to: string; from: string[] }> = {
  take_over: { to: "human", from: ["ai", "needs_human", "closed"] },
  hand_back: { to: "ai", from: ["human", "needs_human", "closed"] },
  close: { to: "closed", from: ["ai", "human", "needs_human"] },
  reopen: { to: "ai", from: ["closed"] },
};

/**
 * Take over / hand back to AI / close / reopen / assign.
 * Shared inbox, "first to take it": taking a chat assigns it to you; taking
 * someone else's chat requires `force` (the UI asks "take it from Aisyah?").
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { supabase, user } = await apiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const conv = await visibleConversation(supabase, id);
  if (!conv) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    outcome?: string | null;
    value_rm?: number | null;
    force?: boolean;
    user_id?: string | null;
    disabled?: boolean;
  };
  const { action } = body;

  // Marketing opt-in (R1): a customer asked a staff member to stop promotions.
  // Recorded as the staff member (RLS only allows withdrawals, never grants).
  if (action === "record_optout") {
    const { data: c } = await supabase.from("conversations").select("contact_id, channel").eq("id", id).eq("tenant_id", conv.tenant_id).single();
    if (!c) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const { error } = await supabase.from("marketing_consent_events").insert({
      tenant_id: conv.tenant_id,
      contact_id: c.contact_id,
      channel: c.channel,
      action: "withdrawn",
      method: "staff_withdrawal",
      consent_text: "Customer asked a staff member to stop promotions.",
      consent_text_version: "staff",
      recorded_by: user.id,
    });
    if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });
    return NextResponse.json({ status: conv.status, consent: "withdrawn" });
  }

  // Per-chat switch for automatic SUAM follow-ups (any team member).
  if (action === "set_follow_up") {
    const disabled = body.disabled === true;
    const { error } = await supabase.from("conversations").update({ follow_up_disabled: disabled }).eq("id", id).eq("tenant_id", conv.tenant_id);
    if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });
    return NextResponse.json({ status: conv.status, follow_up_disabled: disabled });
  }

  // Conversion tracking: owner/staff mark the lead's outcome.
  if (action === "set_outcome") {
    const outcome = body.outcome === "won" || body.outcome === "lost" ? body.outcome : null;
    const value = typeof body.value_rm === "number" && body.value_rm >= 0 && body.value_rm < 10_000_000 ? Math.round(body.value_rm * 100) : null;
    const { error } = await supabase
      .from("conversations")
      .update({ outcome, outcome_value_cents: outcome === "won" ? value : null, outcome_at: outcome ? new Date().toISOString() : null })
      .eq("id", id)
      .eq("tenant_id", conv.tenant_id);
    if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });
    return NextResponse.json({ status: conv.status, outcome });
  }
  // Owner (re)assigns a chat to a colleague, or back to the shared queue.
  if (action === "assign") {
    const { data: me } = await supabase.from("tenant_members").select("role").eq("tenant_id", conv.tenant_id).eq("user_id", user.id).maybeSingle();
    if (me?.role !== "owner") return NextResponse.json({ error: "owner_only" }, { status: 403 });
    const target = body.user_id ?? null;
    const patch = target ? { assigned_to: target, status: conv.status === "closed" ? "human" : conv.status === "ai" ? "human" : conv.status } : { assigned_to: null };
    const { error } = await supabase.from("conversations").update(patch).eq("id", id).eq("tenant_id", conv.tenant_id);
    if (error) return NextResponse.json({ error: "not_a_member" }, { status: 400 });
    return NextResponse.json({ status: (patch as { status?: string }).status ?? conv.status, assigned_to: target });
  }

  const tr = action ? TRANSITIONS[action] : undefined;
  if (!tr) return NextResponse.json({ error: "bad_action" }, { status: 400 });

  if (action === "take_over") {
    const check = canTakeOver(conv, user.id, body.force === true);
    if (!check.ok) return NextResponse.json({ error: "held_by_other", assigned_to: check.holder }, { status: 409 });
    // Atomic in the database: only wins if nobody else took it since we looked (unless forced).
    const { data, error } = await supabase.rpc("take_conversation", { p_conversation: id, p_force: body.force === true });
    if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });
    const r = data as { ok: boolean; assigned_to: string | null };
    if (!r.ok) return NextResponse.json({ error: "held_by_other", assigned_to: r.assigned_to }, { status: 409 });
    return NextResponse.json({ status: "human", assigned_to: user.id });
  }

  if (!tr.from.includes(conv.status)) return NextResponse.json({ status: conv.status, assigned_to: conv.assigned_to });
  const patch: Record<string, unknown> = { status: tr.to };
  if (tr.to === "ai") {
    patch.handoff_reason = null;
    patch.assigned_to = null; // back in the AI's hands → released
  }
  const { error } = await supabase.from("conversations").update(patch).eq("id", id).eq("tenant_id", conv.tenant_id);
  if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });
  return NextResponse.json({ status: tr.to, assigned_to: "assigned_to" in patch ? null : conv.assigned_to });
}

/** PDPA: permanently delete this customer's data (owner only, enforced by RLS). */
export async function DELETE(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { supabase, user } = await apiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const conv = await visibleConversation(supabase, id);
  if (!conv) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const { data, error } = await supabase
    .from("contacts")
    .delete()
    .eq("id", conv.contact_id)
    .eq("tenant_id", conv.tenant_id)
    .select("id");
  if (error || !data?.length) return NextResponse.json({ error: "forbidden" }, { status: 403 });
  return NextResponse.json({ deleted: true });
}
