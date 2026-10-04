import type { NormalizedEvent } from "../types";

// Pure parser for Messenger (object "page") and Instagram (object "instagram")
// webhooks — Meta's official Messenger Platform / Instagram Messaging.
// entry[].id is the Page id (Messenger) or the Instagram account id (Instagram):
// it is the routing key that finds the business.

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Obj) : {});

const ATTACHMENT_LABEL: Record<string, string> = {
  image: "[Gambar]", video: "[Video]", audio: "[Audio]", file: "[Fail]", location: "[Lokasi]", story_mention: "[Sebut dalam story]", share: "[Kongsi]",
};

function bodyOf(message: Obj): string | null {
  const text = str(message.text);
  const atts = Array.isArray(message.attachments) ? (message.attachments as Obj[]) : [];
  const labels = atts.map((a) => ATTACHMENT_LABEL[String(a.type)] ?? "[Lampiran]");
  const parts = [...labels, ...(text ? [text] : [])];
  return parts.length ? parts.join(" ").slice(0, 4000) : null;
}

export type MessagingObject = "page" | "instagram";

export function parseMessagingWebhook(payload: unknown): { object: MessagingObject | null; events: NormalizedEvent[] } {
  const p = obj(payload);
  const object = p.object === "page" || p.object === "instagram" ? (p.object as MessagingObject) : null;
  if (!object) return { object: null, events: [] };
  const events: NormalizedEvent[] = [];
  for (const entry of Array.isArray(p.entry) ? (p.entry as Obj[]) : []) {
    const routingKey = str(entry.id);
    for (const m of Array.isArray(entry.messaging) ? (entry.messaging as Obj[]) : []) {
      const sender = str(obj(m.sender).id);
      const recipient = str(obj(m.recipient).id);
      const at = typeof m.timestamp === "number" ? new Date(m.timestamp) : new Date();
      const message = obj(m.message);
      if (m.message && !message.is_deleted && !message.is_unsupported) {
        const mid = str(message.mid);
        const body = bodyOf(message);
        if (message.is_echo) {
          // Sent by the business (from our app, or from Meta Business Suite / the IG app).
          if (mid && recipient) events.push({ kind: "outbound_echo", contactExternalId: recipient, body: body ?? "", providerMessageId: mid, sentAt: at, routingKey });
        } else if (sender && body) {
          events.push({ kind: "message", contactExternalId: sender, contactName: null, body, providerMessageId: mid, receivedAt: at, routingKey });
        }
        continue;
      }
      // Buttons the customer tapped arrive as postbacks: treat the title as their message.
      const postback = obj(m.postback);
      if (m.postback && sender && str(postback.title)) {
        events.push({ kind: "message", contactExternalId: sender, contactName: null, body: str(postback.title)!, providerMessageId: str(postback.mid), receivedAt: at, routingKey });
        continue;
      }
      // Delivery / read receipts (only when Meta names the message ids).
      const delivery = obj(m.delivery);
      for (const mid of Array.isArray(delivery.mids) ? (delivery.mids as unknown[]) : []) {
        const id = str(mid);
        if (id) events.push({ kind: "status", providerMessageId: id, status: "delivered", occurredAt: at, routingKey });
      }
      const read = obj(m.read);
      if (str(read.mid)) events.push({ kind: "status", providerMessageId: str(read.mid)!, status: "read", occurredAt: at, routingKey });
      // reactions, referrals, standby etc. are ignored
    }
  }
  return { object, events };
}

/** Send body for the Send API (Messenger and Instagram use the same shape). */
export function buildMessagingSendBody(to: string, text: string, opts: { humanAgent?: boolean; maxLength: number }) {
  return {
    recipient: { id: to },
    ...(opts.humanAgent ? { messaging_type: "MESSAGE_TAG", tag: "HUMAN_AGENT" } : { messaging_type: "RESPONSE" }),
    message: { text: text.slice(0, opts.maxLength) },
  };
}
