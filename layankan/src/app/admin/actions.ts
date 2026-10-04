"use server";
import { revalidatePath } from "next/cache";
import { requirePlatformAdmin } from "@/lib/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { issueInvoice, markInvoicePaid } from "@/lib/billing/service";
import { resealAll, supabaseCredentialStore } from "@/lib/crypto/rotation";

export async function adminMarkPaid(invoiceId: string) {
  const admin = await requirePlatformAdmin();
  const db = createAdminClient();
  const result = await markInvoicePaid(db, invoiceId, { source: `admin:${admin.email}` });
  await db.from("payment_events").insert({ gateway: "manual", event_key: `admin:${invoiceId}:${Date.now()}`, invoice_id: invoiceId, verified: true, paid: true, payload: { by: admin.email, result } });
  revalidatePath("/admin");
  return result;
}

/** Comp / bank-transfer client: issue a manual invoice for the plan and mark it paid (keeps an audit trail). */
export async function adminGrantPlan(tenantId: string, planId: string) {
  const admin = await requirePlatformAdmin();
  const db = createAdminClient();
  const { data: t } = await db.from("tenants").select("name").eq("id", tenantId).single();
  const inv = await issueInvoice(db, { tenantId, planId, customerName: t?.name ?? "", customerEmail: admin.email ?? "", gateway: "manual" });
  const result = await markInvoicePaid(db, inv.id, { source: `admin:${admin.email}` });
  revalidatePath("/admin");
  return result;
}

export async function adminExtendTrial(tenantId: string, days: number) {
  await requirePlatformAdmin();
  const db = createAdminClient();
  const { data: sub } = await db.from("subscriptions").select("status, current_period_end").eq("tenant_id", tenantId).single();
  if (!sub || !["trialing", "expired"].includes(sub.status)) return "not_trial";
  const base = Math.max(Date.now(), Date.parse(sub.current_period_end));
  await db
    .from("subscriptions")
    .update({ status: "trialing", current_period_end: new Date(base + Math.min(60, Math.max(1, days)) * 86_400_000).toISOString() })
    .eq("tenant_id", tenantId);
  revalidatePath("/admin");
  return "ok";
}

/** Key rotation step 2: re-encrypt every stored channel credential with ENCRYPTION_KEY_CURRENT. */
export async function adminResealCredentials() {
  const admin = await requirePlatformAdmin();
  const r = await resealAll(supabaseCredentialStore(createAdminClient()));
  console.info(`[admin] ${admin.email} re-encrypted credentials: ${r.reencrypted} ok, ${r.failed} failed`);
  revalidatePath("/admin");
  return r.failed ? `${r.reencrypted} re-encrypted · ${r.failed} FAILED (see Encryption keys)` : `${r.reencrypted} re-encrypted ✓`;
}
