import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { MURPATI_NOT_IMPLEMENTED } from "@/lib/channels/whatsapp/murpati";
import { connectionById } from "@/lib/chat/ingest";

export const runtime = "nodejs";

/**
 * Per-connection Murpati webhook URL — STUB.
 * The Murpati adapter is not implemented until Murpati's API docs are
 * provided (docs/MURPATI_INTEGRATION.md). Requests are NOT parsed or stored:
 * an unverified payload must never reach the database. Answers 501.
 *
 * TODO(murpati-docs): verify signature → murpatiAdapter.receiveMessage →
 * ingestEvents → respondIfLatest (same flow as /api/webhooks/meta).
 */
export async function POST(_req: NextRequest, ctx: { params: Promise<{ connectionId: string }> }) {
  const { connectionId } = await ctx.params;
  const conn = await connectionById(createAdminClient(), connectionId);
  if (!conn || conn.provider !== "murpati") return NextResponse.json({ error: "not_found" }, { status: 404 });
  console.warn(`[webhook:murpati] connection=${conn.id} event refused: adapter not implemented (awaiting Murpati API docs)`);
  return NextResponse.json({ error: MURPATI_NOT_IMPLEMENTED }, { status: 501 });
}
