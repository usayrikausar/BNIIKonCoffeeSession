"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { dict, type DictKey, type Lang } from "@/lib/i18n";
import ScoreBadge from "@/app/components/ScoreBadge";
import StatusPill from "@/app/components/StatusPill";
import { HANDOFF_REASON_LABELS, type HandoffReason } from "@/lib/agent/handoff";
import { heldBy, memberName, type Member } from "@/lib/chat/assignment";
import WhyScore from "@/app/components/WhyScore";

interface Msg {
  id: string;
  sender: "customer" | "ai" | "human" | "system";
  sent_by?: string | null;
  body: string;
  status: string;
  created_at: string;
}
interface Conv {
  id: string;
  status: string;
  channel?: string;
  assigned_to?: string | null;
  last_inbound_at?: string | null;
  follow_up_count?: number;
  follow_up_disabled?: boolean;
  booking_link_sent_at?: string | null;
  outcome?: "won" | "lost" | null;
  outcome_value_cents?: number | null;
  contact?: { opted_out_at: string | null } | { opted_out_at: string | null }[] | null;
  lead_score: string | null;
  score_reason: string | null;
  next_action: string | null;
  lead_details: Record<string, string> | null;
  handoff_reason: string | null;
}

const LEAD_FIELDS = ["name", "need", "timeline", "budget", "phone", "email"] as const;

export interface PayLink { id: string; amount_cents: number; description: string; status: string; url: string | null; paid_amount_cents: number | null; created_at: string; expires_at: string }
const rm = (c: number) => `RM${(c / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export default function ConversationView(props: {
  lang: Lang;
  isOwner: boolean;
  myId: string;
  members: Member[];
  timezone: string;
  initialConversation: Conv;
  initialMessages: Msg[];
  initialConsent?: { action: "granted" | "withdrawn"; method: string; at: string } | null;
  optinAskedAt?: string | null;
  paymentLinks?: PayLink[];
  paymentsReady?: boolean;
}) {
  const t = dict(props.lang);
  const router = useRouter();
  const [conv, setConv] = useState<Conv>(props.initialConversation);
  const [messages, setMessages] = useState<Msg[]>(props.initialMessages);
  const [draft, setDraft] = useState("");
  const [consent, setConsent] = useState(props.initialConsent ?? null);
  const [links, setLinks] = useState<PayLink[]>(props.paymentLinks ?? []);
  const [payOpen, setPayOpen] = useState(false);
  const [payErr, setPayErr] = useState<string | null>(null);
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

  const ms = props.lang === "ms";
  const nameOf = (id: string | null | undefined) => (id === props.myId ? (ms ? "anda" : "you") : (memberName(props.members, id) ?? (ms ? "staf lain" : "a colleague")));
  /** Shared inbox: someone else has this chat → ask before taking it from them. */
  function confirmTakeFrom(holder: string | null | undefined) {
    return confirm(ms ? `${nameOf(holder)} sedang melayan chat ini. Ambil alih daripada ${nameOf(holder)}?` : `${nameOf(holder)} is handling this chat. Take it over from them?`);
  }

  async function act(action: string, extra: Record<string, unknown> = {}) {
    setBusy(true);
    setErr(null);
    const post = (body: object) => fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    let res = await post({ action, ...extra });
    if (res.status === 409) {
      const d = (await res.json()) as { assigned_to?: string | null };
      setConv((c) => ({ ...c, assigned_to: d.assigned_to ?? c.assigned_to, status: "human" }));
      if (!confirmTakeFrom(d.assigned_to)) return setBusy(false);
      res = await post({ action, ...extra, force: true });
    }
    if (res.ok) {
      const data = (await res.json()) as { status: string; assigned_to?: string | null; follow_up_disabled?: boolean };
      setConv((c) => ({
        ...c,
        status: data.status,
        follow_up_disabled: data.follow_up_disabled ?? c.follow_up_disabled,
        assigned_to: data.assigned_to !== undefined ? data.assigned_to : c.assigned_to,
        handoff_reason: data.status === "ai" ? null : c.handoff_reason,
      }));
    } else setErr(t("common.error"));
    setBusy(false);
  }

  /** POST a reply; if a colleague holds the chat, confirm and retry with force. */
  async function postReply(payload: object): Promise<Response> {
    const post = (body: object) => fetch(`${base}/reply`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const res = await post(payload);
    if (res.status !== 409) return res;
    const d = (await res.clone().json()) as { error?: string; assigned_to?: string | null };
    if (d.error !== "held_by_other") return res;
    setConv((c) => ({ ...c, assigned_to: d.assigned_to ?? c.assigned_to, status: "human" }));
    if (!confirmTakeFrom(d.assigned_to)) return res;
    return post({ ...payload, force: true });
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    if (!draft.trim()) return;
    setBusy(true);
    setErr(null);
    const res = await postReply({ body: draft });
    if (res.ok) {
      const data = (await res.json()) as { message: Msg; status: string; assigned_to?: string };
      setMessages((m) => [...m, { ...data.message, sent_by: props.myId }]);
      setConv((c) => ({ ...c, status: data.status, assigned_to: data.assigned_to ?? c.assigned_to }));
      setDraft("");
    } else if (res.status === 409 && ((await res.json().catch(() => ({}))) as { error?: string }).error === "window_closed") {
      setWindowClosed(true);
      setErr(props.lang === "ms" ? "Tetingkap 24 jam WhatsApp sudah tutup — hantar template diluluskan." : "WhatsApp's 24h window is closed — send an approved template.");
    } else setErr(t("common.error"));
    setBusy(false);
  }

  async function sendTemplate(template: { name: string; language: string; variables: string[] }) {
    setBusy(true);
    setErr(null);
    const res = await postReply({ template });
    if (res.ok) {
      const data = (await res.json()) as { message: Msg; status: string; assigned_to?: string };
      setMessages((m) => [...m, { ...data.message, sent_by: props.myId }]);
      setConv((c) => ({ ...c, status: data.status, assigned_to: data.assigned_to ?? c.assigned_to }));
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
  const holder = heldBy({ status: conv.status, assigned_to: conv.assigned_to ?? null });
  const heldByOther = !!holder && holder !== props.myId;

  return (
    <div className="mt-3 grid gap-4 lg:grid-cols-[1fr_300px]">
      <section className="card flex h-[75vh] flex-col p-0">
        <header className="flex flex-wrap items-center gap-2 border-b border-zinc-100 p-3">
          <ScoreBadge score={conv.lead_score} />
          <StatusPill status={conv.status} label={t(`status.${conv.status}` as DictKey)} />
          {holder && (
            <span className={`rounded px-1.5 py-0.5 text-xs font-medium ${heldByOther ? "bg-violet-100 text-violet-800" : "bg-brand-50 text-brand-700"}`}>
              👤 {ms ? "Dilayan oleh" : "Handled by"} {nameOf(holder)}
            </span>
          )}
          <div className="ml-auto flex flex-wrap gap-2">
            {conv.status !== "closed" && (conv.status !== "human" || heldByOther) && (
              <button disabled={busy} onClick={() => (heldByOther && !confirmTakeFrom(holder) ? undefined : act("take_over", heldByOther ? { force: true } : {}))} className="btn-primary py-1.5">
                {heldByOther ? (ms ? `Ambil alih daripada ${nameOf(holder)}` : `Take over from ${nameOf(holder)}`) : t("conv.takeover")}
              </button>
            )}
            {props.isOwner && conv.status !== "closed" && (
              <select
                disabled={busy}
                value={conv.assigned_to ?? ""}
                onChange={(e) => act("assign", { user_id: e.target.value || null })}
                className="input w-auto py-1.5 text-sm"
                aria-label={ms ? "Serahkan kepada" : "Assign to"}
              >
                <option value="">{ms ? "Serahkan kepada…" : "Assign to…"}</option>
                {props.members.map((m) => (
                  <option key={m.user_id} value={m.user_id}>{m.user_id === props.myId ? (ms ? "Saya" : "Me") : memberName(props.members, m.user_id)}</option>
                ))}
              </select>
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
                  {m.sender === "ai" ? "AI · " : m.sender === "human" ? `👤 ${m.sent_by ? nameOf(m.sent_by) : ""} · ` : ""}
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
            <div className="rounded-lg bg-zinc-50 p-2">
              <WhyScore score={conv.lead_score} reason={conv.score_reason} lang={props.lang} />
            </div>
          )}
          {isWa && (
            <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-zinc-600">
                📣 {ms ? "Promosi" : "Promotions"}:{" "}
                {consent?.action === "granted" ? (
                  <b className="text-green-700">{ms ? "setuju" : "agreed"} ({new Date(consent.at).toLocaleDateString(ms ? "ms-MY" : "en-MY")})</b>
                ) : consent?.action === "withdrawn" ? (
                  <b className="text-red-700">{ms ? "berhenti" : "stopped"}{consent.method === "stop_keyword" ? " (STOP)" : ""}</b>
                ) : props.optinAskedAt ? (
                  <span>{ms ? "ditanya, belum setuju" : "asked, not agreed"}</span>
                ) : (
                  <span className="text-zinc-400">{ms ? "belum ditanya" : "not asked"}</span>
                )}
              </span>
              {consent?.action === "granted" && (
                <button
                  disabled={busy}
                  className="text-xs text-red-700 underline"
                  onClick={async () => {
                    if (!confirm(ms ? "Rekod bahawa pelanggan ini minta berhenti terima promosi?" : "Record that this customer asked to stop promotions?")) return;
                    setBusy(true);
                    const res = await fetch(base, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "record_optout" }) });
                    if (res.ok) setConsent({ action: "withdrawn", method: "staff_withdrawal", at: new Date().toISOString() });
                    else setErr(t("common.error"));
                    setBusy(false);
                  }}
                >
                  {ms ? "Pelanggan minta berhenti" : "Customer asked to stop"}
                </button>
              )}
            </div>
          )}
          <div className="space-y-2 border-t border-zinc-100 pt-3">
            <div className="flex items-center justify-between">
              <span className="font-semibold">💳 {ms ? "Bayaran" : "Payments"}</span>
              {props.paymentsReady ? (
                <button className="text-xs font-semibold text-brand-700 underline" onClick={() => { setPayOpen((o) => !o); setPayErr(null); }}>
                  {ms ? "Hantar pautan bayaran" : "Send payment link"}
                </button>
              ) : (
                <a href="/dashboard/channels" className="text-xs text-zinc-500 underline">{ms ? "Sambung akaun pembayaran" : "Connect a payment account"}</a>
              )}
            </div>
            {payOpen && (
              <form
                className="space-y-2 rounded-lg bg-zinc-50 p-2"
                onSubmit={async (e) => {
                  e.preventDefault();
                  const f = new FormData(e.currentTarget);
                  setBusy(true);
                  setPayErr(null);
                  const res = await fetch(`${base}/payment-link`, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ amount_rm: f.get("amount_rm"), description: f.get("description") }),
                  });
                  const d = (await res.json().catch(() => ({}))) as { error?: string; linkId?: string; url?: string };
                  setBusy(false);
                  if (!res.ok) return setPayErr(d.error ?? t("common.error"));
                  const cents = Math.round(Number(String(f.get("amount_rm")).replace(/,/g, "")) * 100);
                  setLinks((l) => [{ id: d.linkId!, amount_cents: cents, description: String(f.get("description")), status: "open", url: d.url ?? null, paid_amount_cents: null, created_at: new Date().toISOString(), expires_at: "" }, ...l]);
                  setPayOpen(false);
                }}
              >
                <input name="amount_rm" inputMode="decimal" className="input" placeholder={ms ? "Jumlah (RM), cth. 80" : "Amount (RM), e.g. 80"} required />
                <input name="description" className="input" maxLength={200} placeholder={ms ? "Untuk apa? cth. Cuci gigi" : "What for? e.g. Scaling"} required />
                <button disabled={busy} className="btn-primary w-full">{ms ? "Hantar dalam chat" : "Send in chat"}</button>
                <p className="text-xs text-zinc-500">{ms ? "Pelanggan bayar terus ke akaun anda (FPX / kad). Sah 7 hari." : "Customer pays straight to your account (FPX / card). Valid 7 days."}</p>
              </form>
            )}
            {payErr && <p className="text-xs text-red-600">{payErr}</p>}
            {links.length > 0 && (
              <ul className="space-y-1 text-xs">
                {links.map((l) => (
                  <li key={l.id} className="flex justify-between gap-2">
                    <span className="truncate">{l.description} · {rm(l.amount_cents)}</span>
                    <span className={l.status === "paid" ? "font-semibold text-green-700" : l.status === "open" ? "text-amber-700" : "text-zinc-400"}>
                      {l.status === "paid" ? (ms ? "Dibayar ✓" : "Paid ✓") : l.status === "open" ? (ms ? "Belum dibayar" : "Unpaid") : l.status === "expired" ? (ms ? "Tamat tempoh" : "Expired") : l.status === "cancelled" ? (ms ? "Dibatalkan" : "Cancelled") : (ms ? "Gagal" : "Failed")}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
          {props.initialConversation.booking_link_sent_at && (
            <p className="text-xs text-zinc-500">📅 {ms ? "Pautan tempahan telah dihantar" : "Booking link sent"}</p>
          )}
          {isWa && (
            <label className="flex items-start gap-2 text-xs text-zinc-600">
              <input
                type="checkbox"
                className="mt-0.5"
                disabled={busy}
                checked={!conv.follow_up_disabled}
                onChange={(e) => act("set_follow_up", { disabled: !e.target.checked })}
              />
              <span>
                {ms ? "Susulan automatik untuk chat ini" : "Automatic follow-ups for this chat"}
                <span className="block text-zinc-400">{ms ? "Maks. 2, hanya jika prospek SUAM senyap" : "Max 2, only if a SUAM lead goes quiet"}</span>
              </span>
            </label>
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
        <OutcomeCard lang={props.lang} base={base} initial={props.initialConversation.outcome ?? null} initialValue={props.initialConversation.outcome_value_cents ?? null} />
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

function OutcomeCard({ lang, base, initial, initialValue }: { lang: Lang; base: string; initial: "won" | "lost" | null; initialValue: number | null }) {
  const ms = lang === "ms";
  const [outcome, setOutcome] = useState(initial);
  const [value, setValue] = useState(initialValue != null ? String(initialValue / 100) : "");
  const [busy, setBusy] = useState(false);
  async function save(next: "won" | "lost" | null) {
    setBusy(true);
    const res = await fetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "set_outcome", outcome: next, value_rm: value ? Number(value) : null }),
    });
    if (res.ok) setOutcome(next);
    setBusy(false);
  }
  return (
    <div className="card space-y-2 text-sm">
      <h2 className="font-semibold">{ms ? "Keputusan" : "Outcome"}</h2>
      <div className="flex gap-2">
        <button disabled={busy} onClick={() => save(outcome === "won" ? null : "won")} className={`btn flex-1 border ${outcome === "won" ? "border-green-600 bg-green-600 text-white" : "border-zinc-300 bg-white"}`}>
          ✓ {ms ? "Jadi pelanggan" : "Won"}
        </button>
        <button disabled={busy} onClick={() => save(outcome === "lost" ? null : "lost")} className={`btn flex-1 border ${outcome === "lost" ? "border-zinc-700 bg-zinc-700 text-white" : "border-zinc-300 bg-white"}`}>
          ✕ {ms ? "Tak jadi" : "Lost"}
        </button>
      </div>
      <label className="flex items-center gap-2 text-xs text-zinc-500">
        {ms ? "Nilai jualan (RM)" : "Sale value (RM)"}
        <input className="input py-1" inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value.replace(/[^\d.]/g, ""))} onBlur={() => outcome === "won" && save("won")} />
      </label>
    </div>
  );
}
