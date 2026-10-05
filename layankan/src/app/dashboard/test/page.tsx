import { requireTenant, getLang } from "@/lib/session";
import TestPane from "./TestPane";

export default async function TestPage() {
  const { tenant } = await requireTenant();
  return <TestPane lang={await getLang()} tenantName={tenant.name} />;
}
