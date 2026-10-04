import "server-only";
import type { GatewayId, PaymentGateway } from "./gateway";
import { billplzGateway } from "./billplz";
import { toyyibpayGateway } from "./toyyibpay";

/** The gateway new invoices use (BILLING_GATEWAY). Existing invoices keep the gateway they were issued with. */
export function activeGatewayId(): GatewayId {
  const g = process.env.BILLING_GATEWAY;
  return g === "billplz" || g === "toyyibpay" ? g : "manual";
}

export function getGateway(id: GatewayId): PaymentGateway | null {
  if (id === "billplz") {
    const { BILLPLZ_API_KEY: apiKey, BILLPLZ_COLLECTION_ID: collectionId, BILLPLZ_X_SIGNATURE_KEY: xSignatureKey } = process.env;
    if (!apiKey || !collectionId || !xSignatureKey) throw new Error("Billplz is not configured (BILLPLZ_* env vars)");
    return billplzGateway({ apiKey, collectionId, xSignatureKey, sandbox: process.env.BILLPLZ_SANDBOX === "true" });
  }
  if (id === "toyyibpay") {
    const { TOYYIBPAY_SECRET_KEY: secretKey, TOYYIBPAY_CATEGORY_CODE: categoryCode } = process.env;
    if (!secretKey || !categoryCode) throw new Error("ToyyibPay is not configured (TOYYIBPAY_* env vars)");
    return toyyibpayGateway({ secretKey, categoryCode, sandbox: process.env.TOYYIBPAY_SANDBOX === "true" });
  }
  // "manual" = bank transfer, marked paid by a platform admin. "stripe" = future adapter.
  return null;
}
