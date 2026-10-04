import { NextResponse, type NextRequest } from "next/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTenantBySlug, findOrCreateConversation, listVisibleMessages } from "@/lib/chat/conversations";
import { isValidVisitorToken, newVisitorToken, visitorTokenHash, webAdapter } from "@/lib/channels/web";
import { recordInbound, runAgentTurn } from "@/lib/agent/engine";
import { allow, clientIp } from "@/lib/ratelimit";
import { env } from "@/lib/env";

export const runtime = "nodejs";
export const maxDuration = 60;

const MAX_BODY_BYTES = 8_000;

function json(data: unknown, status = 200) {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

/** Customer sends a message. Public, unauthenticated, rate limited. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const db = createAdminClient();
  const tenant = await getTenantBySlug(db, slug);
  if (!tenant || tenant.status !== "live") return json({ error: "not_found" }, 404);

  const ip = clientIp(req.headers);
  const [ipOk, tenantOk] = await Promise.all([
    allow(db, `chat-ip:${tenant.id}:${ip}`, 60, env.rateLimitPerIpPerMin()),
    allow(db, `chat-tenant:${tenant.id}`, 3600, env.rateLimitPerTenantPerHour()),
  ]);
  if (!ipOk || !tenantOk) return json({ error: "rate_limited" }, 429);

  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: "too_large" }, 413);
  let parsed: { visitorToken?: unknown; message?: unknown; after?: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const visitorToken = isValidVisitorToken(parsed.visitorToken) ? parsed.visitorToken : newVisitorToken();

  let events;
  try {
    events = await webAdapter.receiveMessage(
      { headers: req.headers, rawBody: JSON.stringify({ visitorToken, message: parsed.message }) },
      null,
    );
  } catch {
    return json({ error: "bad_request" }, 400);
  }
  const ev = events[0];
  if (!ev || ev.kind !== "message") return json({ error: "bad_request" }, 400);

  const { conversationId } = await findOrCreateConversation(db, {
    tenantId: tenant.id,
    channel: "web",
    externalId: ev.contactExternalId,
    visitorTokenHash: visitorTokenHash(visitorToken),
  });

  const inbound = await recordInbound(db, {
    tenantId: tenant.id,
    conversationId,
    body: ev.body,
    channel: "web",
    provider: "web",
  });

  let status: "replied" | "with_team" = "replied";
  if (inbound) {
    try {
      const turn = await runAgentTurn(db, { tenantId: tenant.id, conversationId, inboundMessageId: inbound.id });
      if (turn.paused) status = "with_team";
    } catch (e) {
      console.error(`[chat] agent turn failed tenant=${tenant.id}: ${e instanceof Error ? e.message : e}`);
    }
  }

  const after = typeof parsed.after === "string" ? parsed.after : null;
  const messages = await listVisibleMessages(db, tenant.id, conversationId, after);
  return json({ visitorToken, status, messages });
}

/** Browser polls for new messages (e.g. when the owner replies manually). */
export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const token = req.headers.get("x-visitor-token");
  if (!isValidVisitorToken(token)) return json({ messages: [] });
  const db = createAdminClient();
  const tenant = await getTenantBySlug(db, slug);
  if (!tenant || tenant.status !== "live") return json({ error: "not_found" }, 404);

  const ip = clientIp(req.headers);
  if (!(await allow(db, `poll-ip:${ip}`, 60, 120))) return json({ error: "rate_limited" }, 429);

  const { data: conv } = await db
    .from("conversations")
    .select("id")
    .eq("tenant_id", tenant.id)
    .eq("visitor_token_hash", visitorTokenHash(token))
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (!conv) return json({ messages: [] });
  const after = req.nextUrl.searchParams.get("after");
  return json({ messages: await listVisibleMessages(db, tenant.id, conv.id, after) });
}
