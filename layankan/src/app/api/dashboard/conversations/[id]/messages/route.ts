import { NextResponse, type NextRequest } from "next/server";
import { apiUser, visibleConversation } from "@/lib/api/auth";

/** Polling endpoint for the conversation view (RLS-scoped). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { supabase, user } = await apiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const conv = await visibleConversation(supabase, id);
  if (!conv) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const after = req.nextUrl.searchParams.get("after");
  let q = supabase
    .from("messages")
    .select("id, sender, body, status, created_at, sent_by")
    .eq("conversation_id", id)
    .order("created_at", { ascending: true })
    .limit(500);
  if (after) q = q.gt("created_at", after);
  const [{ data: messages }, { data: c }] = await Promise.all([
    q,
    supabase.from("conversations").select("status, lead_score, score_reason, next_action, lead_details, handoff_reason, last_inbound_at, assigned_to").eq("id", id).single(),
  ]);
  return NextResponse.json({ messages: messages ?? [], conversation: c }, { headers: { "Cache-Control": "no-store" } });
}
