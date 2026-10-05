import { requireTenant, getLang } from "@/lib/session";
import { dict } from "@/lib/i18n";
import { env } from "@/lib/env";
import ChannelsClient from "./ChannelsClient";
import WhatsAppPanel, { type Conn, type Tpl } from "./WhatsAppPanel";
import PaymentsPanel, { type PayAccount } from "./PaymentsPanel";
import MessagingPanel, { type MsgConn } from "./MessagingPanel";
import { formatRm } from "@/lib/payments/links";

export default async function ChannelsPage() {
  const { supabase, tenant, role } = await requireTenant();
  const lang = await getLang();
  const t = dict(lang);
  // Metadata only — credentials are never readable from the browser (no RLS policy).
  const [{ data: connections }, { data: templates }] = await Promise.all([
    supabase
      .from("channel_connections")
      .select("id, provider, is_active, status, display_phone_number, phone_number_id, waba_id, meta_business_id, provider_account_ref, meta_business_owner, waba_owner, owner_legal_name, owner_contact_email, ownership_verified_at, created_at")
      .eq("tenant_id", tenant.id)
      .eq("channel", "whatsapp")
      .neq("status", "disconnected")
      .order("created_at"),
    supabase.from("message_templates").select("id, name, language, status, body_text, variable_count, source").eq("tenant_id", tenant.id).order("name"),
  ]);
  const appUrl = env.appUrl();
  // R2: the business's own payment account (keys are never readable here) and this month's paid links.
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString();
  const [{ data: account }, { data: paid }] = await Promise.all([
    supabase.from("payment_accounts").select("gateway, sandbox, account_holder_name, verified_at").eq("tenant_id", tenant.id).eq("is_active", true).maybeSingle(),
    supabase.from("payment_links").select("paid_amount_cents").eq("tenant_id", tenant.id).eq("status", "paid").gte("paid_at", monthStart),
  ]);
  const { data: msgConns } = await supabase
    .from("channel_connections")
    .select("id, channel, is_active, status, display_name, page_id")
    .eq("tenant_id", tenant.id)
    .in("channel", ["instagram", "messenger"])
    .neq("status", "disconnected")
    .order("created_at");
  const paidTotal = (paid ?? []).reduce((s, r) => s + ((r.paid_amount_cents as number | null) ?? 0), 0);
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <h1 className="text-2xl font-bold">{t("channels.title")}</h1>
      <ChannelsClient
        lang={lang}
        isOwner={role === "owner"}
        live={tenant.status === "live"}
        chatUrl={`${appUrl}/c/${tenant.slug}`}
        embed={`<script src="${appUrl}/widget.js" data-layankan="${tenant.slug}" async></script>`}
        slug={tenant.slug}
      />
      <WhatsAppPanel
        lang={lang}
        isOwner={role === "owner"}
        appUrl={appUrl}
        connections={(connections ?? []) as Conn[]}
        templates={(templates ?? []) as Tpl[]}
        meta={{ appId: env.metaAppId(), configId: env.metaEmbeddedSignupConfigId(), graphVersion: env.metaGraphVersion() }}
      />
      <MessagingPanel lang={lang} isOwner={role === "owner"} connections={(msgConns ?? []) as MsgConn[]}
        meta={{ appId: env.metaAppId(), configId: env.metaPagesConfigId(), graphVersion: env.metaGraphVersion() }} />
      <PaymentsPanel lang={lang} isOwner={role === "owner"} account={(account as PayAccount | null) ?? null} paidThisMonth={{ count: paid?.length ?? 0, total: formatRm(paidTotal) }} />
    </div>
  );
}
