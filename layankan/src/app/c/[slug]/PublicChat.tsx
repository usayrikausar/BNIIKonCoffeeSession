"use client";
import { useCallback, useEffect, useRef, useState } from "react";

interface Msg { id: string; from: "customer" | "business"; body: string; at: string }

const TEXT = {
  ms: {
    placeholder: "Taip mesej…",
    send: "Hantar",
    greeting: "Hai! 👋 Ada apa yang boleh kami bantu?",
    privacy: "Mesej anda disimpan dan diproses (termasuk oleh AI) untuk menjawab pertanyaan anda, mengikut PDPA.",
    privacyLink: "Notis Privasi",
    error: "Maaf, mesej tidak dihantar. Cuba lagi.",
    slow: "Terlalu banyak mesej. Tunggu sebentar.",
    typing: "sedang menaip…",
    powered: "Dikuasakan oleh",
  },
  en: {
    placeholder: "Type a message…",
    send: "Send",
    greeting: "Hi! 👋 How can we help you?",
    privacy: "Your messages are stored and processed (including by AI) to answer your enquiry, in line with Malaysia's PDPA.",
    privacyLink: "Privacy Notice",
    error: "Sorry, your message wasn't sent. Please try again.",
    slow: "Too many messages. Please wait a moment.",
    typing: "typing…",
    powered: "Powered by",
  },
};

export default function PublicChat({ slug, name, locale, embed }: { slug: string; name: string; locale: "ms" | "en"; embed: boolean }) {
  const tx = TEXT[locale] ?? TEXT.ms;
  const storageKey = `layankan:${slug}`;
  const [token, setToken] = useState<string | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const bottom = useRef<HTMLDivElement>(null);
  const api = `/api/public/chat/${slug}`;

  const merge = useCallback((incoming: Msg[]) => {
    setMessages((m) => {
      const real = m.filter((x) => !x.id.startsWith("tmp-"));
      const seen = new Set(real.map((x) => x.id));
      return [...real, ...incoming.filter((x) => !seen.has(x.id))];
    });
  }, []);

  const poll = useCallback(async (tok: string) => {
    const res = await fetch(api, { headers: { "x-visitor-token": tok }, cache: "no-store" });
    if (res.ok) merge((await res.json()).messages ?? []);
  }, [api, merge]);

  useEffect(() => {
    let tok: string | null = null;
    try { tok = localStorage.getItem(storageKey); } catch {}
    if (tok) {
      setToken(tok);
      poll(tok);
    }
  }, [storageKey, poll]);

  useEffect(() => {
    if (!token) return;
    const id = setInterval(() => document.visibilityState === "visible" && poll(token), 5000);
    return () => clearInterval(id);
  }, [token, poll]);

  useEffect(() => bottom.current?.scrollIntoView({ behavior: "smooth" }), [messages.length, busy]);

  async function send(e: React.FormEvent) {
    e.preventDefault();
    const text = draft.trim();
    if (!text || busy) return;
    setDraft("");
    setErr(null);
    setBusy(true);
    setMessages((m) => [...m, { id: `tmp-${Date.now()}`, from: "customer", body: text, at: new Date().toISOString() }]);
    try {
      const res = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text, visitorToken: token }) });
      if (res.status === 429) throw new Error(tx.slow);
      if (!res.ok) throw new Error(tx.error);
      const data = await res.json();
      if (data.visitorToken && data.visitorToken !== token) {
        setToken(data.visitorToken);
        try { localStorage.setItem(storageKey, data.visitorToken); } catch {}
      }
      merge(data.messages ?? []);
    } catch (e2) {
      setErr(e2 instanceof Error ? e2.message : tx.error);
      setMessages((m) => m.filter((x) => !x.id.startsWith("tmp-")));
      setDraft(text);
    }
    setBusy(false);
  }

  return (
    <div className={`flex flex-col bg-white ${embed ? "h-screen" : "mx-auto h-[100dvh] max-w-lg shadow-xl sm:my-6 sm:h-[calc(100dvh-3rem)] sm:rounded-2xl"}`}>
      <header className={`flex items-center gap-3 bg-brand-700 px-4 py-3 text-white ${embed ? "" : "sm:rounded-t-2xl"}`}>
        <div className="flex h-9 w-9 items-center justify-center rounded-full bg-white/20 font-bold">{name.slice(0, 1).toUpperCase()}</div>
        <div>
          <div className="font-semibold leading-tight">{name}</div>
          <div className="text-xs text-white/70">{busy ? tx.typing : "online"}</div>
        </div>
      </header>
      <div className="flex-1 space-y-2 overflow-y-auto bg-[#efeae2] p-3">
        <div className="mx-auto max-w-[90%] rounded-lg bg-amber-50 p-2 text-center text-[11px] text-amber-900">
          🔒 {tx.privacy} <a href={`/privacy?b=${encodeURIComponent(slug)}`} target="_blank" className="underline">{tx.privacyLink}</a>
        </div>
        <Bubble mine={false} body={tx.greeting} />
        {messages.map((m) => <Bubble key={m.id} mine={m.from === "customer"} body={m.body} />)}
        {busy && <div className="w-16 rounded-2xl bg-white px-3 py-2 text-center text-zinc-400 shadow-sm">•••</div>}
        <div ref={bottom} />
      </div>
      {err && <div className="bg-red-50 px-3 py-1 text-xs text-red-700">{err}</div>}
      <form onSubmit={send} className="flex gap-2 border-t border-zinc-200 p-2">
        <input
          className="input rounded-full"
          value={draft}
          maxLength={2000}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={tx.placeholder}
          aria-label={tx.placeholder}
        />
        <button disabled={busy || !draft.trim()} className="btn-primary rounded-full">{tx.send}</button>
      </form>
      <div className={`pb-2 text-center text-[10px] text-zinc-400 ${embed ? "" : "sm:rounded-b-2xl"}`}>
        {tx.powered} <a href="/" target="_blank" className="font-semibold">Layankan</a>
      </div>
    </div>
  );
}

function Bubble({ mine, body }: { mine: boolean; body: string }) {
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div className={`max-w-[80%] whitespace-pre-wrap break-words rounded-2xl px-3 py-2 text-sm shadow-sm ${mine ? "bg-[#d9fdd3]" : "bg-white"}`}>{body}</div>
    </div>
  );
}
