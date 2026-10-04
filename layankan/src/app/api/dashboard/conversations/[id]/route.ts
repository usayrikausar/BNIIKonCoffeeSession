import { NextResponse, type NextRequest } from "next/server";
import { apiUser, visibleConversation } from "@/lib/api/auth";

const TRANSITIONS: Record<string, { to: string; from: string[] }> = {
  take_over: { to: "human", from: ["ai", "needs_human", "closed"] },
  hand_back: { to: "ai", from: ["human", "needs_human", "closed"] },
  close: { to: "closed", from: ["ai", "human", "needs_human"] },
  reopen: { to: "ai", from: ["closed"] },
};

/** Take over / hand back to AI / close / reopen. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { supabase, user } = await apiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const conv = await visibleConversation(supabase, id);
  if (!conv) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const body = (await req.json().catch(() => ({}))) as { action?: string; outcome?: string | null; value_rm?: number | null };
  const { action } = body;

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
  const tr = action ? TRANSITIONS[action] : undefined;
  if (!tr) return NextResponse.json({ error: "bad_action" }, { status: 400 });
  if (!tr.from.includes(conv.status)) return NextResponse.json({ status: conv.status });

  const patch: Record<string, unknown> = { status: tr.to };
  if (tr.to === "ai") patch.handoff_reason = null;
  const { error } = await supabase.from("conversations").update(patch).eq("id", id).eq("tenant_id", conv.tenant_id);
  if (error) return NextResponse.json({ error: "update_failed" }, { status: 500 });
  return NextResponse.json({ status: tr.to });
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
