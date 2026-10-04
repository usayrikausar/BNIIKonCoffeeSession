import Link from "next/link";
import { requireTenant, getT, getLang } from "@/lib/session";
import ScoreBadge from "@/app/components/ScoreBadge";
import AutoRefresh from "@/app/components/AutoRefresh";
import StatusPill from "@/app/components/StatusPill";
import { heldBy, memberName } from "@/lib/chat/assignment";
import type { DictKey } from "@/lib/i18n";

const FILTERS = ["all", "mine", "needs_you", "ai", "closed"] as const;

export default async function InboxPage({ searchParams }: { searchParams: Promise<{ f?: string }> }) {
  const { supabase, tenant, user } = await requireTenant();
  const t = await getT();
  const f = (await searchParams).f;
  const filter = (FILTERS as readonly string[]).includes(f ?? "") ? f! : "all";

  let q = supabase
    .from("conversations")
    .select("id, status, lead_score, last_message_at, last_message_preview, lead_details, customer_message_count, channel, assigned_to")
    .eq("tenant_id", tenant.id)
    .eq("is_test", false)
    .order("lead_score", { ascending: true, nullsFirst: false })
    .order("last_message_at", { ascending: false })
    .limit(200);
  if (filter === "mine") q = q.eq("assigned_to", user.id).in("status", ["needs_human", "human"]);
  if (filter === "needs_you") q = q.in("status", ["needs_human", "human"]);
  if (filter === "ai") q = q.eq("status", "ai");
  if (filter === "closed") q = q.eq("status", "closed");
  const [{ data: rows }, { data: members }] = await Promise.all([
    q,
    supabase.from("tenant_members").select("user_id, email, display_name").eq("tenant_id", tenant.id),
  ]);
  const ms = (await getLang()) === "ms";

  const labels: Record<string, string> = {
    all: t("common.all"),
    mine: ms ? "Chat saya" : "My chats",
    needs_you: t("inbox.filter.needs_you"),
    ai: t("inbox.filter.ai"),
    closed: t("inbox.filter.closed"),
  };

  return (
    <div className="mx-auto max-w-4xl">
      <AutoRefresh />
      <h1 className="mb-4 text-2xl font-bold">{t("inbox.title")}</h1>
      <div className="mb-4 flex gap-2 overflow-x-auto">
        {FILTERS.map((k) => (
          <Link
            key={k}
            href={k === "all" ? "/dashboard/inbox" : `/dashboard/inbox?f=${k}`}
            className={`rounded-full px-3 py-1 text-sm ${filter === k ? "bg-brand-700 text-white" : "bg-white text-zinc-600 ring-1 ring-zinc-200"}`}
          >
            {labels[k]}
          </Link>
        ))}
      </div>
      {!rows?.length ? (
        <div className="card text-center text-sm text-zinc-500">
          {t("inbox.empty")} <Link href="/dashboard/channels" className="font-semibold text-brand-700">→ {t("nav.channels")}</Link>
        </div>
      ) : (
        <ul className="divide-y divide-zinc-100 overflow-hidden rounded-xl border border-zinc-200 bg-white">
          {rows.map((c) => {
            const d = (c.lead_details ?? {}) as Record<string, string>;
            const needsYou = c.status === "needs_human";
            return (
              <li key={c.id}>
                <Link href={`/dashboard/inbox/${c.id}`} className={`flex items-start gap-3 p-4 hover:bg-zinc-50 ${needsYou ? "bg-amber-50/50" : ""}`}>
                  <ScoreBadge score={c.lead_score} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="truncate font-semibold">
                        <span title={c.channel} className="mr-1">{c.channel === "whatsapp" ? "🟢" : "💬"}</span>
                        {d.name || t("inbox.visitor")}
                      </span>
                      <span className="shrink-0 text-xs text-zinc-400">
                        {c.last_message_at ? new Date(c.last_message_at).toLocaleString("ms-MY", { timeZone: tenant.timezone, dateStyle: "short", timeStyle: "short" }) : ""}
                      </span>
                    </div>
                    <p className="truncate text-sm text-zinc-500">{c.last_message_preview}</p>
                    <div className="mt-1 flex flex-wrap gap-2 text-xs">
                      <StatusPill status={c.status} label={t(`status.${c.status}` as DictKey)} />
                      {heldBy(c) && (
                        <span className="rounded bg-violet-50 px-1.5 py-0.5 text-violet-800">
                          👤 {heldBy(c) === user.id ? (ms ? "anda" : "you") : memberName(members ?? [], heldBy(c))}
                        </span>
                      )}
                      {d.need && <span className="text-zinc-500">· {d.need}</span>}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
