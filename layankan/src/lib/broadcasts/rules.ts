// Opt-in broadcasts (R6). Pure rules — no I/O, unit tested.
import { z } from "zod";
import { QUIET_HOURS } from "@/lib/followup/plan";
import { renderTokens, sanitizeTemplateVariable } from "@/lib/channels/whatsapp/policy";

/** One broadcast per contact per this many days (also enforced by the database). */
export const MIN_DAYS_BETWEEN_BROADCASTS = 7;
/** Meta's lowest messaging tier: business-initiated chats with unique people per 24h. */
export const DEFAULT_DAILY_CAP = 250;
export const SCORES = ["PANAS", "SUAM", "SEJUK"] as const;

export const AudienceSchema = z.object({
  /** Empty = everyone who opted in. */
  scores: z.array(z.enum(SCORES)).max(3).default([]),
});
export type Audience = z.infer<typeof AudienceSchema>;

export const CreateBroadcastSchema = z.object({
  name: z.string().trim().min(1).max(120),
  template_name: z.string().regex(/^[a-z0-9_]+$/),
  template_language: z.string().min(2).max(15),
  variables: z.array(z.string().max(200)).max(10).default([]),
  audience: AudienceSchema.default({ scores: [] }),
  /** ISO time; absent/past = send now. */
  scheduled_at: z.string().datetime({ offset: true }).nullish(),
  /** The owner ticks "these people agreed to receive promotions from us". */
  confirm: z.literal(true),
});

export interface TemplateRow {
  name: string;
  language: string;
  status: string;
  category: string | null;
  source: string;
  body_text: string;
  variable_count: number;
}

export type TemplateProblem = "not_synced" | "not_approved" | "not_marketing" | "no_opt_out_line";

/** The template's opt-out line: "Balas STOP untuk berhenti" / "Reply STOP to unsubscribe". */
export const OPT_OUT_LINE = /\b(stop|berhenti)\b/i;

/**
 * Can this template be used for a broadcast? Only an APPROVED MARKETING
 * template synced from Meta (owners can't type their own), whose text tells
 * people how to stop.
 */
export function templateProblem(t: TemplateRow): TemplateProblem | null {
  if (t.source !== "meta_sync") return "not_synced";
  if (t.status.toUpperCase() !== "APPROVED") return "not_approved";
  if ((t.category ?? "").toUpperCase() !== "MARKETING") return "not_marketing";
  if (!OPT_OUT_LINE.test(t.body_text)) return "no_opt_out_line";
  return null;
}

export const TEMPLATE_PROBLEM_TEXT: Record<TemplateProblem, { ms: string; en: string }> = {
  not_synced: { ms: "Bukan dari Meta (tekan Segerak template di Saluran)", en: "Not synced from Meta (press Sync templates in Channels)" },
  not_approved: { ms: "Belum diluluskan Meta", en: "Not approved by Meta" },
  not_marketing: { ms: "Bukan kategori MARKETING", en: "Not a MARKETING template" },
  no_opt_out_line: { ms: "Tiada ayat \"Balas STOP untuk berhenti\"", en: "Missing a \"Reply STOP to stop\" line" },
};

/** Quiet hours: broadcasts only go out 9am–9pm, business local time. */
export function inSendingHours(localHour: number): boolean {
  return localHour >= QUIET_HOURS.start && localHour < QUIET_HOURS.end;
}

export const MAX_DAILY_CAP = 100_000;
/** Meta's messaging tiers (business-initiated chats with unique people per 24h), as admin shortcuts. */
export const META_TIERS = [250, 2_000, 10_000, 100_000] as const;

/** Daily cap per WhatsApp number (Meta messaging tier); the platform admin sets it per connection in /admin. */
export function dailyCap(settings: Record<string, unknown> | null | undefined): number {
  const v = Number(settings?.broadcast_daily_limit);
  return Number.isInteger(v) && v > 0 ? Math.min(v, MAX_DAILY_CAP) : DEFAULT_DAILY_CAP;
}

/** Admin input: a whole number 1–100,000, or null to go back to the default. Anything else → "invalid". */
export function parseDailyCap(v: unknown): number | null | "invalid" {
  if (v === null || v === "") return null;
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+\s*$/.test(v) ? Number(v) : NaN;
  return Number.isInteger(n) && n >= 1 && n <= MAX_DAILY_CAP ? n : "invalid";
}

/** Fill {name} / {business} in each template variable; Meta rejects empty ones. */
export function renderVariables(vars: string[], v: { name: string | null | undefined; business: string }, lang: "ms" | "en"): string[] {
  const fallbackName = lang === "ms" ? "pelanggan" : "there";
  return vars.map((x) => sanitizeTemplateVariable(renderTokens(x, { name: v.name?.split(" ")[0] || fallbackName, business: v.business })));
}

/** Whether a contact's latest conversation fits the chosen lead scores. */
export function matchesAudience(score: string | null | undefined, a: Audience): boolean {
  return !a.scores.length || (!!score && (a.scores as string[]).includes(score));
}
