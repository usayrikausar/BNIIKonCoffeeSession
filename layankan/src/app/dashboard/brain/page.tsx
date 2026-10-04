import { requireTenant, getLang } from "@/lib/session";
import { brainFromRow } from "@/lib/brain/schema";
import BrainEditor from "./BrainEditor";

export default async function BrainPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { supabase, tenant } = await requireTenant();
  const lang = await getLang();
  const { data } = await supabase.from("business_brains").select("*").eq("tenant_id", tenant.id).single();
  const welcome = (await searchParams).welcome === "1";
  const { data: templates } = await supabase
    .from("message_templates")
    .select("name, language, body_text, variable_count")
    .eq("tenant_id", tenant.id)
    .eq("status", "APPROVED")
    .order("name");
  // R1: how many customers currently say yes to promotions (proof kept per customer).
  const { count: optedIn } = await supabase
    .from("marketing_consent_current")
    .select("contact_id", { count: "exact", head: true })
    .eq("tenant_id", tenant.id)
    .eq("action", "granted");
  return (
    <BrainEditor lang={lang} initial={brainFromRow(data)} version={data?.version ?? 1} welcome={welcome} templates={templates ?? []}
      businessName={tenant.name} optedIn={optedIn ?? 0} />
  );
}
