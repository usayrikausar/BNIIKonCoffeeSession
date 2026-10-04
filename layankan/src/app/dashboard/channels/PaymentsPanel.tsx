"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { Lang } from "@/lib/i18n";

export interface PayAccount { gateway: "billplz" | "toyyibpay"; sandbox: boolean; account_holder_name: string | null; verified_at: string | null }

/** Channels → Payments (R2): the business connects its OWN Billplz or ToyyibPay. Money never passes through Layankan. */
export default function PaymentsPanel({ lang, isOwner, account, paidThisMonth }: { lang: Lang; isOwner: boolean; account: PayAccount | null; paidThisMonth: { count: number; total: string } }) {
  const ms = lang === "ms";
  const router = useRouter();
  const [gateway, setGateway] = useState<"billplz" | "toyyibpay">("billplz");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  async function connect(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = Object.fromEntries(f.entries());
    body.gateway = gateway;
    body.sandbox = f.get("sandbox") === "on";
    body.confirm_own_account = f.get("confirm_own_account") === "on";
    setBusy(true);
    setMsg(null);
    const res = await fetch("/api/dashboard/payments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = (await res.json().catch(() => ({}))) as { error?: string };
    setBusy(false);
    if (res.ok) {
      setMsg({ ok: true, text: ms ? "✓ Disambung. Anda kini boleh hantar pautan bayaran dari mana-mana chat." : "✓ Connected. You can now send payment links from any chat." });
      router.refresh();
    } else setMsg({ ok: false, text: d.error ?? "error" });
  }

  async function disconnect() {
    if (!confirm(ms ? "Putuskan akaun pembayaran? Pautan sedia ada masih boleh dibayar, tetapi anda tidak boleh hantar pautan baharu." : "Disconnect the payment account?")) return;
    setBusy(true);
    await fetch("/api/dashboard/payments", { method: "DELETE" });
    setBusy(false);
    router.refresh();
  }

  return (
    <section className="card space-y-4">
      <h2 className="text-lg font-semibold">{ms ? "Pembayaran (pautan bayaran dalam chat)" : "Payments (payment links in chat)"}</h2>
      <p className="text-sm text-zinc-500">
        {ms
          ? "Sambung akaun Billplz atau ToyyibPay perniagaan anda sendiri. Staf boleh hantar pautan bayaran (FPX / kad) dalam chat, dan wang dibayar TERUS ke akaun anda — bukan melalui Layankan. Chat ditanda 'Jadi pelanggan' secara automatik bila dibayar."
          : "Connect your business's own Billplz or ToyyibPay account. Staff can send payment links (FPX / card) in a chat, and the money goes STRAIGHT to your account — never through Layankan. The chat is marked 'Won' automatically when paid."}
      </p>

      {account ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-green-300 bg-green-50/40 p-3 text-sm">
          <span className="rounded bg-green-600 px-2 py-0.5 text-xs font-bold text-white">{ms ? "AKTIF" : "ACTIVE"}</span>
          <b>{account.gateway === "billplz" ? "Billplz" : "ToyyibPay"}</b>
          {account.sandbox && <span className="rounded bg-amber-100 px-1.5 text-xs text-amber-900">sandbox</span>}
          <span className="text-zinc-600">{account.account_holder_name}</span>
          <span className="text-xs text-zinc-500">· {ms ? "bulan ini" : "this month"}: {paidThisMonth.count} {ms ? "bayaran" : "payments"}, {paidThisMonth.total}</span>
          {isOwner && <button onClick={disconnect} disabled={busy} className="btn-danger ml-auto px-3 py-1 text-xs">{ms ? "Putuskan" : "Disconnect"}</button>}
        </div>
      ) : !isOwner ? (
        <p className="text-sm text-zinc-500">{ms ? "Pemilik perlu menyambung akaun pembayaran." : "The owner needs to connect a payment account."}</p>
      ) : (
        <form onSubmit={connect} className="space-y-3">
          <div className="flex gap-2">
            {(["billplz", "toyyibpay"] as const).map((g) => (
              <button type="button" key={g} onClick={() => setGateway(g)} className={gateway === g ? "btn-primary" : "btn-secondary"}>{g === "billplz" ? "Billplz" : "ToyyibPay"}</button>
            ))}
          </div>
          <input name="account_holder_name" className="input" placeholder={ms ? "Nama pemegang akaun (seperti di bank)" : "Account holder name (as at the bank)"} required />
          {gateway === "billplz" ? (
            <>
              <input name="api_key" className="input" placeholder="Billplz API Secret Key" type="password" autoComplete="off" required />
              <input name="collection_id" className="input" placeholder="Collection ID" required />
              <input name="x_signature_key" className="input" placeholder="X Signature Key" type="password" autoComplete="off" required />
              <p className="text-xs text-zinc-500">{ms ? "Billplz → Settings → Keys & Integration. Hidupkan X Signature." : "Billplz → Settings → Keys & Integration. Turn X Signature on."}</p>
            </>
          ) : (
            <>
              <input name="secret_key" className="input" placeholder="ToyyibPay User Secret Key" type="password" autoComplete="off" required />
              <input name="category_code" className="input" placeholder="Category Code" required />
            </>
          )}
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="sandbox" /> {ms ? "Mod ujian (sandbox)" : "Test mode (sandbox)"}</label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="confirm_own_account" className="mt-1" />
            <span>{ms ? "Saya sahkan ini akaun perniagaan saya sendiri dan wang dibayar terus kepada saya." : "I confirm this is my own business account and money is paid straight to me."}</span>
          </label>
          <button disabled={busy} className="btn-primary">{busy ? "…" : ms ? "Semak & sambung" : "Check & connect"}</button>
          <p className="text-xs text-zinc-500">{ms ? "Kunci diperiksa dengan gateway dahulu, kemudian disimpan secara sulit (disulitkan)." : "Keys are checked with the gateway first, then stored encrypted."}</p>
        </form>
      )}
      {msg && <p className={`text-sm ${msg.ok ? "text-brand-700" : "text-red-600"}`}>{msg.text}</p>}
    </section>
  );
}
