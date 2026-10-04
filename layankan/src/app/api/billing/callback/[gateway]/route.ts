import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGateway } from "@/lib/billing/gateways";
import { settleNotice } from "@/lib/billing/service";
import type { GatewayId } from "@/lib/billing/gateway";

export const runtime = "nodejs";

/** Server-to-server payment callback (authoritative). Billplz: signed. ToyyibPay: re-confirmed via its API. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ gateway: string }> }) {
  const { gateway: g } = await ctx.params;
  if (g !== "billplz" && g !== "toyyibpay") return NextResponse.json({ error: "not_found" }, { status: 404 });
  const raw = await req.text();
  if (raw.length > 20_000) return NextResponse.json({ error: "too_large" }, { status: 413 });
  let gateway;
  try {
    gateway = getGateway(g as GatewayId);
  } catch {
    return NextResponse.json({ error: "not_configured" }, { status: 503 });
  }
  const notice = await gateway!.parseCallback(raw, req.headers.get("content-type"));
  if (!notice) return NextResponse.json({ error: "bad_request" }, { status: 400 });
  const out = await settleNotice(createAdminClient(), g as GatewayId, notice);
  if (out.result === "unverified") return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  // Gateways expect a plain 200 once received; anything else triggers retries.
  return new NextResponse("OK", { status: 200 });
}
