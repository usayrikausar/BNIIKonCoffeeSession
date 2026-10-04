import "server-only";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

/** The signed-in platform operator (listed in PLATFORM_ADMIN_EMAILS, verified email), or null. */
export async function platformAdmin() {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  const admins = (process.env.PLATFORM_ADMIN_EMAILS ?? "").split(",").map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (!user?.email || !user.email_confirmed_at || !admins.includes(user.email.toLowerCase())) return null;
  return user;
}

/** Platform operators (you), listed in PLATFORM_ADMIN_EMAILS. Everyone else gets a 404. */
export async function requirePlatformAdmin() {
  const user = await platformAdmin();
  if (!user) notFound();
  return user;
}
