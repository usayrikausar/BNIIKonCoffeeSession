import Link from "next/link";
import { requireTenant, getLang } from "@/lib/session";
import { loadBilling } from "@/lib/billing/service";
import AnalyticsView, { type Summary } from "./AnalyticsView";

const RANGES = [7, 30, 90] as const;

export default async function AnalyticsPage({ searchParams }: { searchParams: Promise<{ days?: string }> }) {
  const { supabase, tenant } = await requireTenant();
  const lang = await getLang();
  const d = Number((await searchParams).days);
  const days = (RANGES as readonly number[]).includes(d) ? d : 30;
  const to = new Date();
  const from = new Date(to.getTime() - days * 86_400_000);
  // SECURITY INVOKER function: RLS guarantees only this workspace's data.
  const [{ data }, billing] = await Promise.all([
    supabase.rpc("analytics_summary", { p_tenant: tenant.id, p_from: from.toISOString(), p_to: to.toISOString() }),
    loadBilling(supabase, tenant.id),
  ]);
  const ms = lang === "ms";
  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">{ms ? "Analitik" : "Analytics"}</h1>
        <div className="flex gap-1 rounded-lg bg-white p-1 ring-1 ring-zinc-200">
          {RANGES.map((r) => (
            <Link key={r} href={`/dashboard/analytics?days=${r}`} className={`rounded-md px-3 py-1 text-sm ${r === days ? "bg-brand-700 text-white" : "text-zinc-600"}`}>
              {r} {ms ? "hari" : "days"}
            </Link>
          ))}
        </div>
      </div>
      <AnalyticsView
        lang={lang}
        days={days}
        fromIso={from.toISOString()}
        timezone={tenant.timezone}
        summary={(data ?? {}) as Summary}
        usage={{ used: billing.usage.ai_replies, limit: billing.entitlement.limit, planName: billing.plan?.name ?? "-" }}
      />
    </div>
  );
}
