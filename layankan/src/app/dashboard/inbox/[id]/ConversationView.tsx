"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { dict, type DictKey, type Lang } from "@/lib/i18n";
import ScoreBadge from "@/app/components/ScoreBadge";
import StatusPill from "@/app/components/StatusPill";
import { HANDOFF_REASON_LABELS, type HandoffReason } from "@/lib/agent/handoff";

interface Msg {
  id: string;
  sender: "customer" | "ai" | "human" | "system";
  body: string;
  status: string;
  created_at: string;
}
interface Conv {
  id: string;
  status: string;
  channel?: string;
  last_inbound_at?: string | null;
  follow_up_count?: number;
  contact?: { opted_out_at: string | null } | { opted_out_at: string | null }[] | null;
  lead_score: string | null;
  score_reason: string | null;
  next_action: string | null;
  lead_details: Record<string, string> | null;
  handoff_reason: string | null;
}

const LEAD_FIELDS = ["name", "need", "timeline", "budget", "phone", "email"] as const;

export default function ConversationView(props: {
  lang: Lang;
  isOwner: boolean;
  timezone: string;
  initialConversation: Conv;
  initialMessages: Msg[];
}) {
  const t = dict(props.lang);
  const router = useRouter();
  const [conv, setConv] = useState<Conv>(props.initialConversation);
  const [messages, setMessages] = useState<Msg[]>(props.initialMessages);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isWa = props.initialConversation.channel === "whatsapp";
  const lastIn = conv.last_inbound_at ?? props.initialConversation.last_inbound_at;
  const [windowClosed, setWindowClosed] = useState(isWa && (!lastIn || Date.now() - Date.parse(lastIn) > 24 * 3600 * 1000));
  useEffect(() => {
    if (isWa) setWindowClosed(!lastIn || Date.now() - Date.parse(lastIn) > 24 * 3600 * 1000);
  }, [isWa, lastIn]);
  const contactRow = Array.isArray(props.initialConversation.contact) ? props.initialConversation.contact[0] : props.initialConversation.contact;
  const optedOut = !!contactRow?.opted_out_at;
  const bottom = useRef<HTMLDivElement>(null);
  const base = `/api/dashboard/conversations/${conv.id}`;

  const poll = useCallback(async () => {
    const last = messages[messages.length - 1]?.created_at;
    const res = await fetch(`${base}/messages${last ? `?after=${encodeURIComponent(last)}` : ""}`, { cache: "no-store" });
    if (!res.ok) return;
    const data = (await res.json()) as { messages: Msg[]; conversation: Partial<Conv> };
    if (data.messages.length) {
      setMessages((m) => {
        const seen = new Set(m.map((x) => x.id));
        return [...m, ...data.messages.filter((x) => !seen.has(x.id))];
      });
    }
    if (data.conversation) setConv((c) => ({ ...c, ...data.conversation }));
  }, [base, messages]);

  useEffect(() => {
    const id = setInterval(() => document.visibilityState === "visible" && poll(), 4000);
    return () => clearInterval(id);
  }, [poll]);
  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [messages.length]);

  async function act(action: string) {
    setBusy(true);
    setErr(null);
    const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) });
    if (res.ok) {
      const data = (await res.json()) as { status: string };
      setConv((c) => ({ ...c, status: data.status, handoff_reason: data.status === "ai" ? null : c.handoff_reason }));
    } else setErr(t("common.error"));
    setBusy(false);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    setErr(null);
    const res = await fetch(`${base}/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ body: draft }) });
    if (res.ok) {
      const data = (await res.json()) as { message: Msg; status: string };
      setMessages((m) => [...m, data.message]);
      setConv((c) => ({ ...c, status: data.status }));
      setDraft("");
    } else if (res.status === 409) {
      setWindowClosed(true);
      setErr(props.lang === "ms" ? "Tetingkap 24 jam WhatsApp sudah tutup — hantar template diluluskan." : "WhatsApp's 24h window is closed — send an approved template.");
    } else setErr(t("common.error"));
    setBusy(false);
  }

  async function sendTemplate(template: { name: string; language: string; variables: string[] }) {
    setBusy(true);
    setErr(null);
    const res = await fetch(`${base}/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ template }) });
    if (res.ok) {
      const data = (await res.json()) as { message: Msg; status: string };
      setMessages((m) => [...m, data.message]);
      setConv((c) => ({ ...c, status: data.status }));
    } else setErr(t("common.error"));
    setBusy(false);
  }

  async function deleteData() {
    if (!confirm(t("conv.delete_confirm"))) return;
    const res = await fetch(base, { method: "DELETE" });
    if (res.ok) router.push("/dashboard/inbox");
    else setErr(t("common.error"));
  }

  const details = conv.lead_details ?? {};
  const reasons = (conv.handoff_reason ?? "").split(",").filter(Boolean) as HandoffReason[];
  const aiActive = conv.status === "ai";

  return (
    <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_300px]">
      <section className="card flex h-[75vh] flex-col p-0">
        <header className="flex flex-wrap items-center gap-2 border-b border-zinc-100 p-3">
          <ScoreBadge score={conv.lead_score} />
          <StatusPill status={conv.status} label={t(`status.${conv.status}` as DictKey)} />
          <div className="ml-auto flex flex-wrap gap-2">
            {conv.status !== "human" && conv.status !== "closed" && (
              <button disabled={busy} onClick={() => act("take_over")} className="btn-primary py-1.5">{t("conv.takeover")}</button>
            )}
            {(conv.status === "human" || conv.status === "needs_human") && (
              <button disabled={busy} onClick={() => act("hand_back")} className="btn-secondary py-1.5">{t("conv.handback")}</button>
            )}
            {conv.status !== "closed" ? (
              <button disabled={busy} onClick={() => act("close")} className="btn-secondary py-1.5">{t("conv.close")}</button>
            ) : (
              <button disabled={busy} onClick={() => act("reopen")} className="btn-secondary py-1.5">{t("conv.reopen")}</button>
            )}
          </div>
        </header>
        <div className="flex-1 space-y-2 overflow-y-auto bg-zinc-50 p-4">
          {messages.map((m) => (
            <div key={m.id} className={`flex ${m.sender === "customer" ? "justify-start" : "justify-end"}`}>
              <div
                className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm shadow-sm ${
                  m.sender === "customer" ? "bg-white" : m.sender === "human" ? "bg-violet-600 text-white" : m.sender === "system" ? "bg-amber-100" : "bg-brand-700 text-white"
                }`}
              >
                {m.body}
                <div className={`mt-1 text-[10px] ${m.sender === "customer" || m.sender === "system" ? "text-zinc-400" : "text-white/70"}`}>
                  {m.sender === "ai" ? "AI · " : m.sender === "human" ? "👤 · " : ""}
                  {new Date(m.created_at).toLocaleTimeString("ms-MY", { timeZone: props.timezone, hour: "2-digit", minute: "2-digit" })}
                  {m.status === "failed" ? " · ⚠️" : ""}
                </div>
              </div>
            </div>
          ))}
          <div ref={bottom} />
        </div>
        {conv.status === "needs_human" && (
          <div className="border-t border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900">{t("conv.ai_paused")}</div>
        )}
        {isWa && windowClosed && <TemplateSender lang={props.lang} busy={busy} onSend={sendTemplate} />}
        <form onSubmit={send} className="flex gap-2 border-t border-zinc-100 p-3">
          <textarea
            className="input min-h-[42px] flex-1 resize-none"
            rows={1}
            placeholder={aiActive ? t("conv.take_over_to_reply") : t("conv.reply_placeholder")}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                (e.currentTarget.form as HTMLFormElement).requestSubmit();
              }
            }}
          />
          <button disabled={busy || !draft.trim()} className="btn-primary">{t("conv.send")}</button>
        </form>
        {err && <p className="px-3 pb-3 text-sm text-red-600">{err}</p>}
      </section>

      <aside className="space-y-4">
        <div className="card space-y-3 text-sm">
          <h2 className="font-semibold">{t("conv.lead")}</h2>
          {isWa && (
            <p className="text-xs text-zinc-500">
              WhatsApp · {windowClosed ? (props.lang === "ms" ? "tetingkap 24j tutup" : "24h window closed") : props.lang === "ms" ? "tetingkap 24j terbuka" : "24h window open"}
              {props.initialConversation.follow_up_count ? ` · ${props.initialConversation.follow_up_count} follow-up` : ""}
              {optedOut ? " · STOP" : ""}
            </p>
          )}
          <dl className="space-y-1">
            {LEAD_FIELDS.map((k) => (
              <div key={k} className="flex gap-2">
                <dt className="w-20 shrink-0 text-zinc-500">{t(`lead.${k}` as DictKey)}</dt>
                <dd className="min-w-0 break-words">{details[k] || "—"}</dd>
              </div>
            ))}
          </dl>
          {conv.score_reason && (
            <div>
              <div className="text-zinc-500">{t("conv.reason")}</div>
              <p>{conv.score_reason}</p>
            </div>
          )}
          {conv.next_action && (
            <div>
              <div className="text-zinc-500">{t("conv.next")}</div>
              <p>{conv.next_action}</p>
            </div>
          )}
          {reasons.length > 0 && (
            <div>
              <div className="text-zinc-500">{t("conv.handoff_reason")}</div>
              <p>{reasons.map((r) => HANDOFF_REASON_LABELS[r]?.[props.lang] ?? r).join(", ")}</p>
            </div>
          )}
        </div>
        {props.isOwner && (
          <button onClick={deleteData} className="btn-danger w-full text-xs">{t("conv.delete_data")}</button>
        )}
      </aside>
    </div>
  );
}

interface TemplateOpt { name: string; language: string; body_text: string; variable_count: number }

function TemplateSender({ lang, busy, onSend }: { lang: Lang; busy: boolean; onSend: (t: { name: string; language: string; variables: string[] }) => void }) {
  const [templates, setTemplates] = useState<TemplateOpt[] | null>(null);
  const [sel, setSel] = useState<TemplateOpt | null>(null);
  const [vars, setVars] = useState<string[]>([]);
  useEffect(() => {
    fetch("/api/dashboard/templates").then((r) => r.json()).then((d) => setTemplates(d.templates ?? []));
  }, []);
  const ms = lang === "ms";
  return (
    <div className="space-y-2 border-t border-amber-200 bg-amber-50 p-3 text-sm">
      <div className="text-xs text-amber-900">
        {ms ? "Pelanggan belum mesej dalam 24 jam. WhatsApp hanya membenarkan template yang diluluskan." : "No customer message in 24h. WhatsApp only allows approved templates."}
      </div>
      {templates && templates.length === 0 && <div className="text-xs">{ms ? "Tiada template. Tambah di Saluran." : "No templates yet. Add them under Channels."}</div>}
      {templates && templates.length > 0 && (
        <>
          <select
            className="input"
            value={sel ? `${sel.name}|${sel.language}` : ""}
            onChange={(e) => {
              const t = templates.find((x) => `${x.name}|${x.language}` === e.target.value) ?? null;
              setSel(t);
              setVars(Array.from({ length: t?.variable_count ?? 0 }, () => ""));
            }}
          >
            <option value="">{ms ? "Pilih template…" : "Choose template…"}</option>
            {templates.map((x) => <option key={`${x.name}|${x.language}`} value={`${x.name}|${x.language}`}>{x.name} ({x.language})</option>)}
          </select>
          {sel && (
            <>
              <p className="text-xs text-zinc-600">{sel.body_text}</p>
              {vars.map((v, i) => (
                <input key={i} className="input" placeholder={`{{${i + 1}}}`} value={v} onChange={(e) => setVars(vars.map((x, j) => (j === i ? e.target.value : x)))} />
              ))}
              <button
                disabled={busy || vars.some((v) => !v.trim())}
                onClick={() => onSend({ name: sel.name, language: sel.language, variables: vars })}
                className="btn-primary"
              >
                {ms ? "Hantar template" : "Send template"}
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
