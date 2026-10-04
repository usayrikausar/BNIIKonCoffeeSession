import "server-only";
import { createServerClient } from "@supabase/ssr";
import { cookies } from "next/headers";
import { env } from "@/lib/env";

/** Supabase client acting AS the signed-in user. RLS applies. Use in dashboard code. */
export async function createClient() {
  const cookieStore = await cookies();
  return createServerClient(env.supabaseUrl(), env.supabaseAnonKey(), {
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (toSet) => {
        try {
          toSet.forEach(({ name, value, options }) => cookieStore.set(name, value, options));
        } catch {
          // Called from a Server Component: cookies are read-only there. The
          // proxy refreshes the session, so this is safe to ignore.
        }
      },
    },
  });
}
