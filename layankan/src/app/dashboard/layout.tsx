import Link from "next/link";
import { requireTenant, getLang } from "@/lib/session";
import { dict } from "@/lib/i18n";
import { setLang, switchTenant } from "./actions";
import NavLinks from "./NavLinks";
import { loadBilling } from "@/lib/billing/service";

export const dynamic = "force-dynamic";

export default async function DashboardLayout({ children }: { children: React.ReactNode }) {
  const { tenant, memberships, user, supabase } = await requireTenant();
  // Pick up invitations sent to this email (also for users who already own a workspace).
  await supabase.rpc("accept_my_invites");
  const lang = await getLang();
  const t = dict(lang);
  const nav = [
    { href: "/dashboard/inbox", label: t("nav.inbox") },
    { href: "/dashboard/leads", label: t("nav.leads") },
    { href: "/dashboard/analytics", label: lang === "ms" ? "Analitik" : "Analytics" },
    { href: "/dashboard/brain", label: t("nav.brain") },
    { href: "/dashboard/test", label: t("nav.test") },
    { href: "/dashboard/promotions", label: lang === "ms" ? "Promosi" : "Promotions" },
    { href: "/dashboard/channels", label: t("nav.channels") },
    { href: "/dashboard/billing", label: lang === "ms" ? "Langganan" : "Billing" },
    { href: "/dashboard/settings", label: t("nav.settings") },
  ];
  const { entitlement: ent } = await loadBilling(supabase, tenant.id);
  const ms = lang === "ms";
  const banner = !ent.aiAllowed && ent.reason !== "quota_exceeded"
    ? { tone: "bg-red-600 text-white", text: ms ? "⚠️ AI dihentikan sementara (had pelan / bayaran). Pelanggan diserahkan kepada anda." : "⚠️ AI is paused (plan limit / payment). Customers are being handed to you." }
    : ent.state === "grace"
      ? { tone: "bg-amber-500 text-white", text: ms ? "Langganan tamat — sila bayar invois untuk elak AI dihentikan." : "Subscription period ended — pay the invoice to keep the AI running." }
      : ent.warn
        ? ent.percent >= 100
          ? { tone: "bg-red-100 text-red-900", text: ms ? `Had perbualan bulan ini dicapai (${ent.used}/${ent.limit}). Perbualan baharu datang kepada anda.` : `Monthly conversation limit reached (${ent.used}/${ent.limit}). New chats come to you.` }
          : { tone: "bg-amber-100 text-amber-900", text: ms ? `Anda telah guna ${ent.percent}% perbualan bulan ini (${ent.used}/${ent.limit}).` : `You've used ${ent.percent}% of this month's conversations (${ent.used}/${ent.limit}).` }
        : ent.state === "trialing" && ent.paidThrough && Date.parse(ent.paidThrough) - Date.now() < 3 * 86_400_000
          ? { tone: "bg-brand-50 text-brand-900", text: ms ? "Tempoh percubaan hampir tamat — pilih pelan." : "Your trial ends soon — choose a plan." }
          : null;
  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-zinc-200 bg-white md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0 md:border-b-0 md:border-r">
        <div className="flex items-center justify-between p-4 md:block">
          <Link href="/dashboard/inbox" className="text-xl font-extrabold text-brand-700">Layankan</Link>
          <div className="mt-0 md:mt-3">
            {memberships.length > 1 ? (
              <form action={switchTenant} className="flex gap-1">
                <select name="tenant" defaultValue={tenant.id} className="input py-1 text-xs">
                  {memberships.map((m) => (
                    <option key={m.tenant.id} value={m.tenant.id}>{m.tenant.name}</option>
                  ))}
                </select>
                <button className="btn-secondary px-2 py-1 text-xs">↻</button>
              </form>
            ) : (
              <div className="truncate text-sm font-semibold">{tenant.name}</div>
            )}
            <span
              className={`mt-1 inline-block rounded-full px-2 py-0.5 text-xs font-semibold ${tenant.status === "live" ? "bg-green-100 text-green-800" : "bg-zinc-200 text-zinc-700"}`}
            >
              {tenant.status === "live" ? t("tenant.live") : t("tenant.draft")}
            </span>
          </div>
        </div>
        <NavLinks items={nav} />
        <div className="hidden space-y-2 p-4 text-xs text-zinc-500 md:block">
          <div className="truncate">{user.email}</div>
          <div className="flex gap-2">
            <form action={setLang.bind(null, "ms")}><button className={lang === "ms" ? "font-bold text-brand-700" : ""}>BM</button></form>
            <span>|</span>
            <form action={setLang.bind(null, "en")}><button className={lang === "en" ? "font-bold text-brand-700" : ""}>EN</button></form>
          </div>
          <form action="/auth/signout" method="post"><button className="underline">{t("nav.signout")}</button></form>
        </div>
      </aside>
      <main className="min-w-0 flex-1">
        {banner && (
          <Link href="/dashboard/billing" className={`block px-4 py-2 text-center text-sm font-medium ${banner.tone}`}>
            {banner.text} →
          </Link>
        )}
        <div className="p-4 md:p-8">{children}</div>
      </main>
    </div>
  );
}
