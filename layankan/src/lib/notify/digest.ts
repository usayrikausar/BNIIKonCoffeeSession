// Pure helpers for the daily summary (no I/O → unit tested).
import type { LeadScore } from "@/lib/agent/schema";

export function localParts(now: Date, timeZone: string): { date: string; hour: number } {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) };
}

/** Due once the tenant's local clock reaches summary_hour (catch-up if a cron run was missed). */
export function isSummaryDue(now: Date, timeZone: string, summaryHour: number): { due: boolean; localDate: string } {
  const { date, hour } = localParts(now, timeZone);
  return { due: hour >= summaryHour, localDate: date };
}

export interface DigestConversation {
  id: string;
  lead_score: LeadScore | null;
  status: string;
  lead_details: Record<string, string> | null;
  score_reason: string | null;
  next_action: string | null;
  customer_message_count: number;
}

export interface Digest {
  total: number;
  counts: Record<LeadScore | "unscored", number>;
  needsYou: number;
  emptyEnquiries: number;
  panas: DigestConversation[];
  suam: DigestConversation[];
}

export function buildDigest(rows: DigestConversation[]): Digest {
  const counts: Digest["counts"] = { PANAS: 0, SUAM: 0, SEJUK: 0, unscored: 0 };
  for (const r of rows) counts[r.lead_score ?? "unscored"]++;
  return {
    total: rows.length,
    counts,
    needsYou: rows.filter((r) => r.status === "needs_human").length,
    // "Hi, harga?" and gone: one customer message, scored cold.
    emptyEnquiries: rows.filter((r) => r.customer_message_count <= 1 && r.lead_score !== "PANAS" && r.lead_score !== "SUAM").length,
    panas: rows.filter((r) => r.lead_score === "PANAS"),
    suam: rows.filter((r) => r.lead_score === "SUAM"),
  };
}
