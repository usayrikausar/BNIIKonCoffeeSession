import "server-only";
import { env } from "@/lib/env";
import { getCredential } from "../credentials";
import { verifyMurpatiSignature } from "../signature";
import type { ChannelAdapter, OutboundMessage, SendResult } from "../types";
import { parseMurpatiWebhook } from "./murpati-parse";
import { sanitizeTemplateVariable, SERVICE_WINDOW_HOURS } from "./policy";

/**
 * Murpati — TRANSPORT ONLY, official WhatsApp API devices only.
 * Never used for: storing brains/prompts/scores/history, Murpati's AI, or its
 * document features. Our DB is the system of record.
 *
 * Credentials per connection (encrypted in channel_credentials):
 *   api_key        — Murpati REST API key
 *   webhook_secret — the whsec_… secret Murpati shows when you add our webhook URL
 * Connection fields: provider_account_ref = Murpati device/sender id of the OFFICIAL-API number.
 *
 * ASSUMPTION: REST send endpoint + body shape (Murpati API reference was not
 * reachable when written). Isolated in buildMurpatiSendBody / MURPATI_SEND_PATH.
 */
export const MURPATI_SEND_PATH = "/messages";

export function buildMurpatiSendBody(deviceId: string | null, msg: OutboundMessage) {
  if (msg.template) {
    return {
      device_id: deviceId,
      to: msg.to,
      type: "template",
      template: {
        name: msg.template.name,
        language: msg.template.language,
        variables: msg.template.variables.map((v) => sanitizeTemplateVariable(v)),
      },
    };
  }
  return { device_id: deviceId, to: msg.to, type: "text", text: msg.body.slice(0, 4096) };
}

export const murpatiAdapter: ChannelAdapter = {
  metadata: () => ({
    channel: "whatsapp",
    provider: "murpati",
    serviceWindowHours: SERVICE_WINDOW_HOURS,
    supportsTemplates: true,
    maxMessageLength: 4096,
  }),

  async receiveMessage(req, conn) {
    if (!conn) throw new Error("unknown connection");
    const secret = await getCredential(conn.tenant_id, conn.id, "webhook_secret");
    if (!secret || !verifyMurpatiSignature(req.rawBody, req.headers.get("x-murpati-signature"), req.headers.get("x-murpati-timestamp"), secret)) {
      throw new Error("invalid signature");
    }
    const { events, rejectedUnofficial } = parseMurpatiWebhook(JSON.parse(req.rawBody));
    if (rejectedUnofficial) {
      console.warn(`[murpati] connection=${conn.id} sent an event from a NON-official device — ignored`);
    }
    return events;
  },

  async sendMessage(conn, msg): Promise<SendResult> {
    const apiKey = await getCredential(conn.tenant_id, conn.id, "api_key");
    if (!apiKey) return { status: "failed", providerMessageId: null, error: "missing Murpati API key" };
    const deviceId = (conn.settings?.device_id as string | undefined) ?? null;
    try {
      const res = await fetch(`${env.murpatiApiBaseUrl()}${MURPATI_SEND_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(buildMurpatiSendBody(deviceId, msg)),
        signal: AbortSignal.timeout(15_000),
      });
      const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
      if (!res.ok) {
        const err = (data.message ?? data.error ?? `Murpati ${res.status}`) as string;
        return { status: "failed", providerMessageId: null, error: String(err).slice(0, 300) };
      }
      const inner = (data.data ?? {}) as Record<string, unknown>;
      const id = (data.id ?? data.message_id ?? inner.id ?? inner.message_id ?? null) as string | null;
      return { status: "sent", providerMessageId: id };
    } catch (e) {
      return { status: "failed", providerMessageId: null, error: e instanceof Error ? e.message.slice(0, 300) : "send failed" };
    }
  },
};
