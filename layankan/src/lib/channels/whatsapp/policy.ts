// WhatsApp Business Platform rules that are independent of the transport
// (Murpati or Meta direct). Pure functions — unit tested.

export const SERVICE_WINDOW_HOURS = 24;

/**
 * Free-form messages are only allowed within 24h of the customer's last
 * inbound message (the "customer service window"). Outside it, only
 * approved templates may be sent.
 */
export function isWithinServiceWindow(lastInboundAt: string | Date | null | undefined, now: Date = new Date(), hours = SERVICE_WINDOW_HOURS): boolean {
  if (!lastInboundAt) return false;
  const t = typeof lastInboundAt === "string" ? Date.parse(lastInboundAt) : lastInboundAt.getTime();
  if (!Number.isFinite(t)) return false;
  return now.getTime() - t < hours * 3600 * 1000;
}

export class ServiceWindowClosedError extends Error {
  readonly code = "window_closed";
  constructor() {
    super("The 24-hour WhatsApp customer service window is closed; an approved template is required.");
  }
}

/** WhatsApp ids are digits only, with country code (e.g. 60123456789). */
export function normalizeWaId(raw: string): string | null {
  let d = raw.replace(/[^\d]/g, "");
  if (d.startsWith("0")) d = "6" + d; // local Malaysian format 012… → 6012…
  return d.length >= 8 && d.length <= 15 ? d : null;
}

export function waMeLink(displayNumber: string, text?: string): string | null {
  const id = normalizeWaId(displayNumber);
  if (!id) return null;
  return `https://wa.me/${id}${text ? `?text=${encodeURIComponent(text)}` : ""}`;
}

/** Customer opt-out keywords (BM + EN). After this, no proactive follow-ups. */
export function isOptOut(body: string): boolean {
  // Also the quick-reply buttons a promotion template may carry, e.g. "Stop promotions" / "Berhenti promosi".
  return /^\s*((stop|berhenti|henti)(\s+(promo|promosi|promotions?))?|unsubscribe|jangan\s+hantar(\s+lagi)?|tak\s+nak\s+terima(\s+(mesej|promosi))?)\s*[.!]*\s*$/i.test(body);
}

/** Count {{1}}, {{2}}… placeholders in a template body. */
export function countTemplateVariables(body: string): number {
  const nums = [...body.matchAll(/\{\{\s*(\d+)\s*\}\}/g)].map((m) => Number(m[1]));
  return nums.length ? Math.max(...nums) : 0;
}

/** Replace {name}, {business}, {need} tokens used in follow-up settings. Empty values become "-". */
export function renderTokens(tpl: string, vars: Record<string, string | null | undefined>): string {
  return tpl.replace(/\{(\w+)\}/g, (_, k: string) => {
    const v = vars[k];
    return v && v.trim() ? v.trim() : k === "name" ? "" : "-";
  }).replace(/\s+([,.!?])/g, "$1").replace(/\s{2,}/g, " ").trim();
}

/** Template variables must be non-empty single-line strings (Meta rejects newlines / empty). */
export function sanitizeTemplateVariable(v: string | null | undefined, max = 200): string {
  const s = (v ?? "").replace(/[\r\n\t]+/g, " ").replace(/\s{4,}/g, "   ").trim().slice(0, max);
  return s || "-";
}

const STATUS_RANK: Record<string, number> = { queued: 0, sent: 1, delivered: 2, read: 3 };

/** Delivery receipts can arrive out of order: never move a status backwards ("failed" always wins). */
export function shouldApplyStatus(current: string, incoming: string): boolean {
  if (incoming === "failed") return current !== "failed";
  if (current === "failed") return false;
  return (STATUS_RANK[incoming] ?? -1) > (STATUS_RANK[current] ?? -1);
}
