import { requireTenant, getLang } from "@/lib/session";
import { brainFromRow } from "@/lib/brain/schema";
import BrainEditor from "./BrainEditor";

export default async function BrainPage({ searchParams }: { searchParams: Promise<{ welcome?: string }> }) {
  const { supabase, tenant } = await requireTenant();
  const lang = await getLang();
  const { data } = await supabase.from("business_brains").select("*").eq("tenant_id", tenant.id).single();
  const welcome = (await searchParams).welcome === "1";
  return <BrainEditor lang={lang} initial={brainFromRow(data)} version={data?.version ?? 1} welcome={welcome} />;
}
