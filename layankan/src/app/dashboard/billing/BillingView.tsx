"use client";
import { useState, useTransition } from "react";
import type { Lang } from "@/lib/i18n";
import type { BillingState } from "@/lib/billing/service";
import type { Plan } from "@/lib/billing/logic";
import { formatRM } from "@/lib/billing/logic";
import { choosePlan, setCancelAtPeriodEnd } from "./actions";

interface Invoice { id: string; number: string; description: string; amount_cents: number; status: string; payment_url: string | null; period_start: string; period_end: string; paid_at: string | null; created_at: string; gateway: string }

const REASON: Record<string, { ms: string; en: string }> = {
  quota_exceeded: { ms: "Had perbualan bulan ini dicapai. AI masih menjawab perbualan yang sedang berjalan; perbualan baharu datang kepada anda. Naik taraf untuk sambung.", en: "Monthly conversation limit reached. The AI still answers ongoing chats; new chats come to you. Upgrade to resume." },
  trial_ended: { ms: "Tempoh percubaan tamat — AI dihentikan. Pilih pelan untuk sambung.", en: "Trial ended — AI paused. Choose a plan to continue." },
  payment_overdue: { ms: "Bayaran tertunggak — AI dihentikan. Bayar invois untuk sambung.", en: "Payment overdue — AI paused. Pay the invoice to resume." },
  canceled: { ms: "Langganan dibatalkan — AI dihentikan.", en: "Subscription canceled — AI paused." },
};

export default function BillingView(props: {
  lang: Lang;
  isOwner: boolean;
  billing: BillingState;
  plans: (Plan & { description: string })[];
  invoices: Invoice[];
  foundingLeft: number;
  manual: boolean;
  bankDetails: string;
  payment: string | null;
}) {
  const ms = props.lang === "ms";
  const { sub, plan, entitlement: e, usage } = props.billing;
  const [err, setErr] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const date = (s: string | null | undefined) => (s ? new Date(s).toLocaleDateString(ms ? "ms-MY" : "en-MY", { day: "numeric", month: "short", year: "numeric" }) : "—");
  const pct = e.limit > 0 ? Math.min(100, (e.used / e.limit) * 100) : 0;
  const openInvoice = props.invoices.find((i) => i.status === "open");

  return (
    <div className="mx-auto max-w-4xl space-y-6 pb-16">
      <h1 className="text-2xl font-bold">{ms ? "Langganan & Bil" : "Plan & Billing"}</h1>

      {props.payment === "success" && <p className="rounded-lg bg-green-50 p-3 text-sm text-green-800">✅ {ms ? "Bayaran diterima. Terima kasih!" : "Payment received. Thank you!"}</p>}
      {props.payment === "pending" && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-800">⏳ {ms ? "Bayaran sedang disahkan. Muat semula sebentar lagi." : "Payment is being confirmed. Refresh in a moment."}</p>}
      {props.payment === "failed" && <p className="rounded-lg bg-red-50 p-3 text-sm text-red-700">{ms ? "Bayaran tidak berjaya. Cuba lagi." : "Payment was not completed. Please try again."}</p>}
      {!e.aiAllowed && REASON[e.reason] && <p className="rounded-lg bg-red-50 p-3 text-sm font-medium text-red-800">⚠️ {REASON[e.reason][props.lang]}</p>}
      {e.aiAllowed && e.state === "grace" && (
        <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">
          {ms ? `Tempoh langganan tamat. AI masih aktif sehingga ${date(e.graceEndsAt)} — sila bayar invois.` : `Your period has ended. AI keeps working until ${date(e.graceEndsAt)} — please pay the invoice.`}
        </p>
      )}

      <section className="card grid gap-4 md:grid-cols-2">
        <div>
          <div className="text-xs text-zinc-500">{ms ? "Pelan semasa" : "Current plan"}</div>
          <div className="text-xl font-bold">{plan?.name ?? "—"}</div>
          <div className="text-sm text-zinc-600">
            {sub?.status === "trialing"
              ? `${ms ? "Percubaan tamat" : "Trial ends"} ${date(sub.current_period_end)}`
              : `${ms ? "Aktif sehingga" : "Paid through"} ${date(sub?.current_period_end)}`}
            {sub?.cancel_at_period_end && <span className="ml-2 text-red-600">({ms ? "akan dibatalkan" : "cancels at period end"})</span>}
          </div>
          {props.isOwner && sub && sub.status === "active" && plan?.id !== "internal" && (
            <button disabled={pending} onClick={() => start(async () => void (await setCancelAtPeriodEnd(!sub.cancel_at_period_end)))} className="mt-2 text-xs text-zinc-500 underline">
              {sub.cancel_at_period_end ? (ms ? "Teruskan langganan" : "Keep subscription") : ms ? "Batalkan pada akhir tempoh" : "Cancel at period end"}
            </button>
          )}
        </div>
        <div>
          <div className="flex items-baseline justify-between text-sm">
            <span className="text-zinc-500">{ms ? "Perbualan bulan ini" : "Conversations this month"}</span>
            <span className="font-semibold tabular-nums">{e.used.toLocaleString()} / {e.limit.toLocaleString()}</span>
          </div>
          <div className="mt-2 h-2 rounded-full bg-zinc-100" role="meter" aria-valuenow={e.used} aria-valuemin={0} aria-valuemax={e.limit}>
            <div className={`h-2 rounded-full ${pct >= 100 ? "bg-red-600" : pct >= 80 ? "bg-amber-500" : "bg-brand-600"}`} style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 text-xs text-zinc-500">
            {usage.inbound_messages.toLocaleString()} {ms ? "mesej masuk" : "messages in"} · {usage.ai_replies.toLocaleString()} {ms ? "balasan AI" : "AI replies"} ·{" "}
            {ms ? "set semula setiap bulan" : "resets monthly"}
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            {ms
              ? "Satu perbualan = seorang pelanggan yang dijawab oleh AI dalam bulan ini, walau berapa banyak mesej. Harga tetap setiap perniagaan — tiada caj ikut kenalan atau staf. Kami e-mel anda pada 80% dan 100%."
              : "One conversation = one customer the AI answered this month, however many messages. One flat price per business — never per contact or per staff. We email you at 80% and 100%."}
          </p>
        </div>
      </section>

      {openInvoice && (
        <section className="card flex flex-wrap items-center justify-between gap-3 border-amber-200 bg-amber-50/50">
          <div>
            <div className="font-semibold">{ms ? "Invois belum dibayar" : "Unpaid invoice"} · {openInvoice.number}</div>
            <div className="text-sm text-zinc-600">{openInvoice.description} · {formatRM(openInvoice.amount_cents)}</div>
          </div>
          {openInvoice.payment_url ? (
            <a href={openInvoice.payment_url} className="btn-primary">{ms ? "Bayar sekarang (FPX)" : "Pay now (FPX)"}</a>
          ) : (
            <div className="max-w-sm whitespace-pre-line text-xs text-zinc-700">{props.bankDetails || (ms ? "Pasukan kami akan menghubungi anda untuk butiran bayaran." : "Our team will contact you with payment details.")}<br />{ms ? "Rujukan" : "Reference"}: <b>{openInvoice.number}</b></div>
          )}
        </section>
      )}

      <section>
        <h2 className="mb-3 text-lg font-semibold">{ms ? "Pilih pelan" : "Choose a plan"}</h2>
        <div className="grid gap-3 md:grid-cols-3">
          {props.plans.map((p) => {
            const current = p.id === plan?.id && sub?.status !== "trialing";
            return (
              <div key={p.id} className={`card flex flex-col gap-2 ${p.id === "founding" ? "ring-2 ring-brand-600" : ""}`}>
                <div className="flex items-baseline justify-between">
                  <h3 className="text-lg font-bold">{p.name}</h3>
                  {p.id === "founding" && <span className="rounded-full bg-brand-50 px-2 text-xs font-semibold text-brand-700">{props.foundingLeft} {ms ? "slot lagi" : "slots left"}</span>}
                </div>
                <div className="text-2xl font-extrabold">{formatRM(p.price_cents)}<span className="text-sm font-medium text-zinc-500">/{ms ? "bulan" : "month"}</span></div>
                {p.setup_fee_cents > 0 && <div className="text-xs text-zinc-500">+ {formatRM(p.setup_fee_cents)} {ms ? "setup (sekali)" : "setup (one-off)"}</div>}
                <p className="text-sm text-zinc-600">{p.description}</p>
                <ul className="space-y-1 text-sm">
                  <li>✓ {p.conversation_limit.toLocaleString()} {ms ? "perbualan pelanggan / bulan" : "customer conversations / month"}</li>
                  <li>✓ {p.max_whatsapp_numbers} {ms ? "nombor WhatsApp" : "WhatsApp number(s)"}</li>
                  <li>✓ {p.max_members} {ms ? "akaun staf (log masuk papan pemuka)" : "staff logins (dashboard users)"}</li>
                </ul>
                <div className="mt-auto pt-2">
                  {props.isOwner ? (
                    <button
                      disabled={pending}
                      onClick={() =>
                        start(async () => {
                          setErr(null);
                          const r = await choosePlan(p.id);
                          if (r && !r.ok) setErr(r.error ?? "error");
                        })
                      }
                      className={current ? "btn-secondary w-full" : "btn-primary w-full"}
                    >
                      {current ? (ms ? "Bayar bulan depan awal" : "Pay next month early") : ms ? "Pilih & bayar" : "Choose & pay"}
                    </button>
                  ) : (
                    <p className="text-xs text-zinc-500">{ms ? "Hanya pemilik boleh menukar pelan." : "Only the owner can change plans."}</p>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        {err && <p className="mt-2 text-sm text-red-600">{err}</p>}
        <p className="mt-3 text-xs text-zinc-500">
          {ms
            ? "Bayaran melalui FPX / kad. Tukar pelan berkuat kuasa serta-merta untuk tempoh sebulan baharu (tiada prorata). Mesej pelanggan tidak pernah hilang — jika had dicapai, AI berhenti dan perbualan diserahkan kepada anda."
            : "Pay by FPX / card. Plan changes start a fresh one-month period immediately (no proration). Customer messages are never lost — at the limit the AI pauses and conversations go to you."}
          {props.manual && (ms ? " Mod bayaran: pindahan bank (manual)." : " Payment mode: bank transfer (manual).")}
        </p>
      </section>

      <section className="card">
        <h2 className="mb-2 font-semibold">{ms ? "Invois" : "Invoices"}</h2>
        {props.invoices.length === 0 ? (
          <p className="text-sm text-zinc-500">—</p>
        ) : (
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500"><tr><th className="py-1">No.</th><th>{ms ? "Butiran" : "Details"}</th><th className="text-right">{ms ? "Jumlah" : "Amount"}</th><th className="text-right">Status</th></tr></thead>
            <tbody className="divide-y divide-zinc-100">
              {props.invoices.map((i) => (
                <tr key={i.id}>
                  <td className="py-2 font-mono text-xs">{i.number}</td>
                  <td className="py-2">{i.description}<div className="text-xs text-zinc-500">{date(i.period_start)} – {date(i.period_end)}</div></td>
                  <td className="py-2 text-right tabular-nums">{formatRM(i.amount_cents)}</td>
                  <td className="py-2 text-right">
                    {i.status === "paid" ? <span className="text-green-700">✓ {date(i.paid_at)}</span> : i.status === "open" && i.payment_url ? <a className="font-semibold text-brand-700 underline" href={i.payment_url}>{ms ? "Bayar" : "Pay"}</a> : i.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
