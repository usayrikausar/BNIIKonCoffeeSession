import "server-only";
import { createClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";

/**
 * Service-role client: BYPASSES RLS. Only for server code paths that have no
 * signed-in user (public chat, cron, agent engine). Every query made with it
 * MUST be scoped by tenant_id in code.
 */
export function createAdminClient() {
  return createClient(env.supabaseUrl(), env.supabaseServiceKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}
