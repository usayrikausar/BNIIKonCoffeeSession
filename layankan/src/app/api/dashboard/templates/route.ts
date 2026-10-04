import { NextResponse } from "next/server";
import { apiTenant } from "@/lib/api/auth";

/** Approved templates for the template picker (RLS-scoped). */
export async function GET() {
  const ctx = await apiTenant();
  if ("error" in ctx) return ctx.error;
  const { data } = await ctx.supabase
    .from("message_templates")
    .select("name, language, body_text, variable_count")
    .eq("tenant_id", ctx.tenantId)
    .eq("status", "APPROVED")
    .order("name");
  return NextResponse.json({ templates: data ?? [] });
}
