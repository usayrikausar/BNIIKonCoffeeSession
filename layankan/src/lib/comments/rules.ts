// Comment-to-chat (R5). Pure rules — no I/O, unit tested.

export const PRIVATE_REPLY_MAX_AGE_DAYS = 7; // Meta allows a private reply within 7 days of the comment
export const ONE_PER_AUTHOR_HOURS = 24;

export interface CommentToChat {
  enabled: boolean;
  keywords: string[];
  opening_message: string;
  public_reply: string;
}

const norm = (s: string) => ` ${s.toLowerCase().normalize("NFKD").replace(/\p{M}/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;

/** First owner keyword that appears as a whole word/phrase in the comment ("harga?" matches "harga"; "hargai" doesn't). */
export function matchKeyword(text: string, keywords: string[]): string | null {
  const t = norm(text);
  for (const k of keywords) {
    const n = norm(k);
    if (n.trim() && t.includes(n)) return k;
  }
  return null;
}

export type CommentDecision =
  | "replied" | "ignored_disabled" | "ignored_own_comment" | "ignored_no_keyword"
  | "skipped_expired" | "skipped_opted_out" | "skipped_already_replied_to_author" | "skipped_plan_limit";

/** Decide what to do with one comment. Order matters: cheap, certain reasons first. */
export function decideComment(
  c: { authorId: string; text: string; createdAt: Date },
  cfg: CommentToChat,
  ctx: { businessAccountIds: string[]; now: Date; optedOut: boolean; repliedToAuthorRecently: boolean; planAllowsNewChat: boolean },
): { decision: CommentDecision; keyword: string | null } {
  if (!cfg.enabled || !cfg.keywords.length) return { decision: "ignored_disabled", keyword: null };
  if (ctx.businessAccountIds.includes(c.authorId)) return { decision: "ignored_own_comment", keyword: null }; // never reply to ourselves (loops)
  const keyword = matchKeyword(c.text, cfg.keywords);
  if (!keyword) return { decision: "ignored_no_keyword", keyword: null };
  if (ctx.now.getTime() - c.createdAt.getTime() > PRIVATE_REPLY_MAX_AGE_DAYS * 86_400_000) return { decision: "skipped_expired", keyword };
  if (ctx.optedOut) return { decision: "skipped_opted_out", keyword };
  if (ctx.repliedToAuthorRecently) return { decision: "skipped_already_replied_to_author", keyword };
  if (!ctx.planAllowsNewChat) return { decision: "skipped_plan_limit", keyword };
  return { decision: "replied", keyword };
}

export function openingMessage(cfg: CommentToChat, v: { name: string | null; business: string }, lang: "ms" | "en"): string {
  const t = cfg.opening_message.trim();
  const fill = (s: string) => s.replace(/\{name\}/g, v.name?.split(" ")[0] || "").replace(/\{business\}/g, v.business).replace(/\s+([,!.?])/g, "$1").replace(/\s{2,}/g, " ").trim();
  if (t) return fill(t).slice(0, 1000);
  return fill(lang === "ms"
    ? `Hai {name}! 👋 Terima kasih atas komen anda di post {business}. Ada apa yang boleh kami bantu? Balas di sini ya 😊`
    : `Hi {name}! 👋 Thanks for your comment on {business}'s post. How can we help? Just reply here 😊`);
}
