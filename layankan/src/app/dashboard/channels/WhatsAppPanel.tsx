"use client";
import { useActionState, useEffect, useRef, useState, useTransition } from "react";
import QRCode from "qrcode";
import type { Lang } from "@/lib/i18n";
import {
  addTemplate,
  completeMetaSignup,
  connectMurpati,
  deleteTemplate,
  disconnectConnection,
  saveOwnership,
  switchProvider,
  syncTemplates,
} from "./whatsapp-actions";

export interface Conn {
  id: string;
  provider: "murpati" | "meta_cloud";
  is_active: boolean;
  status: string;
  display_phone_number: string | null;
  phone_number_id: string | null;
  waba_id: string | null;
  meta_business_id: string | null;
  provider_account_ref: string | null;
  meta_business_owner: string | null;
  waba_owner: string | null;
  owner_legal_name: string | null;
  owner_contact_email: string | null;
  ownership_verified_at: string | null;
  created_at: string;
}
export interface Tpl { id: string; name: string; language: string; status: string; body_text: string; variable_count: number; source: string }

declare global {
  interface Window {
    FB?: { init: (o: object) => void; login: (cb: (r: { authResponse?: { code?: string } }) => void, o: object) => void };
    fbAsyncInit?: () => void;
  }
}

const L = {
  ms: {
    title: "WhatsApp Business (API rasmi)",
    none: "Belum disambung. Pilih cara sambungan — nombor kekal milik perniagaan anda.",
    meta: "Sambung terus dengan Meta (disyorkan)",
    metaHelp: "Log masuk Facebook dan pilih Meta Business, akaun WhatsApp Business (WABA) dan nombor ANDA sendiri.",
    metaNotConfigured: "Sambungan Meta belum dikonfigurasi oleh pentadbir (NEXT_PUBLIC_META_APP_ID).",
    murpati: "Sambung melalui Murpati (API rasmi)",
    active: "AKTIF",
    standby: "Siap sedia",
    makeActive: "Jadikan aktif",
    disconnect: "Putuskan",
    webhook: "URL webhook untuk Murpati",
    ownership: "Pemilikan (untuk mudah alih nombor)",
    templates: "Template mesej diluluskan",
    templatesHelp: "Diperlukan untuk menghantar mesej lebih 24 jam selepas mesej terakhir pelanggan (cth. susulan).",
    sync: "Segerak dari Meta",
    waLink: "Pautan wa.me",
    warnOwner: "⚠️ Akaun Meta/WABA bukan milik klien. Pindahkan pemilikan kepada klien supaya nombor boleh dipindah.",
  },
  en: {
    title: "WhatsApp Business (official API)",
    none: "Not connected yet. Choose how to connect — the number stays owned by your business.",
    meta: "Connect directly with Meta (recommended)",
    metaHelp: "Log in with Facebook and pick YOUR OWN Meta Business, WhatsApp Business Account (WABA) and number.",
    metaNotConfigured: "Meta connection not configured by the admin (NEXT_PUBLIC_META_APP_ID).",
    murpati: "Connect via Murpati (official API)",
    active: "ACTIVE",
    standby: "Standby",
    makeActive: "Make active",
    disconnect: "Disconnect",
    webhook: "Webhook URL for Murpati",
    ownership: "Ownership (for number portability)",
    templates: "Approved message templates",
    templatesHelp: "Needed to message a customer more than 24h after their last message (e.g. follow-ups).",
    sync: "Sync from Meta",
    waLink: "wa.me link",
    warnOwner: "⚠️ Meta Business/WABA is not client-owned. Transfer ownership to the client so the number can be migrated.",
  },
};

export default function WhatsAppPanel(props: {
  lang: Lang;
  isOwner: boolean;
  appUrl: string;
  connections: Conn[];
  templates: Tpl[];
  meta: { appId: string; configId: string; graphVersion: string };
}) {
  const t = L[props.lang];
  const [msg, setMsg] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const run = (fn: () => Promise<{ ok: boolean; error?: string; warning?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg(r.ok ? (r.warning ? `✓ ${r.warning}` : "✓") : `✗ ${r.error ?? "error"}`);
    });

  return (
    <section className="card space-y-4">
      <h2 className="text-lg font-semibold">{t.title}</h2>
      {props.connections.length === 0 && <p className="text-sm text-zinc-500">{t.none}</p>}

      {props.connections.map((c) => (
        <ConnectionCard key={c.id} c={c} t={t} isOwner={props.isOwner} appUrl={props.appUrl} pending={pending} run={run} />
      ))}

      {props.isOwner && (
        <div className="grid gap-3 md:grid-cols-2">
          <MetaSignup t={t} meta={props.meta} run={run} />
          <MurpatiForm t={t} />
        </div>
      )}

      {props.connections.length > 0 && (
        <div className="space-y-2 border-t border-zinc-100 pt-4">
          <h3 className="font-semibold">{t.templates}</h3>
          <p className="text-xs text-zinc-500">{t.templatesHelp}</p>
          <ul className="divide-y divide-zinc-100 text-sm">
            {props.templates.map((tp) => (
              <li key={tp.id} className="flex items-start justify-between gap-2 py-2">
                <div>
                  <code className="font-semibold">{tp.name}</code> <span className="text-xs text-zinc-500">{tp.language} · {tp.status} · {tp.variable_count} var</span>
                  {tp.body_text && <p className="text-xs text-zinc-600">{tp.body_text}</p>}
                </div>
                {props.isOwner && <button onClick={() => run(() => deleteTemplate(tp.id))} className="text-xs text-red-600 underline">✕</button>}
              </li>
            ))}
          </ul>
          {props.isOwner && <TemplateForm />}
        </div>
      )}
      {msg && <p className="text-sm text-zinc-600">{msg}</p>}
    </section>
  );
}

function ConnectionCard({ c, t, isOwner, appUrl, pending, run }: {
  c: Conn; t: (typeof L)["ms"]; isOwner: boolean; appUrl: string; pending: boolean;
  run: (fn: () => Promise<{ ok: boolean; error?: string; warning?: string }>) => void;
}) {
  const [own, ownAction, ownPending] = useActionState(saveOwnership, null);
  const [qr, setQr] = useState<string | null>(null);
  const digits = (c.display_phone_number ?? "").replace(/[^\d]/g, "").replace(/^0/, "60");
  const wa = digits ? `https://wa.me/${digits}` : null;
  useEffect(() => {
    if (wa && c.is_active) QRCode.toDataURL(wa, { width: 1024, margin: 2 }).then(setQr);
  }, [wa, c.is_active]);
  const notClientOwned = (c.waba_owner && c.waba_owner !== "client") || (c.meta_business_owner && c.meta_business_owner !== "client");

  return (
    <div className={`space-y-3 rounded-lg border p-3 ${c.is_active ? "border-green-300 bg-green-50/40" : "border-zinc-200"}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-0.5 text-xs font-bold ${c.is_active ? "bg-green-600 text-white" : "bg-zinc-200"}`}>{c.is_active ? t.active : t.standby}</span>
        <span className="font-semibold">{c.display_phone_number ?? "—"}</span>
        <span className="text-xs text-zinc-500">{c.provider === "meta_cloud" ? "Meta Cloud API" : "Murpati"} · {c.status}</span>
        {isOwner && (
          <span className="ml-auto flex gap-2">
            {!c.is_active && <button disabled={pending} onClick={() => run(() => switchProvider(c.id))} className="btn-primary px-3 py-1 text-xs">{t.makeActive}</button>}
            {c.provider === "meta_cloud" && <button disabled={pending} onClick={() => run(() => syncTemplates(c.id))} className="btn-secondary px-3 py-1 text-xs">{t.sync}</button>}
            <button disabled={pending} onClick={() => confirm("?") && run(() => disconnectConnection(c.id))} className="btn-danger px-3 py-1 text-xs">{t.disconnect}</button>
          </span>
        )}
      </div>
      {c.provider === "murpati" && (
        <div className="text-xs">
          <div className="text-zinc-500">{t.webhook}</div>
          <code className="break-all">{`${appUrl}/api/webhooks/murpati/${c.id}`}</code>
        </div>
      )}
      {c.is_active && wa && (
        <div className="flex flex-wrap items-center gap-3 text-sm">
          <span className="text-zinc-500">{t.waLink}:</span>
          <a href={wa} target="_blank" rel="noreferrer" className="font-medium text-brand-700 underline">{wa}</a>
          {qr && <a href={qr} download={`whatsapp-qr-${digits}.png`} className="btn-secondary px-2 py-1 text-xs">⬇ QR PNG</a>}
        </div>
      )}
      {notClientOwned && <p className="rounded bg-amber-50 p-2 text-xs text-amber-900">{t.warnOwner}</p>}
      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-600">{t.ownership}{c.ownership_verified_at ? " ✓" : ""}</summary>
        <form action={ownAction} className="mt-2 grid gap-2 sm:grid-cols-2">
          <input type="hidden" name="connection_id" value={c.id} />
          {(["meta_business_owner", "waba_owner"] as const).map((k) => (
            <label key={k} className="text-xs">
              {k === "meta_business_owner" ? "Meta Business owner" : "WABA owner"}
              <select name={k} defaultValue={c[k] ?? "unknown"} className="input" disabled={!isOwner}>
                <option value="client">client (recommended)</option>
                <option value="layankan">layankan</option>
                <option value="reseller">reseller</option>
                <option value="unknown">unknown</option>
              </select>
            </label>
          ))}
          <input name="meta_business_id" defaultValue={c.meta_business_id ?? ""} placeholder="Meta Business ID" className="input" disabled={!isOwner} />
          <input name="waba_id" defaultValue={c.waba_id ?? ""} placeholder="WABA ID" className="input" disabled={!isOwner} />
          <input name="owner_legal_name" defaultValue={c.owner_legal_name ?? ""} placeholder="Legal owner name (SSM)" className="input" disabled={!isOwner} />
          <input name="owner_contact_email" defaultValue={c.owner_contact_email ?? ""} placeholder="Owner contact email" className="input" disabled={!isOwner} />
          <label className="flex items-center gap-2 text-xs sm:col-span-2">
            <input type="checkbox" name="verified" defaultChecked={!!c.ownership_verified_at} disabled={!isOwner} /> Verified in Meta Business Manager
          </label>
          {isOwner && <button disabled={ownPending} className="btn-secondary w-fit">Save</button>}
          {own && <span className="text-xs">{own.ok ? "✓" : own.error}</span>}
        </form>
      </details>
    </div>
  );
}

function MetaSignup({ t, meta, run }: {
  t: (typeof L)["ms"]; meta: { appId: string; configId: string; graphVersion: string };
  run: (fn: () => Promise<{ ok: boolean; error?: string; warning?: string }>) => void;
}) {
  const session = useRef<{ phone_number_id?: string; waba_id?: string } | null>(null);
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const configured = !!(meta.appId && meta.configId);

  useEffect(() => {
    if (!configured) return;
    const onMessage = (event: MessageEvent) => {
      if (!/(^|\.)facebook\.com$/.test(new URL(event.origin).hostname)) return;
      try {
        const data = typeof event.data === "string" ? JSON.parse(event.data) : event.data;
        if (data?.type !== "WA_EMBEDDED_SIGNUP") return;
        if (String(data.event).startsWith("FINISH")) session.current = data.data ?? {};
        else if (data.event === "CANCEL") setErr("Dibatalkan / Cancelled");
        else if (data.event === "ERROR") setErr(data.data?.error_message ?? "Embedded Signup error");
      } catch {
        /* non-JSON messages from the SDK */
      }
    };
    window.addEventListener("message", onMessage);
    window.fbAsyncInit = () => {
      window.FB?.init({ appId: meta.appId, autoLogAppEvents: true, xfbml: false, version: meta.graphVersion });
      setReady(true);
    };
    if (!document.getElementById("facebook-jssdk")) {
      const s = document.createElement("script");
      s.id = "facebook-jssdk";
      s.async = true;
      s.crossOrigin = "anonymous";
      s.src = "https://connect.facebook.net/en_US/sdk.js";
      document.body.appendChild(s);
    } else if (window.FB) setReady(true);
    return () => window.removeEventListener("message", onMessage);
  }, [configured, meta.appId, meta.graphVersion]);

  function launch() {
    setErr(null);
    session.current = null;
    window.FB?.login(
      (resp) => {
        const code = resp.authResponse?.code;
        if (!code) return setErr("Dibatalkan / Cancelled");
        // The session-info message can arrive just after the login callback.
        let tries = 0;
        const wait = () => {
          const s = session.current;
          if (s?.phone_number_id && s.waba_id) {
            run(() => completeMetaSignup({ code, phoneNumberId: s.phone_number_id!, wabaId: s.waba_id! }));
          } else if (tries++ < 20) setTimeout(wait, 250);
          else setErr("Nombor tidak dipilih / No phone number selected");
        };
        wait();
      },
      {
        config_id: meta.configId,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {}, featureType: "", sessionInfoVersion: "3" },
      },
    );
  }

  return (
    <div className="space-y-2 rounded-lg border border-zinc-200 p-3">
      <h3 className="font-semibold">{t.meta}</h3>
      <p className="text-xs text-zinc-500">{t.metaHelp}</p>
      {configured ? (
        <button disabled={!ready} onClick={launch} className="btn w-full bg-[#1877f2] text-white hover:bg-[#166fe5]">Facebook · WhatsApp</button>
      ) : (
        <p className="text-xs text-amber-700">{t.metaNotConfigured}</p>
      )}
      {err && <p className="text-xs text-red-600">{err}</p>}
    </div>
  );
}

function MurpatiForm({ t }: { t: (typeof L)["ms"] }) {
  const [state, action, pending] = useActionState(connectMurpati, null);
  const [open, setOpen] = useState(false);
  return (
    <div className="space-y-2 rounded-lg border border-zinc-200 p-3">
      <h3 className="font-semibold">{t.murpati}</h3>
      {!open ? (
        <button onClick={() => setOpen(true)} className="btn-secondary w-full">Murpati…</button>
      ) : (
        <form action={action} className="space-y-2">
          <input name="display_phone_number" placeholder="+60 12-345 6789" className="input" required />
          <input name="device_id" placeholder="Murpati device / sender ID" className="input" required />
          <input name="api_key" placeholder="Murpati API key" className="input" type="password" autoComplete="off" required />
          <input name="webhook_secret" placeholder="Webhook secret (whsec_…)" className="input" type="password" autoComplete="off" required />
          <input name="waba_id" placeholder="WABA ID (optional)" className="input" />
          <input name="phone_number_id" placeholder="Meta phone number ID (optional)" className="input" />
          <label className="flex items-start gap-2 text-xs">
            <input type="checkbox" name="confirm_official" className="mt-0.5" />
            <span>Nombor ini menggunakan <b>API rasmi WhatsApp</b> di Murpati — BUKAN peranti biasa (imbas QR). / This number is on Murpati&apos;s <b>official API</b>, NOT a QR-linked regular device.</span>
          </label>
          <button disabled={pending} className="btn-primary w-full">{pending ? "…" : "Simpan / Save"}</button>
          {state && <p className={`text-xs ${state.ok ? "text-brand-700" : "text-red-600"}`}>{state.ok ? "✓ Tampal URL webhook di atas ke dalam Murpati / Paste the webhook URL above into Murpati" : state.error}</p>}
        </form>
      )}
    </div>
  );
}

function TemplateForm() {
  const [state, action, pending] = useActionState(addTemplate, null);
  return (
    <form action={action} className="grid gap-2 sm:grid-cols-[1fr_80px]">
      <input name="name" placeholder="template_name (as approved by Meta)" className="input" required />
      <input name="language" defaultValue="ms" className="input" />
      <textarea name="body_text" placeholder="Body text, e.g. Hai {{1}}, masih berminat dengan {{2}}?" className="input sm:col-span-2" rows={2} />
      <button disabled={pending} className="btn-secondary w-fit">+ Template</button>
      {state && !state.ok && <span className="text-xs text-red-600">{state.error}</span>}
    </form>
  );
}
