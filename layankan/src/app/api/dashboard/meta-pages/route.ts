import { NextResponse, type NextRequest } from "next/server";
import { cookies } from "next/headers";
import { apiTenant } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { open, seal } from "@/lib/crypto/secrets";
import { putCredential } from "@/lib/channels/credentials";
import { listPages, subscribePage, userTokenFromCode } from "@/lib/channels/meta-messaging/connect";

export const runtime = "nodejs";

const COOKIE = "layankan_meta_pages";
const TTL_MS = 10 * 60 * 1000;
const aad = (tenantId: string, userId: string) => `layankan:metapages:${tenantId}:${userId}`;

/**
 * Connect the business's OWN Facebook Page (Messenger) and its linked
 * Instagram account. Owner only. Two steps:
 *   1. {action:"list", code} — Facebook Login code → the Pages this person manages.
 *      Their Meta token is kept only in a short-lived, encrypted, httpOnly cookie.
 *   2. {action:"connect", page_id, instagram} — re-fetches that Page's token from
 *      Meta (never trusts the browser), stores it encrypted, subscribes our app.
 */
export async function POST(req: NextRequest) {
  const ctx = await apiTenant();
  if ("error" in ctx) return ctx.error;
  if (ctx.role !== "owner") return NextResponse.json({ error: "owner only" }, { status: 403 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; code?: unknown; page_id?: unknown; instagram?: unknown };
  const jar = await cookies();

  if (body.action === "list") {
    if (typeof body.code !== "string" || !body.code) return NextResponse.json({ error: "code" }, { status: 400 });
    let pages;
    try {
      const userToken = await userTokenFromCode(body.code);
      pages = await listPages(userToken);
      const sealed = seal(JSON.stringify({ t: userToken, exp: Date.now() + TTL_MS }), aad(ctx.tenantId, ctx.user.id));
      jar.set(COOKIE, `${sealed.keyId}.${sealed.ciphertext}`, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", maxAge: TTL_MS / 1000, path: "/api/dashboard/meta-pages" });
    } catch (e) {
      return NextResponse.json({ error: `Meta: ${e instanceof Error ? e.message.slice(0, 200) : "error"}` }, { status: 400 });
    }
    // Page tokens never go to the browser.
    return NextResponse.json({ ok: true, pages: pages.map((p) => ({ id: p.id, name: p.name, instagram: p.instagram })) });
  }

  if (body.action === "connect") {
    const raw = jar.get(COOKIE)?.value ?? "";
    const dot = raw.indexOf(".");
    let userToken: string | null = null;
    try {
      const s = JSON.parse(open({ keyId: raw.slice(0, dot), ciphertext: raw.slice(dot + 1) }, aad(ctx.tenantId, ctx.user.id))) as { t: string; exp: number };
      if (s.exp > Date.now()) userToken = s.t;
    } catch {
      /* missing / expired / not this person's */
    }
    if (!userToken) return NextResponse.json({ error: "Sila log masuk Facebook semula / Please log in with Facebook again" }, { status: 401 });
    const page = (await listPages(userToken)).find((p) => p.id === body.page_id);
    if (!page) return NextResponse.json({ error: "Page tidak dijumpai / Page not found" }, { status: 404 });
    const wantInstagram = body.instagram === true && !!page.instagram;

    const db = createAdminClient();
    const connected: string[] = [];
    try {
      await subscribePage(page.id, page.accessToken);
      for (const kind of ["messenger", ...(wantInstagram ? ["instagram"] : [])] as const) {
        // One active connection per channel per business: the previous one goes to standby.
        await db.from("channel_connections").update({ is_active: false }).eq("tenant_id", ctx.tenantId).eq("channel", kind).eq("is_active", true);
        const { data, error } = await db
          .from("channel_connections")
          .insert({
            tenant_id: ctx.tenantId,
            channel: kind,
            provider: kind === "messenger" ? "meta_messenger" : "meta_instagram",
            official_api: true,
            is_active: true,
            status: "connected",
            page_id: page.id,
            ig_account_id: kind === "instagram" ? page.instagram!.id : null,
            display_name: kind === "instagram" ? `@${page.instagram!.username ?? page.instagram!.id}` : page.name,
          })
          .select("id")
          .single();
        if (error || !data) {
          if (error?.code === "23505") return NextResponse.json({ error: "Page / Instagram ini sudah disambung di ruang kerja lain / already connected to another workspace" }, { status: 409 });
          throw new Error(error?.message ?? "save failed");
        }
        await putCredential(ctx.tenantId, data.id, "page_access_token", page.accessToken);
        connected.push(kind);
      }
    } catch (e) {
      return NextResponse.json({ error: `Meta: ${e instanceof Error ? e.message.slice(0, 200) : "error"}` }, { status: 400 });
    }
    jar.delete({ name: COOKIE, path: "/api/dashboard/meta-pages" });
    return NextResponse.json({ ok: true, connected });
  }
  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
