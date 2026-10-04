// Pure billing rules — no I/O, unit tested.

export interface Plan {
  id: string;
  name: string;
  description?: string;
  price_cents: number;
  setup_fee_cents: number;
  /** Customer conversations included per month. One chat counts once a month, however long. */
  conversation_limit: number;
  /** @deprecated Stage 3 — limits are per conversation now. */
  ai_reply_limit?: number;
  max_whatsapp_numbers: number;
  max_members: number;
  trial_days: number;
  is_public?: boolean;
}

export interface Subscription {
  tenant_id: string;
  plan_id: string;
  status: "trialing" | "active" | "past_due" | "canceled" | "expired";
  billing_anchor: string;
  current_period_start: string;
  current_period_end: string;
  setup_fee_paid: boolean;
  cancel_at_period_end?: boolean;
  quota_alerted_period?: string | null;
  usage_alert_period?: string | null;
  usage_alert_level?: number;
}

/** Days after "paid through" during which the AI keeps working while an invoice is unpaid. */
export const GRACE_DAYS = 7;
/** Warn the owner when this share of the month's conversations is used (and again at 100%). */
export const WARN_AT = 0.8;
/** Renewal invoice is issued this many days before the paid period ends. */
export const RENEWAL_LEAD_DAYS = 7;

export type EntitlementReason = "ok" | "quota_exceeded" | "trial_ended" | "payment_overdue" | "canceled" | "no_subscription";

export interface Entitlement {
  aiAllowed: boolean;
  reason: EntitlementReason;
  state: "trialing" | "active" | "grace" | "blocked" | "unknown";
  /** Conversations included this month. */
  limit: number;
  /** Conversations used this month. */
  used: number;
  percent: number;
  warn: boolean;
  paidThrough: string | null;
  graceEndsAt: string | null;
}

const DAY = 86_400_000;

/**
 * May the AI answer? `used` = conversations counted this month.
 * `conversationCounted` = this chat was already counted this month: a chat
 * that started under the limit is never cut off half-way, so the limit only
 * stops NEW conversations.
 */
export function evaluateEntitlement(
  sub: Subscription | null,
  plan: Plan | null,
  used: number,
  now: Date = new Date(),
  opts: { conversationCounted?: boolean } = {},
): Entitlement {
  if (!sub || !plan) {
    // Fail OPEN: a billing bug must never silence every customer.
    return { aiAllowed: true, reason: "no_subscription", state: "unknown", limit: 0, used, percent: 0, warn: false, paidThrough: null, graceEndsAt: null };
  }
  const limit = plan.conversation_limit;
  const percent = limit > 0 ? Math.min(999, Math.round((used / limit) * 100)) : 100;
  const end = Date.parse(sub.current_period_end);
  const graceEnd = end + GRACE_DAYS * DAY;
  const base = {
    limit,
    used,
    percent,
    warn: limit > 0 && used >= limit * WARN_AT,
    paidThrough: sub.current_period_end,
    graceEndsAt: sub.status === "trialing" ? null : new Date(graceEnd).toISOString(),
  };
  const t = now.getTime();
  if (sub.status === "canceled" || sub.status === "expired") {
    if (t > end) return { ...base, aiAllowed: false, reason: "canceled", state: "blocked" };
  }
  if (sub.status === "trialing" && t > end) return { ...base, aiAllowed: false, reason: "trial_ended", state: "blocked" };
  let state: Entitlement["state"] = sub.status === "trialing" ? "trialing" : "active";
  if (sub.status !== "trialing" && t > end) {
    if (t > graceEnd) return { ...base, aiAllowed: false, reason: "payment_overdue", state: "blocked" };
    state = "grace";
  }
  if (used >= limit && !opts.conversationCounted) return { ...base, aiAllowed: false, reason: "quota_exceeded", state };
  return { ...base, aiAllowed: true, reason: "ok", state };
}

/** Usage warning level reached: 0, 80 or 100 (% of the month's conversations). */
export function usageLevel(used: number, limit: number): 0 | 80 | 100 {
  if (limit <= 0) return 0;
  if (used >= limit) return 100;
  if (used >= limit * WARN_AT) return 80;
  return 0;
}

/** Which warning (if any) to send now: only a higher level than already sent this period. */
export function usageAlertDue(
  sub: Pick<Subscription, "usage_alert_period" | "usage_alert_level"> | null,
  periodStart: string | null,
  used: number,
  limit: number,
): 0 | 80 | 100 {
  const level = usageLevel(used, limit);
  if (!level || !periodStart) return 0;
  const samePeriod = !!sub?.usage_alert_period && Date.parse(sub.usage_alert_period) === Date.parse(periodStart);
  const sent = samePeriod ? (sub?.usage_alert_level ?? 0) : 0;
  return level > sent ? level : 0;
}

/** Add calendar months, clamping to the last day of the month (Jan 31 + 1 → Feb 28/29). */
export function addMonths(d: Date, n: number): Date {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + n);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
}

export interface InvoiceDraft {
  kind: "new" | "renewal";
  planId: string;
  periodStart: string;
  periodEnd: string;
  lines: { description: string; amount_cents: number }[];
  amountCents: number;
  includesSetupFee: boolean;
  description: string;
}

/**
 * What to bill for `plan`. Same plan + still paid → renewal starting when the
 * current period ends. Otherwise (trial, other plan, lapsed) → a new period
 * starting now. No proration: switching plans mid-period starts a fresh month.
 */
export function draftInvoice(sub: Subscription | null, plan: Plan, now: Date = new Date()): InvoiceDraft {
  const paidEnd = sub ? Date.parse(sub.current_period_end) : 0;
  const renewal = !!sub && sub.status !== "trialing" && sub.plan_id === plan.id && paidEnd > now.getTime() - GRACE_DAYS * DAY;
  const start = renewal ? new Date(paidEnd) : now;
  const end = addMonths(start, 1);
  const fmt = (d: Date) => d.toISOString().slice(0, 10);
  const lines = [{ description: `Langganan ${plan.name} (${fmt(start)} – ${fmt(end)})`, amount_cents: plan.price_cents }];
  const includesSetupFee = plan.setup_fee_cents > 0 && !sub?.setup_fee_paid;
  if (includesSetupFee) lines.push({ description: `Yuran setup ${plan.name}`, amount_cents: plan.setup_fee_cents });
  return {
    kind: renewal ? "renewal" : "new",
    planId: plan.id,
    periodStart: start.toISOString(),
    periodEnd: end.toISOString(),
    lines,
    amountCents: lines.reduce((s, l) => s + l.amount_cents, 0),
    includesSetupFee,
    description: `Layankan ${plan.name}${includesSetupFee ? " + setup" : ""}`,
  };
}

export interface PaidInvoice {
  plan_id: string;
  period_start: string;
  period_end: string;
  includes_setup_fee: boolean;
}

/**
 * Subscription after an invoice is paid. A renewal extends "paid through"
 * and keeps the usage anchor; a new period (first payment, plan change,
 * lapsed account) re-anchors usage from the period start.
 */
export function applyPayment(sub: Subscription, inv: PaidInvoice, now: Date = new Date()): Partial<Subscription> & { status: Subscription["status"] } {
  const startsLater = Date.parse(inv.period_start) > now.getTime() + 60_000;
  const isRenewal = startsLater && sub.plan_id === inv.plan_id && sub.status !== "trialing";
  const currentEnd = Date.parse(sub.current_period_end);
  const newEnd = isRenewal ? Math.max(currentEnd, Date.parse(inv.period_end)) : Date.parse(inv.period_end);
  return {
    plan_id: inv.plan_id,
    status: "active",
    ...(isRenewal ? {} : { billing_anchor: inv.period_start, current_period_start: inv.period_start }),
    current_period_end: new Date(newEnd).toISOString(),
    setup_fee_paid: sub.setup_fee_paid || inv.includes_setup_fee,
    cancel_at_period_end: false,
    quota_alerted_period: null,
  };
}

/** Should the renewal job issue the next invoice now? */
export function renewalDue(sub: Subscription, hasOpenInvoice: boolean, now: Date = new Date()): boolean {
  if (sub.status !== "active" && sub.status !== "past_due") return false;
  if (sub.cancel_at_period_end || hasOpenInvoice) return false;
  if (sub.plan_id === "internal") return false;
  return Date.parse(sub.current_period_end) - now.getTime() <= RENEWAL_LEAD_DAYS * DAY;
}

export function formatRM(cents: number): string {
  return `RM${(cents / 100).toLocaleString("en-MY", { minimumFractionDigits: cents % 100 ? 2 : 0, maximumFractionDigits: 2 })}`;
}
