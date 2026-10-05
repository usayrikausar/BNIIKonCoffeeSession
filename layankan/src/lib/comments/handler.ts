import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { brainFromRow } from "@/lib/brain/schema";
import { getCredential } from "@/lib/channels/credentials";
import { graph } from "@/lib/channels/whatsapp/meta";
import { connectionByMessagingId } from "@/lib/chat/ingest";
import { findOrCreateConversation } from "@/lib/chat/conversations";
import { loadBilling } from "@/lib/billing/service";
import type { IncomingComment } from "./parse";
import { decideComment, ONE_PER_AUTHOR_HOURS, openingMessage } from "./rules";

/**
 * Comment-to-chat (R5). For each comment on the business's own post:
 * record it (one row per comment — duplicates and retries stop here), decide,
 * and only for "replied" send ONE private reply (+ optional public reply).
 * The private reply does NOT open Meta's 24h window: nobody can send more
 * until the person writes back, which then becomes a normal AI chat.
 */
export async function handleComments(db: SupabaseClient, comments: IncomingComment[], now = new Date()) {
  const results: { commentId: string; decision: string }[] = [];
  for (const c of comments) {
    try {
      const conn = await connectionByMessagingId(db, c.platform === "facebook" ? "page" : "instagram", c.accountId);
      if (!conn) {
        console.warn(`[comments] no connection for ${c.platform} account ${c.accountId}; comment dropped`);
        continue;
      }
      const tenantId = conn.tenant_id;
      // Claim the comment first: a webhook retry for the same comment does nothing.
      const { data: row, error: claimErr } = await db
        .from("social_comments")
        .insert({ tenant_id: tenantId, connection_id: conn.id, platform: c.platform, post_id: c.postId, comment_id: c.commentId, author_external_id: c.authorId, author_name: c.authorName, body: c.text })
        .select("id")
        .single();
      if (claimErr?.code === "23505") continue;
      if (claimErr || !row) throw new Error(claimErr?.message ?? "could not record comment");

      const [{ data: brainRow }, { data: tenant }, { data: contact }, { data: recent }, billing] = await Promise.all([
        db.from("business_brains").select("*").eq("tenant_id", tenantId).maybeSingle(),
        db.from("tenants").select("name, default_locale").eq("id", tenantId).single(),
        db.from("contacts").select("opted_out_at").eq("tenant_id", tenantId).eq("channel", conn.channel).eq("external_id", c.authorId).maybeSingle(),
        db.from("social_comments").select("id").eq("tenant_id", tenantId).eq("author_external_id", c.authorId).eq("decision", "replied")
          .gt("received_at", new Date(now.getTime() - ONE_PER_AUTHOR_HOURS * 3600_000).toISOString()).limit(1),
        loadBilling(db, tenantId, now),
      ]);
      const cfg = brainFromRow(brainRow).comment_to_chat;
      const { decision, keyword } = decideComment({ authorId: c.authorId, text: c.text, createdAt: c.createdAt }, cfg, {
        businessAccountIds: [conn.page_id, conn.ig_account_id].filter(Boolean) as string[],
        now,
        optedOut: !!contact?.opted_out_at,
        repliedToAuthorRecently: !!recent?.length,
        planAllowsNewChat: billing.entitlement.aiAllowed,
      });
      if (decision !== "replied") {
        await db.from("social_comments").update({ decision, matched_keyword: keyword }).eq("tenant_id", tenantId).eq("id", row.id);
        results.push({ commentId: c.commentId, decision });
        continue;
      }

      const token = await getCredential(tenantId, conn.id, "page_access_token");
      if (!token || !conn.page_id) throw new Error("connection has no Page token");
      const lang = (tenant?.default_locale as "ms" | "en") ?? "ms";
      const text = openingMessage(cfg, { name: c.authorName, business: tenant?.name ?? "" }, lang);
      // ONE private reply, addressed to the comment (Meta's private-replies feature).
      const sent = await graph<{ recipient_id?: string; message_id?: string }>(`${conn.page_id}/messages`, {
        method: "POST",
        token,
        body: { recipient: { comment_id: c.commentId }, message: { text } },
      });
      // Optional short public reply under the comment (best effort).
      if (cfg.public_reply.trim()) {
        await graph(c.platform === "facebook" ? `${c.commentId}/comments` : `${c.commentId}/replies`, {
          method: "POST", token, body: { message: cfg.public_reply.trim().slice(0, 200) },
        }).catch((e) => console.warn(`[comments] public reply failed: ${e instanceof Error ? e.message : e}`));
      }

      // The private reply starts a conversation with the person (Meta tells us their messaging id).
      let conversationId: string | null = null;
      let replyMessageId: string | null = null;
      if (sent.recipient_id) {
        ({ conversationId } = await findOrCreateConversation(db, { tenantId, channel: conn.channel, externalId: sent.recipient_id, contactName: c.authorName }));
        await db.from("conversations").update({ channel_connection_id: conn.id }).eq("tenant_id", tenantId).eq("id", conversationId);
        // Context for staff and the AI: their public comment, then our private reply.
        // Inserted directly: last_inbound_at is NOT set, so Meta's 24h window stays closed until they write back.
        await db.from("messages").insert({
          tenant_id: tenantId, conversation_id: conversationId, direction: "inbound", sender: "customer",
          body: `💬 ${lang === "ms" ? "Komen di post" : "Comment on post"}: "${c.text.slice(0, 1000)}"`, channel: conn.channel, provider: conn.provider,
          status: "received", metadata: { source: "comment", comment_id: c.commentId, post_id: c.postId },
        });
        const { data: m } = await db.from("messages").insert({
          tenant_id: tenantId, conversation_id: conversationId, direction: "outbound", sender: "system", body: text,
          channel: conn.channel, provider: conn.provider, provider_message_id: sent.message_id ?? null, status: "sent",
          metadata: { source: "comment_private_reply", comment_id: c.commentId },
        }).select("id").single();
        replyMessageId = m?.id ?? null;
        await db.from("conversations").update({ last_message_at: new Date().toISOString(), last_message_preview: text.slice(0, 140) }).eq("tenant_id", tenantId).eq("id", conversationId);
      }
      await db.from("social_comments").update({ decision: "replied", matched_keyword: keyword, conversation_id: conversationId, private_reply_message_id: replyMessageId })
        .eq("tenant_id", tenantId).eq("id", row.id);
      results.push({ commentId: c.commentId, decision: "replied" });
    } catch (e) {
      console.error(`[comments] ${c.platform} comment ${c.commentId} failed: ${e instanceof Error ? e.message : e}`);
      await db.from("social_comments").update({ decision: "failed", error: e instanceof Error ? e.message.slice(0, 300) : "failed" })
        .eq("comment_id", c.commentId).eq("decision", "pending");
      results.push({ commentId: c.commentId, decision: "failed" });
    }
  }
  return results;
}
