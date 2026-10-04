import { requirePlatformAdmin } from "@/lib/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatRM } from "@/lib/billing/logic";
import AdminActions from "./AdminActions";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin", robots: { index: false } };

export default async function AdminPage() {
  await requirePlatformAdmin();
  const db = createAdminClient();
  const [{ data: tenants }, { data: open }, { data: plans }, { data: usage }] = await Promise.all([
    db.from("tenants").select("id, name, slug, status, created_at, subscription:subscriptions(plan_id, status, current_period_end, cancel_at_period_end)").order("created_at", { ascending: false }).limit(500),
    db.from("invoices").select("id, number, tenant_id, description, amount_cents, gateway, created_at").eq("status", "open").order("created_at"),
    db.from("plans").select("id, name, price_cents, ai_reply_limit").eq("is_active", true).order("sort_order"),
    db.rpc("admin_current_usage"),
  ]);
  const latestUsage = new Map<string, number>(((usage ?? []) as { tenant_id: string; ai_replies: number }[]).map((u) => [u.tenant_id, u.ai_replies]));
  const names = new Map((tenants ?? []).map((t) => [t.id, t.name]));
  const mrr = (tenants ?? []).reduce((sum, t) => {
    const s = Array.isArray(t.subscription) ? t.subscription[0] : t.subscription;
    const p = plans?.find((x) => x.id === s?.plan_id);
    return s?.status === "active" && p ? sum + p.price_cents : sum;
  }, 0);

  return (
    <div className="mx-auto max-w-6xl space-y-6 p-6">
      <h1 className="text-2xl font-bold">Layankan admin</h1>
      <div className="grid grid-cols-3 gap-3">
        <div className="card"><div className="text-xs text-zinc-500">Workspaces</div><div className="text-2xl font-bold">{tenants?.length ?? 0}</div></div>
        <div className="card"><div className="text-xs text-zinc-500">MRR (active)</div><div className="text-2xl font-bold">{formatRM(mrr)}</div></div>
        <div className="card"><div className="text-xs text-zinc-500">Open invoices</div><div className="text-2xl font-bold">{open?.length ?? 0}</div></div>
      </div>

      <section className="card">
        <h2 className="mb-2 font-semibold">Open invoices (bank transfer / unpaid)</h2>
        <table className="w-full text-sm">
          <tbody className="divide-y divide-zinc-100">
            {(open ?? []).map((i) => (
              <tr key={i.id}>
                <td className="py-2 font-mono text-xs">{i.number}</td>
                <td>{names.get(i.tenant_id) ?? i.tenant_id}</td>
                <td>{i.description}</td>
                <td className="text-right">{formatRM(i.amount_cents)}</td>
                <td className="text-xs text-zinc-500">{i.gateway}</td>
                <td className="text-right"><AdminActions kind="markPaid" id={i.id} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <section className="card overflow-x-auto">
        <h2 className="mb-2 font-semibold">Workspaces</h2>
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-zinc-500"><tr><th>Name</th><th>Plan</th><th>Status</th><th>Paid through</th><th className="text-right">AI used</th><th /></tr></thead>
          <tbody className="divide-y divide-zinc-100">
            {(tenants ?? []).map((t) => {
              const s = Array.isArray(t.subscription) ? t.subscription[0] : t.subscription;
              const p = plans?.find((x) => x.id === s?.plan_id);
              return (
                <tr key={t.id}>
                  <td className="py-2"><div className="font-medium">{t.name}</div><div className="text-xs text-zinc-500">/c/{t.slug} · {t.status}</div></td>
                  <td>{p?.name ?? s?.plan_id ?? "—"}</td>
                  <td>{s?.status}{s?.cancel_at_period_end ? " (canceling)" : ""}</td>
                  <td className="text-xs">{s?.current_period_end ? new Date(s.current_period_end).toLocaleDateString("ms-MY") : "—"}</td>
                  <td className="text-right tabular-nums">{(latestUsage.get(t.id) ?? 0).toLocaleString()} / {(p?.ai_reply_limit ?? 0).toLocaleString()}</td>
                  <td className="text-right"><AdminActions kind="tenant" id={t.id} plans={(plans ?? []).map((x) => ({ id: x.id, name: x.name }))} trial={s?.status === "trialing" || s?.status === "expired"} /></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </div>
  );
}
