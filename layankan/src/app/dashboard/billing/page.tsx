import { requireTenant, getLang } from "@/lib/session";
import { loadBilling } from "@/lib/billing/service";
import { createAdminClient } from "@/lib/supabase/admin";
import { activeGatewayId } from "@/lib/billing/gateways";
import BillingView from "./BillingView";

export default async function BillingPage({ searchParams }: { searchParams: Promise<{ payment?: string }> }) {
  const { supabase, tenant, role } = await requireTenant();
  const [billing, { data: plans }, { data: invoices }, { count: foundingTaken }] = await Promise.all([
    loadBilling(supabase, tenant.id),
    supabase.from("plans").select("*").eq("is_active", true).order("sort_order"),
    supabase.from("invoices").select("id, number, description, amount_cents, status, payment_url, period_start, period_end, paid_at, created_at, gateway").eq("tenant_id", tenant.id).order("created_at", { ascending: false }).limit(24),
    createAdminClient().from("subscriptions").select("*", { count: "exact", head: true }).eq("plan_id", "founding"),
  ]);
  const foundingLeft = Math.max(0, Number(process.env.FOUNDING_SLOTS ?? 3) - (foundingTaken ?? 0));
  const visible = (plans ?? []).filter(
    (p) => p.is_public || p.id === billing.plan?.id || (p.id === "founding" && foundingLeft > 0),
  ).filter((p) => p.id !== "trial" && p.id !== "internal");
  return (
    <BillingView
      lang={await getLang()}
      isOwner={role === "owner"}
      billing={JSON.parse(JSON.stringify(billing))}
      plans={visible}
      invoices={invoices ?? []}
      foundingLeft={foundingLeft}
      manual={activeGatewayId() === "manual"}
      bankDetails={process.env.BILLING_BANK_DETAILS ?? ""}
      payment={(await searchParams).payment ?? null}
    />
  );
}
