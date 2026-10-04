import type { ChannelAdapter, SendResult } from "../types";
import { SERVICE_WINDOW_HOURS } from "./policy";

/*
 * ╔══════════════════════════════════════════════════════════════════════════╗
 * ║  MURPATI ADAPTER — STUB. NOT IMPLEMENTED.                                ║
 * ║                                                                          ║
 * ║  Do NOT guess endpoints or payloads. This file is deliberately empty of  ║
 * ║  any Murpati API detail until Murpati's official API documentation has   ║
 * ║  been provided. What is needed, and where each answer goes, is listed in ║
 * ║  docs/MURPATI_INTEGRATION.md.                                            ║
 * ║                                                                          ║
 * ║  Until then the stub:                                                    ║
 * ║   • never makes a network call;                                          ║
 * ║   • refuses every webhook (the route answers 501, nothing is ingested);  ║
 * ║   • reports every send as failed with MURPATI_NOT_IMPLEMENTED;           ║
 * ║   • reports metadata().available = false, so the dashboard won't let a   ║
 * ║     business connect a Murpati number or make one active.               ║
 * ╚══════════════════════════════════════════════════════════════════════════╝
 *
 * Fixed rules for the real implementation (these come from our own
 * requirements, not from Murpati):
 *   • TRANSPORT ONLY. Never store brains, prompts, scores or history in
 *     Murpati; never use Murpati's AI or document features. Our database is
 *     the system of record (messages are persisted before sending and on receipt).
 *   • OFFICIAL WhatsApp API numbers only. Refuse unofficial / QR-linked devices.
 *   • Verify every webhook signature before trusting the payload.
 *   • Credentials live encrypted in channel_credentials (putCredential / getCredential).
 */

export const MURPATI_NOT_IMPLEMENTED = "MURPATI_NOT_IMPLEMENTED";
const REASON =
  "Murpati adapter is a stub: waiting for Murpati's API documentation (see docs/MURPATI_INTEGRATION.md). Use the direct Meta connection instead.";

export class MurpatiNotImplementedError extends Error {
  readonly code = MURPATI_NOT_IMPLEMENTED;
  constructor() {
    super(REASON);
    this.name = "MurpatiNotImplementedError";
  }
}

export const murpatiAdapter: ChannelAdapter = {
  metadata: () => ({
    channel: "whatsapp",
    provider: "murpati",
    available: false,
    unavailableReason: REASON,
    // WhatsApp's own rules (same for every official-API transport), not Murpati details:
    serviceWindowHours: SERVICE_WINDOW_HOURS,
    supportsTemplates: true,
    maxMessageLength: 4096,
  }),

  async receiveMessage() {
    // TODO(murpati-docs): verify the signature, then parse events into NormalizedEvent[].
    throw new MurpatiNotImplementedError();
  },

  async sendMessage(): Promise<SendResult> {
    // TODO(murpati-docs): send text / template messages via Murpati's documented endpoint.
    return { status: "failed", providerMessageId: null, error: `${MURPATI_NOT_IMPLEMENTED}: ${REASON}` };
  },
};
