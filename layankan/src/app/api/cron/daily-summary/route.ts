import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runDailySummaries } from "@/lib/notify/daily-summary";
import { verifyBearer } from "@/lib/channels/signature";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

// Called hourly by Vercel Cron (or Supabase pg_cron). Vercel sends
// "Authorization: Bearer $CRON_SECRET" automatically.
export async function GET(req: NextRequest) {
  if (!verifyBearer(req.headers.get("authorization"), env.cronSecret())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const results = await runDailySummaries(createAdminClient());
  return NextResponse.json({ ok: true, processed: results.length, results });
}
