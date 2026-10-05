"use client";
import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DEFAULT_DAILY_CAP, META_TIERS } from "@/lib/broadcasts/rules";

/** Set one WhatsApp number's broadcast daily cap (empty / Reset = default). */
export default function BroadcastCapControl({ connectionId, custom }: { connectionId: string; custom: number | null }) {
  const router = useRouter();
  const [value, setValue] = useState(custom ? String(custom) : "");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const save = (limit: number | null) =>
    start(async () => {
      const r = await fetch("/api/admin/broadcast-cap", {
        method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ connection_id: connectionId, limit }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) return setMsg({ ok: false, text: String(d.error ?? "error") });
      setValue(d.custom ? String(d.cap) : "");
      setMsg({ ok: true, text: `Saved: ${Number(d.cap).toLocaleString()}/day` });
      router.refresh();
    });
  const parsed = value.trim() === "" ? null : Number(value);
  return (
    <span className="flex flex-wrap items-center justify-end gap-1">
      <input
        aria-label="Daily cap"
        inputMode="numeric"
        className="input w-24 py-1 text-xs"
        placeholder={String(DEFAULT_DAILY_CAP)}
        list={`tiers-${connectionId}`}
        value={value}
        onChange={(e) => { setValue(e.target.value.replace(/[^\d]/g, "")); setMsg(null); }}
      />
      <datalist id={`tiers-${connectionId}`}>{META_TIERS.map((t) => <option key={t} value={t} />)}</datalist>
      <button
        disabled={pending || (parsed !== null && !(parsed >= 1 && parsed <= 100_000))}
        onClick={() => confirm(parsed === null ? `Go back to the default (${DEFAULT_DAILY_CAP}/day)?` : `Allow up to ${parsed.toLocaleString()} broadcast messages per 24h from this number? Only do this once Meta has raised the number's messaging tier.`) && save(parsed)}
        className="btn-secondary px-2 py-1 text-xs"
      >
        Save
      </button>
      {custom !== null && <button disabled={pending} onClick={() => save(null)} className="btn-secondary px-2 py-1 text-xs">Reset</button>}
      {msg && <span className={`text-xs ${msg.ok ? "text-green-700" : "text-red-700"}`}>{msg.text}</span>}
    </span>
  );
}
