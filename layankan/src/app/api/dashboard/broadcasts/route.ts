import { after, NextResponse, type NextRequest } from "next/server";
import { apiTenant } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { AudienceSchema, CreateBroadcastSchema } from "@/lib/broadcasts/rules";
import { broadcastAllowance, buildAudience, createBroadcast, runBroadcasts } from "@/lib/broadcasts/service";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Opt-in broadcasts (owner only).
 *   {action:"preview", audience}  → how many people would get it (and why others won't)
 *   {action:"create", …, confirm:true} → queue it; sends now or at scheduled_at
 * Authorisation: the owner role comes from the user's own RLS-scoped session;
 * the writes then use the service client for that tenant only.
 */
export async function POST(req: NextRequest) {
  const ctx = await apiTenant();
  if ("error" in ctx) return ctx.error;
  if (ctx.role !== "owner") return NextResponse.json({ error: "owner only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const db = createAdminClient();

  if (body.action === "preview") {
    const audience = AudienceSchema.safeParse(body.audience ?? {});
    if (!audience.success) return NextResponse.json({ error: "audience" }, { status: 400 });
    const [aud, allowance] = await Promise.all([buildAudience(db, ctx.tenantId, audience.data), broadcastAllowance(db, ctx.tenantId)]);
    return NextResponse.json({ optedIn: aud.optedIn, matching: aud.matching, tooRecent: aud.tooRecent, eligible: aud.eligible.length, left: allowance.left, limit: allowance.limit });
  }

  if (body.action === "create") {
    const input = CreateBroadcastSchema.safeParse(body);
    if (!input.success) {
      const i = input.error.issues[0];
      return NextResponse.json({ error: `${i?.path.join(".")}: ${i?.message}` }, { status: 400 });
    }
    const d = input.data;
    const scheduledAt = d.scheduled_at ? new Date(d.scheduled_at) : null;
    if (scheduledAt && scheduledAt.getTime() > Date.now() + 60 * 86_400_000) return NextResponse.json({ error: "scheduled_at: max 60 days ahead" }, { status: 400 });
    const res = await createBroadcast(db, {
      tenantId: ctx.tenantId, userId: ctx.user.id, name: d.name, templateName: d.template_name, templateLanguage: d.template_language,
      variables: d.variables, audience: d.audience, scheduledAt,
    });
    if (!res.ok) return NextResponse.json({ error: res.error, problem: res.problem }, { status: res.status });
    if (res.status === "sending") {
      after(async () => {
        try {
          await runBroadcasts(db, { onlyId: res.broadcastId });
        } catch (e) {
          console.error(`[broadcasts] send failed broadcast=${res.broadcastId}: ${e instanceof Error ? e.message : e}`);
        }
      });
    }
    return NextResponse.json(res);
  }
  return NextResponse.json({ error: "action" }, { status: 400 });
}
