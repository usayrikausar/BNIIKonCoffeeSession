import { NextResponse, type NextRequest } from "next/server";
import { apiTenant } from "@/lib/api/auth";
import { leadsQuery, toCsv } from "@/lib/leads/query";

export async function GET(req: NextRequest) {
  const ctx = await apiTenant();
  if ("error" in ctx) return ctx.error;
  const sp = req.nextUrl.searchParams;
  const { data } = await leadsQuery(ctx.supabase, ctx.tenantId, { score: sp.get("score"), from: sp.get("from"), to: sp.get("to") }, 10000);
  const rows = (data ?? []).map((c) => {
    const d = (c.lead_details ?? {}) as Record<string, string>;
    return [c.last_message_at, c.lead_score, c.score_confidence, d.name, d.phone, d.email, d.need, d.timeline, d.budget, c.score_reason, c.next_action, c.status, c.channel, c.id];
  });
  const csv = toCsv([
    ["last_activity", "score", "confidence", "name", "phone", "email", "need", "timeline", "budget", "reason", "next_action", "status", "channel", "conversation_id"],
    ...rows,
  ]);
  return new NextResponse(csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="layankan-leads-${new Date().toISOString().slice(0, 10)}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
