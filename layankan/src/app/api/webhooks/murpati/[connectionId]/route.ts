import { after, NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { murpatiAdapter } from "@/lib/channels/whatsapp/murpati";
import { connectionById, ingestEvents } from "@/lib/chat/ingest";
import { respondIfLatest } from "@/lib/agent/engine";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Per-connection Murpati webhook URL (shown on the Channels page). The
 * connection id routes the event; the connection's own secret verifies it.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await ctx.params;
  const db = createAdminClient();
  const conn = await connectionById(db, connectionId);
  if (!conn || conn.provider !== "murpati") return NextResponse.json({ error: "not_found" }, { status: 404 });

  const rawBody = await req.text();
  if (rawBody.length > 256_000) return NextResponse.json({ error: "too_large" }, { status: 413 });
  let events;
  try {
    events = await murpatiAdapter.receiveMessage({ headers: req.headers, rawBody }, conn);
  } catch {
    return NextResponse.json({ error: "invalid signature" }, { status: 401 });
  }

  const pending = await ingestEvents(db, conn, events);
  if (pending.length) {
    after(async () => {
      for (const p of pending) {
        try {
          await respondIfLatest(db, p);
        } catch (e) {
          console.error(`[webhook:murpati] agent turn failed tenant=${p.tenantId}: ${e instanceof Error ? e.message : e}`);
        }
      }
    });
  }
  return NextResponse.json({ ok: true });
}
