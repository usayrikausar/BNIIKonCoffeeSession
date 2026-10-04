import { notFound } from "next/navigation";
import Link from "next/link";
import { requireTenant, getLang } from "@/lib/session";
import { dict } from "@/lib/i18n";
import ConversationView from "./ConversationView";

export default async function ConversationPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const { supabase, tenant, role, user } = await requireTenant();
  const lang = await getLang();
  const t = dict(lang);
  const { data: conv } = await supabase
    .from("conversations")
    .select("id, status, channel, lead_score, score_confidence, score_reason, next_action, lead_details, handoff_reason, last_inbound_at, follow_up_count, outcome, outcome_value_cents, assigned_to, created_at, contact:contacts(opted_out_at)")
    .eq("tenant_id", tenant.id)
    .eq("id", id)
    .maybeSingle();
  if (!conv) notFound();
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
        initialMessages={messages ?? []}
      />
    </div>
  );
}
