import { requireTenant, getLang } from "@/lib/session";
import { dict } from "@/lib/i18n";
import { env } from "@/lib/env";
import ChannelsClient from "./ChannelsClient";

export default async function ChannelsPage() {
  const { supabase, tenant, role } = await requireTenant();
  const lang = await getLang();
  const t = dict(lang);
  const { data: wa } = await supabase
    .from("channel_connections")
    .select("provider, status, display_phone_number, is_active")
    .eq("tenant_id", tenant.id)
    .eq("channel", "whatsapp")
    .eq("is_active", true)
    .maybeSingle();
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
      <section className="card space-y-2">
        <h2 className="text-lg font-semibold">{t("channels.whatsapp")}</h2>
        {wa ? (
          <p className="text-sm">
            {wa.display_phone_number ?? "—"} · {wa.provider} · <b>{wa.status}</b>
          </p>
        ) : (
          <p className="text-sm text-zinc-500">{t("channels.whatsapp.soon")}</p>
        )}
      </section>
    </div>
  );
}
