import type { NormalizedEvent } from "../types";

// Pure parser for Murpati webhooks.
// Confirmed from Murpati's public docs: events "message.received" (contact
// messaged you) and "message.sent" (outgoing message delivered — from the
// API, Murpati dashboard or campaigns).
// ASSUMPTION: field names inside `data`. We read the common variants; adjust
// `pick*` below once the real payload is confirmed (see tests/whatsapp.test.ts).

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);

function pickBody(d: Obj): string | null {
  const text = d.text;
  return (
    str(d.body) ??
    (text && typeof text === "object" ? str((text as Obj).body) : str(text)) ??
    str(d.message) ??
    str(d.content) ??
    str(d.caption) ??
    (str(d.type) && str(d.type) !== "text" ? `[${str(d.type)}]` : null)
  );
}
const pickId = (d: Obj) => str(d.id) ?? str(d.message_id) ?? str(d.wamid);
const pickTime = (d: Obj) => {
  const t = d.timestamp ?? d.created_at ?? d.time;
  if (typeof t === "number" || (typeof t === "string" && /^\d+$/.test(t))) {
    const n = Number(t);
    return new Date(n > 1e12 ? n : n * 1000);
  }
  if (typeof t === "string" && Number.isFinite(Date.parse(t))) return new Date(t);
  return new Date();
};

/** Murpati also offers UNOFFICIAL (QR-linked) devices. Anything flagged as such is refused. */
export function isUnofficialMurpatiPayload(d: Obj): boolean {
  if (d.is_official === false || d.official === false) return true;
  const kind = String(d.device_type ?? d.connection_type ?? d.channel_type ?? "").toLowerCase();
  return /unofficial|regular|qr|web/.test(kind);
}

export function parseMurpatiWebhook(payload: unknown): { events: NormalizedEvent[]; rejectedUnofficial: boolean } {
  const p = (payload ?? {}) as Obj;
  const event = str(p.event) ?? str(p.type);
  const d = ((p.data && typeof p.data === "object" ? p.data : p) ?? {}) as Obj;
  if (isUnofficialMurpatiPayload(d) || isUnofficialMurpatiPayload(p)) return { events: [], rejectedUnofficial: true };
  const id = pickId(d);
  const body = pickBody(d);

  if (event === "message.received") {
    const from = str(d.from) ?? str(d.sender) ?? str(d.phone) ?? str(d.wa_id);
    if (!from || !body) return { events: [], rejectedUnofficial: false };
    return {
      events: [{
        kind: "message",
        contactExternalId: from.replace(/[^\d]/g, ""),
        contactName: str(d.name) ?? str(d.push_name) ?? str(d.contact_name),
        body: body.slice(0, 4000),
        providerMessageId: id,
        receivedAt: pickTime(d),
      }],
      rejectedUnofficial: false,
    };
  }
  if (event === "message.sent") {
    const to = str(d.to) ?? str(d.recipient) ?? str(d.phone) ?? str(d.wa_id);
    if (!id) return { events: [], rejectedUnofficial: false };
    const status = str(d.status)?.toLowerCase();
    if (status === "failed") return { events: [{ kind: "status", providerMessageId: id, status: "failed", occurredAt: pickTime(d), error: str(d.error) }], rejectedUnofficial: false };
    // Known id → delivery receipt; unknown id → message sent outside Layankan (ingest decides).
    return {
      events: [{ kind: "outbound_echo", contactExternalId: (to ?? "").replace(/[^\d]/g, ""), body: body ?? "", providerMessageId: id, sentAt: pickTime(d) }],
      rejectedUnofficial: false,
    };
  }
  return { events: [], rejectedUnofficial: false };
}
