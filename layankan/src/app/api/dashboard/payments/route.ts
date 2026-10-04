import { NextResponse, type NextRequest } from "next/server";
import { apiTenant } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { checkGatewayKeys, connectPaymentAccount, disconnectPaymentAccount, type ConnectInput } from "@/lib/payments/service";

export const runtime = "nodejs";

const s = (v: unknown, max = 300) => (typeof v === "string" ? v.trim().slice(0, max) : "");

/** Owner connects the business's OWN Billplz or ToyyibPay account. Keys are checked with the gateway, then stored encrypted. */
export async function POST(req: NextRequest) {
  const ctx = await apiTenant();
  if ("error" in ctx) return ctx.error;
  if (ctx.role !== "owner") return NextResponse.json({ error: "owner only" }, { status: 403 });
  const b = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  if (b.confirm_own_account !== true) {
    return NextResponse.json({ error: "Sahkan wang dibayar terus ke akaun perniagaan anda sendiri / Confirm the money goes to your own business account" }, { status: 400 });
  }
  const gateway = b.gateway === "billplz" || b.gateway === "toyyibpay" ? b.gateway : null;
  if (!gateway) return NextResponse.json({ error: "gateway" }, { status: 400 });
  const input: ConnectInput = {
    gateway,
    sandbox: b.sandbox === true,
    accountHolderName: s(b.account_holder_name, 200),
    ...(gateway === "billplz"
      ? { billplz: { apiKey: s(b.api_key), collectionId: s(b.collection_id, 100), xSignatureKey: s(b.x_signature_key) } }
      : { toyyibpay: { secretKey: s(b.secret_key), categoryCode: s(b.category_code, 100) } }),
  };
  if (!input.accountHolderName) return NextResponse.json({ error: "Nama pemegang akaun diperlukan / Account holder name required" }, { status: 400 });
  const problem = await checkGatewayKeys(input);
  if (problem) return NextResponse.json({ error: problem }, { status: 400 });
  const r = await connectPaymentAccount(createAdminClient(), ctx.tenantId, input);
  return NextResponse.json({ ok: true, id: r.id });
}

export async function DELETE() {
  const ctx = await apiTenant();
  if ("error" in ctx) return ctx.error;
  if (ctx.role !== "owner") return NextResponse.json({ error: "owner only" }, { status: 403 });
  await disconnectPaymentAccount(createAdminClient(), ctx.tenantId);
  return NextResponse.json({ ok: true });
}
