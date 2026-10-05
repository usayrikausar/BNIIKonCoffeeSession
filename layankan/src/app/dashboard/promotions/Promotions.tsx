"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { SCORES, TEMPLATE_PROBLEM_TEXT, type TemplateProblem } from "@/lib/broadcasts/rules";

interface Tpl { name: string; language: string; body_text: string; variable_count: number; problem: TemplateProblem | null }
interface Row {
  id: string; name: string; template_name: string; status: string; scheduled_at: string; started_at: string | null; finished_at: string | null;
  recipients_total: number; sent_count: number; failed_count: number; skipped_count: number; audience: { scores?: string[] } | null; created_at: string;
}
interface Preview { optedIn: number; matching: number; tooRecent: number; eligible: number; left: number; limit: number }

const STATUS: Record<string, { ms: string; en: string; cls: string }> = {
  scheduled: { ms: "Dijadualkan", en: "Scheduled", cls: "bg-sky-100 text-sky-800" },
  sending: { ms: "Sedang dihantar", en: "Sending", cls: "bg-amber-100 text-amber-800" },
  sent: { ms: "Selesai", en: "Done", cls: "bg-emerald-100 text-emerald-800" },
  cancelled: { ms: "Dibatalkan", en: "Cancelled", cls: "bg-zinc-200 text-zinc-700" },
};

export default function Promotions({ lang, isOwner, timezone, optedIn, allowance, connected, templates, broadcasts }: {
  lang: Lang; isOwner: boolean; timezone: string; optedIn: number; allowance: { limit: number; used: number; left: number };
  connected: boolean; templates: Tpl[]; broadcasts: Row[];
}) {
  const ms = lang === "ms";
  const router = useRouter();
  const usable = templates.filter((t) => !t.problem);
  const [name, setName] = useState("");
  const [tplKey, setTplKey] = useState(usable[0] ? `${usable[0].name}|${usable[0].language}` : "");
  const [vars, setVars] = useState<string[]>([]);
  const [scores, setScores] = useState<string[]>([]);
  const [when, setWhen] = useState<"now" | "later">("now");
  const [at, setAt] = useState("");
  const [confirm, setConfirm] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const tpl = templates.find((t) => `${t.name}|${t.language}` === tplKey);
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleString(ms ? "ms-MY" : "en-MY", { timeZone: timezone, dateStyle: "medium", timeStyle: "short" }) : "—");

  useEffect(() => {
    if (!isOwner || !connected) return;
    let live = true;
    fetch("/api/dashboard/broadcasts", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "preview", audience: { scores } }) })
      .then((r) => (r.ok ? r.json() : null)).then((d) => { if (live) setPreview(d); }).catch(() => {});
    return () => { live = false; };
  }, [scores, isOwner, connected]);

  async function send() {
    setBusy(true);
    setMsg(null);
    const r = await fetch("/api/dashboard/broadcasts", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        action: "create", name, template_name: tpl?.name, template_language: tpl?.language,
        variables: Array.from({ length: tpl?.variable_count ?? 0 }, (_, i) => vars[i] ?? ""),
        audience: { scores }, scheduled_at: when === "later" && at ? new Date(at).toISOString() : null, confirm,
      }),
    });
    const d = await r.json().catch(() => ({}));
    setBusy(false);
    if (!r.ok) { setMsg({ ok: false, text: d.problem ? TEMPLATE_PROBLEM_TEXT[d.problem as TemplateProblem][lang] : String(d.error ?? "error") }); return; }
    setMsg({ ok: true, text: d.status === "sending"
      ? (ms ? `Sedang dihantar kepada ${d.queued} pelanggan.` : `Sending to ${d.queued} customers.`)
      : (ms ? `Dijadualkan untuk ${d.queued} pelanggan.` : `Scheduled for ${d.queued} customers.`) });
    setName(""); setConfirm(false);
    router.refresh();
  }

  async function cancel(id: string) {
    if (!window.confirm(ms ? "Batalkan promosi ini? Mesej yang sudah dihantar kekal." : "Cancel this broadcast? Messages already sent stay sent.")) return;
    await fetch(`/api/dashboard/broadcasts/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "cancel" }) });
    router.refresh();
  }

  const canSend = isOwner && connected && !!tpl && !tpl.problem && name.trim() && confirm && !busy && (preview?.eligible ?? 0) > 0
    && (preview?.eligible ?? 0) <= (preview?.left ?? 0) && (when === "now" || !!at)
    && Array.from({ length: tpl.variable_count }, (_, i) => (vars[i] ?? "").trim()).every(Boolean);

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-16">
      <div>
        <h1 className="text-2xl font-bold">{ms ? "Promosi (WhatsApp)" : "Promotions (WhatsApp)"}</h1>
        <p className="text-sm text-zinc-500">
          {ms
            ? "Hantar satu mesej promosi kepada pelanggan yang telah membalas PROMO sahaja. Dihantar 9 pagi–9 malam, maksimum satu promosi seorang setiap 7 hari. Meta mengenakan caj setiap mesej pada akaun WhatsApp anda sendiri."
            : "Send one promotional message to customers who replied PROMO, and nobody else. Sent 9am–9pm, at most one promotion per person every 7 days. Meta charges per message on your own WhatsApp account."}
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="card"><div className="text-xs text-zinc-500">{ms ? "Pelanggan yang setuju terima promosi" : "Customers who agreed to promotions"}</div><div className="text-2xl font-bold">{optedIn}</div></div>
        <div className="card"><div className="text-xs text-zinc-500">{ms ? "Mesej promosi bulan ini" : "Promotion messages this month"}</div><div className="text-2xl font-bold">{allowance.used} <span className="text-base font-normal text-zinc-500">/ {allowance.limit}</span></div></div>
      </div>

      {!connected && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {ms ? "Sambungkan nombor WhatsApp anda melalui Meta (Saluran) untuk menghantar promosi." : "Connect your WhatsApp number through Meta (Channels) to send promotions."}
        </p>
      )}

      {isOwner && connected && (
        <section className="card space-y-4">
          <h2 className="text-lg font-semibold">{ms ? "Promosi baharu" : "New broadcast"}</h2>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{ms ? "Nama (untuk anda sahaja)" : "Name (just for you)"}</span>
            <input className="input" maxLength={120} placeholder={ms ? "Promo Merdeka" : "Merdeka promo"} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="block text-sm">
            <span className="mb-1 block font-medium">{ms ? "Template (diluluskan Meta)" : "Template (approved by Meta)"}</span>
            <select className="input" value={tplKey} onChange={(e) => { setTplKey(e.target.value); setVars([]); }}>
              {!templates.length && <option value="">{ms ? "Tiada template — segerak di Saluran" : "No templates — sync them in Channels"}</option>}
              {templates.map((t) => (
                <option key={`${t.name}|${t.language}`} value={`${t.name}|${t.language}`} disabled={!!t.problem}>
                  {t.name} ({t.language}){t.problem ? ` — ${TEMPLATE_PROBLEM_TEXT[t.problem][lang]}` : ""}
                </option>
              ))}
            </select>
          </label>
          {tpl && (
            <div className="rounded-lg bg-zinc-50 p-3 text-sm">
              <div className="mb-1 text-xs font-semibold text-zinc-500">{ms ? "Teks template:" : "Template text:"}</div>
              <p className="whitespace-pre-wrap text-zinc-700">{tpl.body_text || "—"}</p>
            </div>
          )}
          {tpl && tpl.variable_count > 0 && (
            <div className="space-y-2">
              <p className="text-xs text-zinc-500">{ms ? "Isi setiap {{n}}. Guna {name} untuk nama pelanggan, {business} untuk nama anda." : "Fill each {{n}}. Use {name} for the customer's name, {business} for yours."}</p>
              {Array.from({ length: tpl.variable_count }, (_, i) => (
                <input key={i} className="input" placeholder={`{{${i + 1}}}`} maxLength={200} value={vars[i] ?? ""}
                  onChange={(e) => setVars((v) => { const c = [...v]; c[i] = e.target.value; return c; })} />
              ))}
            </div>
          )}
          <div className="text-sm">
            <span className="mb-1 block font-medium">{ms ? "Siapa terima" : "Who gets it"}</span>
            <div className="flex flex-wrap gap-4">
              {SCORES.map((s) => (
                <label key={s} className="flex items-center gap-1">
                  <input type="checkbox" checked={scores.includes(s)} onChange={(e) => setScores((x) => (e.target.checked ? [...x, s] : x.filter((y) => y !== s)))} /> {s}
                </label>
              ))}
            </div>
            <p className="mt-1 text-xs text-zinc-500">{ms ? "Tiada ditanda = semua pelanggan yang setuju." : "None ticked = everyone who agreed."}</p>
          </div>
          {preview && (
            <div className="rounded-lg bg-brand-50 p-3 text-sm text-brand-900" data-testid="broadcast-preview">
              <b>{preview.eligible}</b> {ms ? "pelanggan akan terima mesej ini." : "customers will get this message."}
              {preview.tooRecent > 0 && <> {ms ? `${preview.tooRecent} lagi dilangkau (sudah terima promosi dalam 7 hari).` : `${preview.tooRecent} more skipped (got a promotion in the last 7 days).`}</>}
              {preview.eligible > preview.left && <div className="mt-1 text-red-700">{ms ? `Baki bulan ini hanya ${preview.left} mesej.` : `Only ${preview.left} messages left this month.`}</div>}
            </div>
          )}
          <div className="flex flex-wrap items-center gap-4 text-sm">
            <label className="flex items-center gap-1"><input type="radio" checked={when === "now"} onChange={() => setWhen("now")} /> {ms ? "Hantar sekarang" : "Send now"}</label>
            <label className="flex items-center gap-1"><input type="radio" checked={when === "later"} onChange={() => setWhen("later")} /> {ms ? "Jadualkan" : "Schedule"}</label>
            {when === "later" && <input type="datetime-local" className="input w-auto" value={at} onChange={(e) => setAt(e.target.value)} />}
          </div>
          <p className="text-xs text-zinc-500">{ms ? "Di luar 9 pagi–9 malam, mesej menunggu sehingga 9 pagi." : "Outside 9am–9pm, messages wait until 9am."}</p>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
            {ms ? "Saya sahkan ini promosi daripada perniagaan saya, dan template mempunyai ayat \"Balas STOP untuk berhenti\"." : "I confirm this is a promotion from my business, and the template has a \"Reply STOP to stop\" line."}
          </label>
          <div className="flex items-center gap-3">
            <button className="btn-primary" disabled={!canSend} onClick={send}>
              {busy ? "…" : when === "now" ? (ms ? "Hantar" : "Send") : (ms ? "Jadualkan" : "Schedule")}
            </button>
            {msg && <span className={`text-sm ${msg.ok ? "text-emerald-700" : "text-red-600"}`}>{msg.text}</span>}
          </div>
        </section>
      )}

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">{ms ? "Promosi terdahulu" : "Past broadcasts"}</h2>
        {!broadcasts.length && <p className="text-sm text-zinc-500">{ms ? "Belum ada promosi." : "No broadcasts yet."}</p>}
        {broadcasts.map((b) => {
          const st = STATUS[b.status] ?? { ms: b.status, en: b.status, cls: "bg-zinc-100" };
          return (
            <div key={b.id} className="flex flex-wrap items-center justify-between gap-2 border-b border-zinc-100 pb-3 last:border-0">
              <div>
                <div className="font-medium">{b.name} <span className={`ml-2 rounded px-2 py-0.5 text-xs ${st.cls}`}>{st[lang]}</span></div>
                <div className="text-xs text-zinc-500">
                  {b.template_name} · {b.audience?.scores?.length ? b.audience.scores.join(", ") : ms ? "semua yang setuju" : "everyone who agreed"} · {fmt(b.status === "scheduled" ? b.scheduled_at : b.started_at ?? b.scheduled_at)}
                </div>
                <div className="text-sm">
                  {ms ? "Dihantar" : "Sent"} <b>{b.sent_count}</b>/{b.recipients_total}
                  {b.skipped_count > 0 && <> · {ms ? "dilangkau" : "skipped"} {b.skipped_count}</>}
                  {b.failed_count > 0 && <> · <span className="text-red-600">{ms ? "gagal" : "failed"} {b.failed_count}</span></>}
                </div>
              </div>
              {isOwner && (b.status === "scheduled" || b.status === "sending") && (
                <button className="btn-secondary" onClick={() => cancel(b.id)}>{ms ? "Batal" : "Cancel"}</button>
              )}
            </div>
          );
        })}
      </section>
    </div>
  );
}
