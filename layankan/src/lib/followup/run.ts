import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { brainFromRow } from "@/lib/brain/schema";
import { loadConnection, sendOutbound } from "@/lib/agent/engine";
import { localParts } from "@/lib/notify/digest";
import type { ChannelKind } from "@/lib/channels/types";
import { MAX_FOLLOW_UPS, planFollowUp, templatePreview, type FollowUpCandidate } from "./plan";
import { countConversation, loadBilling } from "@/lib/billing/service";

/** Hourly: nudge SUAM leads who went quiet, per each tenant's follow-up settings. */
export async function runFollowUps(db: SupabaseClient, now = new Date()) {
  const { data: brains } = await db
    .from("business_brains")
    .select("tenant_id, follow_up, tenant:tenants!inner(name, timezone, status)")
    .eq("follow_up->>enabled", "true")
    .eq("tenant.status", "live");
  let sent = 0;
  const skipped: Record<string, number> = {};
  for (const b of brains ?? []) {
    const tenant = (Array.isArray(b.tenant) ? b.tenant[0] : b.tenant) as { name: string; timezone: string };
    const cfg = brainFromRow({ follow_up: b.follow_up }).follow_up;
    // No proactive messages from accounts whose AI is paused (unpaid / trial ended).
    // The monthly conversation limit is checked per chat below.
    const tenantBilling = await loadBilling(db, b.tenant_id, now);
    if (!tenantBilling.entitlement.aiAllowed && tenantBilling.entitlement.reason !== "quota_exceeded") {
      skipped["billing"] = (skipped["billing"] ?? 0) + 1;
      continue;
    }
    const minDelay = Math.min(cfg.delay_hours, cfg.second_delay_hours);
    const cutoff = new Date(now.getTime() - minDelay * 3600 * 1000).toISOString();
    const { data: convs } = await db
      .from("conversations")
      .select("id, lead_score, status, is_test, channel, channel_connection_id, follow_up_count, follow_up_disabled, last_follow_up_at, last_message_at, last_inbound_at, lead_details, contact:contacts(external_id, opted_out_at)")
      .eq("tenant_id", b.tenant_id)
      .eq("lead_score", "SUAM")
      .eq("status", "ai")
      .eq("is_test", false)
      .eq("channel", "whatsapp")
      .eq("follow_up_disabled", false)
      .lt("follow_up_count", Math.min(cfg.max_attempts, MAX_FOLLOW_UPS))
      .lt("last_message_at", cutoff)
      .limit(100);
    const localHour = localParts(now, tenant.timezone).hour;
    for (const c of convs ?? []) {
      try {
        const contact = (Array.isArray(c.contact) ? c.contact[0] : c.contact) as { external_id: string; opted_out_at: string | null } | null;
        const { data: lastMsg } = await db
          .from("messages")
          .select("sender")
          .eq("tenant_id", b.tenant_id)
          .eq("conversation_id", c.id)
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        const plan = planFollowUp(c as FollowUpCandidate, cfg, {
          now,
          localHour,
          lastSender: lastMsg?.sender ?? null,
          optedOut: !!contact?.opted_out_at,
          businessName: tenant.name,
        });
        if (plan.action === "skip") {
          skipped[plan.reason] = (skipped[plan.reason] ?? 0) + 1;
          continue;
        }
        // A follow-up keeps a chat active this month: allowed only if the chat is
        // already counted, or the monthly limit still has room.
        if (tenantBilling.entitlement.reason === "quota_exceeded") {
          const perChat = await loadBilling(db, b.tenant_id, now, { conversationId: c.id });
          if (!perChat.entitlement.aiAllowed) {
            skipped["monthly limit"] = (skipped["monthly limit"] ?? 0) + 1;
            continue;
          }
        }
        const connection = await loadConnection(db, b.tenant_id, c.channel_connection_id as string | null);
        let body: string;
        let template = null;
        if (plan.action === "template") {
          const { data: tpl } = await db
            .from("message_templates")
            .select("body_text")
            .eq("tenant_id", b.tenant_id)
            .eq("name", plan.template.name)
            .eq("language", plan.template.language)
            .maybeSingle();
          body = templatePreview(tpl?.body_text, plan.template.name, plan.template.variables);
          template = plan.template;
        } else body = plan.text;
        // Claim first so a concurrent run can't double-send.
        const { data: claimed } = await db
          .from("conversations")
          .update({ follow_up_count: (c.follow_up_count as number) + 1, last_follow_up_at: now.toISOString() })
          .eq("tenant_id", b.tenant_id)
          .eq("id", c.id)
          .eq("follow_up_count", c.follow_up_count)
          .select("id");
        if (!claimed?.length) continue;
        await sendOutbound(db, {
          tenantId: b.tenant_id,
          conversationId: c.id,
          body,
          sender: "ai",
          connection,
          channel: c.channel as ChannelKind,
          contactExternalId: contact?.external_id ?? "",
          lastInboundAt: c.last_inbound_at as string | null,
          template,
          metadata: { follow_up: (c.follow_up_count as number) + 1 },
        });
        await countConversation(db, b.tenant_id, c.id);
        sent++;
      } catch (e) {
        console.error(`[follow-up] tenant=${b.tenant_id} conversation=${c.id} failed: ${e instanceof Error ? e.message : e}`);
      }
    }
  }
  return { sent, skipped };
}
