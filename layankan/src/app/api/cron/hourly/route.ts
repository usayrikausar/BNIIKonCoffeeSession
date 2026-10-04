import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runDailySummaries } from "@/lib/notify/daily-summary";
import { runFollowUps } from "@/lib/followup/run";
import { verifyBearer } from "@/lib/channels/signature";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

/** One hourly job: daily summaries (when due per tenant timezone) + SUAM follow-ups. */
export async function GET(req: NextRequest) {
  if (!verifyBearer(req.headers.get("authorization"), env.cronSecret())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = createAdminClient();
  const summaries = await runDailySummaries(db);
  const followUps = await runFollowUps(db);
  return NextResponse.json({ ok: true, summaries: summaries.length, followUps });
}
