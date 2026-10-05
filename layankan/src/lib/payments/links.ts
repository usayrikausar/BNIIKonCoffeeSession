// Payment links (R2). Pure rules — no I/O, unit tested.
import type { PaymentNotice } from "@/lib/billing/gateway";

export const MIN_LINK_CENTS = 100; // RM1
export const MAX_LINK_CENTS = 10_000_000; // RM100,000
export const LINK_VALID_DAYS = 7;

export type Lang = "ms" | "en";

/** Parse what a staff member typed. The AI never calls this: amounts always come from a person. */
export function validateLinkInput(amountRm: unknown, description: unknown): { amountCents: number; description: string } | { error: string } {
  const raw = typeof amountRm === "number" ? String(amountRm) : typeof amountRm === "string" ? amountRm.trim().replace(/^RM\s*/i, "").replace(/,/g, "") : "";
  if (!/^\d{1,6}(\.\d{1,2})?$/.test(raw)) return { error: "Jumlah tidak sah (cth. 80 atau 80.50) / Invalid amount (e.g. 80 or 80.50)" };
  const amountCents = Math.round(Number(raw) * 100);
  if (amountCents < MIN_LINK_CENTS || amountCents > MAX_LINK_CENTS) return { error: "Jumlah mesti antara RM1 dan RM100,000 / Amount must be between RM1 and RM100,000" };
  const d = typeof description === "string" ? description.replace(/\s+/g, " ").trim() : "";
  if (!d || d.length > 200) return { error: "Keterangan diperlukan (maks. 200 aksara) / Description required (max 200 characters)" };
  return { amountCents, description: d };
}

export function formatRm(cents: number): string {
  return `RM${(cents / 100).toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** The chat message carrying the link. */
export function linkMessage(l: { description: string; amountCents: number; url: string; expiresAt: Date }, lang: Lang, timeZone = "Asia/Kuala_Lumpur"): string {
  const until = l.expiresAt.toLocaleDateString(lang === "ms" ? "ms-MY" : "en-MY", { day: "numeric", month: "short", timeZone });
  return lang === "ms"
    ? `💳 Pautan bayaran: ${l.description} — ${formatRm(l.amountCents)}\n${l.url}\nFPX / kad. Sah sehingga ${until}.`
    : `💳 Payment link: ${l.description} — ${formatRm(l.amountCents)}\n${l.url}\nFPX / card. Valid until ${until}.`;
}

export function paidMessage(l: { description: string; paidCents: number }, lang: Lang): string {
  return lang === "ms"
    ? `✅ Bayaran ${formatRm(l.paidCents)} untuk "${l.description}" telah diterima. Terima kasih! 🙏`
    : `✅ Payment of ${formatRm(l.paidCents)} for "${l.description}" received. Thank you! 🙏`;
}

export type PaymentDecision = "paid" | "already_paid" | "unverified" | "not_paid" | "underpaid" | "unknown_link" | "cancelled";

/**
 * What a gateway notice means for a link. Only a VERIFIED notice that says
 * paid, for at least the full amount, marks a link paid. A link that expired
 * can still be paid (the customer's money arrived); a cancelled one cannot.
 */
export function decidePayment(
  link: { status: string; amount_cents: number } | null,
  n: Pick<PaymentNotice, "verified" | "paid" | "paidAmountCents">,
): PaymentDecision {
  if (!link) return "unknown_link";
  if (!n.verified) return "unverified";
  if (link.status === "paid") return "already_paid";
  if (link.status === "cancelled") return "cancelled";
  if (!n.paid) return "not_paid";
  if (n.paidAmountCents == null || n.paidAmountCents < link.amount_cents) return "underpaid";
  return "paid";
}
