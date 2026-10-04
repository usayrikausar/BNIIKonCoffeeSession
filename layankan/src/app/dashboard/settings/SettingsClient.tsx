"use client";
import { useActionState, useState, useTransition } from "react";
import { dict, type Lang } from "@/lib/i18n";
import type { CurrentTenant } from "@/lib/session";
import { cancelInvite, deleteWorkspace, inviteMember, removeMember, updateMyPrefs, updateWorkspace } from "./actions";

const TIMEZONES = ["Asia/Kuala_Lumpur", "Asia/Singapore", "Asia/Jakarta", "Asia/Brunei", "Asia/Bangkok", "Asia/Manila", "Asia/Dubai", "Europe/London"];

export default function SettingsClient(props: {
  lang: Lang;
  isOwner: boolean;
  tenant: CurrentTenant;
  myId: string;
  members: { user_id: string; role: string; email: string | null }[];
  invites: { id: string; email: string }[];
  prefs: { email_handoff: boolean; email_daily_summary: boolean };
}) {
  const t = dict(props.lang);
  const [ws, wsAction, wsPending] = useActionState(updateWorkspace, null);
  const [inv, invAction, invPending] = useActionState(inviteMember, null);
  const [del, delAction, delPending] = useActionState(deleteWorkspace, null);
  const [prefs, setPrefs] = useState(props.prefs);
  const [pending, start] = useTransition();
  const ro = !props.isOwner;

  return (
    <div className="mx-auto max-w-3xl space-y-6 pb-16">
      <h1 className="text-2xl font-bold">{t("settings.title")}</h1>

      <section className="card space-y-4">
        <h2 className="text-lg font-semibold">{t("settings.workspace")}</h2>
        {ro && <p className="text-xs text-zinc-500">{t("settings.owner_only")}</p>}
        <form action={wsAction} className="grid gap-4 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <label className="label">{t("brain.name")}</label>
            <input name="name" className="input" defaultValue={props.tenant.name} disabled={ro} />
          </div>
          <div>
            <label className="label">{t("settings.timezone")}</label>
            <select name="timezone" className="input" defaultValue={props.tenant.timezone} disabled={ro}>
              {[...new Set([props.tenant.timezone, ...TIMEZONES])].map((z) => <option key={z}>{z}</option>)}
            </select>
          </div>
          <div>
            <label className="label">{t("settings.summary_hour")}</label>
            <select name="summary_hour" className="input" defaultValue={props.tenant.summary_hour} disabled={ro}>
              {Array.from({ length: 24 }, (_, h) => <option key={h} value={h}>{String(h).padStart(2, "0")}:00</option>)}
            </select>
          </div>
          <div>
            <label className="label">{t("settings.locale")}</label>
            <select name="default_locale" className="input" defaultValue={props.tenant.default_locale} disabled={ro}>
              <option value="ms">Bahasa Malaysia</option>
              <option value="en">English</option>
            </select>
          </div>
          {!ro && (
            <div className="flex items-end gap-3">
              <button disabled={wsPending} className="btn-primary">{wsPending ? t("common.saving") : t("common.save")}</button>
              {ws?.ok && <span className="text-sm text-brand-700">{t("common.saved")}</span>}
              {ws && !ws.ok && <span className="text-sm text-red-600">{t("common.error")}</span>}
            </div>
          )}
        </form>
      </section>

      <section className="card space-y-4">
        <h2 className="text-lg font-semibold">{t("settings.team")}</h2>
        <ul className="divide-y divide-zinc-100 text-sm">
          {props.members.map((m) => (
            <li key={m.user_id} className="flex items-center justify-between py-2">
              <span>{m.email ?? m.user_id}</span>
              <span className="flex items-center gap-3">
                <span className="text-zinc-500">{m.role === "owner" ? t("settings.role.owner") : t("settings.role.staff")}</span>
                {props.isOwner && m.user_id !== props.myId && (
                  <button disabled={pending} onClick={() => start(async () => void (await removeMember(m.user_id)))} className="text-xs text-red-600 underline">{t("common.delete")}</button>
                )}
              </span>
            </li>
          ))}
          {props.invites.map((i) => (
            <li key={i.id} className="flex items-center justify-between py-2 text-zinc-500">
              <span>{i.email}</span>
              <span className="flex items-center gap-3">
                <span>{t("settings.invite.pending")}</span>
                <button disabled={pending} onClick={() => start(async () => void (await cancelInvite(i.id)))} className="text-xs text-red-600 underline">{t("common.cancel")}</button>
              </span>
            </li>
          ))}
        </ul>
        {props.isOwner && (
          <form action={invAction} className="flex gap-2">
            <input name="email" type="email" required placeholder={t("settings.invite")} className="input" />
            <button disabled={invPending} className="btn-secondary">{t("settings.invite.send")}</button>
          </form>
        )}
        {inv && !inv.ok && <p className="text-sm text-red-600">{t("common.error")}</p>}
      </section>

      <section className="card space-y-3">
        <h2 className="text-lg font-semibold">{t("settings.notifications")}</h2>
        {(["email_handoff", "email_daily_summary"] as const).map((k) => (
          <label key={k} className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={prefs[k]}
              onChange={(e) => {
                const next = { ...prefs, [k]: e.target.checked };
                setPrefs(next);
                start(async () => void (await updateMyPrefs(next)));
              }}
            />
            {k === "email_handoff" ? t("settings.notif.handoff") : t("settings.notif.daily")}
          </label>
        ))}
      </section>

      {props.isOwner && (
        <section className="card space-y-4 border-red-200">
          <h2 className="text-lg font-semibold">{t("settings.privacy")}</h2>
          <a href="/api/dashboard/export" className="btn-secondary">⬇ {t("settings.export")}</a>
          <form action={delAction} className="space-y-2 rounded-lg bg-red-50 p-3">
            <label className="label text-red-800">{t("settings.delete_ws.confirm")} <code>{props.tenant.slug}</code></label>
            <div className="flex gap-2">
              <input name="confirm" className="input" autoComplete="off" />
              <button disabled={delPending} className="btn-danger whitespace-nowrap">{t("settings.delete_ws")}</button>
            </div>
            {del && !del.ok && <p className="text-sm text-red-600">{t("common.error")}</p>}
          </form>
        </section>
      )}
    </div>
  );
}
