import "server-only";
import { env } from "@/lib/env";
import { getCredential } from "../credentials";
import { verifyMetaSignature } from "../signature";
import type { ChannelAdapter, ChannelConnection, OutboundMessage, SendResult } from "../types";
import { graph } from "../whatsapp/meta";
import { buildMessagingSendBody, parseMessagingWebhook, type MessagingObject } from "./parse";

/** Meta's standard messaging window, and the extra time a HUMAN may reply with the human-agent tag. */
export const MESSAGING_WINDOW_HOURS = 24;
export const HUMAN_AGENT_WINDOW_HOURS = 7 * 24;

function messagingAdapter(kind: "messenger" | "instagram"): ChannelAdapter {
  const object: MessagingObject = kind === "messenger" ? "page" : "instagram";
  const maxLength = kind === "messenger" ? 2000 : 1000;
  return {
    metadata: () => ({
      channel: kind,
      provider: kind === "messenger" ? "meta_messenger" : "meta_instagram",
      available: true,
      serviceWindowHours: MESSAGING_WINDOW_HOURS,
      humanAgentWindowHours: HUMAN_AGENT_WINDOW_HOURS,
      supportsTemplates: false,
      maxMessageLength: maxLength,
    }),

    async receiveMessage(req) {
      // Same Meta app as WhatsApp: signed with OUR app secret.
      if (!verifyMetaSignature(req.rawBody, req.headers.get("x-hub-signature-256"), env.metaAppSecret())) throw new Error("invalid signature");
      const parsed = parseMessagingWebhook(JSON.parse(req.rawBody));
      if (parsed.object !== object) return [];
      return parsed.events;
    },

    async sendMessage(conn: ChannelConnection, msg: OutboundMessage): Promise<SendResult> {
      if (msg.template) return { status: "failed", providerMessageId: null, error: `${kind} has no message templates` };
      if (!conn.page_id) return { status: "failed", providerMessageId: null, error: "connection has no page_id" };
      const token = await getCredential(conn.tenant_id, conn.id, "page_access_token");
      if (!token) return { status: "failed", providerMessageId: null, error: "missing page access token" };
      try {
        // Instagram messages are sent through the linked Facebook Page too.
        const data = await graph<{ message_id?: string }>(`${conn.page_id}/messages`, {
          method: "POST",
          token,
          body: buildMessagingSendBody(msg.to, msg.body, { humanAgent: msg.humanAgent, maxLength }),
        });
        return { status: "sent", providerMessageId: data.message_id ?? null };
      } catch (e) {
        return { status: "failed", providerMessageId: null, error: e instanceof Error ? e.message.slice(0, 300) : "send failed" };
      }
    },
  };
}

export const metaMessengerAdapter = messagingAdapter("messenger");
export const metaInstagramAdapter = messagingAdapter("instagram");
