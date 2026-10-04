import { NextResponse, type NextRequest } from "next/server";
import { apiUser, visibleConversation } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { allow } from "@/lib/ratelimit";
import { validateLinkInput } from "@/lib/payments/links";
import { createAndSendLink, PaymentLinkError } from "@/lib/payments/service";

export const runtime = "nodejs";

/** A staff member sends a payment link in this chat, for an amount THEY typed (R2). */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { supabase, user } = await apiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const conv = await visibleConversation(supabase, id); // RLS: null if not their business's chat
  if (!conv) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (conv.is_test) return NextResponse.json({ error: "Pautan bayaran tidak boleh dihantar dalam chat ujian / Not in test chats" }, { status: 400 });
  const body = (await req.json().catch(() => ({}))) as { amount_rm?: unknown; description?: unknown };
  const v = validateLinkInput(body.amount_rm, body.description);
  if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });
  const admin = createAdminClient();
  if (!(await allow(admin, `paylink:${conv.tenant_id}`, 3600, 200))) return NextResponse.json({ error: "rate_limited" }, { status: 429 });
  const { data: t } = await admin.from("tenants").select("default_locale, timezone").eq("id", conv.tenant_id).single();
  try {
    const r = await createAndSendLink(supabase, admin, {
      tenantId: conv.tenant_id, conversationId: conv.id, userId: user.id, amountCents: v.amountCents, description: v.description,
      lang: (t?.default_locale as "ms" | "en") ?? "ms", timeZone: (t?.timezone as string) ?? "Asia/Kuala_Lumpur",
    });
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    if (e instanceof PaymentLinkError) return NextResponse.json({ error: e.message, code: e.code }, { status: e.code === "not_found" ? 404 : 409 });
    console.error(`[payments] link failed tenant=${conv.tenant_id}: ${e instanceof Error ? e.message : e}`);
    return NextResponse.json({ error: "failed" }, { status: 500 });
  }
}
