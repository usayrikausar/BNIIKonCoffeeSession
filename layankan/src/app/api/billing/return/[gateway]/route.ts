import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getGateway } from "@/lib/billing/gateways";
import { settleNotice } from "@/lib/billing/service";
import type { GatewayId } from "@/lib/billing/gateway";
import { env } from "@/lib/env";

export const runtime = "nodejs";

/** Customer's browser comes back from the payment page. Verified the same way as callbacks. */
export async function GET(req: NextRequest, ctx: { params: Promise<{ gateway: string }> }) {
  const { gateway: g } = await ctx.params;
  const back = (state: string) => NextResponse.redirect(`${env.appUrl()}/dashboard/billing?payment=${state}`, { status: 303 });
  if (g !== "billplz" && g !== "toyyibpay") return back("failed");
  try {
    const notice = await getGateway(g as GatewayId)!.parseReturn(req.nextUrl.searchParams);
    if (!notice) return back("failed");
    const out = await settleNotice(createAdminClient(), g as GatewayId, notice);
    if (out.result === "paid" || out.result === "already_paid") return back("success");
    if (out.result === "not_paid") return back("failed");
    return back("pending"); // unverified/unknown: the server callback will settle it
  } catch {
    return back("pending");
  }
}
