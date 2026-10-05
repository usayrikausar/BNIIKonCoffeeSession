import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { emailLayout, escapeHtml, sendEmail } from "@/lib/notify/email";
import type { GatewayId, PaymentNotice } from "./gateway";
import { activeGatewayId, getGateway } from "./gateways";
import {
  applyPayment,
  draftInvoice,
  evaluateEntitlement,
  formatRM,
  GRACE_DAYS,
  renewalDue,
  usageAlertDue,
  type Entitlement,
  type Plan,
  type Subscription,
} from "./logic";

export interface BillingState {
  sub: Subscription | null;
  plan: Plan | null;
  periodStart: string | null;
  usage: { conversations: number; ai_replies: number; inbound_messages: number; outbound_messages: number; template_messages: number; input_tokens: number; output_tokens: number };
  /** Set when loadBilling was asked about one conversation: already counted this month? */
  conversationCounted: boolean;
  entitlement: Entitlement;
}

const ZERO = { conversations: 0, ai_replies: 0, inbound_messages: 0, outbound_messages: 0, template_messages: 0, input_tokens: 0, output_tokens: 0 };

/** Works with the service client or an RLS-scoped member client. */
export async function loadBilling(
  db: SupabaseClient,
  tenantId: string,
  now = new Date(),
  opts: { conversationId?: string } = {},
): Promise<BillingState> {
  const [{ data: sub }, { data: period }] = await Promise.all([
    db.from("subscriptions").select("*, plan:plans!subscriptions_plan_id_fkey(*)").eq("tenant_id", tenantId).maybeSingle(),
    db.rpc("current_usage_period", { p_tenant: tenantId }),
  ]);
  const periodStart = (period as string | null) ?? null;
  let usage = ZERO;
  let conversationCounted = false;
  if (periodStart) {
    const [{ data }, counted] = await Promise.all([
      db
        .from("usage_counters")
        .select("conversations, ai_replies, inbound_messages, outbound_messages, template_messages, input_tokens, output_tokens")
        .eq("tenant_id", tenantId)
        .eq("period_start", periodStart)
        .maybeSingle(),
      opts.conversationId
        ? db
            .from("usage_conversations")
            .select("conversation_id")
            .eq("tenant_id", tenantId)
            .eq("period_start", periodStart)
            .eq("conversation_id", opts.conversationId)
            .maybeSingle()
        : Promise.resolve({ data: null }),
    ]);
    if (data) usage = data as typeof ZERO;
    conversationCounted = !!counted.data;
  }
  const plan = (sub ? (Array.isArray(sub.plan) ? sub.plan[0] : sub.plan) : null) as Plan | null;
  const s = sub ? ({ ...sub, plan: undefined } as unknown as Subscription) : null;
  return {
    sub: s,
    plan,
    periodStart,
    usage,
    conversationCounted,
    entitlement: evaluateEntitlement(s, plan, usage.conversations, now, { conversationCounted }),
  };
}

/**
 * Count this conversation for the month (once) and send the 80% / 100%
 * warning when a new level is reached. Service role. Never throws.
 */
export async function countConversation(db: SupabaseClient, tenantId: string, conversationId: string) {
  try {
    const { data, error } = await db.rpc("count_conversation", { p_tenant: tenantId, p_conversation: conversationId });
    if (error) throw new Error(error.message);
    const row = (Array.isArray(data) ? data[0] : data) as { is_new: boolean; total: number } | null;
    if (row?.is_new) await alertUsage(db, tenantId);
    return row;
  } catch (e) {
    console.warn(`[meter] conversation count tenant=${tenantId}: ${e instanceof Error ? e.message : e}`);
    return null;
  }
}

/** Email owners at 80% and at 100% of the month's conversations (each once per month). */
export async function alertUsage(db: SupabaseClient, tenantId: string, now = new Date()) {
  const billing = await loadBilling(db, tenantId, now);
  if (!billing.plan || !billing.sub || billing.plan.id === "internal") return;
  const level = usageAlertDue(billing.sub, billing.periodStart, billing.usage.conversations, billing.plan.conversation_limit);
  if (!level) return;
  // Claim the level first so two parallel chats can't both send it.
  const { data: claimed } = await db.rpc("claim_usage_alert", { p_tenant: tenantId, p_period: billing.periodStart, p_level: level });
  if (claimed !== true) return;
  const { used, limit } = { used: billing.usage.conversations, limit: billing.plan.conversation_limit };
  const link = `${env.appUrl()}/dashboard/billing`;
  const full = level === 100;
  const subject = full
    ? "⚠️ Had perbualan bulan ini telah dicapai / Monthly conversation limit reached"
    : "Makluman: 80% perbualan bulan ini telah digunakan / 80% of this month's conversations used";
  const body = full
    ? `<p>Anda telah menggunakan <b>${used}/${limit}</b> perbualan bulan ini. AI masih menjawab perbualan yang sedang berjalan, tetapi <b>perbualan baharu</b> akan ditanda "Perlukan anda" untuk anda jawab sendiri sehingga bulan baharu bermula atau anda naik taraf.</p>
<p><i>You have used ${used}/${limit} conversations this month. Ongoing chats continue; new chats go to you until the month resets or you upgrade.</i></p>`
    : `<p>Anda telah menggunakan <b>${used}/${limit}</b> perbualan bulan ini (80%). Tiada apa-apa berubah lagi — ini cuma makluman awal.</p>
<p><i>You have used ${used}/${limit} conversations this month (80%). Nothing changes yet — this is an early heads-up.</i></p>`;
  for (const to of await owners(db, tenantId)) {
    const res = await sendEmail({
      to,
      subject,
      html: emailLayout(full ? "Had perbualan dicapai" : "80% perbualan digunakan", `${body}
<p><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Lihat penggunaan / naik taraf</a></p>`),
      text: `${subject}: ${used}/${limit}. ${link}`,
    });
    await db.from("notifications").insert({
      tenant_id: tenantId, kind: "quota", transport: "email", recipient: to,
      status: res.ok ? "sent" : "failed", error: res.error ?? null, sent_at: res.ok ? new Date().toISOString() : null,
    });
  }
}

/** Meter usage (service role). Never throws — metering must not break messaging. */
export async function meter(
  db: SupabaseClient,
  tenantId: string,
  d: { ai?: number; inbound?: number; outbound?: number; templates?: number; inputTokens?: number; outputTokens?: number },
) {
  const { error } = await db.rpc("increment_usage", {
    p_tenant: tenantId,
    p_ai: d.ai ?? 0,
    p_in: d.inbound ?? 0,
    p_out: d.outbound ?? 0,
    p_tpl: d.templates ?? 0,
    p_input_tokens: d.inputTokens ?? 0,
    p_output_tokens: d.outputTokens ?? 0,
  });
  if (error) console.warn(`[meter] tenant=${tenantId}: ${error.message}`);
}

async function owners(db: SupabaseClient, tenantId: string) {
  const { data } = await db.from("tenant_members").select("email").eq("tenant_id", tenantId).eq("role", "owner");
  return (data ?? []).map((m) => m.email as string).filter(Boolean);
}

/**
 * Create (or reuse) an open invoice for `planId` and its payment link.
 * Called from the owner's "Choose plan / Pay" button and by the renewal job.
 */
export async function issueInvoice(
  db: SupabaseClient,
  args: { tenantId: string; planId: string; customerName: string; customerEmail: string; customerPhone?: string | null; gateway?: GatewayId },
  now = new Date(),
) {
  const { data: plan } = await db.from("plans").select("*").eq("id", args.planId).eq("is_active", true).maybeSingle();
  if (!plan || plan.id === "trial" || plan.id === "internal") throw new Error("Pelan tidak sah / invalid plan");
  const { data: sub } = await db.from("subscriptions").select("*").eq("tenant_id", args.tenantId).maybeSingle();
  const draft = draftInvoice(sub as Subscription | null, plan as Plan, now);

  // Reuse an open invoice for the same plan and period instead of piling up bills.
  const { data: existing } = await db
    .from("invoices")
    .select("*")
    .eq("tenant_id", args.tenantId)
    .eq("plan_id", plan.id)
    .eq("status", "open")
    .eq("period_start", draft.periodStart)
    .maybeSingle();
  if (existing?.payment_url || (existing && existing.gateway === "manual")) return existing;

  const gatewayId: GatewayId = existing?.gateway ?? args.gateway ?? activeGatewayId();
  let invoice = existing;
  if (!invoice) {
    const { data: number } = await db.rpc("next_invoice_number");
    const { data, error } = await db
      .from("invoices")
      .insert({
        tenant_id: args.tenantId,
        number,
        plan_id: plan.id,
        description: draft.description,
        amount_cents: draft.amountCents,
        lines: draft.lines,
        period_start: draft.periodStart,
        period_end: draft.periodEnd,
        includes_setup_fee: draft.includesSetupFee,
        gateway: gatewayId,
      })
      .select("*")
      .single();
    if (error || !data) throw new Error(`invoice: ${error?.message}`);
    invoice = data;
  }

  const gateway = getGateway(gatewayId);
  if (gateway && invoice.amount_cents > 0) {
    const bill = await gateway.createBill({
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      amountCents: invoice.amount_cents,
      description: invoice.description,
      customerName: args.customerName,
      customerEmail: args.customerEmail,
      customerPhone: args.customerPhone,
      callbackUrl: `${env.appUrl()}/api/billing/callback/${gatewayId}`,
      returnUrl: `${env.appUrl()}/api/billing/return/${gatewayId}`,
    });
    const { data } = await db
      .from("invoices")
      .update({ gateway_bill_id: bill.billId, payment_url: bill.paymentUrl })
      .eq("id", invoice.id)
      .select("*")
      .single();
    invoice = data ?? invoice;
  }
  return invoice;
}

/**
 * Mark an invoice paid and extend the subscription. Idempotent: the
 * open→paid transition is a conditional update, so duplicate callbacks,
 * redirects and admin clicks activate the period exactly once.
 */
export async function markInvoicePaid(
  db: SupabaseClient,
  invoiceId: string,
  opts: { paidAmountCents?: number | null; source: string },
  now = new Date(),
): Promise<"paid" | "already_paid" | "underpaid" | "not_found"> {
  const { data: inv } = await db.from("invoices").select("*").eq("id", invoiceId).maybeSingle();
  if (!inv) return "not_found";
  if (inv.status === "paid") return "already_paid";
  if (opts.paidAmountCents != null && opts.paidAmountCents < inv.amount_cents) {
    console.warn(`[billing] invoice ${inv.number} underpaid: ${opts.paidAmountCents} < ${inv.amount_cents}`);
    return "underpaid";
  }
  const { data: claimed } = await db
    .from("invoices")
    .update({ status: "paid", paid_at: now.toISOString(), paid_amount_cents: opts.paidAmountCents ?? inv.amount_cents })
    .eq("id", inv.id)
    .eq("status", "open")
    .select("id");
  if (!claimed?.length) return "already_paid";

  const { data: sub } = await db.from("subscriptions").select("*").eq("tenant_id", inv.tenant_id).single();
  const next = applyPayment(sub as Subscription, inv, now);
  await db
    .from("subscriptions")
    .update({ ...next, gateway: inv.gateway, next_plan_id: null, updated_at: now.toISOString() })
    .eq("tenant_id", inv.tenant_id);

  const { data: tenant } = await db.from("tenants").select("name").eq("id", inv.tenant_id).single();
  for (const to of await owners(db, inv.tenant_id)) {
    const res = await sendEmail({
      to,
      subject: `Resit ${inv.number} — ${formatRM(inv.amount_cents)} diterima`,
      html: emailLayout(
        "Terima kasih! Bayaran diterima",
        `<p>${escapeHtml(tenant?.name ?? "")}: ${escapeHtml(inv.description)}</p>
<p><b>${formatRM(inv.amount_cents)}</b> · Invois ${escapeHtml(inv.number)}<br/>Aktif sehingga ${new Date(next.current_period_end!).toLocaleDateString("ms-MY")}</p>`,
      ),
      text: `Bayaran diterima: ${inv.number} ${formatRM(inv.amount_cents)} (${opts.source}).`,
    });
    await db.from("notifications").insert({
      tenant_id: inv.tenant_id, kind: "billing", transport: "email", recipient: to,
      status: res.ok ? "sent" : "failed", error: res.error ?? null, sent_at: res.ok ? now.toISOString() : null,
    });
  }
  return "paid";
}

/** Gateway callback/redirect → audit row → (if verified & paid) settle the invoice. */
export async function settleNotice(db: SupabaseClient, gatewayId: GatewayId, notice: PaymentNotice) {
  const { data: inv } = await db.from("invoices").select("id, tenant_id").eq("gateway", gatewayId).eq("gateway_bill_id", notice.billId).maybeSingle();
  const { error: dupErr } = await db.from("payment_events").insert({
    gateway: gatewayId,
    event_key: notice.eventKey,
    invoice_id: inv?.id ?? null,
    tenant_id: inv?.tenant_id ?? null,
    verified: notice.verified,
    paid: notice.paid,
    payload: notice.raw,
  });
  if (dupErr && dupErr.code !== "23505") console.warn(`[billing] payment_events insert: ${dupErr.message}`);
  if (!notice.verified) return { result: "unverified" as const, invoiceId: inv?.id ?? null };
  if (!inv) return { result: "unknown_bill" as const, invoiceId: null };
  if (!notice.paid) return { result: "not_paid" as const, invoiceId: inv.id };
  const result = await markInvoicePaid(db, inv.id, { paidAmountCents: notice.paidAmountCents, source: gatewayId });
  return { result, invoiceId: inv.id };
}

/**
 * Hourly: status transitions + renewal invoices (emailed with a payment link).
 * Customers keep being answered through GRACE_DAYS after the paid period.
 */
export async function runBillingJobs(db: SupabaseClient, now = new Date()) {
  const nowIso = now.toISOString();
  const graceCut = new Date(now.getTime() - GRACE_DAYS * 86_400_000).toISOString();
  await db.from("subscriptions").update({ status: "expired", updated_at: nowIso }).eq("status", "trialing").lt("current_period_end", nowIso);
  await db.from("subscriptions").update({ status: "canceled", updated_at: nowIso }).eq("status", "active").eq("cancel_at_period_end", true).lt("current_period_end", nowIso);
  await db.from("subscriptions").update({ status: "past_due", updated_at: nowIso }).eq("status", "active").lt("current_period_end", nowIso);

  const { data: subs } = await db.from("subscriptions").select("*").in("status", ["active", "past_due"]).neq("plan_id", "internal");
  let issued = 0;
  for (const s of (subs ?? []) as Subscription[]) {
    try {
      const { data: open } = await db.from("invoices").select("id").eq("tenant_id", s.tenant_id).eq("status", "open").limit(1);
      if (!renewalDue(s, !!open?.length, now)) continue;
      if (s.status === "past_due" && s.current_period_end < graceCut) continue; // lapsed: owner restarts from Billing page
      const emails = await owners(db, s.tenant_id);
      const { data: tenant } = await db.from("tenants").select("name").eq("id", s.tenant_id).single();
      const planId = (s as Subscription & { next_plan_id?: string | null }).next_plan_id ?? s.plan_id;
      const inv = await issueInvoice(db, { tenantId: s.tenant_id, planId, customerName: tenant?.name ?? "Layankan", customerEmail: emails[0] ?? "billing@example.com" }, now);
      issued++;
      for (const to of emails) {
        const link = inv.payment_url ?? `${env.appUrl()}/dashboard/billing`;
        await sendEmail({
          to,
          subject: `Invois ${inv.number}: ${formatRM(inv.amount_cents)} — langganan Layankan`,
          html: emailLayout(
            "Invois langganan bulan depan",
            `<p>${escapeHtml(inv.description)} · <b>${formatRM(inv.amount_cents)}</b></p>
<p>Tempoh: ${new Date(inv.period_start).toLocaleDateString("ms-MY")} – ${new Date(inv.period_end).toLocaleDateString("ms-MY")}</p>
<p><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Bayar sekarang (FPX)</a></p>`,
          ),
          text: `Invois ${inv.number} ${formatRM(inv.amount_cents)}: ${link}`,
        });
      }
    } catch (e) {
      console.error(`[billing] renewal tenant=${s.tenant_id}: ${e instanceof Error ? e.message : e}`);
    }
  }
  return { issued };
}

/** Email owners once per usage period when the AI pauses for quota/payment reasons. */
export async function alertAiPaused(db: SupabaseClient, tenantId: string, ent: Entitlement, periodStart: string | null) {
  // The limit has its own 100% warning (sent once when it was reached).
  if (ent.reason === "quota_exceeded") return alertUsage(db, tenantId);
  const { data: sub } = await db.from("subscriptions").select("quota_alerted_period").eq("tenant_id", tenantId).maybeSingle();
  // One alert per usage period.
  if (sub?.quota_alerted_period && periodStart && Date.parse(sub.quota_alerted_period) === Date.parse(periodStart)) return;
  await db.from("subscriptions").update({ quota_alerted_period: periodStart }).eq("tenant_id", tenantId);
  const why: Record<string, string> = {
    quota_exceeded: `Had perbualan bulan ini telah dicapai (${ent.used}/${ent.limit}). Perbualan yang sedang berjalan masih dijawab oleh AI.`,
    trial_ended: "Tempoh percubaan anda telah tamat.",
    payment_overdue: "Bayaran langganan telah tertunggak melebihi tempoh tangguh.",
    canceled: "Langganan anda telah dibatalkan.",
  };
  const link = `${env.appUrl()}/dashboard/billing`;
  for (const to of await owners(db, tenantId)) {
    const res = await sendEmail({
      to,
      subject: "⚠️ AI Layankan dihentikan sementara — pelanggan menunggu anda",
      html: emailLayout(
        "AI dihentikan sementara",
        `<p>${escapeHtml(why[ent.reason] ?? ent.reason)}</p><p>Mesej pelanggan masih diterima dan disimpan. Perbualan yang AI tidak jawab ditanda "Perlukan anda".</p>
<p><a href="${link}" style="display:inline-block;background:#0f766e;color:#fff;padding:10px 16px;border-radius:8px;text-decoration:none">Naik taraf / bayar</a></p>`,
      ),
      text: `${why[ent.reason] ?? ent.reason} ${link}`,
    });
    await db.from("notifications").insert({
      tenant_id: tenantId, kind: "quota", transport: "email", recipient: to,
      status: res.ok ? "sent" : "failed", error: res.error ?? null, sent_at: res.ok ? new Date().toISOString() : null,
    });
  }
}

/** Enforce plan caps on team size and WhatsApp numbers (checked before adding one more). */
export async function checkPlanCap(db: SupabaseClient, tenantId: string, kind: "members" | "whatsapp"): Promise<string | null> {
  const { plan } = await loadBilling(db, tenantId);
  if (!plan) return null;
  if (kind === "members") {
    const [{ count: members }, { count: invites }] = await Promise.all([
      db.from("tenant_members").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId),
      db.from("tenant_invites").select("*", { count: "exact", head: true }).eq("tenant_id", tenantId).is("accepted_at", null),
    ]);
    if ((members ?? 0) + (invites ?? 0) >= plan.max_members) {
      return `Pelan ${plan.name} membenarkan ${plan.max_members} akaun staf. Naik taraf untuk tambah. / Plan allows ${plan.max_members} staff logins.`;
    }
  } else {
    const { count } = await db
      .from("channel_connections")
      .select("*", { count: "exact", head: true })
      .eq("tenant_id", tenantId)
      .eq("channel", "whatsapp")
      .neq("status", "disconnected");
    if ((count ?? 0) >= plan.max_whatsapp_numbers + 1) {
      // +1: one standby connection is always allowed so a number can be migrated between transports.
      return `Pelan ${plan.name} membenarkan ${plan.max_whatsapp_numbers} nombor WhatsApp. / Plan allows ${plan.max_whatsapp_numbers} WhatsApp number(s).`;
    }
  }
  return null;
}
