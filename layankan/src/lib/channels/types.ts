// Channel adapter contract. The agent engine never knows which channel it is
// talking to: inbound messages are normalised by an adapter, persisted by us,
// processed by the engine, and replies go back out through the same adapter.
//
// Vendor independence: adapters are TRANSPORT ONLY. They never store brains,
// prompts, scores or history. We persist every message in our own database
// BEFORE calling sendMessage and immediately on receipt, so switching a tenant
// between providers (e.g. Murpati → Meta Cloud API) loses nothing.
//
// Every adapter must pass tests/adapter-contract.test.ts.

export type ChannelKind = "web" | "whatsapp";
export type ChannelProvider = "web" | "murpati" | "meta_cloud";
export type DeliveryStatus = "queued" | "sent" | "delivered" | "read" | "failed";

export interface ChannelConnection {
  id: string;
  tenant_id: string;
  channel: ChannelKind;
  provider: ChannelProvider;
  phone_number_id: string | null;
  waba_id: string | null;
  display_phone_number: string | null;
  settings: Record<string, unknown>;
}

/** A customer message as every adapter must hand it to the core. */
export interface NormalizedInbound {
  kind: "message";
  contactExternalId: string; // web visitor id / WhatsApp wa_id
  contactName?: string | null;
  body: string;
  providerMessageId?: string | null;
  receivedAt: Date;
  /** Provider routing key, e.g. Meta phone_number_id, to find the workspace. */
  routingKey?: string | null;
}

/**
 * A message sent from OUTSIDE Layankan (e.g. typed in the provider's own
 * dashboard). We still persist it so our history stays complete.
 */
export interface NormalizedOutboundEcho {
  kind: "outbound_echo";
  contactExternalId: string;
  body: string;
  providerMessageId: string;
  sentAt: Date;
  routingKey?: string | null;
}

/** Delivery receipt (sent → delivered → read / failed) from a provider. */
export interface NormalizedStatus {
  kind: "status";
  providerMessageId: string;
  status: DeliveryStatus;
  occurredAt: Date;
  error?: string | null;
  routingKey?: string | null;
}

export type NormalizedEvent = NormalizedInbound | NormalizedStatus | NormalizedOutboundEcho;

export interface OutboundMessage {
  to: string; // contact external id
  body: string;
  /** For WhatsApp outside the 24h window: an approved template instead of free text. */
  template?: { name: string; language: string; variables: string[] };
}

export interface SendResult {
  status: DeliveryStatus;
  providerMessageId: string | null;
  error?: string | null;
}

export interface ChannelMetadata {
  channel: ChannelKind;
  provider: ChannelProvider;
  /** False for a stub adapter (e.g. Murpati until its API docs arrive): no connecting, no sending. */
  available: boolean;
  unavailableReason?: string;
  /** Hours after the customer's last message during which free-form replies are allowed (null = unlimited). */
  serviceWindowHours: number | null;
  supportsTemplates: boolean;
  maxMessageLength: number;
}

export interface InboundRequest {
  headers: Headers;
  rawBody: string;
}

export interface ChannelAdapter {
  metadata(): ChannelMetadata;
  /** Verify + parse a provider request into normalised events. Must throw on bad signatures. */
  receiveMessage(req: InboundRequest, conn: ChannelConnection | null): Promise<NormalizedEvent[]>;
  /** Deliver one outbound message. Must not persist anything itself. */
  sendMessage(conn: ChannelConnection, msg: OutboundMessage): Promise<SendResult>;
}
