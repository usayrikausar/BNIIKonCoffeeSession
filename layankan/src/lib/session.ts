import "server-only";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { dict, LANG_COOKIE, type Lang } from "@/lib/i18n";

export const TENANT_COOKIE = "layankan_tenant";

export interface CurrentTenant {
  id: string;
  slug: string;
  name: string;
  status: "draft" | "live" | "suspended";
  timezone: string;
  default_locale: "ms" | "en";
  summary_hour: number;
}

export async function getLang(): Promise<Lang> {
  const c = (await cookies()).get(LANG_COOKIE)?.value;
  return c === "en" ? "en" : "ms";
}

export async function getT() {
  return dict(await getLang());
}

/**
 * Resolves the signed-in user and their current workspace. All reads go
 * through the user's RLS-scoped client, so a forged tenant cookie simply
 * finds nothing and falls back to a workspace the user really belongs to.
 */
export async function requireTenant() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) redirect("/login");

  const { data: memberships } = await supabase
    .from("tenant_members")
    .select("role, tenant:tenants(id, slug, name, status, timezone, default_locale, summary_hour)")
    .eq("user_id", user.id);

  if (!memberships?.length) {
    // Maybe they were invited before signing up.
    const { data: accepted } = await supabase.rpc("accept_my_invites");
    if (accepted && accepted > 0) redirect("/dashboard");
    redirect("/onboarding");
  }

  const wanted = (await cookies()).get(TENANT_COOKIE)?.value;
  const pick = memberships.find((m) => one(m.tenant)?.id === wanted) ?? memberships[0]!;
  const tenant = one(pick.tenant) as CurrentTenant;
  return {
    supabase,
    user,
    tenant,
    role: pick.role as "owner" | "staff",
    memberships: memberships.map((m) => ({ role: m.role, tenant: one(m.tenant) as CurrentTenant })),
  };
}

function one<T>(v: T | T[] | null | undefined): T | null {
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}
