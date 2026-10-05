import { describe, expect, it } from "vitest";
import { decideComment, matchKeyword, openingMessage, type CommentToChat } from "@/lib/comments/rules";
import { parseCommentWebhook } from "@/lib/comments/parse";
import { BrainSchema, brainFromRow } from "@/lib/brain/schema";

const cfg = (o: Partial<CommentToChat> = {}): CommentToChat => ({ enabled: true, keywords: ["harga", "how much"], opening_message: "", public_reply: "", ...o });
const now = new Date("2026-10-04T10:00:00Z");
const ctx = (o = {}) => ({ businessAccountIds: ["PAGE1", "IG1"], now, optedOut: false, repliedToAuthorRecently: false, planAllowsNewChat: true, ...o });
const comment = (o = {}) => ({ authorId: "U1", text: "Harga berapa?", createdAt: now, ...o });

describe("matchKeyword", () => {
  it("matches whole words and phrases, case- and accent-insensitive", () => {
    expect(matchKeyword("HARGA??", ["harga"])).toBe("harga");
    expect(matchKeyword("so how much is it", ["how much"])).toBe("how much");
    expect(matchKeyword("Café open?", ["cafe"])).toBe("cafe");
    expect(matchKeyword("info.", ["info"])).toBe("info");
  });
  it("does not match inside other words", () => {
    expect(matchKeyword("saya hargai", ["harga"])).toBeNull();
    expect(matchKeyword("pricey", ["price"])).toBeNull();
    expect(matchKeyword("how is much", ["how much"])).toBeNull();
  });
  it("ignores empty keywords", () => {
    expect(matchKeyword("anything", ["", "  ", "!!"])).toBeNull();
  });
});

describe("decideComment", () => {
  it("replies to a matching comment", () => {
    expect(decideComment(comment(), cfg(), ctx())).toEqual({ decision: "replied", keyword: "harga" });
  });
  it("does nothing when off or without keywords", () => {
    expect(decideComment(comment(), cfg({ enabled: false }), ctx()).decision).toBe("ignored_disabled");
    expect(decideComment(comment(), cfg({ keywords: [] }), ctx()).decision).toBe("ignored_disabled");
  });
  it("never replies to the business's own comments (no loops)", () => {
    expect(decideComment(comment({ authorId: "PAGE1" }), cfg(), ctx()).decision).toBe("ignored_own_comment");
    expect(decideComment(comment({ authorId: "IG1" }), cfg(), ctx()).decision).toBe("ignored_own_comment");
  });
  it("ignores comments without a keyword", () => {
    expect(decideComment(comment({ text: "Cantik!" }), cfg(), ctx()).decision).toBe("ignored_no_keyword");
  });
  it("skips comments older than 7 days (Meta's private-reply limit)", () => {
    const old = new Date(now.getTime() - 8 * 86_400_000);
    expect(decideComment(comment({ createdAt: old }), cfg(), ctx()).decision).toBe("skipped_expired");
    const recent = new Date(now.getTime() - 6 * 86_400_000);
    expect(decideComment(comment({ createdAt: recent }), cfg(), ctx()).decision).toBe("replied");
  });
  it("respects opt-out, one-per-person-per-day and the plan", () => {
    expect(decideComment(comment(), cfg(), ctx({ optedOut: true })).decision).toBe("skipped_opted_out");
    expect(decideComment(comment(), cfg(), ctx({ repliedToAuthorRecently: true })).decision).toBe("skipped_already_replied_to_author");
    expect(decideComment(comment(), cfg(), ctx({ planAllowsNewChat: false })).decision).toBe("skipped_plan_limit");
  });
});

describe("openingMessage", () => {
  it("fills {name} (first name) and {business}", () => {
    expect(openingMessage(cfg({ opening_message: "Hai {name}, terima kasih dari {business}!" }), { name: "Aisyah Rahman", business: "Kedai G" }, "ms"))
      .toBe("Hai Aisyah, terima kasih dari Kedai G!");
  });
  it("reads cleanly without a name", () => {
    expect(openingMessage(cfg({ opening_message: "Hai {name}, apa khabar?" }), { name: null, business: "X" }, "ms")).toBe("Hai, apa khabar?");
  });
  it("has a friendly default in both languages", () => {
    expect(openingMessage(cfg(), { name: "Ali", business: "Kedai G" }, "ms")).toMatch(/^Hai Ali! .*Kedai G/);
    expect(openingMessage(cfg(), { name: "Ali", business: "Kedai G" }, "en")).toMatch(/^Hi Ali! .*Kedai G/);
  });
});

describe("parseCommentWebhook", () => {
  it("parses a Facebook Page comment", () => {
    const out = parseCommentWebhook({
      object: "page",
      entry: [{ id: "PAGE1", changes: [{ field: "feed", value: { item: "comment", verb: "add", comment_id: "C1", post_id: "P1", from: { id: "U1", name: "Ali" }, message: "harga?", created_time: 1_790_000_000 } }] }],
    });
    expect(out).toEqual([{ platform: "facebook", accountId: "PAGE1", commentId: "C1", postId: "P1", authorId: "U1", authorName: "Ali", text: "harga?", createdAt: new Date(1_790_000_000_000) }]);
  });
  it("ignores non-comment feed changes (likes, edits, deletes, posts)", () => {
    const v = { comment_id: "C1", post_id: "P1", from: { id: "U1" }, message: "x" };
    expect(parseCommentWebhook({ object: "page", entry: [{ id: "PAGE1", changes: [
      { field: "feed", value: { ...v, item: "reaction", verb: "add" } },
      { field: "feed", value: { ...v, item: "comment", verb: "edited" } },
      { field: "feed", value: { ...v, item: "comment", verb: "remove" } },
      { field: "feed", value: { ...v, item: "status", verb: "add" } },
    ] }] })).toEqual([]);
  });
  it("parses an Instagram comment", () => {
    const [c] = parseCommentWebhook({ object: "instagram", entry: [{ id: "IG1", changes: [{ field: "comments", value: { id: "IC1", text: "Price?", from: { id: "IGU1", username: "ali.k" }, media: { id: "M1" } } }] }] });
    expect(c).toMatchObject({ platform: "instagram", accountId: "IG1", commentId: "IC1", postId: "M1", authorId: "IGU1", authorName: "ali.k", text: "Price?" });
  });
  it("drops malformed entries and other objects", () => {
    expect(parseCommentWebhook({ object: "whatsapp_business_account", entry: [] })).toEqual([]);
    expect(parseCommentWebhook({ object: "instagram", entry: [{ id: "IG1", changes: [{ field: "comments", value: { id: "IC1" } }] }] })).toEqual([]);
    expect(parseCommentWebhook(null)).toEqual([]);
  });
});

describe("Brain comment_to_chat", () => {
  it("is off by default, and old rows load fine", () => {
    expect(brainFromRow({}).comment_to_chat).toEqual({ enabled: false, keywords: [], opening_message: "", public_reply: "" });
  });
  it("limits keyword count and length", () => {
    const base = brainFromRow({});
    expect(BrainSchema.safeParse({ ...base, comment_to_chat: { ...base.comment_to_chat, keywords: Array(21).fill("x") } }).success).toBe(false);
    expect(BrainSchema.safeParse({ ...base, comment_to_chat: { ...base.comment_to_chat, keywords: ["x".repeat(31)] } }).success).toBe(false);
    expect(BrainSchema.safeParse({ ...base, comment_to_chat: { ...base.comment_to_chat, public_reply: "x".repeat(201) } }).success).toBe(false);
  });
});
