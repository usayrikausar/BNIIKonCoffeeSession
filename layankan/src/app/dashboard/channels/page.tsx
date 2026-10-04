import { requireTenant, getLang } from "@/lib/session";
import { dict } from "@/lib/i18n";
import { env } from "@/lib/env";
import ChannelsClient from "./ChannelsClient";
import WhatsAppPanel, { type Conn, type Tpl } from "./WhatsAppPanel";

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
    </div>
  );
}
