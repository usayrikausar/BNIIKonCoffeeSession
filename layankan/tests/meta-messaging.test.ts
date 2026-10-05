import { describe, expect, it } from "vitest";
import { buildMessagingSendBody, parseMessagingWebhook } from "@/lib/channels/meta-messaging/parse";
import { messagingWindow, channelIcon } from "@/lib/channels/labels";

const at = 1_759_572_000_000;
const page = (messaging: unknown[]) => ({ object: "page", entry: [{ id: "PAGE1", time: at, messaging }] });

describe("Messenger webhook (object: page)", () => {
  it("customer text → message, routed by Page id", () => {
    const r = parseMessagingWebhook(page([{ sender: { id: "PSID1" }, recipient: { id: "PAGE1" }, timestamp: at, message: { mid: "m.1", text: "Hi, harga?" } }]));
    expect(r.object).toBe("page");
    expect(r.events).toEqual([{ kind: "message", contactExternalId: "PSID1", contactName: null, body: "Hi, harga?", providerMessageId: "m.1", receivedAt: new Date(at), routingKey: "PAGE1" }]);
  });
  it("attachments become readable placeholders", () => {
    const r = parseMessagingWebhook(page([{ sender: { id: "P" }, recipient: { id: "PAGE1" }, timestamp: at, message: { mid: "m.2", text: "macam ni", attachments: [{ type: "image" }] } }]));
    expect(r.events[0]).toMatchObject({ body: "[Gambar] macam ni" });
  });
  it("messages sent by the business (echo) are kept as outbound history", () => {
    const r = parseMessagingWebhook(page([{ sender: { id: "PAGE1" }, recipient: { id: "PSID1" }, timestamp: at, message: { mid: "m.3", text: "Dari Business Suite", is_echo: true } }]));
    expect(r.events).toEqual([{ kind: "outbound_echo", contactExternalId: "PSID1", body: "Dari Business Suite", providerMessageId: "m.3", sentAt: new Date(at), routingKey: "PAGE1" }]);
  });
  it("button taps (postbacks) count as the customer's message", () => {
    const r = parseMessagingWebhook(page([{ sender: { id: "PSID1" }, recipient: { id: "PAGE1" }, timestamp: at, postback: { title: "Lihat harga", payload: "X", mid: "m.4" } }]));
    expect(r.events[0]).toMatchObject({ kind: "message", body: "Lihat harga" });
  });
  it("delivery receipts with message ids → delivered", () => {
    const r = parseMessagingWebhook(page([{ sender: { id: "PSID1" }, recipient: { id: "PAGE1" }, timestamp: at, delivery: { mids: ["m.out1", "m.out2"], watermark: at } }]));
    expect(r.events.map((e) => e.kind === "status" && [e.providerMessageId, e.status])).toEqual([["m.out1", "delivered"], ["m.out2", "delivered"]]);
  });
  it("ignores deleted/unsupported messages, reactions and other objects", () => {
    expect(parseMessagingWebhook(page([{ sender: { id: "P" }, recipient: { id: "PAGE1" }, message: { mid: "x", is_deleted: true } }])).events).toEqual([]);
    expect(parseMessagingWebhook(page([{ sender: { id: "P" }, recipient: { id: "PAGE1" }, reaction: { mid: "x", reaction: "love" } }])).events).toEqual([]);
    expect(parseMessagingWebhook({ object: "whatsapp_business_account", entry: [] }).object).toBeNull();
    expect(parseMessagingWebhook(null).events).toEqual([]);
  });
});

describe("Instagram webhook (object: instagram)", () => {
  it("DM → message routed by Instagram account id; read receipt → read", () => {
    const r = parseMessagingWebhook({ object: "instagram", entry: [{ id: "IG1", time: at, messaging: [
      { sender: { id: "IGSID1" }, recipient: { id: "IG1" }, timestamp: at, message: { mid: "ig.1", text: "Ada saiz M?" } },
      { sender: { id: "IGSID1" }, recipient: { id: "IG1" }, timestamp: at, read: { mid: "ig.out1" } },
      { sender: { id: "IGSID1" }, recipient: { id: "IG1" }, timestamp: at, message: { mid: "ig.2", attachments: [{ type: "story_mention" }] } },
    ] }] });
    expect(r.object).toBe("instagram");
    expect(r.events[0]).toMatchObject({ kind: "message", contactExternalId: "IGSID1", body: "Ada saiz M?", routingKey: "IG1" });
    expect(r.events[1]).toMatchObject({ kind: "status", providerMessageId: "ig.out1", status: "read" });
    expect(r.events[2]).toMatchObject({ kind: "message", body: "[Sebut dalam story]" });
  });
});

describe("sending", () => {
  it("normal replies are standard RESPONSE messages", () => {
    expect(buildMessagingSendBody("PSID1", "Hai!", { maxLength: 2000 })).toEqual({ recipient: { id: "PSID1" }, messaging_type: "RESPONSE", message: { text: "Hai!" } });
  });
  it("a staff reply after 24h uses Meta's HUMAN_AGENT tag", () => {
    expect(buildMessagingSendBody("PSID1", "Maaf lambat", { humanAgent: true, maxLength: 2000 })).toEqual({ recipient: { id: "PSID1" }, messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT", message: { text: "Maaf lambat" } });
  });
  it("long text is cut to the platform limit (Instagram 1000)", () => {
    expect(buildMessagingSendBody("x", "a".repeat(1500), { maxLength: 1000 }).message.text).toHaveLength(1000);
  });
});

describe("messaging windows", () => {
  const now = Date.parse("2026-10-10T00:00:00Z");
  const ago = (h: number) => new Date(now - h * 3600_000).toISOString();
  it("Messenger / Instagram: open 24h, then staff only up to 7 days, then closed", () => {
    expect(messagingWindow("messenger", ago(2), now)).toBe("open");
    expect(messagingWindow("instagram", ago(30), now)).toBe("staff_only");
    expect(messagingWindow("messenger", ago(24 * 7 - 1), now)).toBe("staff_only");
    expect(messagingWindow("messenger", ago(24 * 7 + 1), now)).toBe("closed");
  });
  it("WhatsApp: no staff-only period (templates instead); web: no window", () => {
    expect(messagingWindow("whatsapp", ago(30), now)).toBe("closed");
    expect(messagingWindow("web", null, now)).toBe("n/a");
    expect(channelIcon("instagram")).toBe("📸");
    expect(channelIcon("messenger")).toBe("💙");
  });
});
