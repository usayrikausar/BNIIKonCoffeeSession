import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { buildDigest, isSummaryDue, type Digest, type DigestConversation } from "./digest";
import { emailLayout, escapeHtml, sendEmail } from "./email";

interface TenantRow { id: string; name: string; timezone: string; summary_hour: number }

/** Runs hourly; each tenant gets at most one digest per local day (enforced by daily_summary_runs PK). */
export async function runDailySummaries(db: SupabaseClient, now = new Date()) {
  const { data: tenants } = await db.from("tenants").select("id, name, timezone, summary_hour").eq("status", "live");
  const results: { tenant: string; sent: number; skipped?: string }[] = [];
  for (const t of (tenants ?? []) as TenantRow[]) {
    try {
      const { due, localDate } = isSummaryDue(now, t.timezone, t.summary_hour);
      if (!due) continue;
      // Claim today's run first: concurrent/duplicate cron calls lose the race and skip.
      const { error: claimErr } = await db.from("daily_summary_runs").insert({ tenant_id: t.id, local_date: localDate });
      if (claimErr) continue;

      const since = new Date(now.getTime() - 24 * 3600 * 1000).toISOString();
      const { data: rows } = await db
        .from("conversations")
        .select("id, lead_score, status, lead_details, score_reason, next_action, customer_message_count")
        .eq("tenant_id", t.id)
        .eq("is_test", false)
        .gte("last_message_at", since)
        .order("lead_score", { ascending: true, nullsFirst: false })
        .limit(500);
      const digest = buildDigest((rows ?? []) as DigestConversation[]);
      await db.from("daily_summary_runs").update({ stats: { ...digest.counts, total: digest.total, needs_you: digest.needsYou } }).eq("tenant_id", t.id).eq("local_date", localDate);
      if (digest.total === 0) {
        results.push({ tenant: t.id, sent: 0, skipped: "no activity" });
        continue;
      }
      const { data: members } = await db.from("tenant_members").select("email, notification_prefs").eq("tenant_id", t.id);
      const recipients = (members ?? []).filter((m) => m.email && (m.notification_prefs as Record<string, unknown>)?.email_daily_summary !== false);
      const email = renderDigestEmail(t.name, localDate, digest);
      let sent = 0;
      for (const m of recipients) {
        const res = await sendEmail({ to: m.email as string, ...email });
        if (res.ok) sent++;
        await db.from("notifications").insert({
          tenant_id: t.id,
          kind: "daily_summary",
          transport: "email",
          recipient: m.email,
          status: res.ok ? "sent" : "failed",
          error: res.error ?? null,
          sent_at: res.ok ? new Date().toISOString() : null,
        });
      }
      results.push({ tenant: t.id, sent });
    } catch (e) {
      console.error(`[daily-summary] tenant=${t.id} failed: ${e instanceof Error ? e.message : e}`);
    }
  }
  return results;
}

export function renderDigestEmail(tenantName: string, localDate: string, d: Digest) {
  const link = `${env.appUrl()}/dashboard/leads`;
  const item = (c: DigestConversation) => {
    const det = c.lead_details ?? {};
    return `<li style="margin-bottom:8px"><a href="${env.appUrl()}/dashboard/inbox/${c.id}"><b>${escapeHtml(det.name || "Pelawat")}</b></a>${det.need ? ` — ${escapeHtml(det.need)}` : ""}${det.timeline ? ` · ${escapeHtml(det.timeline)}` : ""}<br/><span style="color:#71717a;font-size:13px">${escapeHtml(c.next_action ?? c.score_reason ?? "")}</span></li>`;
  };
  const html = emailLayout(
    `Ringkasan harian · ${tenantName} · ${localDate}`,
    `<table style="width:100%;text-align:center;margin-bottom:16px"><tr>
<td style="background:#fee2e2;border-radius:8px;padding:10px"><div style="font-size:22px;font-weight:700">${d.counts.PANAS}</div>🔥 PANAS</td>
<td style="width:8px"></td>
<td style="background:#fef3c7;border-radius:8px;padding:10px"><div style="font-size:22px;font-weight:700">${d.counts.SUAM}</div>🌤 SUAM</td>
<td style="width:8px"></td>
<td style="background:#e0f2fe;border-radius:8px;padding:10px"><div style="font-size:22px;font-weight:700">${d.counts.SEJUK}</div>❄️ SEJUK</td>
</tr></table>
<p>${d.total} perbualan dalam 24 jam lepas. ${d.needsYou ? `<b>${d.needsYou} menunggu anda.</b>` : ""} ${d.emptyEnquiries ? `${d.emptyEnquiries} pertanyaan kosong ditapis oleh AI.` : ""}</p>
${d.panas.length ? `<h3 style="font-size:15px">🔥 Prospek PANAS — hubungi hari ini</h3><ul>${d.panas.slice(0, 15).map(item).join("")}</ul>` : ""}
${d.suam.length ? `<h3 style="font-size:15px">🌤 Prospek SUAM — perlu susulan</h3><ul>${d.suam.slice(0, 15).map(item).join("")}</ul>` : ""}
<p><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Lihat semua prospek</a></p>`,
  );
  const text = `Ringkasan harian ${tenantName} (${localDate})\nPANAS: ${d.counts.PANAS} · SUAM: ${d.counts.SUAM} · SEJUK: ${d.counts.SEJUK}\nMenunggu anda: ${d.needsYou}\n${link}`;
  return { subject: `📊 ${tenantName}: ${d.counts.PANAS} PANAS, ${d.counts.SUAM} SUAM, ${d.counts.SEJUK} SEJUK`, html, text };
}
