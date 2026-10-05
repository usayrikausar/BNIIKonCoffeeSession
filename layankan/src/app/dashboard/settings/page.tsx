import { requireTenant, getLang } from "@/lib/session";
import SettingsClient from "./SettingsClient";

export default async function SettingsPage() {
  const { supabase, tenant, role, user } = await requireTenant();
  const [{ data: members }, { data: invites }] = await Promise.all([
    supabase.from("tenant_members").select("user_id, role, email, display_name, notification_prefs").eq("tenant_id", tenant.id).order("created_at"),
    role === "owner"
      ? supabase.from("tenant_invites").select("id, email, created_at").eq("tenant_id", tenant.id).is("accepted_at", null)
      : Promise.resolve({ data: [] as { id: string; email: string; created_at: string }[] }),
  ]);
  const me = members?.find((m) => m.user_id === user.id);
  const prefs = (me?.notification_prefs ?? {}) as { email_handoff?: boolean; email_daily_summary?: boolean };
  return (
    <SettingsClient
      lang={await getLang()}
      isOwner={role === "owner"}
      tenant={tenant}
      myId={user.id}
      members={(members ?? []).map((m) => ({ user_id: m.user_id, role: m.role, email: m.email, display_name: m.display_name }))}
      myDisplayName={me?.display_name ?? ""}
      invites={invites ?? []}
      prefs={{ email_handoff: prefs.email_handoff !== false, email_daily_summary: prefs.email_daily_summary !== false }}
    />
  );
}
