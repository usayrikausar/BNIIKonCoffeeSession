import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { HANDOFF_REASON_LABELS, type HandoffReason } from "@/lib/agent/handoff";
import { emailLayout, escapeHtml, sendEmail } from "./email";

interface HandoffAlert {
  tenantId: string;
  tenantName: string;
  conversationId: string;
  reasons: HandoffReason[];
  score: string | null;
  details: Record<string, string>;
  lastCustomerMessage: string;
}

/** Recipients = workspace members who have handoff emails switched on. */
async function handoffRecipients(db: SupabaseClient, tenantId: string): Promise<string[]> {
  const { data } = await db.from("tenant_members").select("email, notification_prefs").eq("tenant_id", tenantId);
  return (data ?? [])
    .filter((m) => m.email && (m.notification_prefs as Record<string, unknown> | null)?.email_handoff !== false)
    .map((m) => m.email as string);
}

export async function notifyHandoff(db: SupabaseClient, alert: HandoffAlert): Promise<void> {
  const recipients = await handoffRecipients(db, alert.tenantId);
  const link = `${env.appUrl()}/dashboard/inbox/${alert.conversationId}`;
  const reasons = alert.reasons.map((r) => HANDOFF_REASON_LABELS[r].ms).join(", ");
  const subject = `${alert.score === "PANAS" ? "🔥 " : ""}Pelanggan perlukan anda — ${alert.tenantName}`;
  const detailRows = Object.entries(alert.details)
    .map(([k, v]) => `<tr><td style="color:#71717a;padding:2px 12px 2px 0">${escapeHtml(k)}</td><td>${escapeHtml(v)}</td></tr>`)
    .join("");
  const html = emailLayout(
    "AI telah berhenti dan menunggu anda",
    `<p><b>Sebab:</b> ${escapeHtml(reasons)}<br/><b>Skor:</b> ${escapeHtml(alert.score ?? "-")}</p>
<p style="background:#f4f4f5;border-radius:8px;padding:12px">“${escapeHtml(alert.lastCustomerMessage.slice(0, 500))}”</p>
${detailRows ? `<table style="font-size:14px">${detailRows}</table>` : ""}
<p><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Buka perbualan</a></p>`,
  );
  const text = `AI berhenti dan menunggu anda.\nSebab: ${reasons}\nSkor: ${alert.score ?? "-"}\nMesej: ${alert.lastCustomerMessage.slice(0, 500)}\n${link}`;

  for (const to of recipients) {
    const res = await sendEmail({ to, subject, html, text });
    await db.from("notifications").insert({
      tenant_id: alert.tenantId,
      conversation_id: alert.conversationId,
      kind: "handoff",
      transport: "email",
      recipient: to,
      status: res.ok ? "sent" : "failed",
      error: res.error ?? null,
      sent_at: res.ok ? new Date().toISOString() : null,
    });
  }
}
