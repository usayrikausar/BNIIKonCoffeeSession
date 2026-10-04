import { NextResponse, type NextRequest } from "next/server";
import { apiTenant } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { cancelBroadcast } from "@/lib/broadcasts/service";

export const runtime = "nodejs";

/** {action:"cancel"}: stop a scheduled or sending broadcast (owner only). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const t = await apiTenant();
  if ("error" in t) return t.error;
  if (t.role !== "owner") return NextResponse.json({ error: "owner only" }, { status: 403 });
  if (!/^[0-9a-f-]{36}$/.test(id)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { action?: string };
  if (body.action !== "cancel") return NextResponse.json({ error: "action" }, { status: 400 });
  // Must be visible to this owner (RLS) — another business's id is simply not found.
  const { data: own } = await t.supabase.from("broadcasts").select("id").eq("id", id).eq("tenant_id", t.tenantId).maybeSingle();
  if (!own) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ok = await cancelBroadcast(createAdminClient(), t.tenantId, id, t.user.id);
  return ok ? NextResponse.json({ cancelled: true }) : NextResponse.json({ error: "Tidak boleh dibatalkan / Can't be cancelled" }, { status: 409 });
}
