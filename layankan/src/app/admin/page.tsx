import { requirePlatformAdmin } from "@/lib/admin";
import { createAdminClient } from "@/lib/supabase/admin";
import { formatRM } from "@/lib/billing/logic";
import AdminActions from "./AdminActions";
import { keyStatus, type KeyStatus } from "@/lib/crypto/rotation";

export const dynamic = "force-dynamic";
export const metadata = { title: "Admin", robots: { index: false } };

export default async function AdminPage() {
  await requirePlatformAdmin();
  const db = createAdminClient();
  const [{ data: tenants }, { data: open }, { data: plans }, { data: usage }] = await Promise.all([
    db.from("tenants").select("id, name, slug, status, created_at, subscription:subscriptions(plan_id, status, current_period_end, cancel_at_period_end)").order("created_at", { ascending: false }).limit(500),
    db.from("invoices").select("id, number, tenant_id, description, amount_cents, gateway, created_at").eq("status", "open").order("created_at"),
    db.from("plans").select("id, name, price_cents, conversation_limit").eq("is_active", true).order("sort_order"),
    db.rpc("admin_current_usage"),
  ]);
  // Vendor independence: encryption keys and WhatsApp account ownership at a glance.
  let keys: KeyStatus | null = null;
  let keyError: string | null = null;
  try {
    keys = await keyStatus(db);
  } catch (e) {
    keyError = e instanceof Error ? e.message : "unavailable";
  }
  const { data: waConns } = await db
    .from("channel_connections")
    .select("id, tenant_id, provider, is_active, display_phone_number, meta_business_owner, waba_owner, ownership_verified_at")
    .eq("channel", "whatsapp")
    .neq("status", "disconnected");
  const ownershipIssues = (waConns ?? []).filter((c) => c.waba_owner !== "client" || c.meta_business_owner !== "client" || !c.ownership_verified_at || c.provider === "murpati");
  const latestUsage = new Map<string, number>(((usage ?? []) as { tenant_id: string; conversations: number }[]).map((u) => [u.tenant_id, u.conversations]));
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

      <section className="card space-y-2">
        <h2 className="font-semibold">Encryption keys (stored WhatsApp tokens + payment-gateway keys)</h2>
        {keyError ? (
          <p className="text-sm text-red-700">Cannot read keys: {keyError}</p>
        ) : keys && (
          <>
            <table className="text-sm">
              <tbody>
                {[...new Set([...keys.configured, ...Object.keys(keys.rowsByKey)])].map((k) => (
                  <tr key={k}>
                    <td className="pr-4 font-mono">{k}</td>
                    <td className="pr-4">{keys!.rowsByKey[k] ?? 0} credential(s)</td>
                    <td className="text-xs">
                      {k === keys!.current ? <b className="text-green-700">current</b>
                        : keys!.unreadableKeys.includes(k) ? <b className="text-red-700">NOT CONFIGURED — these credentials can&apos;t be read; add the key back</b>
                        : keys!.safeToRemove.includes(k) ? <span className="text-zinc-500">unused — safe to remove from ENCRYPTION_KEYS</span>
                        : <span className="text-amber-700">still in use — re-encrypt before removing</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {keys.stale > 0 && <AdminActions kind="reseal" id="all" />}
            <p className="text-xs text-zinc-500">Rotate: add a new key to ENCRYPTION_KEYS, set ENCRYPTION_KEY_CURRENT to it, redeploy → press Re-encrypt → remove the old key once it shows “safe to remove”, redeploy.</p>
          </>
        )}
      </section>

      <section className="card">
        <h2 className="mb-2 font-semibold">WhatsApp numbers needing attention ({ownershipIssues.length})</h2>
        {ownershipIssues.length === 0 ? (
          <p className="text-sm text-zinc-500">All WhatsApp numbers are client-owned (Meta Business + WABA), verified, and on an available transport.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-xs text-zinc-500"><tr><th>Workspace</th><th>Number</th><th>Transport</th><th>Meta Business</th><th>WABA</th><th>Verified</th></tr></thead>
            <tbody className="divide-y divide-zinc-100">
              {ownershipIssues.map((c) => (
                <tr key={c.id}>
                  <td className="py-1">{names.get(c.tenant_id) ?? c.tenant_id}</td>
                  <td>{c.display_phone_number ?? "—"}{c.is_active ? " (active)" : ""}</td>
                  <td className={c.provider === "murpati" ? "text-red-700" : ""}>{c.provider === "murpati" ? "Murpati (stub — not working)" : "Meta"}</td>
                  <td className={c.meta_business_owner === "client" ? "" : "text-amber-700"}>{c.meta_business_owner ?? "unknown"}</td>
                  <td className={c.waba_owner === "client" ? "" : "text-amber-700"}>{c.waba_owner ?? "unknown"}</td>
                  <td>{c.ownership_verified_at ? "✓" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

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
          <thead className="text-left text-xs text-zinc-500"><tr><th>Name</th><th>Plan</th><th>Status</th><th>Paid through</th><th className="text-right">Conversations</th><th /></tr></thead>
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
                  <td className="text-right tabular-nums">{(latestUsage.get(t.id) ?? 0).toLocaleString()} / {(p?.conversation_limit ?? 0).toLocaleString()}</td>
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
