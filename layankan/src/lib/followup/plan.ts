import type { FollowUp } from "@/lib/brain/schema";
import { isWithinServiceWindow, renderTokens } from "@/lib/channels/whatsapp/policy";

export interface FollowUpCandidate {
  lead_score: string | null;
  status: string;
  is_test: boolean;
  channel: string;
  follow_up_count: number;
  /** Per-chat off switch set by the team. */
  follow_up_disabled?: boolean | null;
  last_follow_up_at: string | null;
  last_message_at: string | null;
  last_inbound_at: string | null;
  lead_details: Record<string, string> | null;
}

export type FollowUpPlan =
  | { action: "skip"; reason: string }
  | { action: "freeform"; text: string }
  | { action: "template"; template: { name: string; language: string; variables: string[] } };

export const QUIET_HOURS = { start: 9, end: 21 }; // only message customers 9am–9pm local time

/** At most this many follow-ups per conversation, whatever the settings say. */
export const MAX_FOLLOW_UPS = 2;

/** Hours to wait before follow-up number `n` (1 or 2). */
export function followUpDelayHours(cfg: FollowUp, n: number): number {
  return n <= 1 ? cfg.delay_hours : cfg.second_delay_hours;
}

/**
 * Decide whether (and how) to nudge a SUAM lead who went quiet. Pure.
 * Never follows up opted-out customers, chats where the team switched
 * follow-ups off, AI-paused/closed conversations, or tests; respects the
 * attempt limit (max 2), each attempt's interval, quiet hours and the
 * WhatsApp 24h rule (free text inside the window, approved template outside).
 */
export function planFollowUp(
  c: FollowUpCandidate,
  cfg: FollowUp,
  ctx: { now: Date; localHour: number; lastSender: string | null; optedOut: boolean; businessName: string },
): FollowUpPlan {
  if (!cfg.enabled) return { action: "skip", reason: "disabled" };
  if (c.is_test) return { action: "skip", reason: "test" };
  if (c.channel !== "whatsapp") return { action: "skip", reason: "channel" };
  if (c.lead_score !== "SUAM") return { action: "skip", reason: "not SUAM" };
  if (c.status !== "ai") return { action: "skip", reason: "not AI-handled" };
  if (c.follow_up_disabled) return { action: "skip", reason: "off for this chat" };
  if (ctx.optedOut) return { action: "skip", reason: "opted out" };
  if (c.follow_up_count >= Math.min(cfg.max_attempts, MAX_FOLLOW_UPS)) return { action: "skip", reason: "max attempts" };
  if (ctx.lastSender === "customer") return { action: "skip", reason: "customer spoke last" };
  const delayMs = followUpDelayHours(cfg, c.follow_up_count + 1) * 3600 * 1000;
  const last = Date.parse(c.last_message_at ?? "");
  if (!Number.isFinite(last) || ctx.now.getTime() - last < delayMs) return { action: "skip", reason: "too soon" };
  if (c.last_follow_up_at && ctx.now.getTime() - Date.parse(c.last_follow_up_at) < delayMs) return { action: "skip", reason: "too soon after last follow-up" };
  if (ctx.localHour < QUIET_HOURS.start || ctx.localHour >= QUIET_HOURS.end) return { action: "skip", reason: "quiet hours" };

  const d = c.lead_details ?? {};
  const vars = { name: d.name, business: ctx.businessName, need: d.need };
  if (cfg.message && isWithinServiceWindow(c.last_inbound_at, ctx.now)) {
    return { action: "freeform", text: renderTokens(cfg.message, vars) };
  }
  if (cfg.template_name) {
    return {
      action: "template",
      template: {
        name: cfg.template_name,
        language: cfg.template_language,
        variables: cfg.template_variables.map((v) => renderTokens(v, vars) || "-"),
      },
    };
  }
  return { action: "skip", reason: "window closed and no template configured" };
}

/** Human-readable copy of a template message for our own history. */
export function templatePreview(bodyText: string | null | undefined, name: string, variables: string[]): string {
  if (!bodyText) return `[Template: ${name}] ${variables.join(" · ")}`;
  return bodyText.replace(/\{\{\s*(\d+)\s*\}\}/g, (_, n: string) => variables[Number(n) - 1] ?? "");
}
