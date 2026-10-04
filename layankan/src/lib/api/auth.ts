import "server-only";
import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { createClient } from "@/lib/supabase/server";
import { TENANT_COOKIE } from "@/lib/session";

/**
 * For dashboard API routes. Authorisation is proven with the user's
 * RLS-scoped client (if RLS lets them see the row, they may act on it);
 * privileged writes then use the service client scoped by that tenant_id.
 */
export async function apiUser() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  return { supabase, user };
}

export async function apiTenant() {
  const { supabase, user } = await apiUser();
  if (!user) return { error: NextResponse.json({ error: "unauthorized" }, { status: 401 }) } as const;
  const wanted = (await cookies()).get(TENANT_COOKIE)?.value;
  const { data: rows } = await supabase.from("tenant_members").select("tenant_id, role").eq("user_id", user.id);
  const m = rows?.find((r) => r.tenant_id === wanted) ?? rows?.[0];
  if (!m) return { error: NextResponse.json({ error: "no_workspace" }, { status: 403 }) } as const;
  return { supabase, user, tenantId: m.tenant_id as string, role: m.role as "owner" | "staff" } as const;
}

/** Load a conversation the user can see (RLS) — null means not theirs. */
export async function visibleConversation(supabase: Awaited<ReturnType<typeof createClient>>, id: string) {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const { data } = await supabase
    .from("conversations")
    .select("id, tenant_id, status, channel, channel_connection_id, is_test, contact_id, contact:contacts(external_id)")
    .eq("id", id)
    .maybeSingle();
  return data;
}
