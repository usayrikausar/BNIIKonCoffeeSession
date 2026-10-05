import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { isOptinAgreement, OPTIN_TEXT_VERSION, optinQuestion, withinAnswerWindow, type Lang } from "./optin";

/** Has this contact ever had a consent event (granted or withdrawn)? */
export async function hasConsentRecord(db: SupabaseClient, tenantId: string, contactId: string): Promise<boolean> {
  const { data } = await db.from("marketing_consent_events").select("id").eq("tenant_id", tenantId).eq("contact_id", contactId).limit(1);
  return !!data?.length;
}

/**
 * Record a marketing opt-in if this inbound message is the customer agreeing
 * (PROMO) to the question we asked, within the answer window, and they haven't
 * answered already. The consent record stores the EXACT question text the
 * customer saw (taken from the stored question message) and their reply as
 * evidence. Returns true if consent was recorded.
 */
export async function recordOptinIfAgreed(
  db: SupabaseClient,
  a: { tenantId: string; conversationId: string; contactId: string; channel: string; askedAt: string | null; inboundMessageId: string; inboundBody: string },
  now = new Date(),
): Promise<boolean> {
  if (a.channel !== "whatsapp" || !isOptinAgreement(a.inboundBody) || !withinAnswerWindow(a.askedAt, now)) return false;
  const [{ data: answered }, { data: question }] = await Promise.all([
    db.from("marketing_consent_events").select("id").eq("tenant_id", a.tenantId).eq("contact_id", a.contactId).gte("created_at", a.askedAt!).limit(1),
    db
      .from("messages")
      .select("id, body, metadata, status")
      .eq("tenant_id", a.tenantId)
      .eq("conversation_id", a.conversationId)
      .eq("direction", "outbound")
      .not("metadata->>optin_version", "is", null)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
  ]);
  if (answered?.length) return false; // already answered (or opted out) since we asked
  if (!question || question.status === "failed") return false; // can't prove what they saw
  const { error } = await db.from("marketing_consent_events").insert({
    tenant_id: a.tenantId,
    contact_id: a.contactId,
    channel: "whatsapp",
    action: "granted",
    method: "chat_reply",
    consent_text: question.body,
    consent_text_version: String((question.metadata as Record<string, unknown>).optin_version),
    evidence_message_id: a.inboundMessageId,
  });
  if (error) {
    console.error(`[optin] tenant=${a.tenantId} could not record consent: ${error.message}`);
    return false;
  }
  return true;
}

/**
 * Claim "asked" for this contact (only once, race-safe), then return the
 * question to send. Returns null if someone else already asked.
 */
export async function claimOptinQuestion(db: SupabaseClient, tenantId: string, contactId: string, businessName: string, lang: Lang) {
  const { data } = await db
    .from("contacts")
    .update({ marketing_optin_asked_at: new Date().toISOString() })
    .eq("tenant_id", tenantId)
    .eq("id", contactId)
    .is("marketing_optin_asked_at", null)
    .is("opted_out_at", null)
    .select("id");
  if (!data?.length) return null;
  const text = optinQuestion(businessName, lang);
  return { text, metadata: { optin_question: true, optin_version: OPTIN_TEXT_VERSION } };
}
