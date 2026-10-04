import { createHmac, timingSafeEqual } from "node:crypto";
import type { CreateBillInput, CreatedBill, PaymentGateway, PaymentNotice } from "./gateway";
import { formToRecord } from "./gateway";

/**
 * Billplz (https://www.billplz.com/api) — FPX / cards, MYR.
 * X Signature: every key+value (minus x_signature) as "keyvalue", sorted
 * ascending case-insensitively, joined with "|", HMAC-SHA256 with the
 * X Signature Key. Redirect params are flattened: billplz[id] → "billplzid".
 */
export function billplzSignatureSource(fields: Record<string, string>): string {
  return Object.entries(fields)
    .filter(([k]) => k !== "x_signature" && k !== "billplz[x_signature]")
    .map(([k, v]) => `${k.replace(/[[\]]/g, "")}${v}`)
    .sort((a, b) => {
      const x = a.toLowerCase();
      const y = b.toLowerCase();
      return x < y ? -1 : x > y ? 1 : 0;
    })
    .join("|");
}

export function billplzSign(fields: Record<string, string>, key: string): string {
  return createHmac("sha256", key).update(billplzSignatureSource(fields), "utf8").digest("hex");
}

export function verifyBillplzSignature(fields: Record<string, string>, key: string): boolean {
  const given = fields.x_signature ?? fields["billplz[x_signature]"];
  if (!key || !given || !/^[0-9a-f]{64}$/i.test(given)) return false;
  return timingSafeEqual(Buffer.from(given.toLowerCase(), "hex"), Buffer.from(billplzSign(fields, key), "hex"));
}

interface BillplzConfig {
  apiKey: string;
  collectionId: string;
  xSignatureKey: string;
  sandbox: boolean;
}

export function billplzGateway(cfg: BillplzConfig): PaymentGateway {
  const base = cfg.sandbox ? "https://www.billplz-sandbox.com" : "https://www.billplz.com";
  return {
    id: "billplz",
    async createBill(input: CreateBillInput): Promise<CreatedBill> {
      const form = new URLSearchParams({
        collection_id: cfg.collectionId,
        email: input.customerEmail,
        name: input.customerName.slice(0, 255),
        amount: String(input.amountCents),
        callback_url: input.callbackUrl,
        redirect_url: input.returnUrl,
        description: input.description.slice(0, 200),
        reference_1_label: "Invois",
        reference_1: input.invoiceNumber,
      });
      if (input.customerPhone) form.set("mobile", input.customerPhone);
      const res = await fetch(`${process.env.BILLPLZ_API_BASE_URL ?? base}/api/v3/bills`, {
        method: "POST",
        headers: { Authorization: `Basic ${Buffer.from(`${cfg.apiKey}:`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
        body: form,
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json().catch(() => ({}))) as { id?: string; url?: string; error?: { message?: string | string[] } };
      if (!res.ok || !data.id || !data.url) {
        const msg = data.error?.message;
        throw new Error(`Billplz: ${Array.isArray(msg) ? msg.join(", ") : (msg ?? res.status)}`);
      }
      return { billId: data.id, paymentUrl: data.url };
    },
    async parseCallback(rawBody): Promise<PaymentNotice | null> {
      const f = formToRecord(rawBody);
      if (!f.id) return null;
      return {
        // Distinct per delivery content (forged/underpaid/genuine never collide in the audit log).
        eventKey: `cb:${f.id}:${f.paid}:${f.paid_amount ?? f.amount ?? ""}:${(f.x_signature ?? "").slice(0, 16)}`,
        billId: f.id,
        verified: verifyBillplzSignature(f, cfg.xSignatureKey),
        paid: f.paid === "true",
        paidAmountCents: f.paid_amount ? Number(f.paid_amount) : f.amount ? Number(f.amount) : null,
        raw: f,
      };
    },
    async parseReturn(params): Promise<PaymentNotice | null> {
      const f = Object.fromEntries(params);
      const id = f["billplz[id]"];
      if (!id) return null;
      return {
        eventKey: `rt:${id}:${f["billplz[paid]"]}:${(f["billplz[x_signature]"] ?? "").slice(0, 16)}`,
        billId: id,
        verified: verifyBillplzSignature(f, cfg.xSignatureKey),
        paid: f["billplz[paid]"] === "true",
        paidAmountCents: null, // redirect carries no amount; callback is authoritative for amount
        raw: f,
      };
    },
  };
}
