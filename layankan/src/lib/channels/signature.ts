import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Webhook signature checks used by the Phase 2 WhatsApp adapters (and any
 * future provider). Kept dependency-free and constant-time.
 */

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b) || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

/** Meta (WhatsApp Cloud API): header `X-Hub-Signature-256: sha256=<hex HMAC of raw body with app secret>`. */
export function verifyMetaSignature(rawBody: string, header: string | null, appSecret: string): boolean {
  if (!header || !appSecret) return false;
  const [algo, sig] = header.split("=", 2);
  if (algo !== "sha256" || !sig) return false;
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  return safeEqualHex(sig, expected);
}

/** Meta webhook subscription handshake (GET ?hub.mode=subscribe&hub.verify_token=…&hub.challenge=…). */
export function verifyMetaSubscription(params: URLSearchParams, verifyToken: string): string | null {
  if (!verifyToken) return null;
  if (params.get("hub.mode") !== "subscribe") return null;
  const token = params.get("hub.verify_token") ?? "";
  const a = Buffer.from(token);
  const b = Buffer.from(verifyToken);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  return params.get("hub.challenge");
}

/**
 * Generic timestamped HMAC (used for Murpati-style webhooks and our own
 * internal callbacks): signature = hex HMAC-SHA256 of `${timestamp}.${body}`.
 * Rejects stale timestamps to stop replay attacks.
 */
export function verifyTimestampedHmac(
  rawBody: string,
  signature: string | null,
  timestamp: string | null,
  secret: string,
  opts: { toleranceSeconds?: number; now?: number } = {},
): boolean {
  if (!signature || !timestamp || !secret) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return false;
  const now = Math.floor((opts.now ?? Date.now()) / 1000);
  if (Math.abs(now - ts) > (opts.toleranceSeconds ?? 300)) return false;
  const expected = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`, "utf8").digest("hex");
  return safeEqualHex(signature.replace(/^sha256=/, ""), expected);
}

/** Bearer-token check for our cron endpoints (constant time). */
export function verifyBearer(header: string | null, secret: string): boolean {
  if (!header || !secret) return false;
  const token = header.replace(/^Bearer\s+/i, "");
  const a = Buffer.from(token);
  const b = Buffer.from(secret);
  return a.length === b.length && timingSafeEqual(a, b);
}
