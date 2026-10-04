import { requireTenant, getLang } from "@/lib/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { templateProblem, type TemplateRow } from "@/lib/broadcasts/rules";
import { broadcastAllowance, broadcastConnection } from "@/lib/broadcasts/service";
import Promotions from "./Promotions";

export const dynamic = "force-dynamic";

export default async function PromotionsPage() {
  const { supabase, tenant, role } = await requireTenant();
  const lang = await getLang();
  // Everything the page shows is read with the member's own RLS-scoped session.
  const [{ data: broadcasts }, { data: templates }, { count: optedIn }] = await Promise.all([
    supabase.from("broadcasts")
      .select("id, name, template_name, status, scheduled_at, started_at, finished_at, recipients_total, sent_count, failed_count, skipped_count, audience, created_at")
      .eq("tenant_id", tenant.id).order("created_at", { ascending: false }).limit(50),
    supabase.from("message_templates").select("name, language, status, category, source, body_text, variable_count").eq("tenant_id", tenant.id).order("name"),
    supabase.from("marketing_consent_current").select("contact_id", { count: "exact", head: true }).eq("tenant_id", tenant.id).eq("action", "granted").eq("channel", "whatsapp"),
  ]);
  // Allowance + connection need server-only tables (plans / connection flags); scoped to this tenant.
  const admin = createAdminClient();
  const [allowance, conn] = await Promise.all([broadcastAllowance(admin, tenant.id), broadcastConnection(admin, tenant.id)]);
  return (
    <Promotions
      lang={lang}
      isOwner={role === "owner"}
      timezone={tenant.timezone}
      optedIn={optedIn ?? 0}
      allowance={{ limit: allowance.limit, used: allowance.used, left: allowance.left }}
      connected={!!conn}
      templates={((templates ?? []) as TemplateRow[]).map((t) => ({ ...t, problem: templateProblem(t) }))}
      broadcasts={broadcasts ?? []}
    />
  );
}
