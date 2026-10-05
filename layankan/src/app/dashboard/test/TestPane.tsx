"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { dict, type Lang } from "@/lib/i18n";
import ScoreBadge from "@/app/components/ScoreBadge";

interface Msg { id: string; sender: string; body: string }
interface Assessment {
  score: string | null;
  confidence: number | null;
  reason: string | null;
  captured: Record<string, string | null>;
  next_action: string | null;
  handoff_required: boolean;
  error: string | null;
  latency_ms: number | null;
}

export default function TestPane({ lang, tenantName }: { lang: Lang; tenantName: string }) {
  const t = dict(lang);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [reasons, setReasons] = useState<string[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [messages.length, busy]);

  async function call(payload: object) {
    setBusy(true);
    setErr(null);
    const res = await fetch("/api/dashboard/test-chat", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    const data = await res.json().catch(() => ({}));
    if (res.ok) {
      setMessages(data.messages);
      setAssessment(data.assessment);
      setReasons(data.handedOff ? data.handoffReasons : []);
    } else setErr(t("common.error"));
    setBusy(false);
  }

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft("");
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, sender: "customer", body: text }]);
    await call({ message: text });
  }

  return (
    <div className="mx-auto max-w-5xl">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold">{t("test.title")}</h1>
          <p className="text-sm text-zinc-500">{t("test.intro")}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => call({ reset: true })} className="btn-secondary">{t("test.reset")}</button>
          <Link href="/dashboard/channels" className="btn-primary">{t("channels.golive")} →</Link>
        </div>
      </div>
      <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
        <div className="card flex h-[70vh] flex-col p-0">
          <div className="rounded-t-xl bg-brand-700 px-4 py-3 font-semibold text-white">{tenantName}</div>
          <div className="flex-1 space-y-2 overflow-y-auto bg-zinc-50 p-4">
            {messages.length === 0 && <p className="text-center text-sm text-zinc-400">“Hi, harga?” · “Nak tanya pakej” · “Can I book for Saturday?”</p>}
            {messages.map((m) => (
              <div key={m.id} className={`flex ${m.sender === "customer" ? "justify-end" : "justify-start"}`}>
                <div className={`max-w-[80%] whitespace-pre-wrap rounded-2xl px-3 py-2 text-sm shadow-sm ${m.sender === "customer" ? "bg-brand-700 text-white" : m.sender === "system" ? "bg-amber-100" : "bg-white"}`}>
                  {m.body}
                </div>
              </div>
            ))}
            {busy && <div className="text-sm text-zinc-400">…</div>}
            <div ref={bottom} />
          </div>
          <form onSubmit={send} className="flex gap-2 border-t border-zinc-100 p-3">
            <input className="input" value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Taip mesej sebagai pelanggan…" />
            <button disabled={busy} className="btn-primary">{t("conv.send")}</button>
          </form>
          {err && <p className="px-3 pb-3 text-sm text-red-600">{err}</p>}
        </div>
        <aside className="card space-y-3 text-sm">
          <h2 className="font-semibold">{t("test.assessment")}</h2>
          {!assessment ? (
            <p className="text-zinc-400">—</p>
          ) : (
            <>
              <div className="flex items-center gap-2">
                <ScoreBadge score={assessment.score} />
                {assessment.confidence != null && <span className="text-zinc-500">{Math.round(assessment.confidence * 100)}%</span>}
                {assessment.latency_ms != null && <span className="ml-auto text-xs text-zinc-400">{(assessment.latency_ms / 1000).toFixed(1)}s</span>}
              </div>
              {assessment.reason && <p>{assessment.reason}</p>}
              {assessment.next_action && <p className="text-zinc-600"><b>{t("conv.next")}:</b> {assessment.next_action}</p>}
              <dl className="space-y-1">
                {Object.entries(assessment.captured ?? {}).filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} className="flex gap-2"><dt className="w-20 text-zinc-500">{k}</dt><dd>{v}</dd></div>
                ))}
              </dl>
              {reasons.length > 0 && (
                <p className="rounded-lg bg-amber-50 p-2 text-amber-900">
                  ✋ {lang === "ms" ? "Dalam perbualan sebenar, AI akan berhenti di sini dan anda dimaklumkan:" : "In a real conversation the AI would pause here and alert you:"} {reasons.join(", ")}
                </p>
              )}
              {assessment.error && <p className="text-xs text-red-600">{assessment.error}</p>}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
