import type { DeliveryStatus, NormalizedEvent } from "../types";

// Pure parser for Meta WhatsApp Cloud API webhooks (object = whatsapp_business_account).
// https://developers.facebook.com/docs/whatsapp/cloud-api/webhooks/components

interface MetaMessage {
  from: string;
  id: string;
  timestamp?: string;
  type: string;
  text?: { body?: string };
  button?: { text?: string };
  interactive?: { button_reply?: { title?: string }; list_reply?: { title?: string } };
  image?: { caption?: string };
  video?: { caption?: string };
  document?: { caption?: string; filename?: string };
  location?: { name?: string; address?: string; latitude?: number; longitude?: number };
  reaction?: { emoji?: string };
}

interface MetaStatus {
  id: string;
  status: string;
  timestamp?: string;
  recipient_id?: string;
  errors?: { code?: number; title?: string; message?: string }[];
}

interface MetaValue {
  messaging_product?: string;
  metadata?: { phone_number_id?: string; display_phone_number?: string };
  contacts?: { wa_id?: string; profile?: { name?: string } }[];
  messages?: MetaMessage[];
  statuses?: MetaStatus[];
}

const tsDate = (ts?: string) => (ts && /^\d+$/.test(ts) ? new Date(Number(ts) * 1000) : new Date());

/** Human-readable body for non-text messages so the agent and the owner know what arrived. */
export function metaMessageBody(m: MetaMessage): string {
  switch (m.type) {
    case "text":
      return m.text?.body ?? "";
    case "button":
      return m.button?.text ?? "[button]";
    case "interactive":
      return m.interactive?.button_reply?.title ?? m.interactive?.list_reply?.title ?? "[interactive]";
    case "image":
      return m.image?.caption ? `[Gambar] ${m.image.caption}` : "[Gambar]";
    case "video":
      return m.video?.caption ? `[Video] ${m.video.caption}` : "[Video]";
    case "audio":
      return "[Mesej suara]";
    case "document":
      return `[Dokumen] ${m.document?.filename ?? m.document?.caption ?? ""}`.trim();
    case "sticker":
      return "[Stiker]";
    case "location":
      return `[Lokasi] ${m.location?.name ?? ""} ${m.location?.address ?? ""}`.trim();
    case "reaction":
      return ""; // reactions are not enquiries
    default:
      return `[${m.type}]`;
  }
}

const STATUS_MAP: Record<string, DeliveryStatus> = { sent: "sent", delivered: "delivered", read: "read", failed: "failed" };

export function parseMetaWebhook(payload: unknown): NormalizedEvent[] {
  const p = payload as { object?: string; entry?: { changes?: { field?: string; value?: MetaValue }[] }[] };
  if (!p || p.object !== "whatsapp_business_account" || !Array.isArray(p.entry)) return [];
  const out: NormalizedEvent[] = [];
  for (const entry of p.entry) {
    for (const change of entry.changes ?? []) {
      if (change.field !== "messages" || !change.value) continue;
      const v = change.value;
      const routingKey = v.metadata?.phone_number_id ?? null;
      const names = new Map((v.contacts ?? []).map((c) => [c.wa_id ?? "", c.profile?.name ?? null]));
      for (const m of v.messages ?? []) {
        const body = metaMessageBody(m).slice(0, 4000);
        if (!body || !m.from || !m.id) continue;
        out.push({
          kind: "message",
          contactExternalId: m.from,
          contactName: names.get(m.from) ?? null,
          body,
          providerMessageId: m.id,
          receivedAt: tsDate(m.timestamp),
          routingKey,
        });
      }
      for (const s of v.statuses ?? []) {
        const status = STATUS_MAP[s.status];
        if (!status || !s.id) continue;
        const err = s.errors?.[0];
        out.push({
          kind: "status",
          providerMessageId: s.id,
          status,
          occurredAt: tsDate(s.timestamp),
          error: err ? `${err.code ?? ""} ${err.title ?? err.message ?? ""}`.trim() : null,
          routingKey,
        });
      }
    }
  }
  return out;
}
