import { describe, expect, it } from "vitest";
import { decidePayment, formatRm, linkMessage, paidMessage, validateLinkInput } from "@/lib/payments/links";
import { billplzGateway, billplzSign } from "@/lib/billing/billplz";
import { paymentCredentialAad, credentialAad } from "@/lib/crypto/secrets";

describe("payment link input (always typed by a person)", () => {
  it.each([["80", 8000], ["80.50", 8050], ["RM 1,250", 125000], ["1", 100], [80, 8000], ["100000", 10_000_000]])("accepts %s", (input, cents) => {
    expect(validateLinkInput(input, "Cuci gigi")).toEqual({ amountCents: cents, description: "Cuci gigi" });
  });
  it.each(["0", "0.99", "100000.01", "-5", "abc", "80.555", "", "1e3", null])("rejects amount %s", (input) => {
    expect(validateLinkInput(input, "x")).toHaveProperty("error");
  });
  it("needs a short description", () => {
    expect(validateLinkInput("80", "")).toHaveProperty("error");
    expect(validateLinkInput("80", "x".repeat(201))).toHaveProperty("error");
    expect(validateLinkInput("80", "  Cuci   gigi ")).toEqual({ amountCents: 8000, description: "Cuci gigi" });
  });
});

describe("only a verified, full payment marks a link paid", () => {
  const open = { status: "open", amount_cents: 8000 };
  const ok = { verified: true, paid: true, paidAmountCents: 8000 };
  it("paid", () => expect(decidePayment(open, ok)).toBe("paid"));
  it("overpaid still counts as paid", () => expect(decidePayment(open, { ...ok, paidAmountCents: 9000 })).toBe("paid"));
  it("forged / unsigned notice", () => expect(decidePayment(open, { ...ok, verified: false })).toBe("unverified"));
  it("underpaid", () => expect(decidePayment(open, { ...ok, paidAmountCents: 7999 })).toBe("underpaid"));
  it("amount unknown (e.g. a browser redirect)", () => expect(decidePayment(open, { ...ok, paidAmountCents: null })).toBe("underpaid"));
  it("gateway says not paid", () => expect(decidePayment(open, { ...ok, paid: false })).toBe("not_paid"));
  it("already paid (replay)", () => expect(decidePayment({ ...open, status: "paid" }, ok)).toBe("already_paid"));
  it("expired link paid late: still accepted (the money arrived)", () => expect(decidePayment({ ...open, status: "expired" }, ok)).toBe("paid"));
  it("cancelled link", () => expect(decidePayment({ ...open, status: "cancelled" }, ok)).toBe("cancelled"));
  it("unknown bill", () => expect(decidePayment(null, ok)).toBe("unknown_link"));
});

describe("messages", () => {
  it("link message shows what, how much, the link and the expiry", () => {
    const m = linkMessage({ description: "Cuci gigi", amountCents: 8050, url: "https://www.billplz.com/bills/abc", expiresAt: new Date("2026-10-11T03:00:00Z") }, "ms");
    expect(m).toContain("Cuci gigi");
    expect(m).toContain("RM80.50");
    expect(m).toContain("https://www.billplz.com/bills/abc");
    expect(m).toMatch(/Sah sehingga 11 Okt/);
    expect(paidMessage({ description: "Cuci gigi", paidCents: 8050 }, "en")).toContain("RM80.50");
    expect(formatRm(10_000_000)).toBe("RM100,000.00");
  });
});

describe("gateway reuse for the business's own account", () => {
  it("Billplz accepts a mobile number instead of an email (payment links often only have the WhatsApp number)", async () => {
    let sent: URLSearchParams | null = null;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: { body: URLSearchParams }) => {
      sent = init.body;
      return new Response(JSON.stringify({ id: "b1", url: "https://www.billplz-sandbox.com/bills/b1" }), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const gw = billplzGateway({ apiKey: "k", collectionId: "c", xSignatureKey: "x", sandbox: true });
      await gw.createBill({ invoiceId: "i", invoiceNumber: "ABC", referenceLabel: "Rujukan", amountCents: 8000, description: "Cuci gigi", customerName: "Ali", customerEmail: "", customerPhone: "60123456789", callbackUrl: "https://x/cb", returnUrl: "https://x/rt" });
      expect(sent!.get("mobile")).toBe("60123456789");
      expect(sent!.has("email")).toBe(false);
      expect(sent!.get("reference_1_label")).toBe("Rujukan");
      await expect(gw.createBill({ invoiceId: "i", invoiceNumber: "ABC", amountCents: 8000, description: "x", customerName: "Ali", customerEmail: "", customerPhone: null, callbackUrl: "https://x", returnUrl: "https://x" })).rejects.toThrow(/email or mobile/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it("a callback signed with ANOTHER business's X-Signature key is not verified", async () => {
    const fields = { id: "b1", paid: "true", paid_amount: "8000", amount: "8000" };
    const signedByOther = new URLSearchParams({ ...fields, x_signature: billplzSign(fields, "other-business-key") }).toString();
    const mine = billplzGateway({ apiKey: "k", collectionId: "c", xSignatureKey: "my-key", sandbox: true });
    expect((await mine.parseCallback(signedByOther, null))?.verified).toBe(false);
    const signedByMe = new URLSearchParams({ ...fields, x_signature: billplzSign(fields, "my-key") }).toString();
    expect((await mine.parseCallback(signedByMe, null))?.verified).toBe(true);
  });
  it("payment keys are bound to their own business + account (different AAD from WhatsApp tokens)", () => {
    expect(paymentCredentialAad("t1", "a1", "api_key")).not.toBe(credentialAad("t1", "a1", "api_key"));
    expect(paymentCredentialAad("t1", "a1", "api_key")).not.toBe(paymentCredentialAad("t2", "a1", "api_key"));
  });
});
