import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";

// Backstop used only while the database limiter is unavailable: a per-instance
// window, so a database outage cannot turn into unlimited AI calls.
const memory = new Map<string, { start: number; count: number }>();
function allowInMemory(key: string, windowSeconds: number, max: number, now = Date.now()): boolean {
  const w = memory.get(key);
  if (!w || now - w.start >= windowSeconds * 1000) {
    if (memory.size > 10_000) memory.clear();
    memory.set(key, { start: now, count: 1 });
    return true;
  }
  w.count++;
  return w.count <= max;
}

/**
 * Fixed-window rate limit backed by Postgres (works across serverless
 * instances, no extra vendor). If the database check fails, falls back to an
 * in-memory window instead of blocking chats — abuse protection, not billing.
 */
export async function allow(db: SupabaseClient, key: string, windowSeconds: number, max: number): Promise<boolean> {
  const { data, error } = await db.rpc("rate_limit_hit", { p_key: key, p_window_seconds: windowSeconds, p_max: max });
  if (error) {
    console.warn(`[ratelimit] check failed for ${key.split(":")[0]}: ${error.message}`);
    return allowInMemory(key, windowSeconds, max);
  }
  return data === true;
}

/**
 * The visitor's IP as seen by OUR hosting platform. Platform headers first
 * (Vercel sets these and they can't be forged by the visitor); otherwise the
 * LAST X-Forwarded-For hop, which is the address our own proxy saw. The first
 * hop is whatever the visitor chose to send, so it is never trusted.
 */
export function clientIp(headers: Headers): string {
  const platform = headers.get("x-vercel-forwarded-for") ?? headers.get("x-real-ip");
  if (platform) return platform.split(",")[0]!.trim();
  const fwd = headers.get("x-forwarded-for");
  if (fwd) return fwd.split(",").map((s) => s.trim()).filter(Boolean).pop() ?? "unknown";
  return "unknown";
}

export const __test = { allowInMemory, memory };
