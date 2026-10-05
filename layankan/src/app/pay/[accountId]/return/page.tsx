import { createAdminClient } from "@/lib/supabase/admin";
import { accountById, gatewayFor, processPaymentNotice } from "@/lib/payments/service";
import { formatRm } from "@/lib/payments/links";

export const dynamic = "force-dynamic";
export const metadata = { title: "Bayaran / Payment", robots: { index: false } };

/**
 * Where the customer lands after paying. The page never trusts the URL: it
 * shows "received" only if the link is paid in our database (set by a verified
 * callback). For ToyyibPay the return is re-confirmed with ToyyibPay's API.
 */
export default async function PaymentReturn({ params, searchParams }: { params: Promise<{ accountId: string }>; searchParams: Promise<Record<string, string>> }) {
  const { accountId } = await params;
  const sp = await searchParams;
  const db = createAdminClient();
  const account = await accountById(db, accountId);
  let paid: { amount: number; description: string } | null = null;
  let business = "";
  if (account) {
    const billId = sp["billplz[id]"] ?? sp.billcode ?? "";
    if (account.gateway === "toyyibpay" && billId) {
      try {
        const n = await (await gatewayFor(db, account)).parseReturn(new URLSearchParams(sp));
        if (n) await processPaymentNotice(db, account, n);
      } catch {
        /* the callback will settle it */
      }
    }
    const [{ data: link }, { data: t }] = await Promise.all([
      billId ? db.from("payment_links").select("status, paid_amount_cents, description").eq("account_id", account.id).eq("gateway_bill_id", billId).maybeSingle() : Promise.resolve({ data: null }),
      db.from("tenants").select("name").eq("id", account.tenant_id).single(),
    ]);
    business = t?.name ?? "";
    if (link?.status === "paid") paid = { amount: link.paid_amount_cents as number, description: link.description as string };
  }
  return (
    <div className="mx-auto flex min-h-screen max-w-md flex-col items-center justify-center gap-3 p-6 text-center">
      {paid ? (
        <>
          <div className="text-5xl">✅</div>
          <h1 className="text-xl font-bold">Bayaran diterima / Payment received</h1>
          <p className="text-zinc-600">{formatRm(paid.amount)} · {paid.description}{business ? ` · ${business}` : ""}</p>
          <p className="text-sm text-zinc-500">Terima kasih! Anda boleh kembali ke WhatsApp / chat. · Thank you! You can return to the chat.</p>
        </>
      ) : (
        <>
          <div className="text-5xl">⏳</div>
          <h1 className="text-xl font-bold">Bayaran sedang disahkan / Confirming payment</h1>
          <p className="text-sm text-zinc-500">
            Jika anda telah membayar, {business || "perniagaan"} akan menerima pengesahan sebentar lagi. Jika tidak, anda boleh cuba semula melalui pautan yang sama.
            <br />If you paid, the business will get the confirmation shortly. If not, you can try again with the same link.
          </p>
        </>
      )}
    </div>
  );
}
