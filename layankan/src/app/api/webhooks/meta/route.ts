import { after, NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { metaCloudAdapter } from "@/lib/channels/whatsapp/meta";
import { metaInstagramAdapter, metaMessengerAdapter } from "@/lib/channels/meta-messaging/adapters";
import { verifyMetaSubscription } from "@/lib/channels/signature";
import { connectionByMessagingId, connectionByPhoneNumberId, ingestEvents, type PendingTurn } from "@/lib/chat/ingest";
import type { ChannelConnection } from "@/lib/channels/types";
import { parseCommentWebhook } from "@/lib/comments/parse";
import { handleComments } from "@/lib/comments/handler";
import { respondIfLatest } from "@/lib/agent/engine";
import type { NormalizedEvent } from "@/lib/channels/types";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 60;

/** Meta webhook subscription handshake. */
export async function GET(req: NextRequest) {
  const challenge = verifyMetaSubscription(req.nextUrl.searchParams, env.metaWebhookVerifyToken());
  return challenge ? new NextResponse(challenge, { status: 200 }) : new NextResponse("forbidden", { status: 403 });
}

/**
 * One endpoint for every tenant and every Meta product: WhatsApp Cloud API
 * (object "whatsapp_business_account", routed by phone_number_id), Messenger
 * (object "page", routed by Page id) and Instagram (object "instagram", routed
 * by Instagram account id). Verify signature → route → persist → 200 → answer
 * customers in the background.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  let object: unknown;
  try {
    object = (JSON.parse(rawBody) as { object?: unknown }).object;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const adapter = object === "page" ? metaMessengerAdapter : object === "instagram" ? metaInstagramAdapter : metaCloudAdapter;
  let events: NormalizedEvent[];
  try {
    events = await adapter.receiveMessage({ headers: req.headers, rawBody }, null); // verifies Meta's signature first
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const db = createAdminClient();
  const byKey = new Map<string, NormalizedEvent[]>();
  for (const ev of events) {
    const key = ev.routingKey ?? "";
    byKey.set(key, [...(byKey.get(key) ?? []), ev]);
  }
  const pending: PendingTurn[] = [];
  for (const [key, evs] of byKey) {
    let conn: ChannelConnection | null = null;
    if (key) {
      conn = object === "page" || object === "instagram"
        ? await connectionByMessagingId(db, object, key)
        : await connectionByPhoneNumberId(db, key);
    }
    if (!conn) {
      console.warn(`[webhook:meta] no connection for ${String(object)} id=${key || "?"}; ${evs.length} event(s) dropped`);
      continue;
    }
    pending.push(...(await ingestEvents(db, conn, evs)));
  }

  // Comment-to-chat (R5): comments on the business's own Facebook / Instagram posts.
  // The signature was already verified above, by the adapter.
  if (object === "page" || object === "instagram") {
    // Handled after the 200 so Meta never waits on our Graph calls; each comment is claimed
    // in the database first, so a Meta retry can't cause a second private reply.
    const comments = parseCommentWebhook(JSON.parse(rawBody));
    if (comments.length) {
      after(async () => {
        try {
          await handleComments(db, comments);
        } catch (e) {
          console.error(`[webhook:meta] comments failed: ${e instanceof Error ? e.message : e}`);
        }
      });
    }
  }

  if (pending.length) {
    after(async () => {
      for (const p of pending) {
        try {
          await respondIfLatest(db, p);
        } catch (e) {
          console.error(`[webhook:meta] agent turn failed tenant=${p.tenantId}: ${e instanceof Error ? e.message : e}`);
        }
      }
    });
  }
  // Always 200 once stored, so Meta doesn't retry (retries are de-duplicated anyway).
  return NextResponse.json({ ok: true });
}
