import type { Booking } from "@/lib/brain/schema";
import type { AgentOutput } from "./schema";

const LEAD_IN = {
  ms: "📅 Tempah terus di sini:",
  en: "📅 Book directly here:",
} as const;

/**
 * Offer the business's booking link to a PANAS lead, once per conversation.
 * Pure. Done in code (not left to the model) so the link is always exact and
 * always offered at the right moment. If the AI already included the link
 * itself, it is not repeated, but it still counts as offered.
 */
export function withBookingLink(
  output: AgentOutput,
  booking: Booking,
  opts: { alreadySent: boolean; locale: "ms" | "en" },
): { text: string; offered: boolean } {
  const reply = output.reply;
  if (!booking.url || opts.alreadySent || output.assessment.score !== "PANAS") return { text: reply, offered: false };
  if (reply.includes(booking.url)) return { text: reply, offered: true };
  const lang = output.language === "en" ? "en" : output.language === "ms" ? "ms" : opts.locale;
  const label = booking.label ? `${booking.label}: ` : "";
  return { text: `${reply}\n\n${LEAD_IN[lang]} ${label}${booking.url}`, offered: true };
}
