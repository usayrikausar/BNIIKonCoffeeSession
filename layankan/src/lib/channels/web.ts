import { createHash, randomBytes } from "node:crypto";
import type { ChannelAdapter, NormalizedEvent } from "./types";

export const MAX_WEB_MESSAGE_CHARS = 2000;

/**
 * Web chat (public link + embed widget). Our own database IS the transport:
 * the browser polls for new messages, so "sending" just means the row exists.
 */
export const webAdapter: ChannelAdapter = {
  metadata: () => ({
    channel: "web",
    provider: "web",
    available: true,
    serviceWindowHours: null,
    supportsTemplates: false,
    maxMessageLength: MAX_WEB_MESSAGE_CHARS,
  }),

  async receiveMessage(req) {
    let data: unknown;
    try {
      data = JSON.parse(req.rawBody);
    } catch {
      throw new Error("invalid JSON");
    }
    const d = data as { visitorToken?: unknown; message?: unknown };
    if (!isValidVisitorToken(d.visitorToken)) throw new Error("invalid visitorToken");
    if (typeof d.message !== "string") throw new Error("invalid message");
    const body = d.message.replace(/\u0000/g, "").trim().slice(0, MAX_WEB_MESSAGE_CHARS);
    if (!body) throw new Error("empty message");
    const ev: NormalizedEvent = { kind: "message", contactExternalId: visitorExternalId(d.visitorToken), body, receivedAt: new Date() };
    return [ev];
  },

  async sendMessage() {
    return { status: "sent", providerMessageId: null };
  },
};

// A web visitor is identified by a random secret token kept in their browser.
// We store only hashes: the contact id is derived from it, and the
// conversation stores a hash used to authorise polling.
export function newVisitorToken(): string {
  return randomBytes(24).toString("base64url");
}

export function isValidVisitorToken(t: unknown): t is string {
  return typeof t === "string" && /^[A-Za-z0-9_-]{32,64}$/.test(t);
}

export function visitorTokenHash(token: string): string {
  return createHash("sha256").update(`layankan:visitor:${token}`).digest("hex");
}

export function visitorExternalId(token: string): string {
  return "web_" + visitorTokenHash(token).slice(0, 32);
}
