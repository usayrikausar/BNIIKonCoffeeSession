import "server-only";
import { Resend } from "resend";
import { env } from "@/lib/env";

export interface EmailMessage {
  to: string;
  subject: string;
  html: string;
  text: string;
}

/** Sends via Resend. Without RESEND_API_KEY (local dev) it logs the subject only. */
export async function sendEmail(msg: EmailMessage): Promise<{ ok: boolean; error?: string }> {
  const key = env.resendKey();
  if (!key) {
    console.info(`[email:dev] would send "${msg.subject}" to ${msg.to}`);
    return { ok: true };
  }
  try {
    const resend = new Resend(key);
    const { error } = await resend.emails.send({ from: env.emailFrom(), ...msg });
    return error ? { ok: false, error: error.message } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "send failed" };
  }
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function emailLayout(title: string, bodyHtml: string): string {
  return `<!doctype html><html><body style="margin:0;background:#f4f4f5;font-family:Arial,Helvetica,sans-serif;color:#18181b">
<div style="max-width:560px;margin:24px auto;background:#fff;border-radius:12px;padding:24px">
<div style="font-weight:700;color:#0f766e;font-size:18px;margin-bottom:12px">Layankan</div>
<h1 style="font-size:18px;margin:0 0 16px">${escapeHtml(title)}</h1>
${bodyHtml}
<p style="font-size:12px;color:#71717a;margin-top:24px">Anda menerima emel ini kerana anda ahli ruang kerja Layankan. Tukar tetapan makluman di Tetapan.</p>
</div></body></html>`;
}
