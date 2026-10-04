import { NextResponse } from "next/server";
import { apiTenant } from "@/lib/api/auth";

/** PDPA data portability: everything this workspace holds, as JSON (owner only). */
export async function GET() {
  const ctx = await apiTenant();
  if ("error" in ctx) return ctx.error;
  if (ctx.role !== "owner") return NextResponse.json({ error: "owner only" }, { status: 403 });
  const s = ctx.supabase;
  const id = ctx.tenantId;
  const all = async (table: string, order = "created_at") => {
    const out: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await s.from(table).select("*").eq("tenant_id", id).order(order).range(from, from + 999);
      out.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    return out;
  };
  const [tenant, brain, revisions, members, contacts, conversations, messages, assessments, notifications, channels, templates] = await Promise.all([
    s.from("tenants").select("*").eq("id", id).single().then((r) => r.data),
    s.from("business_brains").select("*").eq("tenant_id", id).single().then((r) => r.data),
    all("brain_revisions"),
    s.from("tenant_members").select("user_id, role, email, created_at").eq("tenant_id", id).then((r) => r.data),
    all("contacts"),
    all("conversations"),
    all("messages"),
    all("ai_assessments"),
    all("notifications"),
    // Channel metadata only — credentials are never exported.
    s.from("channel_connections").select("*").eq("tenant_id", id).then((r) => r.data),
    s.from("message_templates").select("*").eq("tenant_id", id).then((r) => r.data),
  ]);
  const body = JSON.stringify(
    { exported_at: new Date().toISOString(), tenant, brain, brain_revisions: revisions, members, channel_connections: channels, message_templates: templates, contacts, conversations, messages, ai_assessments: assessments, notifications },
    null,
    2,
  );
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="layankan-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
