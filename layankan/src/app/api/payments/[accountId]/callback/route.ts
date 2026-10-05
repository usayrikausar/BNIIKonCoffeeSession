import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { accountById, gatewayFor, processPaymentNotice } from "@/lib/payments/service";

export const runtime = "nodejs";

/**
 * Payment-link callback from a BUSINESS'S OWN gateway account (R2).
 * The account id routes the request; that account's own keys verify it
 * (Billplz: X-Signature; ToyyibPay: re-confirmed with ToyyibPay's API, since
 * its callbacks aren't signed). Only a verified, full payment marks a link paid.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ accountId: string }> }) {
  const { accountId } = await ctx.params;
  const db = createAdminClient();
  const account = await accountById(db, accountId);
  if (!account) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const raw = await req.text();
  if (raw.length > 20_000) return NextResponse.json({ error: "too_large" }, { status: 413 });
  let notice;
  try {
    notice = await (await gatewayFor(db, account)).parseCallback(raw, req.headers.get("content-type"));
  } catch {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  if (!notice) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const decision = await processPaymentNotice(db, account, notice);
  if (decision === "unverified") return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  // Gateways expect a plain 200 once received; anything else triggers retries.
  return new NextResponse("OK", { status: 200 });
}
