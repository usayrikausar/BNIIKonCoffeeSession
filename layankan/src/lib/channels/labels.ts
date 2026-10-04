import type { ChannelKind } from "./types";

/** How each channel is shown in the dashboard. */
export const CHANNEL_ICON: Record<ChannelKind, string> = { web: "💬", whatsapp: "🟢", instagram: "📸", messenger: "💙" };
export const CHANNEL_NAME: Record<ChannelKind, string> = { web: "Web", whatsapp: "WhatsApp", instagram: "Instagram", messenger: "Messenger" };

export function channelIcon(c: string | null | undefined): string {
  return CHANNEL_ICON[(c ?? "web") as ChannelKind] ?? "💬";
}

/**
 * Meta's messaging windows, from the customer's last message: WhatsApp — free
 * text for 24h, then templates only; Messenger / Instagram — AI and staff for
 * 24h, then staff only (human-agent tag) up to 7 days, then nobody.
 */
export function messagingWindow(channel: string, lastInboundAt: string | null | undefined, now = Date.now()): "open" | "staff_only" | "closed" | "n/a" {
  if (channel === "web") return "n/a";
  const age = lastInboundAt ? now - Date.parse(lastInboundAt) : Infinity;
  if (age <= 24 * 3600_000) return "open";
  if ((channel === "instagram" || channel === "messenger") && age <= 7 * 24 * 3600_000) return "staff_only";
  return "closed";
}
