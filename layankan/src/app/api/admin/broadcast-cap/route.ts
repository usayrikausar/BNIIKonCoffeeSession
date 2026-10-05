import { NextResponse, type NextRequest } from "next/server";
import { platformAdmin } from "@/lib/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { dailyCap, parseDailyCap } from "@/lib/broadcasts/rules";

export const runtime = "nodejs";

/**
 * Platform admin only: set how many broadcast messages one WhatsApp number may
 * send per 24h (match it to the number's Meta messaging tier). {connection_id,
 * limit: 1–100000 | null}. null goes back to the default (250). Everyone else
 * gets a 404, like /admin itself.
 */
export async function POST(req: NextRequest) {
  const admin = await platformAdmin();
  if (!admin) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { connection_id?: unknown; limit?: unknown };
  const limit = parseDailyCap(body.limit);
  if (limit === "invalid") return NextResponse.json({ error: "limit must be a whole number from 1 to 100000, or empty for the default" }, { status: 400 });
  if (typeof body.connection_id !== "string" || !/^[0-9a-f-]{36}$/.test(body.connection_id)) return NextResponse.json({ error: "connection_id" }, { status: 400 });

  const db = createAdminClient();
  const { data: conn } = await db.from("channel_connections").select("id, tenant_id, channel, provider, status, settings").eq("id", body.connection_id).maybeSingle();
  if (!conn || conn.channel !== "whatsapp" || conn.provider !== "meta_cloud" || conn.status === "disconnected") {
    return NextResponse.json({ error: "Only connected Meta WhatsApp numbers send broadcasts" }, { status: 404 });
  }
  const settings = { ...((conn.settings as Record<string, unknown> | null) ?? {}) };
  if (limit === null) {
    delete settings.broadcast_daily_limit;
  } else {
    settings.broadcast_daily_limit = limit;
  }
  // Who changed it and when, kept with the setting.
  settings.broadcast_daily_limit_set_by = admin.email;
  settings.broadcast_daily_limit_set_at = new Date().toISOString();
  const { error } = await db.from("channel_connections").update({ settings }).eq("tenant_id", conn.tenant_id).eq("id", conn.id);
  if (error) return NextResponse.json({ error: "save failed" }, { status: 500 });
  console.info(`[admin] ${admin.email} set broadcast daily cap for connection ${conn.id} to ${limit ?? "default"}`);
  return NextResponse.json({ ok: true, cap: dailyCap(settings), custom: limit !== null });
}
