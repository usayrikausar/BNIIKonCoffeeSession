import { notFound } from "next/navigation";
import Link from "next/link";
import { requireTenant, getLang } from "@/lib/session";
import { dict } from "@/lib/i18n";
import ConversationView, { type Memory, type PayLink } from "./ConversationView";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, tenant, role, user } = await requireTenant();
  const lang = await getLang();
  const t = dict(lang);
  const { data: conv } = await supabase
    .from("conversations")
    .select("id, status, channel, lead_score, score_confidence, score_reason, next_action, lead_details, handoff_reason, last_inbound_at, follow_up_count, follow_up_disabled, booking_link_sent_at, outcome, outcome_value_cents, assigned_to, created_at, contact:contacts(id, opted_out_at, marketing_optin_asked_at, customer_id)")
    .eq("tenant_id", tenant.id)
    .eq("id", id)
    .maybeSingle();
  if (!conv) notFound();
  const contact = Array.isArray(conv.contact) ? conv.contact[0] : conv.contact;
  const [{ data: memoryRows }, { data: brainRow }] = await Promise.all([
    contact?.customer_id
      ? supabase.from("customer_memories").select("id, kind, content, source, created_at").eq("tenant_id", tenant.id).eq("customer_id", contact.customer_id)
          .is("deleted_at", null).gt("expires_at", new Date().toISOString()).order("created_at", { ascending: false }).limit(30)
      : Promise.resolve({ data: [] }),
    supabase.from("business_brains").select("memory").eq("tenant_id", tenant.id).maybeSingle(),
  ]);
  const [{ data: payLinks }, { data: payAccount }] = await Promise.all([
    supabase.from("payment_links").select("id, amount_cents, description, status, url, paid_amount_cents, created_at, expires_at").eq("tenant_id", tenant.id).eq("conversation_id", id).order("created_at", { ascending: false }).limit(20),
    supabase.from("payment_accounts").select("gateway").eq("tenant_id", tenant.id).eq("is_active", true).maybeSingle(),
  ]);
  const { data: consent } = contact?.id
    ? await supabase.from("marketing_consent_current").select("action, method, created_at").eq("tenant_id", tenant.id).eq("contact_id", contact.id).maybeSingle()
    : { data: null };
  const [{ data: messages }, { data: members }] = await Promise.all([
    supabase.from("messages").select("id, sender, body, status, created_at, sent_by").eq("conversation_id", id).order("created_at", { ascending: true }).limit(500),
    supabase.from("tenant_members").select("user_id, email, display_name, role").eq("tenant_id", tenant.id).order("created_at"),
  ]);

  return (
    <div className="mx-auto max-w-5xl">
      <Link href="/dashboard/inbox" className="text-sm text-brand-700">← {t("nav.inbox")}</Link>
      <ConversationView
        lang={lang}
        isOwner={role === "owner"}
        myId={user.id}
        members={members ?? []}
        timezone={tenant.timezone}
        initialConversation={conv}
        initialConsent={consent ? { action: consent.action as "granted" | "withdrawn", method: consent.method as string, at: consent.created_at as string } : null}
        optinAskedAt={(contact?.marketing_optin_asked_at as string | null) ?? null}
        paymentLinks={(payLinks ?? []) as PayLink[]}
        paymentsReady={!!payAccount}
        memories={(memoryRows ?? []) as Memory[]}
        memoryEnabled={!!(brainRow?.memory as { enabled?: boolean } | null)?.enabled}
        initialMessages={messages ?? []}
      />
    </div>
  );
}
