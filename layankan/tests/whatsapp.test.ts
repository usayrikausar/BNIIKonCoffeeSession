import { describe, expect, it } from "vitest";
import { createHmac } from "node:crypto";
import {
  countTemplateVariables,
  isOptOut,
  isWithinServiceWindow,
  normalizeWaId,
  renderTokens,
  sanitizeTemplateVariable,
  shouldApplyStatus,
  waMeLink,
} from "@/lib/channels/whatsapp/policy";
import { parseMetaWebhook } from "@/lib/channels/whatsapp/meta-parse";
import { buildMetaSendBody } from "@/lib/channels/whatsapp/meta";
import { parseMurpatiWebhook } from "@/lib/channels/whatsapp/murpati-parse";
import { buildMurpatiSendBody } from "@/lib/channels/whatsapp/murpati";
import { verifyMurpatiSignature } from "@/lib/channels/signature";

const NOW = new Date("2026-10-04T10:00:00Z");

describe("24h customer service window", () => {
  it("is open within 24h of the customer's last message", () => {
    expect(isWithinServiceWindow("2026-10-03T10:00:01Z", NOW)).toBe(true);
    expect(isWithinServiceWindow(new Date("2026-10-04T09:59:00Z"), NOW)).toBe(true);
  });
  it("is closed after 24h, or if the customer never wrote", () => {
    expect(isWithinServiceWindow("2026-10-03T10:00:00Z", NOW)).toBe(false);
    expect(isWithinServiceWindow(null, NOW)).toBe(false);
    expect(isWithinServiceWindow("garbage", NOW)).toBe(false);
  });
});

describe("WhatsApp helpers", () => {
  it("normalises Malaysian numbers to wa_id", () => {
    expect(normalizeWaId("012-345 6789")).toBe("60123456789");
    expect(normalizeWaId("+60 12-345 6789")).toBe("60123456789");
    expect(normalizeWaId("123")).toBeNull();
    expect(waMeLink("+60123456789", "Hai")).toBe("https://wa.me/60123456789?text=Hai");
  });
  it("detects opt-out keywords only as the whole message", () => {
    for (const m of ["STOP", "stop.", "Berhenti", "jangan hantar lagi", "tak nak terima mesej"]) expect(isOptOut(m), m).toBe(true);
    for (const m of ["don't stop", "bila kedai berhenti operasi?", "stop by tomorrow?"]) expect(isOptOut(m), m).toBe(false);
  });
  it("counts template variables and renders tokens", () => {
    expect(countTemplateVariables("Hai {{1}}, pakej {{2}} masih ada. {{1}}")).toBe(2);
    expect(countTemplateVariables("No vars")).toBe(0);
    expect(renderTokens("Hai {name}, masih berminat dengan {need}?", { name: "Ali", need: "rumah" })).toBe("Hai Ali, masih berminat dengan rumah?");
    expect(renderTokens("Hai {name}, apa khabar?", { name: null })).toBe("Hai, apa khabar?");
  });
  it("sanitises template variables (no newlines, never empty)", () => {
    expect(sanitizeTemplateVariable("a\nb\tc")).toBe("a b c");
    expect(sanitizeTemplateVariable("   ")).toBe("-");
  });
  it("never moves delivery status backwards", () => {
    expect(shouldApplyStatus("sent", "delivered")).toBe(true);
    expect(shouldApplyStatus("read", "delivered")).toBe(false);
    expect(shouldApplyStatus("delivered", "failed")).toBe(true);
    expect(shouldApplyStatus("failed", "read")).toBe(false);
  });
});

describe("Meta Cloud API webhook parsing", () => {
  const payload = {
    object: "whatsapp_business_account",
    entry: [{
      id: "WABA1",
      changes: [{
        field: "messages",
        value: {
          messaging_product: "whatsapp",
          metadata: { display_phone_number: "60311112222", phone_number_id: "PN1" },
          contacts: [{ profile: { name: "Siti" }, wa_id: "60123456789" }],
          messages: [
            { from: "60123456789", id: "wamid.A", timestamp: "1759572000", type: "text", text: { body: "Hi, harga?" } },
            { from: "60123456789", id: "wamid.B", timestamp: "1759572001", type: "image", image: { caption: "macam ni" } },
            { from: "60123456789", id: "wamid.C", timestamp: "1759572002", type: "reaction", reaction: { emoji: "👍" } },
          ],
          statuses: [
            { id: "wamid.OUT", status: "delivered", timestamp: "1759572003", recipient_id: "60123456789" },
            { id: "wamid.OUT2", status: "failed", timestamp: "1759572004", errors: [{ code: 131047, title: "Re-engagement message" }] },
          ],
        },
      }],
    }],
  };
  it("extracts messages, names, routing key and statuses", () => {
    const evs = parseMetaWebhook(payload);
    expect(evs).toHaveLength(4); // reaction dropped
    expect(evs[0]).toMatchObject({ kind: "message", contactExternalId: "60123456789", contactName: "Siti", body: "Hi, harga?", providerMessageId: "wamid.A", routingKey: "PN1" });
    expect(evs[1]).toMatchObject({ kind: "message", body: "[Gambar] macam ni" });
    expect(evs[2]).toMatchObject({ kind: "status", providerMessageId: "wamid.OUT", status: "delivered" });
    expect(evs[3]).toMatchObject({ kind: "status", status: "failed", error: "131047 Re-engagement message" });
  });
  it("ignores other objects and fields", () => {
    expect(parseMetaWebhook({ object: "page", entry: [] })).toEqual([]);
    expect(parseMetaWebhook({ object: "whatsapp_business_account", entry: [{ changes: [{ field: "account_update", value: {} }] }] })).toEqual([]);
    expect(parseMetaWebhook(null)).toEqual([]);
  });
});

describe("Meta send payloads", () => {
  it("text message", () => {
    expect(buildMetaSendBody({ to: "601", body: "Hai" })).toEqual({
      messaging_product: "whatsapp", recipient_type: "individual", to: "601", type: "text", text: { body: "Hai", preview_url: false },
    });
  });
  it("template message with sanitised body parameters", () => {
    const b = buildMetaSendBody({ to: "601", body: "", template: { name: "follow_up", language: "ms", variables: ["Ali\nBin", ""] } });
    expect(b).toMatchObject({
      type: "template",
      template: { name: "follow_up", language: { code: "ms" }, components: [{ type: "body", parameters: [{ type: "text", text: "Ali Bin" }, { type: "text", text: "-" }] }] },
    });
  });
});

describe("Murpati (official API devices only)", () => {
  it("parses message.received", () => {
    const { events } = parseMurpatiWebhook({ event: "message.received", data: { id: "m1", from: "+60123456789", name: "Ali", type: "text", body: "Nak tanya pakej", timestamp: 1759572000 } });
    expect(events[0]).toMatchObject({ kind: "message", contactExternalId: "60123456789", contactName: "Ali", body: "Nak tanya pakej", providerMessageId: "m1" });
  });
  it("turns message.sent into an echo (status if known, stored if sent from Murpati's dashboard)", () => {
    const { events } = parseMurpatiWebhook({ event: "message.sent", data: { id: "m2", to: "60123456789", text: { body: "Ok boleh" } } });
    expect(events[0]).toMatchObject({ kind: "outbound_echo", providerMessageId: "m2", body: "Ok boleh", contactExternalId: "60123456789" });
  });
  it("REFUSES events from unofficial (QR-linked) devices", () => {
    for (const data of [{ is_official: false }, { device_type: "regular" }, { connection_type: "qr" }]) {
      const r = parseMurpatiWebhook({ event: "message.received", data: { id: "x", from: "601", body: "hi", ...data } });
      expect(r.rejectedUnofficial).toBe(true);
      expect(r.events).toEqual([]);
    }
  });
  it("send payloads", () => {
    expect(buildMurpatiSendBody("dev1", { to: "601", body: "Hai" })).toEqual({ device_id: "dev1", to: "601", type: "text", text: "Hai" });
    expect(buildMurpatiSendBody("dev1", { to: "601", body: "", template: { name: "fu", language: "ms", variables: [""] } })).toMatchObject({ type: "template", template: { name: "fu", variables: ["-"] } });
  });

  const body = JSON.stringify({ event: "message.received", data: { id: "m1" } });
  const secret = "whsec_" + Buffer.from("0123456789abcdef0123456789abcdef").toString("base64");
  const now = 1_759_572_000_000;
  const ts = String(now / 1000);
  const hmac = (key: string | Buffer, payload: string) => createHmac("sha256", key).update(payload).digest("hex");

  it("verifies the supported signature layouts", () => {
    expect(verifyMurpatiSignature(body, `t=${ts},v1=${hmac(secret, `${ts}.${body}`)}`, null, secret, { now })).toBe(true);
    expect(verifyMurpatiSignature(body, `sha256=${hmac(secret, body)}`, null, secret, { now })).toBe(true);
    expect(verifyMurpatiSignature(body, hmac(secret, `${ts}.${body}`), ts, secret, { now })).toBe(true);
    const raw = Buffer.from(secret.slice(6), "base64");
    expect(verifyMurpatiSignature(body, hmac(raw, body), null, secret, { now })).toBe(true); // Svix-style key
  });
  it("rejects wrong secret, tampering and replays", () => {
    expect(verifyMurpatiSignature(body, `sha256=${hmac("whsec_other", body)}`, null, secret, { now })).toBe(false);
    expect(verifyMurpatiSignature(body + " ", `sha256=${hmac(secret, body)}`, null, secret, { now })).toBe(false);
    expect(verifyMurpatiSignature(body, `t=${ts},v1=${hmac(secret, `${ts}.${body}`)}`, null, secret, { now: now + 3_600_000 })).toBe(false);
    expect(verifyMurpatiSignature(body, null, null, secret, { now })).toBe(false);
    expect(verifyMurpatiSignature(body, "abc", null, "", { now })).toBe(false);
  });
});
