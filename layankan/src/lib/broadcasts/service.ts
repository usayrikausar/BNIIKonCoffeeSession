import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { loadConnection, sendOutbound } from "@/lib/agent/engine";
import { loadBilling } from "@/lib/billing/service";
import { localParts } from "@/lib/notify/digest";
import { templatePreview } from "@/lib/followup/plan";
import type { ChannelConnection } from "@/lib/channels/types";
import {
  dailyCap,
  inSendingHours,
  matchesAudience,
  MIN_DAYS_BETWEEN_BROADCASTS,
  renderVariables,
  templateProblem,
  type Audience,
  type TemplateProblem,
  type TemplateRow,
} from "./rules";

const PAGE = 1000;
const DAY_MS = 86_400_000;

async function pages<T>(q: (from: number, to: number) => PromiseLike<{ data: T[] | null }>): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += PAGE) {
    const { data } = await q(from, from + PAGE - 1);
    out.push(...(data ?? []));
    if (!data || data.length < PAGE) return out;
  }
}

export interface AudiencePreview {
  /** Opted in (latest consent is a grant, no STOP) on WhatsApp. */
  optedIn: number;
  /** …of whom match the chosen lead scores. */
  matching: number;
  /** …of whom got a broadcast in the last 7 days (skipped). */
  tooRecent: number;
  /** Will receive it. */
  eligible: { contactId: string; consentEventId: number }[];
  skipped: { contactId: string; consentEventId: number }[];
}

/**
 * Who would get a broadcast. Starts from the consent history (never from the
 * contact list), so a contact without a current opt-in can't even be considered.
 * The database checks every recipient again anyway.
 */
export async function buildAudience(db: SupabaseClient, tenantId: string, audience: Audience, now = new Date()): Promise<AudiencePreview> {
  const consents = await pages<{ contact_id: string; event_id: number }>((a, b) =>
    db.from("marketing_consent_current").select("contact_id, event_id").eq("tenant_id", tenantId).eq("action", "granted").eq("channel", "whatsapp").order("contact_id").range(a, b));
  const ids = consents.map((c) => c.contact_id);
  const contacts = new Map<string, { opted_out_at: string | null }>();
  const scores = new Map<string, string | null>();
  for (let i = 0; i < ids.length; i += 200) {
    const chunk = ids.slice(i, i + 200);
    const [{ data: cs }, { data: convs }] = await Promise.all([
      db.from("contacts").select("id, opted_out_at").eq("tenant_id", tenantId).eq("channel", "whatsapp").in("id", chunk),
      db.from("conversations").select("contact_id, lead_score, last_message_at").eq("tenant_id", tenantId).eq("channel", "whatsapp").eq("is_test", false).in("contact_id", chunk).order("last_message_at", { ascending: false }),
    ]);
    for (const c of cs ?? []) contacts.set(c.id, c);
    for (const v of convs ?? []) if (!scores.has(v.contact_id)) scores.set(v.contact_id, v.lead_score);
  }
  const since = new Date(now.getTime() - MIN_DAYS_BETWEEN_BROADCASTS * DAY_MS).toISOString();
  const recent = new Set(
    (await pages<{ contact_id: string }>((a, b) =>
      db.from("broadcast_recipients").select("contact_id").eq("tenant_id", tenantId).in("status", ["queued", "sending", "sent"]).gt("queued_at", since).range(a, b))).map((r) => r.contact_id),
  );
  const opted = consents.filter((c) => contacts.has(c.contact_id) && !contacts.get(c.contact_id)!.opted_out_at);
  const matching = opted.filter((c) => matchesAudience(scores.get(c.contact_id), audience));
  const toRow = (c: { contact_id: string; event_id: number }) => ({ contactId: c.contact_id, consentEventId: c.event_id });
  return {
    optedIn: opted.length,
    matching: matching.length,
    tooRecent: matching.filter((c) => recent.has(c.contact_id)).length,
    eligible: matching.filter((c) => !recent.has(c.contact_id)).map(toRow),
    skipped: matching.filter((c) => recent.has(c.contact_id)).map(toRow),
  };
}

/** The business's live, official WhatsApp connection (broadcasts never go through anything else). */
export async function broadcastConnection(db: SupabaseClient, tenantId: string): Promise<ChannelConnection | null> {
  const { data } = await db
    .from("channel_connections")
    .select("id, tenant_id, channel, provider, phone_number_id, waba_id, display_phone_number, settings, page_id, ig_account_id")
    .eq("tenant_id", tenantId).eq("channel", "whatsapp").eq("provider", "meta_cloud").eq("is_active", true).eq("official_api", true)
    .maybeSingle();
  return (data as ChannelConnection | null) ?? null;
}

export async function loadTemplate(db: SupabaseClient, tenantId: string, name: string, language: string) {
  const { data } = await db.from("message_templates").select("name, language, status, category, source, body_text, variable_count")
    .eq("tenant_id", tenantId).eq("name", name).eq("language", language).maybeSingle();
  return (data as TemplateRow | null) ?? null;
}

/** Monthly allowance: limit, used, left. */
export async function broadcastAllowance(db: SupabaseClient, tenantId: string) {
  const billing = await loadBilling(db, tenantId);
  const limit = Number((billing.plan as unknown as { broadcast_message_limit?: number } | null)?.broadcast_message_limit ?? 0);
  let used = 0;
  if (billing.periodStart) {
    const { data } = await db.from("usage_counters").select("broadcast_messages").eq("tenant_id", tenantId).eq("period_start", billing.periodStart).maybeSingle();
    used = Number(data?.broadcast_messages ?? 0);
  }
  return { limit, used, left: Math.max(limit - used, 0), billing };
}

export type CreateResult =
  | { ok: true; broadcastId: string; queued: number; skipped: number; status: "scheduled" | "sending" }
  | { ok: false; status: number; error: string; problem?: TemplateProblem };

/** Create a broadcast and queue its recipients (server only; the caller has checked the owner). */
export async function createBroadcast(
  db: SupabaseClient,
  args: { tenantId: string; userId: string; name: string; templateName: string; templateLanguage: string; variables: string[]; audience: Audience; scheduledAt: Date | null; now?: Date },
): Promise<CreateResult> {
  const now = args.now ?? new Date();
  const conn = await broadcastConnection(db, args.tenantId);
  if (!conn) return { ok: false, status: 409, error: "Sambungkan WhatsApp (Meta) dahulu / Connect WhatsApp (Meta) first" };
  const tpl = await loadTemplate(db, args.tenantId, args.templateName, args.templateLanguage);
  if (!tpl) return { ok: false, status: 400, error: "unknown_template" };
  const problem = templateProblem(tpl);
  if (problem) return { ok: false, status: 400, error: "template_not_allowed", problem };
  if (args.variables.length < tpl.variable_count) return { ok: false, status: 400, error: "missing_variables" };

  const { left, billing } = await broadcastAllowance(db, args.tenantId);
  if (!billing.entitlement.aiAllowed && billing.entitlement.reason !== "quota_exceeded") {
    return { ok: false, status: 402, error: "Langganan tidak aktif / Subscription not active" };
  }
  const aud = await buildAudience(db, args.tenantId, args.audience, now);
  if (!aud.eligible.length) return { ok: false, status: 400, error: "Tiada penerima / No recipients" };
  if (aud.eligible.length > left) {
    return { ok: false, status: 409, error: `Baki bulan ini ${left} mesej, penerima ${aud.eligible.length}. Pilih kurang penerima atau naik taraf. / ${left} messages left this month for ${aud.eligible.length} recipients.` };
  }

  const sendNow = !args.scheduledAt || args.scheduledAt.getTime() <= now.getTime();
  const { data: b, error } = await db.from("broadcasts").insert({
    tenant_id: args.tenantId, connection_id: conn.id, name: args.name, template_name: tpl.name, template_language: tpl.language,
    template_variables: args.variables.slice(0, tpl.variable_count), audience: args.audience,
    status: "scheduled", scheduled_at: (sendNow ? now : args.scheduledAt!).toISOString(), created_by: args.userId,
  }).select("id").single();
  if (error || !b) throw new Error(`broadcast insert failed: ${error?.message}`);

  // Queue. The database refuses anyone without a current opt-in, or messaged in the last 7 days.
  let queued = 0;
  let skipped = 0;
  const insert = async (rows: { contactId: string; consentEventId: number }[], status: "queued" | "skipped") => {
    for (let i = 0; i < rows.length; i += 500) {
      const chunk = rows.slice(i, i + 500);
      const toRow = (r: { contactId: string; consentEventId: number }) => ({
        broadcast_id: b.id, contact_id: r.contactId, tenant_id: args.tenantId, consent_event_id: r.consentEventId, status,
        ...(status === "skipped" ? { skip_reason: "too_recent" } : {}),
      });
      const { error: e } = await db.from("broadcast_recipients").insert(chunk.map(toRow));
      if (!e) { status === "queued" ? (queued += chunk.length) : (skipped += chunk.length); continue; }
      // Someone changed between preview and now (e.g. wrote STOP): insert one by one, dropping the refused.
      for (const r of chunk) {
        const { error: e1 } = await db.from("broadcast_recipients").insert(toRow(r));
        if (!e1) status === "queued" ? queued++ : skipped++;
      }
    }
  };
  await insert(aud.eligible, "queued");
  await insert(aud.skipped, "skipped");
  await db.from("broadcasts").update({
    recipients_total: queued, skipped_count: skipped,
    ...(sendNow ? { status: "sending", started_at: now.toISOString() } : {}),
  }).eq("tenant_id", args.tenantId).eq("id", b.id);
  return { ok: true, broadcastId: b.id, queued, skipped, status: sendNow ? "sending" : "scheduled" };
}

/** Stop a scheduled or sending broadcast. Messages already sent stay sent. */
export async function cancelBroadcast(db: SupabaseClient, tenantId: string, broadcastId: string, userId: string) {
  const { data } = await db.from("broadcasts").update({ status: "cancelled", cancelled_by: userId, finished_at: new Date().toISOString() })
    .eq("tenant_id", tenantId).eq("id", broadcastId).in("status", ["scheduled", "sending"]).select("id");
  if (!data?.length) return false;
  await db.from("broadcast_recipients").update({ status: "skipped", skip_reason: "cancelled" })
    .eq("tenant_id", tenantId).eq("broadcast_id", broadcastId).eq("status", "queued");
  await refreshCounts(db, tenantId, broadcastId);
  return true;
}

async function refreshCounts(db: SupabaseClient, tenantId: string, broadcastId: string) {
  const count = async (status: string) => {
    const { count: n } = await db.from("broadcast_recipients").select("contact_id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).eq("broadcast_id", broadcastId).eq("status", status);
    return n ?? 0;
  };
  const [sent, failed, skipped, queued, sending] = await Promise.all(["sent", "failed", "skipped", "queued", "sending"].map(count));
  await db.from("broadcasts").update({ sent_count: sent, failed_count: failed, skipped_count: skipped }).eq("tenant_id", tenantId).eq("id", broadcastId);
  return { queued, sending };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Send queued broadcast messages. Runs hourly (cron) and right after "Send now".
 * Per message: consent re-checked by the database at claim time, monthly
 * allowance taken atomically, 9am–9pm only, daily cap per number, paced.
 */
export async function runBroadcasts(
  db: SupabaseClient,
  opts: { now?: Date; onlyId?: string; budgetMs?: number; intervalMs?: number } = {},
) {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const budget = opts.budgetMs ?? 240_000;
  const interval = opts.intervalMs ?? Number(process.env.BROADCAST_SEND_INTERVAL_MS ?? 100);
  const out = { sent: 0, failed: 0, skipped: 0, waiting: [] as string[] };

  // Scheduled ones that are due start now.
  await db.from("broadcasts").update({ status: "sending", started_at: now.toISOString() })
    .eq("status", "scheduled").lte("scheduled_at", now.toISOString());
  let q = db.from("broadcasts").select("id, tenant_id, connection_id, template_name, template_language, template_variables, tenant:tenants(name, timezone, status, default_locale)")
    .eq("status", "sending").order("started_at").limit(20);
  if (opts.onlyId) q = q.eq("id", opts.onlyId);
  const { data: list } = await q;

  for (const b of list ?? []) {
    const tenant = (Array.isArray(b.tenant) ? b.tenant[0] : b.tenant) as { name: string; timezone: string; status: string; default_locale: string | null };
    const tenantId = b.tenant_id as string;
    if (!inSendingHours(localParts(now, tenant.timezone).hour)) { out.waiting.push(`${b.id}:quiet_hours`); continue; }
    const billing = await loadBilling(db, tenantId, now);
    if (tenant.status !== "live" || (!billing.entitlement.aiAllowed && billing.entitlement.reason !== "quota_exceeded")) { out.waiting.push(`${b.id}:billing`); continue; }
    const conn = await loadConnection(db, tenantId, b.connection_id as string);
    const { data: live } = await db.from("channel_connections").select("is_active").eq("tenant_id", tenantId).eq("id", b.connection_id).maybeSingle();
    if (!conn || !live?.is_active) { out.waiting.push(`${b.id}:connection`); continue; }
    const { count: sent24h } = await db.from("broadcast_recipients").select("contact_id", { count: "exact", head: true })
      .eq("tenant_id", tenantId).eq("status", "sent").gt("sent_at", new Date(now.getTime() - DAY_MS).toISOString());
    let room = dailyCap(conn.settings) - (sent24h ?? 0);
    const tpl = await loadTemplate(db, tenantId, b.template_name as string, b.template_language as string);
    const lang = tenant.default_locale === "en" ? "en" : "ms";

    while (room > 0 && Date.now() - started < budget) {
      const { data: batch } = await db.from("broadcast_recipients").select("contact_id, contact:contacts(external_id, name)")
        .eq("tenant_id", tenantId).eq("broadcast_id", b.id).eq("status", "queued").limit(Math.min(room, 50));
      if (!batch?.length) break;
      for (const r of batch) {
        if (room <= 0 || Date.now() - started >= budget) break;
        // Claim: the database re-checks the opt-in here (a STOP since queuing stops it).
        const { data: claimed, error: claimErr } = await db.from("broadcast_recipients").update({ status: "sending" })
          .eq("tenant_id", tenantId).eq("broadcast_id", b.id).eq("contact_id", r.contact_id).eq("status", "queued").select("contact_id");
        if (claimErr) {
          await db.from("broadcast_recipients").update({ status: "skipped", skip_reason: "consent_withdrawn" })
            .eq("tenant_id", tenantId).eq("broadcast_id", b.id).eq("contact_id", r.contact_id).eq("status", "queued");
          out.skipped++;
          continue;
        }
        if (!claimed?.length) continue; // cancelled, or another run took it
        const { data: allowed } = await db.rpc("consume_broadcast_message", { p_tenant: tenantId });
        if (allowed !== true) {
          await db.from("broadcast_recipients").update({ status: "skipped", skip_reason: "plan_limit" })
            .eq("tenant_id", tenantId).eq("broadcast_id", b.id).in("status", ["queued", "sending"]);
          out.skipped++;
          room = 0;
          break;
        }
        const contact = (Array.isArray(r.contact) ? r.contact[0] : r.contact) as { external_id: string; name: string | null } | null;
        try {
          const { data: conv } = await db.from("conversations").select("id, last_inbound_at").eq("tenant_id", tenantId).eq("contact_id", r.contact_id)
            .eq("channel", "whatsapp").eq("is_test", false).order("last_message_at", { ascending: false }).limit(1).maybeSingle();
          if (!conv || !contact) throw Object.assign(new Error("no conversation"), { skip: "no_conversation" });
          const variables = renderVariables((b.template_variables as string[]) ?? [], { name: contact.name, business: tenant.name }, lang);
          const msg = await sendOutbound(db, {
            tenantId, conversationId: conv.id, body: templatePreview(tpl?.body_text, b.template_name as string, variables), sender: "system",
            connection: conn, channel: "whatsapp", contactExternalId: contact.external_id, lastInboundAt: conv.last_inbound_at as string | null,
            template: { name: b.template_name as string, language: b.template_language as string, variables },
            metadata: { broadcast_id: b.id },
          });
          if (msg.status === "failed") {
            const { data: m } = await db.from("messages").select("error").eq("tenant_id", tenantId).eq("id", msg.id).maybeSingle();
            throw new Error(m?.error ?? "send failed");
          }
          await db.from("broadcast_recipients").update({ status: "sent", message_id: msg.id, sent_at: new Date().toISOString() })
            .eq("tenant_id", tenantId).eq("broadcast_id", b.id).eq("contact_id", r.contact_id);
          out.sent++;
          room--;
        } catch (e) {
          await db.rpc("release_broadcast_message", { p_tenant: tenantId }); // not sent → not counted
          const skip = (e as { skip?: string }).skip;
          await db.from("broadcast_recipients").update(skip ? { status: "skipped", skip_reason: skip } : { status: "failed", error: (e instanceof Error ? e.message : "failed").slice(0, 300) })
            .eq("tenant_id", tenantId).eq("broadcast_id", b.id).eq("contact_id", r.contact_id);
          if (skip) out.skipped++; else out.failed++;
        }
        if (interval > 0) await sleep(interval);
      }
    }
    const { queued } = await refreshCounts(db, tenantId, b.id as string);
    if (!queued) {
      await db.from("broadcasts").update({ status: "sent", finished_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("id", b.id).eq("status", "sending");
    } else if (room <= 0) out.waiting.push(`${b.id}:daily_cap`);
  }
  return out;
}

export { templateProblem };
