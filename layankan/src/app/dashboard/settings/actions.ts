"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireTenant, TENANT_COOKIE } from "@/lib/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { sendEmail, emailLayout, escapeHtml } from "@/lib/notify/email";
import { env } from "@/lib/env";
import { checkPlanCap } from "@/lib/billing/service";

type Result = { ok: boolean; error?: string };

function validTimezone(tz: string) {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

export async function updateWorkspace(_p: Result | null, form: FormData): Promise<Result> {
  const { supabase, tenant, role } = await requireTenant();
  if (role !== "owner") return { ok: false, error: "owner only" };
  const name = String(form.get("name") ?? "").trim();
  const timezone = String(form.get("timezone") ?? "Asia/Kuala_Lumpur");
  const hour = Number(form.get("summary_hour"));
  const locale = form.get("default_locale") === "en" ? "en" : "ms";
  if (!name || name.length > 120) return { ok: false, error: "name" };
  if (!validTimezone(timezone)) return { ok: false, error: "timezone" };
  if (!Number.isInteger(hour) || hour < 0 || hour > 23) return { ok: false, error: "hour" };
  const { error } = await supabase
    .from("tenants")
    .update({ name, timezone, summary_hour: hour, default_locale: locale })
    .eq("id", tenant.id);
  revalidatePath("/dashboard", "layout");
  return error ? { ok: false, error: "save failed" } : { ok: true };
}

export async function inviteMember(_p: Result | null, form: FormData): Promise<Result> {
  const { supabase, tenant, role, user } = await requireTenant();
  if (role !== "owner") return { ok: false, error: "owner only" };
  const email = String(form.get("email") ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return { ok: false, error: "email" };
  const cap = await checkPlanCap(createAdminClient(), tenant.id, "members");
  if (cap) return { ok: false, error: cap };
  const { error } = await supabase.from("tenant_invites").upsert(
    { tenant_id: tenant.id, email, role: "staff", invited_by: user.id, accepted_at: null },
    { onConflict: "tenant_id,email" },
  );
  if (error) return { ok: false, error: "invite failed" };
  const link = `${env.appUrl()}/signup`;
  await sendEmail({
    to: email,
    subject: `Jemputan ke ${tenant.name} di Layankan`,
    html: emailLayout(
      `Anda dijemput ke ${tenant.name}`,
      `<p>${escapeHtml(user.email ?? "")} menjemput anda untuk membantu melayan pelanggan ${escapeHtml(tenant.name)}.</p>
<p>Daftar atau log masuk dengan emel ini: <b>${escapeHtml(email)}</b></p>
<p><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Terima jemputan</a></p>`,
    ),
    text: `Anda dijemput ke ${tenant.name} di Layankan. Daftar/log masuk dengan ${email}: ${link}`,
  });
  revalidatePath("/dashboard/settings");
  return { ok: true };
}

export async function removeMember(userId: string): Promise<Result> {
  const { supabase, tenant, role, user } = await requireTenant();
  if (role !== "owner" || userId === user.id) return { ok: false };
  await supabase.from("tenant_members").delete().eq("tenant_id", tenant.id).eq("user_id", userId);
  revalidatePath("/dashboard/settings");
  return { ok: true };
}

export async function cancelInvite(id: string): Promise<Result> {
  const { supabase, tenant, role } = await requireTenant();
  if (role !== "owner") return { ok: false };
  await supabase.from("tenant_invites").delete().eq("tenant_id", tenant.id).eq("id", id);
  revalidatePath("/dashboard/settings");
  return { ok: true };
}

export async function updateMyPrefs(prefs: { email_handoff: boolean; email_daily_summary: boolean }): Promise<Result> {
  const { supabase, tenant } = await requireTenant();
  const { error } = await supabase.rpc("update_my_notification_prefs", {
    p_tenant: tenant.id,
    p_prefs: { email_handoff: !!prefs.email_handoff, email_daily_summary: !!prefs.email_daily_summary },
  });
  return { ok: !error };
}

/** PDPA: permanently delete the workspace and ALL its data (cascades), plus stored files. */
export async function deleteWorkspace(_p: Result | null, form: FormData): Promise<Result> {
  const { supabase, tenant, role } = await requireTenant();
  if (role !== "owner") return { ok: false, error: "owner only" };
  if (String(form.get("confirm") ?? "").trim() !== tenant.slug) return { ok: false, error: "confirm" };
  const admin = createAdminClient();
  const { data: files } = await admin.storage.from("brain-sources").list(tenant.id, { limit: 1000 });
  if (files?.length) await admin.storage.from("brain-sources").remove(files.map((f) => `${tenant.id}/${f.name}`));
  const { data, error } = await supabase.from("tenants").delete().eq("id", tenant.id).select("id");
  if (error || !data?.length) return { ok: false, error: "delete failed" };
  (await cookies()).delete(TENANT_COOKIE);
  redirect("/onboarding");
}
