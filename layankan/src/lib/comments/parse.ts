// Pure parser for comment webhooks on the business's own posts:
//  • Facebook Page: object "page", entry[].changes[] with field "feed", value.item "comment", verb "add"
//  • Instagram:     object "instagram", entry[].changes[] with field "comments"

type Obj = Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : null);
const obj = (v: unknown) => (v && typeof v === "object" ? (v as Obj) : {});

export interface IncomingComment {
  platform: "facebook" | "instagram";
  accountId: string; // Page id / Instagram account id (routing key)
  commentId: string;
  postId: string;
  authorId: string;
  authorName: string | null;
  text: string;
  createdAt: Date;
}

export function parseCommentWebhook(payload: unknown): IncomingComment[] {
  const p = obj(payload);
  const out: IncomingComment[] = [];
  if (p.object !== "page" && p.object !== "instagram") return out;
  for (const entry of Array.isArray(p.entry) ? (p.entry as Obj[]) : []) {
    const accountId = str(entry.id);
    if (!accountId) continue;
    for (const ch of Array.isArray(entry.changes) ? (entry.changes as Obj[]) : []) {
      const v = obj(ch.value);
      if (p.object === "page" && ch.field === "feed" && v.item === "comment" && v.verb === "add") {
        const from = obj(v.from);
        const commentId = str(v.comment_id), postId = str(v.post_id), authorId = str(from.id), text = str(v.message);
        if (!commentId || !postId || !authorId || !text) continue;
        const t = typeof v.created_time === "number" ? new Date(v.created_time * 1000) : new Date();
        out.push({ platform: "facebook", accountId, commentId, postId, authorId, authorName: str(from.name), text: text.slice(0, 4000), createdAt: t });
      } else if (p.object === "instagram" && ch.field === "comments") {
        const from = obj(v.from);
        const commentId = str(v.id), postId = str(obj(v.media).id), authorId = str(from.id), text = str(v.text);
        if (!commentId || !postId || !authorId || !text) continue;
        out.push({ platform: "instagram", accountId, commentId, postId, authorId, authorName: str(from.username), text: text.slice(0, 4000), createdAt: new Date() });
      }
    }
  }
  return out;
}
