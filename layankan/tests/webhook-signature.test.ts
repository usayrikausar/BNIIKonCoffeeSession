import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import { verifyBearer, verifyMetaSignature, verifyMetaSubscription, verifyTimestampedHmac } from "@/lib/channels/signature";

const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "1" }] });
const secret = "app-secret-123";
const sig = (b: string, s = secret) => "sha256=" + createHmac("sha256", s).update(b).digest("hex");

describe("Meta X-Hub-Signature-256", () => {
  it("accepts a valid signature", () => expect(verifyMetaSignature(body, sig(body), secret)).toBe(true));
  it("rejects a tampered body", () => expect(verifyMetaSignature(body + " ", sig(body), secret)).toBe(false));
  it("rejects the wrong secret", () => expect(verifyMetaSignature(body, sig(body, "other"), secret)).toBe(false));
  it("rejects missing / malformed headers", () => {
    expect(verifyMetaSignature(body, null, secret)).toBe(false);
    expect(verifyMetaSignature(body, "sha1=abc", secret)).toBe(false);
    expect(verifyMetaSignature(body, "sha256=zz", secret)).toBe(false);
    expect(verifyMetaSignature(body, sig(body), "")).toBe(false);
  });
});

describe("Meta subscription handshake", () => {
  it("returns the challenge only for the right token", () => {
    const ok = new URLSearchParams({ "hub.mode": "subscribe", "hub.verify_token": "tok", "hub.challenge": "42" });
    expect(verifyMetaSubscription(ok, "tok")).toBe("42");
    expect(verifyMetaSubscription(new URLSearchParams({ ...Object.fromEntries(ok), "hub.verify_token": "nope" }), "tok")).toBeNull();
    expect(verifyMetaSubscription(ok, "")).toBeNull();
  });
});

describe("timestamped HMAC (Murpati-style)", () => {
  const now = 1_760_000_000_000;
  const ts = String(Math.floor(now / 1000));
  const s = createHmac("sha256", "whsec").update(`${ts}.${body}`).digest("hex");
  it("accepts fresh, valid signatures", () => expect(verifyTimestampedHmac(body, s, ts, "whsec", { now })).toBe(true));
  it("rejects replays outside the tolerance window", () => expect(verifyTimestampedHmac(body, s, ts, "whsec", { now: now + 10 * 60_000 })).toBe(false));
  it("rejects altered bodies", () => expect(verifyTimestampedHmac(body + "x", s, ts, "whsec", { now })).toBe(false));
});

describe("cron bearer", () => {
  it("accepts only the exact secret", () => {
    expect(verifyBearer("Bearer s3cret", "s3cret")).toBe(true);
    expect(verifyBearer("Bearer s3cre", "s3cret")).toBe(false);
    expect(verifyBearer(null, "s3cret")).toBe(false);
    expect(verifyBearer("Bearer ", "")).toBe(false);
  });
});
