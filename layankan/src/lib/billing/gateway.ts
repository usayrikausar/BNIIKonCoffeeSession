// Payment gateway contract. Malaysian gateways (Billplz, ToyyibPay) are
// one-off FPX/card bills, so Layankan runs the subscription itself: it issues
// a monthly invoice + bill and activates the period when the bill is paid.
// A Stripe adapter can implement the same interface later.

export type GatewayId = "billplz" | "toyyibpay" | "stripe" | "manual";

export interface CreateBillInput {
  invoiceId: string;
  invoiceNumber: string;
  amountCents: number;
  description: string;
  customerName: string;
  /** Billplz needs an email OR a mobile number; payment links often only have the WhatsApp number. */
  customerEmail: string;
  customerPhone?: string | null;
  /** Label for the reference shown on the bill (default "Invois"). */
  referenceLabel?: string;
  callbackUrl: string;
  returnUrl: string;
}

export interface CreatedBill {
  billId: string | null;
  paymentUrl: string | null;
}

/** Normalised result of a callback/redirect. `verified` means we proved it came from the gateway. */
export interface PaymentNotice {
  eventKey: string;
  billId: string;
  verified: boolean;
  paid: boolean;
  paidAmountCents: number | null;
  raw: Record<string, string>;
}

export interface PaymentGateway {
  id: GatewayId;
  createBill(input: CreateBillInput): Promise<CreatedBill>;
  /** Server-to-server callback (authoritative). */
  parseCallback(rawBody: string, contentType: string | null): Promise<PaymentNotice | null>;
  /** Browser redirect back to us after payment (also verified; used for instant feedback). */
  parseReturn(params: URLSearchParams): Promise<PaymentNotice | null>;
}

export function formToRecord(raw: string): Record<string, string> {
  return Object.fromEntries(new URLSearchParams(raw));
}
