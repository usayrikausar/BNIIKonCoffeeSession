import { NextResponse } from "next/server";
import { apiTenant } from "@/lib/api/auth";

/** PDPA data portability: everything this workspace holds, as JSON (owner only). */
export async function GET() {
  const ctx = await apiTenant();
  if ("error" in ctx) return ctx.error;
  if (ctx.role !== "owner") return NextResponse.json({ error: "owner only" }, { status: 403 });
  const s = ctx.supabase;
  const id = ctx.tenantId;
  const all = async (table: string, order = "created_at") => {
    const out: unknown[] = [];
    for (let from = 0; ; from += 1000) {
      const { data } = await s.from(table).select("*").eq("tenant_id", id).order(order).range(from, from + 999);
      out.push(...(data ?? []));
      if (!data || data.length < 1000) break;
    }
    return out;
  };
  const [tenant, brain, revisions, members, contacts, conversations, messages, assessments, notifications, channels, templates, statusEvents, consentEvents, paymentLinks, paymentAccounts, summaryRuns, subscription, invoices, usage] = await Promise.all([
    s.from("tenants").select("*").eq("id", id).single().then((r) => r.data),
    s.from("business_brains").select("*").eq("tenant_id", id).single().then((r) => r.data),
    all("brain_revisions"),
    s.from("tenant_members").select("user_id, role, email, created_at").eq("tenant_id", id).then((r) => r.data),
    all("contacts"),
    all("conversations"),
    all("messages"),
    all("ai_assessments"),
    all("notifications"),
    // Channel metadata only — credentials are never exported.
    s.from("channel_connections").select("*").eq("tenant_id", id).then((r) => r.data),
    s.from("message_templates").select("*").eq("tenant_id", id).then((r) => r.data),
    all("message_status_events", "occurred_at"),
    all("marketing_consent_events"),
    all("payment_links"),
    // Payment account details only — gateway keys are never exported.
    s.from("payment_accounts").select("id, gateway, status, is_active, sandbox, collection_ref, account_holder_name, verified_at, created_at").eq("tenant_id", id).then((r) => r.data),
    all("daily_summary_runs"),
    // Billing records (what you were charged and how much you used).
    s.from("subscriptions").select("*").eq("tenant_id", id).maybeSingle().then((r) => r.data),
    all("invoices"),
    all("usage_counters", "period_start"),
  ]);
  const body = JSON.stringify(
    { exported_at: new Date().toISOString(), tenant, brain, brain_revisions: revisions, members, channel_connections: channels, message_templates: templates, contacts, conversations, messages, message_status_events: statusEvents, marketing_consent_events: consentEvents, payment_links: paymentLinks, payment_accounts: paymentAccounts, ai_assessments: assessments, notifications, daily_summary_runs: summaryRuns, billing: { subscription, invoices, usage_counters: usage } },
    null,
    2,
  );
  return new NextResponse(body, {
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="layankan-export-${new Date().toISOString().slice(0, 10)}.json"`,
      "Cache-Control": "no-store",
    },
  });
}
