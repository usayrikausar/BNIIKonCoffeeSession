import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Fixed-window rate limit backed by Postgres (works across serverless
 * instances, no extra vendor). Fails OPEN on DB errors so an outage of the
 * limiter never takes the chat down — abuse protection, not billing.
 */
export async function allow(db: SupabaseClient, key: string, windowSeconds: number, max: number): Promise<boolean> {
  const { data, error } = await db.rpc("rate_limit_hit", { p_key: key, p_window_seconds: windowSeconds, p_max: max });
  if (error) {
    console.warn(`[ratelimit] check failed for ${key.split(":")[0]}: ${error.message}`);
    return true;
  }
  return data === true;
}

export function clientIp(headers: Headers): string {
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  return headers.get("x-real-ip") ?? "unknown";
}
