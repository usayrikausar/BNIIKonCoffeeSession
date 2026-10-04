import { after, NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { metaCloudAdapter } from "@/lib/channels/whatsapp/meta";
import { verifyMetaSubscription } from "@/lib/channels/signature";
import { connectionByPhoneNumberId, ingestEvents, type PendingTurn } from "@/lib/chat/ingest";
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
 * One endpoint for every tenant on the direct Cloud API. Verify signature →
 * route by phone_number_id → persist → 200 → answer customers in the background.
 */
export async function POST(req: NextRequest) {
  const rawBody = await req.text();
  let events: NormalizedEvent[];
  try {
    events = await metaCloudAdapter.receiveMessage({ headers: req.headers, rawBody }, null);
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const db = createAdminClient();
  const byPhone = new Map<string, NormalizedEvent[]>();
  for (const ev of events) {
    const key = ev.routingKey ?? "";
    byPhone.set(key, [...(byPhone.get(key) ?? []), ev]);
  }
  const pending: PendingTurn[] = [];
  for (const [phoneNumberId, evs] of byPhone) {
    const conn = phoneNumberId ? await connectionByPhoneNumberId(db, phoneNumberId) : null;
    if (!conn) {
      console.warn(`[webhook:meta] no connection for phone_number_id=${phoneNumberId || "?"}; ${evs.length} event(s) dropped`);
      continue;
    }
    pending.push(...(await ingestEvents(db, conn, evs)));
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
