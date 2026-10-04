import Link from "next/link";
import { requireTenant, getT, getLang } from "@/lib/session";
import { leadsQuery } from "@/lib/leads/query";
import ScoreBadge from "@/app/components/ScoreBadge";
import StatusPill from "@/app/components/StatusPill";
import WhyScore from "@/app/components/WhyScore";
import type { DictKey } from "@/lib/i18n";

export default async function LeadsPage({ searchParams }: { searchParams: Promise<{ score?: string; from?: string; to?: string }> }) {
  const { supabase, tenant } = await requireTenant();
  const lang = await getLang();
  const t = await getT();
  const sp = await searchParams;
  const { data: rows } = await leadsQuery(supabase, tenant.id, sp, 500);
  const qs = new URLSearchParams(Object.entries(sp).filter(([, v]) => v) as [string, string][]).toString();

  return (
    <div className="mx-auto max-w-6xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold">{t("leads.title")}</h1>
        <a href={`/api/dashboard/leads/export${qs ? `?${qs}` : ""}`} className="btn-secondary">⬇ {t("leads.export")}</a>
      </div>
      <form className="card mb-4 flex flex-wrap items-end gap-3 p-4">
        <div>
          <label className="label">{t("leads.col.score")}</label>
          <select name="score" defaultValue={sp.score ?? ""} className="input">
            <option value="">{t("common.all")}</option>
            <option value="PANAS">🔥 PANAS</option>
            <option value="SUAM">🌤 SUAM</option>
            <option value="SEJUK">❄️ SEJUK</option>
          </select>
        </div>
        <div>
          <label className="label">{t("leads.from")}</label>
          <input type="date" name="from" defaultValue={sp.from ?? ""} className="input" />
        </div>
        <div>
          <label className="label">{t("leads.to")}</label>
          <input type="date" name="to" defaultValue={sp.to ?? ""} className="input" />
        </div>
        <button className="btn-primary">{t("leads.filter")}</button>
      </form>
      {!rows?.length ? (
        <div className="card text-center text-sm text-zinc-500">{t("leads.empty")}</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-zinc-200 bg-white">
          <table className="w-full text-left text-sm">
            <thead className="bg-zinc-50 text-xs uppercase text-zinc-500">
              <tr>
                <th className="p-3">{t("leads.col.score")}</th>
                <th className="p-3">{lang === "ms" ? "Kenapa skor ini?" : "Why this score?"}</th>
                <th className="p-3">{t("leads.col.name")}</th>
                <th className="p-3">{t("leads.col.need")}</th>
                <th className="p-3">{t("lead.timeline")}</th>
                <th className="p-3">{t("lead.budget")}</th>
                <th className="p-3">{t("leads.col.status")}</th>
                <th className="p-3">{t("leads.col.when")}</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map((c) => {
                const d = (c.lead_details ?? {}) as Record<string, string>;
                return (
                  <tr key={c.id} className="hover:bg-zinc-50">
                    <td className="p-3"><ScoreBadge score={c.lead_score} /></td>
                    <td className="min-w-56 max-w-sm p-3">{c.score_reason ? <WhyScore score={c.lead_score} reason={c.score_reason} lang={lang} /> : <span className="text-zinc-400">—</span>}</td>
                    <td className="p-3 font-medium"><Link href={`/dashboard/inbox/${c.id}`} className="hover:underline">{d.name || "—"}</Link>{d.phone && <div className="text-xs text-zinc-500">{d.phone}</div>}</td>
                    <td className="max-w-xs p-3">{d.need || "—"}</td>
                    <td className="p-3">{d.timeline || "—"}</td>
                    <td className="p-3">{d.budget || "—"}</td>
                    <td className="p-3 text-xs"><StatusPill status={c.status} label={t(`status.${c.status}` as DictKey)} /></td>
                    <td className="whitespace-nowrap p-3 text-xs text-zinc-500">
                      {c.last_message_at && new Date(c.last_message_at).toLocaleString("ms-MY", { timeZone: tenant.timezone, dateStyle: "short", timeStyle: "short" })}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
