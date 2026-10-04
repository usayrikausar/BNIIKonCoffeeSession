import { describe, expect, it } from "vitest";
import { addMonths, applyPayment, draftInvoice, evaluateEntitlement, formatRM, renewalDue, type Plan, type Subscription } from "@/lib/billing/logic";
import { billplzSign, billplzSignatureSource, verifyBillplzSignature, billplzGateway } from "@/lib/billing/billplz";
import { toyyibBillName, toyyibPaidAmount } from "@/lib/billing/toyyibpay";

const NOW = new Date("2026-10-04T00:00:00Z");
const DAY = 86_400_000;
const iso = (ms: number) => new Date(ms).toISOString();

const niaga: Plan = { id: "niaga", name: "Niaga", price_cents: 24900, setup_fee_cents: 0, ai_reply_limit: 2000, max_whatsapp_numbers: 1, max_members: 5, trial_days: 0 };
const founding: Plan = { ...niaga, id: "founding", name: "Founding Offer", price_cents: 30000, setup_fee_cents: 50000, ai_reply_limit: 3000 };
const trialPlan: Plan = { ...niaga, id: "trial", name: "Trial", price_cents: 0, ai_reply_limit: 150, trial_days: 14 };

function sub(over: Partial<Subscription> = {}): Subscription {
  return {
    tenant_id: "t",
    plan_id: "niaga",
    status: "active",
    billing_anchor: iso(NOW.getTime() - 10 * DAY),
    current_period_start: iso(NOW.getTime() - 10 * DAY),
    current_period_end: iso(NOW.getTime() + 20 * DAY),
    setup_fee_paid: false,
    ...over,
  };
}

describe("entitlement (when may the AI reply?)", () => {
  it("allows a paid, under-limit account", () => {
    const e = evaluateEntitlement(sub(), niaga, 100, NOW);
    expect(e).toMatchObject({ aiAllowed: true, reason: "ok", state: "active", limit: 2000, warn: false });
  });
  it("warns at 80% and allows a 5% soft overage before pausing", () => {
    expect(evaluateEntitlement(sub(), niaga, 1600, NOW).warn).toBe(true);
    expect(evaluateEntitlement(sub(), niaga, 2099, NOW).aiAllowed).toBe(true);
    expect(evaluateEntitlement(sub(), niaga, 2100, NOW)).toMatchObject({ aiAllowed: false, reason: "quota_exceeded" });
  });
  it("blocks when the trial has ended", () => {
    const s = sub({ plan_id: "trial", status: "trialing", current_period_end: iso(NOW.getTime() - 1000) });
    expect(evaluateEntitlement(s, trialPlan, 0, NOW)).toMatchObject({ aiAllowed: false, reason: "trial_ended" });
  });
  it("keeps the AI running during the 7-day grace period, then blocks", () => {
    const s = sub({ status: "past_due", current_period_end: iso(NOW.getTime() - 3 * DAY) });
    expect(evaluateEntitlement(s, niaga, 0, NOW)).toMatchObject({ aiAllowed: true, state: "grace" });
    const late = sub({ status: "past_due", current_period_end: iso(NOW.getTime() - 8 * DAY) });
    expect(evaluateEntitlement(late, niaga, 0, NOW)).toMatchObject({ aiAllowed: false, reason: "payment_overdue" });
  });
  it("canceled accounts keep service until the paid period ends", () => {
    expect(evaluateEntitlement(sub({ status: "canceled" }), niaga, 0, NOW).aiAllowed).toBe(true);
    expect(evaluateEntitlement(sub({ status: "canceled", current_period_end: iso(NOW.getTime() - DAY) }), niaga, 0, NOW).reason).toBe("canceled");
  });
  it("fails OPEN if billing data is missing (never silence customers because of a billing bug)", () => {
    expect(evaluateEntitlement(null, null, 0, NOW)).toMatchObject({ aiAllowed: true, reason: "no_subscription" });
  });
});

describe("periods & invoices", () => {
  it("adds months with month-end clamping", () => {
    expect(addMonths(new Date("2026-01-31T05:00:00Z"), 1).toISOString()).toBe("2026-02-28T05:00:00.000Z");
    expect(addMonths(new Date("2028-01-31T00:00:00Z"), 1).toISOString()).toBe("2028-02-29T00:00:00.000Z");
    expect(addMonths(new Date("2026-12-15T00:00:00Z"), 1).toISOString()).toBe("2027-01-15T00:00:00.000Z");
  });
  it("first paid invoice (from trial) starts now and includes the setup fee once", () => {
    const d = draftInvoice(sub({ plan_id: "trial", status: "trialing" }), founding, NOW);
    expect(d.kind).toBe("new");
    expect(d.periodStart).toBe(NOW.toISOString());
    expect(d.amountCents).toBe(80000);
    expect(d.includesSetupFee).toBe(true);
    expect(d.lines).toHaveLength(2);
    expect(draftInvoice(sub({ plan_id: "founding", setup_fee_paid: true }), founding, NOW).amountCents).toBe(30000);
  });
  it("renewal starts when the current paid period ends", () => {
    const s = sub();
    const d = draftInvoice(s, niaga, NOW);
    expect(d.kind).toBe("renewal");
    expect(d.periodStart).toBe(s.current_period_end);
  });
  it("switching plan starts a fresh month now (no proration)", () => {
    const d = draftInvoice(sub(), founding, NOW);
    expect(d.kind).toBe("new");
    expect(d.periodStart).toBe(NOW.toISOString());
  });
  it("applying a NEW payment re-anchors usage; a RENEWAL extends paid-through and keeps the anchor", () => {
    const fresh = applyPayment(sub({ plan_id: "trial", status: "trialing" }), { plan_id: "niaga", period_start: NOW.toISOString(), period_end: addMonths(NOW, 1).toISOString(), includes_setup_fee: false }, NOW);
    expect(fresh).toMatchObject({ plan_id: "niaga", status: "active", billing_anchor: NOW.toISOString() });

    const s = sub();
    const ren = applyPayment(s, { plan_id: "niaga", period_start: s.current_period_end, period_end: addMonths(new Date(s.current_period_end), 1).toISOString(), includes_setup_fee: false }, NOW);
    expect(ren.billing_anchor).toBeUndefined();
    expect(ren.current_period_end).toBe(addMonths(new Date(s.current_period_end), 1).toISOString());
    expect(applyPayment(sub(), { plan_id: "founding", period_start: NOW.toISOString(), period_end: addMonths(NOW, 1).toISOString(), includes_setup_fee: true }, NOW).setup_fee_paid).toBe(true);
  });
  it("issues renewal invoices 7 days ahead, once, never for internal/canceling accounts", () => {
    expect(renewalDue(sub({ current_period_end: iso(NOW.getTime() + 6 * DAY) }), false, NOW)).toBe(true);
    expect(renewalDue(sub({ current_period_end: iso(NOW.getTime() + 8 * DAY) }), false, NOW)).toBe(false);
    expect(renewalDue(sub({ current_period_end: iso(NOW.getTime() + 1 * DAY) }), true, NOW)).toBe(false);
    expect(renewalDue(sub({ current_period_end: iso(NOW.getTime() + DAY), cancel_at_period_end: true }), false, NOW)).toBe(false);
    expect(renewalDue(sub({ plan_id: "internal", current_period_end: iso(NOW.getTime() + DAY) }), false, NOW)).toBe(false);
    expect(renewalDue(sub({ status: "trialing", current_period_end: iso(NOW.getTime() + DAY) }), false, NOW)).toBe(false);
  });
  it("formats ringgit", () => {
    expect(formatRM(30000)).toBe("RM300");
    expect(formatRM(24950)).toBe("RM249.50");
  });
});

describe("Billplz X-Signature", () => {
  const key = "S-test-x-signature-key";
  const cb = { id: "W_79pJDk", collection_id: "inbmmepb", paid: "true", state: "paid", amount: "24900", paid_amount: "24900", due_at: "2026-10-4", email: "a@b.my", mobile: "", name: "KLINIK ANA", url: "https://www.billplz.com/bills/W_79pJDk", paid_at: "2026-10-04 10:00:00 +0800" };

  it("builds the source string sorted case-insensitively and joined with |", () => {
    expect(billplzSignatureSource({ b: "2", A: "1", x_signature: "zz" })).toBe("A1|b2");
    expect(billplzSignatureSource({ "billplz[paid]": "true", "billplz[id]": "abc" })).toBe("billplzidabc|billplzpaidtrue");
  });
  it("accepts a valid callback and rejects tampering / wrong key", () => {
    const signed = { ...cb, x_signature: billplzSign(cb, key) };
    expect(verifyBillplzSignature(signed, key)).toBe(true);
    expect(verifyBillplzSignature({ ...signed, paid_amount: "1" }, key)).toBe(false);
    expect(verifyBillplzSignature(signed, "other")).toBe(false);
    expect(verifyBillplzSignature(cb, key)).toBe(false);
  });
  it("parses callbacks and redirects into verified notices", async () => {
    const gw = billplzGateway({ apiKey: "k", collectionId: "c", xSignatureKey: key, sandbox: true });
    const body = new URLSearchParams({ ...cb, x_signature: billplzSign(cb, key) }).toString();
    const n = await gw.parseCallback(body, "application/x-www-form-urlencoded");
    expect(n).toMatchObject({ billId: "W_79pJDk", verified: true, paid: true, paidAmountCents: 24900 });

    const ret = { "billplz[id]": "W_79pJDk", "billplz[paid]": "true", "billplz[paid_at]": "2026-10-04 10:00:00 +0800" };
    const params = new URLSearchParams({ ...ret, "billplz[x_signature]": billplzSign(ret, key) });
    expect(await gw.parseReturn(params)).toMatchObject({ billId: "W_79pJDk", verified: true, paid: true });
    params.set("billplz[paid]", "false");
    expect((await gw.parseReturn(params))?.verified).toBe(false);
  });
});

describe("ToyyibPay", () => {
  it("only counts a successful transaction as paid (amount in sen)", () => {
    expect(toyyibPaidAmount([{ billpaymentStatus: "3" }, { billpaymentStatus: "1", billpaymentAmount: "249.00" }])).toBe(24900);
    expect(toyyibPaidAmount([{ billpaymentStatus: "2", billpaymentAmount: "249.00" }])).toBeNull();
    expect(toyyibPaidAmount([])).toBeNull();
  });
  it("sanitises bill names to ToyyibPay's rules", () => {
    expect(toyyibBillName("Layankan Founding Offer + setup!!")).toBe("Layankan Founding Offer setup");
    expect(toyyibBillName("@@@")).toBe("Layankan");
  });
});
