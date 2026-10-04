"use server";
import { randomInt } from "node:crypto";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { putCredential, getCredential } from "@/lib/channels/credentials";
import {
  exchangeCodeForToken,
  fetchPhoneNumber,
  fetchWabaOwner,
  listTemplates,
  registerPhoneNumber,
  subscribeAppToWaba,
} from "@/lib/channels/whatsapp/meta";
import { countTemplateVariables } from "@/lib/channels/whatsapp/policy";
import { getAdapter } from "@/lib/channels/registry";
import type { ChannelProvider } from "@/lib/channels/types";
import { env } from "@/lib/env";
import { checkPlanCap } from "@/lib/billing/service";

type Result = { ok: boolean; error?: string; warning?: string; connectionId?: string };
const OWNERS = ["client", "layankan", "reseller", "unknown"] as const;
const MURPATI_UNAVAILABLE =
  "Murpati belum tersedia — menunggu dokumentasi API Murpati. Sila sambung terus melalui Meta. / Murpati is not available yet (waiting for Murpati's API docs). Please connect directly with Meta.";

async function ownerCtx() {
  const ctx = await requireTenant();
  if (ctx.role !== "owner") throw new Error("Hanya pemilik / Owner only");
  return ctx;
}

async function hasActiveWhatsapp(tenantId: string) {
  const { data } = await createAdminClient()
    .from("channel_connections")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("channel", "whatsapp")
    .eq("is_active", true)
    .maybeSingle();
  return !!data;
}

/**
 * Meta Embedded Signup finished in the browser: exchange the code, record the
 * client's own WABA + number, subscribe our app for webhooks, register the number.
 * Becomes active only if the workspace has no active WhatsApp yet (otherwise it
 * waits as a standby connection — see EXIT_RUNBOOK.md).
 */
export async function completeMetaSignup(input: { code: string; phoneNumberId: string; wabaId: string }): Promise<Result> {
  try {
    const { tenant } = await ownerCtx();
    if (!/^\d{5,25}$/.test(input.phoneNumberId) || !/^\d{5,25}$/.test(input.wabaId) || !input.code) {
      return { ok: false, error: "Maklumat pendaftaran tidak lengkap / Incomplete signup data" };
    }
    const cap = await checkPlanCap(createAdminClient(), tenant.id, "whatsapp");
    if (cap) return { ok: false, error: cap };
    const token = await exchangeCodeForToken(input.code);
    const [phone, owner] = await Promise.all([fetchPhoneNumber(input.phoneNumberId, token), fetchWabaOwner(input.wabaId, token)]);
    const ownerKind = owner.businessId && owner.businessId === env.metaPlatformBusinessId() ? "layankan" : owner.businessId ? "client" : "unknown";

    const admin = createAdminClient();
    const active = !(await hasActiveWhatsapp(tenant.id));
    const { data: conn, error } = await admin
      .from("channel_connections")
      .insert({
        tenant_id: tenant.id,
        channel: "whatsapp",
        provider: "meta_cloud",
        is_active: active,
        status: active ? "connected" : "pending",
        display_phone_number: phone.display_phone_number ?? null,
        phone_number_id: input.phoneNumberId,
        waba_id: input.wabaId,
        meta_business_id: owner.businessId,
        meta_business_owner: ownerKind,
        waba_owner: ownerKind,
        owner_legal_name: owner.businessName,
        settings: { verified_name: phone.verified_name ?? null, connected_via: "embedded_signup" },
      })
      .select("id")
      .single();
    if (error || !conn) {
      if (error?.code === "23505") return { ok: false, error: "Nombor ini sudah aktif di ruang kerja lain / This number is already live in another workspace" };
      return { ok: false, error: "Tidak dapat menyimpan sambungan / Could not save connection" };
    }
    await putCredential(tenant.id, conn.id, "access_token", token);

    const warnings: string[] = [];
    try {
      await subscribeAppToWaba(input.wabaId, token);
    } catch (e) {
      warnings.push(`webhook subscribe: ${e instanceof Error ? e.message : e}`);
    }
    const pin = String(randomInt(0, 1_000_000)).padStart(6, "0");
    try {
      await registerPhoneNumber(input.phoneNumberId, token, pin);
      await putCredential(tenant.id, conn.id, "two_step_pin", pin);
    } catch (e) {
      // Already-registered numbers (e.g. moving from another provider) keep their existing PIN.
      warnings.push(`register: ${e instanceof Error ? e.message : e}`);
    }
    await syncTemplatesFor(tenant.id, conn.id, input.wabaId, token).catch((e) => warnings.push(`templates: ${e instanceof Error ? e.message : e}`));
    revalidatePath("/dashboard/channels");
    return { ok: true, connectionId: conn.id, warning: warnings.join(" · ") || undefined };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 300) : "failed" };
  }
}

/** Portability record: who owns the Meta Business + WABA (should be the client). */
export async function saveOwnership(_p: Result | null, form: FormData): Promise<Result> {
  try {
    const { supabase, tenant } = await ownerCtx();
    const pick = (k: string) => {
      const v = String(form.get(k) ?? "unknown");
      return (OWNERS as readonly string[]).includes(v) ? v : "unknown";
    };
    const { error } = await supabase
      .from("channel_connections")
      .update({
        meta_business_owner: pick("meta_business_owner"),
        waba_owner: pick("waba_owner"),
        meta_business_id: String(form.get("meta_business_id") ?? "").trim() || null,
        waba_id: String(form.get("waba_id") ?? "").trim() || null,
        owner_legal_name: String(form.get("owner_legal_name") ?? "").trim().slice(0, 200) || null,
        owner_contact_email: String(form.get("owner_contact_email") ?? "").trim().slice(0, 200) || null,
        ownership_verified_at: form.get("verified") === "on" ? new Date().toISOString() : null,
      })
      .eq("tenant_id", tenant.id)
      .eq("id", String(form.get("connection_id") ?? ""));
    revalidatePath("/dashboard/channels");
    return error ? { ok: false, error: "save failed" } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "failed" };
  }
}

/** Per-tenant transport switch (Murpati ↔ Meta direct). No code change, no deploy. */
export async function switchProvider(connectionId: string): Promise<Result> {
  try {
    const { supabase, tenant } = await ownerCtx();
    // Never route customers through a transport whose adapter is a stub.
    const { data: conn } = await supabase.from("channel_connections").select("provider").eq("tenant_id", tenant.id).eq("id", connectionId).maybeSingle();
    if (!conn) return { ok: false, error: "not found" };
    const meta = getAdapter(conn.provider as ChannelProvider).metadata();
    if (!meta.available) return { ok: false, error: conn.provider === "murpati" ? MURPATI_UNAVAILABLE : (meta.unavailableReason ?? "unavailable") };
    const { error } = await supabase.rpc("switch_active_connection", { p_tenant: tenant.id, p_connection: connectionId });
    revalidatePath("/dashboard", "layout");
    return error ? { ok: false, error: error.code === "23505" ? "Nombor ini aktif di ruang kerja lain" : error.message } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "failed" };
  }
}

export async function disconnectConnection(connectionId: string): Promise<Result> {
  try {
    const { tenant } = await ownerCtx();
    const admin = createAdminClient();
    await admin.from("channel_credentials").update({ is_current: false, revoked_at: new Date().toISOString() })
      .eq("tenant_id", tenant.id).eq("connection_id", connectionId);
    await admin.from("channel_connections").update({ is_active: false, status: "disconnected" })
      .eq("tenant_id", tenant.id).eq("id", connectionId);
    revalidatePath("/dashboard/channels");
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "failed" };
  }
}

async function syncTemplatesFor(tenantId: string, connectionId: string, wabaId: string, token: string) {
  const templates = await listTemplates(wabaId, token);
  const admin = createAdminClient();
  if (!templates.length) return 0;
  await admin.from("message_templates").upsert(
    templates.map((t) => ({
      tenant_id: tenantId,
      connection_id: connectionId,
      name: t.name,
      language: t.language,
      category: t.category,
      status: t.status,
      body_text: t.body_text,
      variable_count: t.variable_count,
      source: "meta_sync",
      updated_at: new Date().toISOString(),
    })),
    { onConflict: "tenant_id,name,language" },
  );
  return templates.length;
}

export async function syncTemplates(connectionId: string): Promise<Result> {
  try {
    const { tenant } = await ownerCtx();
    const admin = createAdminClient();
    const { data: conn } = await admin.from("channel_connections").select("id, provider, waba_id").eq("tenant_id", tenant.id).eq("id", connectionId).single();
    if (!conn || conn.provider !== "meta_cloud" || !conn.waba_id) return { ok: false, error: "Hanya untuk sambungan Meta / Meta connections only" };
    const token = await getCredential(tenant.id, conn.id, "access_token");
    if (!token) return { ok: false, error: "missing token" };
    const n = await syncTemplatesFor(tenant.id, conn.id, conn.waba_id, token);
    revalidatePath("/dashboard/channels");
    return { ok: true, warning: `${n} template` };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message.slice(0, 300) : "failed" };
  }
}

/** For Murpati (or templates created elsewhere): record an APPROVED template by name. */
export async function addTemplate(_p: Result | null, form: FormData): Promise<Result> {
  try {
    const { supabase, tenant } = await ownerCtx();
    const name = String(form.get("name") ?? "").trim();
    const language = String(form.get("language") ?? "ms").trim() || "ms";
    const body = String(form.get("body_text") ?? "").trim().slice(0, 1024);
    if (!/^[a-z0-9_]{1,512}$/.test(name)) return { ok: false, error: "Nama: huruf kecil, nombor, _ sahaja / lowercase, digits, _ only" };
    const { error } = await supabase.from("message_templates").upsert(
      { tenant_id: tenant.id, name, language, body_text: body, variable_count: countTemplateVariables(body), status: "APPROVED", source: "manual", updated_at: new Date().toISOString() },
      { onConflict: "tenant_id,name,language" },
    );
    revalidatePath("/dashboard/channels");
    return error ? { ok: false, error: "save failed" } : { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "failed" };
  }
}

export async function deleteTemplate(id: string): Promise<Result> {
  const { supabase, tenant } = await ownerCtx();
  await supabase.from("message_templates").delete().eq("tenant_id", tenant.id).eq("id", id);
  revalidatePath("/dashboard/channels");
  return { ok: true };
}
