import type { SupabaseClient } from "@supabase/supabase-js";

export interface LeadFilter {
  score?: string | null;
  from?: string | null; // YYYY-MM-DD (tenant local)
  to?: string | null;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Shared by the Leads page and the CSV export so they always agree. RLS-scoped client. */
export function leadsQuery(supabase: SupabaseClient, tenantId: string, f: LeadFilter, limit = 1000) {
  let q = supabase
    .from("conversations")
    .select("id, status, channel, lead_score, score_confidence, score_reason, next_action, lead_details, last_message_at, created_at")
    .eq("tenant_id", tenantId)
    .eq("is_test", false)
    .not("lead_score", "is", null)
    .order("lead_score", { ascending: true })
    .order("last_message_at", { ascending: false })
    .limit(limit);
  if (f.score && ["PANAS", "SUAM", "SEJUK"].includes(f.score)) q = q.eq("lead_score", f.score);
  // Dates are interpreted in Malaysia time (UTC+8) — the default tenant timezone.
  if (f.from && DATE.test(f.from)) q = q.gte("last_message_at", `${f.from}T00:00:00+08:00`);
  if (f.to && DATE.test(f.to)) q = q.lte("last_message_at", `${f.to}T23:59:59.999+08:00`);
  return q;
}

/** RFC 4180 CSV with formula-injection guard (cells starting with = + - @ are prefixed). */
export function toCsv(rows: (string | number | null | undefined)[][]): string {
  const cell = (v: string | number | null | undefined) => {
    let s = v == null ? "" : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return "﻿" + rows.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}
