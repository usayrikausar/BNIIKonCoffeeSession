import type { CreateBillInput, CreatedBill, PaymentGateway, PaymentNotice } from "./gateway";
import { formToRecord } from "./gateway";

/**
 * ToyyibPay (https://toyyibpay.com/apireference) — FPX, MYR.
 * Its callback is NOT signed, so we never trust it: every callback/redirect is
 * confirmed server-to-server with getBillTransactions before anything is paid.
 */
interface ToyyibConfig {
  secretKey: string;
  categoryCode: string;
  sandbox: boolean;
}

/** ToyyibPay billName: max 30 chars, letters/digits/space/underscore only. */
export function toyyibBillName(s: string): string {
  return s.replace(/[^A-Za-z0-9 _]/g, " ").replace(/\s+/g, " ").trim().slice(0, 30) || "Layankan";
}

export interface ToyyibTransaction {
  billpaymentStatus?: string;
  billpaymentAmount?: string;
  billpaymentInvoiceNo?: string;
  billExternalReferenceNo?: string;
}

/** Pure: does the transaction list prove a successful payment? Returns the paid amount in sen. */
export function toyyibPaidAmount(txs: ToyyibTransaction[]): number | null {
  const ok = txs.find((t) => t.billpaymentStatus === "1");
  if (!ok) return null;
  const rm = Number(String(ok.billpaymentAmount ?? "").replace(/,/g, ""));
  return Number.isFinite(rm) ? Math.round(rm * 100) : null;
}

export function toyyibpayGateway(cfg: ToyyibConfig): PaymentGateway {
  // The customer pays on ToyyibPay's own site; only the API calls may be pointed elsewhere (tests).
  const site = cfg.sandbox ? "https://dev.toyyibpay.com" : "https://toyyibpay.com";
  const base = process.env.TOYYIBPAY_API_BASE_URL ?? site;

  async function confirm(billCode: string): Promise<number | null> {
    const res = await fetch(`${base}/index.php/api/getBillTransactions`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ billCode, billpaymentStatus: "1" }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => []);
    return toyyibPaidAmount(Array.isArray(data) ? (data as ToyyibTransaction[]) : []);
  }

  async function notice(kind: string, billCode: string | undefined, raw: Record<string, string>): Promise<PaymentNotice | null> {
    if (!billCode || !/^[A-Za-z0-9]{3,40}$/.test(billCode)) return null;
    const amount = await confirm(billCode);
    return {
      eventKey: `${kind}:${billCode}:${raw.refno ?? raw.transaction_id ?? ""}:${amount != null}`,
      billId: billCode,
      verified: true, // the paid/unpaid answer below comes from ToyyibPay's API, not the request
      paid: amount != null,
      paidAmountCents: amount,
      raw,
    };
  }

  return {
    id: "toyyibpay",
    async createBill(input: CreateBillInput): Promise<CreatedBill> {
      const res = await fetch(`${base}/index.php/api/createBill`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          userSecretKey: cfg.secretKey,
          categoryCode: cfg.categoryCode,
          billName: toyyibBillName(input.description),
          billDescription: `${input.description} (${input.invoiceNumber})`.slice(0, 100),
          billPriceSetting: "1",
          billPayorInfo: "1",
          billAmount: String(input.amountCents),
          billReturnUrl: input.returnUrl,
          billCallbackUrl: input.callbackUrl,
          billExternalReferenceNo: input.invoiceNumber,
          billTo: input.customerName.slice(0, 100),
          billEmail: input.customerEmail,
          billPhone: (input.customerPhone ?? "").replace(/[^\d]/g, ""),
          billPaymentChannel: "0",
        }),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json().catch(() => null)) as { BillCode?: string }[] | null;
      const code = Array.isArray(data) ? data[0]?.BillCode : undefined;
      if (!res.ok || !code) throw new Error(`ToyyibPay: could not create bill (${res.status})`);
      return { billId: code, paymentUrl: `${site}/${code}` };
    },
    async parseCallback(rawBody) {
      const f = formToRecord(rawBody);
      return notice("cb", f.billcode, f);
    },
    async parseReturn(params) {
      const f = Object.fromEntries(params);
      return notice("rt", f.billcode, f);
    },
  };
}
