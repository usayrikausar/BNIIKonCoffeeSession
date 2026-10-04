import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { runDailySummaries } from "@/lib/notify/daily-summary";
import { runFollowUps } from "@/lib/followup/run";
import { runBillingJobs } from "@/lib/billing/service";
import { expirePaymentLinks } from "@/lib/payments/service";
import { purgeExpiredMemories } from "@/lib/memory/store";
import { verifyBearer } from "@/lib/channels/signature";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 300;

/** One hourly job: billing (status changes, renewal invoices), daily summaries (per tenant timezone), SUAM follow-ups, payment-link expiry, memory retention (12 months). */
export async function GET(req: NextRequest) {
  if (!verifyBearer(req.headers.get("authorization"), env.cronSecret())) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  const db = createAdminClient();
  const billing = await runBillingJobs(db);
  const summaries = await runDailySummaries(db);
  const followUps = await runFollowUps(db);
  const expiredPaymentLinks = await expirePaymentLinks(db);
  const purgedMemories = await purgeExpiredMemories(db);
  return NextResponse.json({ ok: true, billing, summaries: summaries.length, followUps, expiredPaymentLinks, purgedMemories });
}
