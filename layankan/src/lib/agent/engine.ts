import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { brainFromRow } from "@/lib/brain/schema";
import { getAdapter } from "@/lib/channels/registry";
import type { ChannelConnection, ChannelKind, ChannelProvider } from "@/lib/channels/types";
import { notifyHandoff } from "@/lib/notify/handoff";
import { isWithinServiceWindow, ServiceWindowClosedError } from "@/lib/channels/whatsapp/policy";
import { callClaude, type AgentLlm, type LlmResult } from "./llm";
import { planTurn } from "./interpret";
import { buildConversationTurn, buildSystemPrompt, PROMPT_TEMPLATE_VERSION, TRANSCRIPT_WINDOW } from "./prompt";
import { mergeLeadDetails } from "./schema";
import { FALLBACK_REPLY } from "./interpret";
import { alertAiPaused, loadBilling, meter } from "@/lib/billing/service";

export interface StoredMessage {
  id: string;
  conversation_id: string;
  direction: "inbound" | "outbound";
  sender: "customer" | "ai" | "human" | "system";
  body: string;
  status: string;
  created_at: string;
}

const MESSAGE_COLUMNS = "id, conversation_id, direction, sender, body, status, created_at";

/** Persist a customer message the moment it arrives (before any AI work). */
export async function recordInbound(
  db: SupabaseClient,
  args: {
    tenantId: string;
    conversationId: string;
    body: string;
    channel: ChannelKind;
    provider: ChannelProvider;
    providerMessageId?: string | null;
  },
): Promise<StoredMessage | null> {
  const now = new Date().toISOString();
  const { data, error } = await db
    .from("messages")
    .insert({
      tenant_id: args.tenantId,
      conversation_id: args.conversationId,
      direction: "inbound",
      sender: "customer",
      body: args.body,
      channel: args.channel,
      provider: args.provider,
      provider_message_id: args.providerMessageId ?? null,
      status: "received",
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error) {
    if (error.code === "23505") return null; // duplicate webhook delivery — already stored
    throw new Error(`could not store inbound message: ${error.message}`);
  }
  const { data: conv } = await db
    .from("conversations")
    .select("customer_message_count, is_test")
    .eq("tenant_id", args.tenantId)
    .eq("id", args.conversationId)
    .single();
  if (conv && !conv.is_test) await meter(db, args.tenantId, { inbound: 1 });
  await db
    .from("conversations")
    .update({
      customer_message_count: (conv?.customer_message_count ?? 0) + 1,
      last_message_at: now,
      last_inbound_at: now,
      last_message_preview: args.body.slice(0, 140),
      // A closed conversation re-opens when the customer writes again.
    })
    .eq("tenant_id", args.tenantId)
    .eq("id", args.conversationId);
  await db
    .from("conversations")
    .update({ status: "ai" })
    .eq("tenant_id", args.tenantId)
    .eq("id", args.conversationId)
    .eq("status", "closed");
  return data as StoredMessage;
}

/**
 * Store an outbound message as "queued", hand it to the channel adapter, then
 * record the delivery result. Our DB row exists before the provider sees it.
 */
export async function sendOutbound(
  db: SupabaseClient,
  args: {
    tenantId: string;
    conversationId: string;
    /** Free text, or for templates a human-readable preview stored in our history. */
    body: string;
    sender: "ai" | "human" | "system";
    sentBy?: string | null;
    connection: ChannelConnection | null;
    channel: ChannelKind;
    contactExternalId: string;
    /** Required for WhatsApp free text: when the customer last wrote (24h window). */
    lastInboundAt?: string | null;
    template?: { name: string; language: string; variables: string[] } | null;
    metadata?: Record<string, unknown>;
  },
): Promise<StoredMessage> {
  if (args.channel !== "web" && !args.connection) throw new Error(`no active ${args.channel} connection for this conversation`);
  const provider: ChannelProvider = args.connection?.provider ?? "web";
  const adapter = getAdapter(provider);
  const windowHours = adapter.metadata().serviceWindowHours;
  // WhatsApp rule: free-form only within 24h of the customer's last message.
  if (!args.template && windowHours != null && !isWithinServiceWindow(args.lastInboundAt, new Date(), windowHours)) {
    throw new ServiceWindowClosedError();
  }
  const { data: row, error } = await db
    .from("messages")
    .insert({
      tenant_id: args.tenantId,
      conversation_id: args.conversationId,
      direction: "outbound",
      sender: args.sender,
      body: args.body,
      channel: args.channel,
      provider,
      status: "queued",
      sent_by: args.sentBy ?? null,
      metadata: { ...(args.metadata ?? {}), ...(args.template ? { template: args.template } : {}) },
    })
    .select(MESSAGE_COLUMNS)
    .single();
  if (error || !row) throw new Error(`could not store outbound message: ${error?.message}`);

  let result: { status: string; providerMessageId: string | null; error?: string | null };
  try {
    const conn: ChannelConnection = args.connection ?? {
      id: "web",
      tenant_id: args.tenantId,
      channel: "web",
      provider: "web",
      phone_number_id: null,
      waba_id: null,
      display_phone_number: null,
      settings: {},
    };
    result = await adapter.sendMessage(conn, {
      to: args.contactExternalId,
      body: args.body,
      ...(args.template ? { template: args.template } : {}),
    });
  } catch (e) {
    result = { status: "failed", providerMessageId: null, error: e instanceof Error ? e.message : "send failed" };
  }
  const now = new Date().toISOString();
  await db
    .from("messages")
    .update({
      status: result.status,
      provider_message_id: result.providerMessageId,
      error: result.error ?? null,
      status_updated_at: now,
    })
    .eq("tenant_id", args.tenantId)
    .eq("id", row.id);
  await db.from("message_status_events").insert({ tenant_id: args.tenantId, message_id: row.id, status: result.status });
  const { data: touched } = await db
    .from("conversations")
    .update({ last_message_at: now, last_message_preview: args.body.slice(0, 140) })
    .eq("tenant_id", args.tenantId)
    .eq("id", args.conversationId)
    .select("is_test");
  if (touched?.[0] && !touched[0].is_test && result.status !== "failed") {
    await meter(db, args.tenantId, { outbound: 1, templates: args.template ? 1 : 0 });
  }
  return { ...(row as StoredMessage), status: result.status };
}

export interface AgentTurnResult {
  reply: StoredMessage | null;
  handedOff: boolean;
  paused: boolean;
}

/**
 * Run the agent for the latest customer message in a conversation.
 * Uses the service-role client: every query is explicitly scoped by tenant_id.
 */
export async function runAgentTurn(
  db: SupabaseClient,
  args: { tenantId: string; conversationId: string; inboundMessageId: string },
  llm: AgentLlm = callClaude,
): Promise<AgentTurnResult> {
  const { tenantId, conversationId } = args;

  const { data: conv, error: convErr } = await db
    .from("conversations")
    .select("id, tenant_id, status, is_test, channel, channel_connection_id, lead_details, last_inbound_at, contact:contacts(external_id), tenant:tenants(name, default_locale)")
    .eq("tenant_id", tenantId)
    .eq("id", conversationId)
    .single();
  if (convErr || !conv) throw new Error("conversation not found");

  // Owner has taken over (or AI handed off): AI stays silent until handed back.
  if (conv.status !== "ai") return { reply: null, handedOff: false, paused: true };

  // Plan limits / unpaid / trial ended → no AI call. The message is already
  // stored; the customer gets a polite holding reply and the owner takes over.
  // (Owner test chats are never blocked or metered.)
  if (!conv.is_test) {
    const billing = await loadBilling(db, tenantId);
    if (!billing.entitlement.aiAllowed) {
      const tenantRow = one(conv.tenant) as { default_locale: "ms" | "en" } | null;
      const contactRow = one(conv.contact) as { external_id: string } | null;
      const connection = await loadConnection(db, tenantId, conv.channel_connection_id as string | null);
      const reply = await sendOutbound(db, {
        tenantId,
        conversationId,
        body: FALLBACK_REPLY[tenantRow?.default_locale ?? "ms"],
        sender: "system",
        connection,
        channel: conv.channel as ChannelKind,
        contactExternalId: contactRow?.external_id ?? "",
        lastInboundAt: (conv.last_inbound_at as string | null) ?? new Date().toISOString(),
      }).catch(() => null);
      await db.from("ai_assessments").insert({
        tenant_id: tenantId,
        conversation_id: conversationId,
        inbound_message_id: args.inboundMessageId,
        reply_message_id: reply?.id ?? null,
        handoff_required: true,
        handoff_decision: { handoff: true, reasons: ["billing_paused"], billing: billing.entitlement.reason },
        model: "none",
        prompt_template_version: PROMPT_TEMPLATE_VERSION,
        error: `ai paused: ${billing.entitlement.reason}`,
      });
      await db
        .from("conversations")
        .update({ status: "needs_human", handoff_reason: "billing_paused", handoff_at: new Date().toISOString() })
        .eq("tenant_id", tenantId)
        .eq("id", conversationId)
        .eq("status", "ai");
      await alertAiPaused(db, tenantId, billing.entitlement, billing.periodStart).catch((e) =>
        console.error(`[agent] quota alert failed tenant=${tenantId}: ${e instanceof Error ? e.message : e}`),
      );
      return { reply, handedOff: true, paused: false };
    }
  }

  const [{ data: brainRow }, { data: history }, connection] = await Promise.all([
    db.from("business_brains").select("*").eq("tenant_id", tenantId).single(),
    db
      .from("messages")
      .select("sender, body, created_at")
      .eq("tenant_id", tenantId)
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(TRANSCRIPT_WINDOW),
    loadConnection(db, tenantId, conv.channel_connection_id as string | null),
  ]);
  const brain = brainFromRow(brainRow);
  const tenant = one(conv.tenant) as { name: string; default_locale: "ms" | "en" } | null;
  const contact = one(conv.contact) as { external_id: string } | null;

  const system = buildSystemPrompt(brain);
  const turn = buildConversationTurn([...(history ?? [])].reverse());

  const started = Date.now();
  let result: LlmResult | null = null;
  let thrown: string | null = null;
  try {
    result = await llm(system, turn);
  } catch (e) {
    // Log the class of failure only — never request payloads or keys.
    thrown = e instanceof Error ? `${e.name}: ${e.message.slice(0, 200)}` : "llm call failed";
    console.error(`[agent] tenant=${tenantId} conversation=${conversationId} llm error: ${thrown}`);
  }
  const latency = Date.now() - started;

  const plan = planTurn(result, brain, { locale: tenant?.default_locale ?? "ms", thrownError: thrown });

  const reply = await sendOutbound(db, {
    tenantId,
    conversationId,
    body: plan.replyText,
    sender: plan.output ? "ai" : "system",
    connection,
    channel: conv.channel as ChannelKind,
    contactExternalId: contact?.external_id ?? "",
    lastInboundAt: (conv.last_inbound_at as string | null) ?? new Date().toISOString(),
  });

  if (!conv.is_test && plan.output) {
    await meter(db, tenantId, { ai: 1, inputTokens: result?.inputTokens ?? 0, outputTokens: result?.outputTokens ?? 0 });
  }

  const a = plan.output?.assessment;
  await db.from("ai_assessments").insert({
    tenant_id: tenantId,
    conversation_id: conversationId,
    inbound_message_id: args.inboundMessageId,
    reply_message_id: reply.id,
    score: a?.score ?? null,
    confidence: a?.confidence ?? null,
    reason: a?.reason ?? null,
    captured: a?.captured ?? {},
    next_action: a?.next_action ?? null,
    handoff_required: plan.decision.handoff,
    handoff_decision: plan.decision,
    raw_output: plan.output ?? null,
    model: result?.model ?? "unknown",
    prompt_template_version: PROMPT_TEMPLATE_VERSION,
    brain_version: (brainRow?.version as number | undefined) ?? null,
    input_tokens: result?.inputTokens ?? null,
    output_tokens: result?.outputTokens ?? null,
    latency_ms: latency,
    stop_reason: result?.stopReason ?? null,
    error: plan.error,
  });

  const details = a ? mergeLeadDetails(conv.lead_details as Record<string, string>, a.captured) : (conv.lead_details as Record<string, string>);
  const patch: Record<string, unknown> = { lead_details: details };
  if (a) {
    patch.lead_score = a.score;
    patch.score_confidence = a.confidence;
    patch.score_reason = a.reason;
    patch.next_action = a.next_action;
  }
  if (plan.decision.handoff) {
    patch.status = "needs_human";
    patch.handoff_reason = plan.decision.reasons.join(",");
    patch.handoff_at = new Date().toISOString();
  }
  // Only flip status if the conversation is still AI-handled (owner may have taken over meanwhile).
  await db.from("conversations").update(patch).eq("tenant_id", tenantId).eq("id", conversationId).eq("status", "ai");

  if (plan.decision.handoff && !conv.is_test) {
    const lastCustomer = (history ?? []).find((m) => m.sender === "customer")?.body ?? "";
    try {
      await notifyHandoff(db, {
        tenantId,
        tenantName: tenant?.name ?? "",
        conversationId,
        reasons: plan.decision.reasons,
        score: a?.score ?? null,
        details,
        lastCustomerMessage: lastCustomer,
        ownerWhatsapp: brain.handoff_rules.owner_whatsapp || null,
      });
    } catch (e) {
      console.error(`[agent] handoff notification failed tenant=${tenantId}: ${e instanceof Error ? e.message : e}`);
    }
  }

  return { reply, handedOff: plan.decision.handoff, paused: false };
}

/**
 * Webhook path: several WhatsApp messages often arrive in a burst ("Hi" /
 * "nak tanya" / "harga?"). Wait briefly and only answer if this is still the
 * customer's latest message, so the AI replies once to the whole burst.
 */
export async function respondIfLatest(
  db: SupabaseClient,
  args: { tenantId: string; conversationId: string; inboundMessageId: string },
  opts: { debounceMs?: number; llm?: AgentLlm } = {},
): Promise<AgentTurnResult | null> {
  await new Promise((r) => setTimeout(r, opts.debounceMs ?? 2500));
  const { data: latest } = await db
    .from("messages")
    .select("id")
    .eq("tenant_id", args.tenantId)
    .eq("conversation_id", args.conversationId)
    .eq("direction", "inbound")
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (latest && latest.id !== args.inboundMessageId) return null;
  return runAgentTurn(db, args, opts.llm);
}

export async function loadConnection(db: SupabaseClient, tenantId: string, id: string | null): Promise<ChannelConnection | null> {
  if (!id) return null;
  const { data } = await db
    .from("channel_connections")
    .select("id, tenant_id, channel, provider, phone_number_id, waba_id, display_phone_number, settings")
    .eq("tenant_id", tenantId)
    .eq("id", id)
    .maybeSingle();
  return (data as ChannelConnection | null) ?? null;
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}
