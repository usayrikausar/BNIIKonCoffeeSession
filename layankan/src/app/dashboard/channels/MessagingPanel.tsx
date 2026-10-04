"use client";
import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";
import { disconnectConnection } from "./whatsapp-actions";

export interface MsgConn { id: string; channel: "instagram" | "messenger"; is_active: boolean; status: string; display_name: string | null; page_id: string | null }
interface PageOpt { id: string; name: string; instagram: { id: string; username: string | null } | null }

/** Channels → Facebook Messenger & Instagram (R4): the business connects its OWN Page and linked Instagram account. */
export default function MessagingPanel({ lang, isOwner, connections, meta }: {
  lang: Lang; isOwner: boolean; connections: MsgConn[]; meta: { appId: string; configId: string; graphVersion: string };
}) {
  const ms = lang === "ms";
  const router = useRouter();
  const [pending, start] = useTransition();
  const [pages, setPages] = useState<PageOpt[] | null>(null);
  const [withIg, setWithIg] = useState(true);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [ready, setReady] = useState(false);
  const configured = !!(meta.appId && meta.configId);

  useEffect(() => {
    if (!configured || !isOwner) return;
    const init = () => {
      window.FB?.init({ appId: meta.appId, autoLogAppEvents: true, xfbml: false, version: meta.graphVersion });
      setReady(true);
    };
    if (window.FB) return init();
    const prev = window.fbAsyncInit;
    window.fbAsyncInit = () => {
      prev?.();
      init();
    };
    if (!document.getElementById("facebook-jssdk")) {
      const s = document.createElement("script");
      s.id = "facebook-jssdk";
      s.async = true;
      s.crossOrigin = "anonymous";
      s.src = "https://connect.facebook.net/en_US/sdk.js";
      document.body.appendChild(s);
    }
  }, [configured, isOwner, meta.appId, meta.graphVersion]);

  async function post(body: object) {
    const res = await fetch("/api/dashboard/meta-pages", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    return { ok: res.ok, data: (await res.json().catch(() => ({}))) as { error?: string; pages?: PageOpt[]; connected?: string[] } };
  }

  function login() {
    setMsg(null);
    window.FB?.login(
      (resp) => {
        const code = resp.authResponse?.code;
        if (!code) return setMsg({ ok: false, text: ms ? "Dibatalkan" : "Cancelled" });
        start(async () => {
          const r = await post({ action: "list", code });
          if (!r.ok) return setMsg({ ok: false, text: r.data.error ?? "error" });
          setPages(r.data.pages ?? []);
        });
      },
      { config_id: meta.configId, response_type: "code", override_default_response_type: true },
    );
  }

  function connect(p: PageOpt) {
    start(async () => {
      const r = await post({ action: "connect", page_id: p.id, instagram: withIg && !!p.instagram });
      if (!r.ok) return setMsg({ ok: false, text: r.data.error ?? "error" });
      setPages(null);
      setMsg({ ok: true, text: ms ? `✓ Disambung: ${r.data.connected?.join(" + ")}` : `✓ Connected: ${r.data.connected?.join(" + ")}` });
      router.refresh();
    });
  }

  const live = connections.filter((c) => c.status !== "disconnected");
  return (
    <section className="card space-y-4">
      <h2 className="text-lg font-semibold">{ms ? "Facebook Messenger & Instagram" : "Facebook Messenger & Instagram"}</h2>
      <p className="text-sm text-zinc-500">
        {ms
          ? "Sambung Page Facebook perniagaan anda (dan akaun Instagram profesional yang dipautkan). Mesej dari Messenger dan DM Instagram masuk ke Peti Masuk yang sama, dijawab oleh AI yang sama. API rasmi Meta sahaja."
          : "Connect your business's Facebook Page (and the Instagram professional account linked to it). Messenger messages and Instagram DMs arrive in the same Inbox, answered by the same AI. Official Meta APIs only."}
      </p>
      {live.map((c) => (
        <div key={c.id} className={`flex flex-wrap items-center gap-2 rounded-lg border p-3 text-sm ${c.is_active ? "border-green-300 bg-green-50/40" : "border-zinc-200"}`}>
          <span>{c.channel === "instagram" ? "📸" : "💙"}</span>
          <span className={`rounded px-2 py-0.5 text-xs font-bold ${c.is_active ? "bg-green-600 text-white" : "bg-zinc-200"}`}>{c.is_active ? (ms ? "AKTIF" : "ACTIVE") : ms ? "Siap sedia" : "Standby"}</span>
          <b>{c.display_name ?? c.page_id}</b>
          <span className="text-xs text-zinc-500">{c.channel === "instagram" ? "Instagram" : "Messenger"}</span>
          {isOwner && (
            <button disabled={pending} className="btn-danger ml-auto px-3 py-1 text-xs" onClick={() => confirm("?") && start(async () => { await disconnectConnection(c.id); router.refresh(); })}>
              {ms ? "Putuskan" : "Disconnect"}
            </button>
          )}
        </div>
      ))}
      {isOwner && !configured && (
        <p className="text-xs text-amber-700">{ms ? "Belum dikonfigurasi oleh pentadbir (NEXT_PUBLIC_META_PAGES_CONFIG_ID)." : "Not configured by the administrator yet (NEXT_PUBLIC_META_PAGES_CONFIG_ID)."}</p>
      )}
      {isOwner && configured && !pages && (
        <button disabled={!ready || pending} onClick={login} className="btn-primary">{ms ? "Sambung dengan Facebook" : "Connect with Facebook"}</button>
      )}
      {pages && (
        <div className="space-y-2">
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={withIg} onChange={(e) => setWithIg(e.target.checked)} /> {ms ? "Sambung juga Instagram yang dipautkan" : "Also connect the linked Instagram"}</label>
          {pages.length === 0 && <p className="text-sm text-zinc-500">{ms ? "Tiada Page dijumpai untuk akaun ini." : "No Pages found for this account."}</p>}
          {pages.map((p) => (
            <button key={p.id} disabled={pending} onClick={() => connect(p)} className="btn-secondary flex w-full justify-between">
              <span>💙 {p.name}</span>
              <span className="text-xs text-zinc-500">{p.instagram ? `📸 @${p.instagram.username ?? p.instagram.id}` : ms ? "tiada Instagram" : "no Instagram"}</span>
            </button>
          ))}
        </div>
      )}
      {msg && <p className={`text-sm ${msg.ok ? "text-brand-700" : "text-red-600"}`}>{msg.text}</p>}
      <p className="text-xs text-zinc-500">
        {ms
          ? "Peraturan Meta: AI hanya membalas dalam 24 jam selepas mesej terakhir pelanggan. Selepas itu, staf masih boleh membalas sehingga 7 hari."
          : "Meta's rule: the AI only replies within 24h of the customer's last message. After that, staff can still reply for up to 7 days."}
      </p>
    </section>
  );
}
