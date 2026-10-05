"use server";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { issueInvoice } from "@/lib/billing/service";

/** Owner picks a plan → invoice + payment link (FPX/card via the configured gateway). */
export async function choosePlan(planId: string): Promise<{ ok: boolean; error?: string }> {
  const { tenant, role, user, supabase } = await requireTenant();
  if (role !== "owner") return { ok: false, error: "Hanya pemilik / Owner only" };
  if (planId === "founding") {
    const { count } = await createAdminClient()
      .from("subscriptions")
      .select("*", { count: "exact", head: true })
      .eq("plan_id", "founding")
      .neq("tenant_id", tenant.id);
    if ((count ?? 0) >= Number(process.env.FOUNDING_SLOTS ?? 3)) return { ok: false, error: "Slot Founding Offer sudah penuh / Founding slots are full" };
  }
  const { data: brain } = await supabase.from("business_brains").select("handoff_rules").eq("tenant_id", tenant.id).maybeSingle();
  let url: string | null = null;
  try {
    const inv = await issueInvoice(createAdminClient(), {
      tenantId: tenant.id,
      planId,
      customerName: tenant.name,
      customerEmail: user.email ?? "",
      customerPhone: (brain?.handoff_rules as { owner_whatsapp?: string } | null)?.owner_whatsapp ?? null,
    });
    url = inv.payment_url ?? null;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 200) : "failed" };
  }
  revalidatePath("/dashboard/billing");
  if (url) redirect(url);
  return { ok: true };
}

export async function setCancelAtPeriodEnd(cancel: boolean): Promise<{ ok: boolean }> {
  const { tenant, role } = await requireTenant();
  if (role !== "owner") return { ok: false };
  await createAdminClient().from("subscriptions").update({ cancel_at_period_end: cancel, updated_at: new Date().toISOString() }).eq("tenant_id", tenant.id);
  revalidatePath("/dashboard/billing");
  return { ok: true };
}
