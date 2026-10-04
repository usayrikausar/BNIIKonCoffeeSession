import { NextResponse, type NextRequest } from "next/server";
import { apiUser, visibleConversation } from "@/lib/api/auth";
import { createAdminClient } from "@/lib/supabase/admin";
import { validateStaffNote } from "@/lib/memory/memory";
import { ensureCustomer } from "@/lib/memory/store";

export const runtime = "nodejs";

/** Staff curate what we remember about this customer (R3): add a note, or remove any memory. */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const { id } = await ctx.params;
  const { supabase, user } = await apiUser();
  if (!user) return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  const conv = await visibleConversation(supabase, id); // RLS: null if not their business's chat
  if (!conv) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const body = (await req.json().catch(() => ({}))) as { action?: string; content?: unknown; memory_id?: unknown };

  if (body.action === "add") {
    const v = validateStaffNote(body.content);
    if ("error" in v) return NextResponse.json({ error: v.error }, { status: 400 });
    const customerId = await ensureCustomer(createAdminClient(), conv.tenant_id, conv.contact_id as string);
    // Inserted AS the staff member (RLS: staff notes only, created_by = them).
    const { data, error } = await supabase
      .from("customer_memories")
      .insert({ tenant_id: conv.tenant_id, customer_id: customerId, kind: "note", content: v.content, source: "staff", created_by: user.id })
      .select("id, kind, content, source, created_at")
      .single();
    if (error) return NextResponse.json({ error: "save_failed" }, { status: 500 });
    return NextResponse.json({ ok: true, memory: data });
  }

  if (body.action === "remove" && typeof body.memory_id === "string") {
    // Soft delete AS the staff member; only memories of THIS chat's customer.
    const { data: c } = await supabase.from("contacts").select("customer_id").eq("id", conv.contact_id as string).maybeSingle();
    if (!c?.customer_id) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const { data, error } = await supabase
      .from("customer_memories")
      .update({ deleted_at: new Date().toISOString() })
      .eq("id", body.memory_id).eq("customer_id", c.customer_id).is("deleted_at", null)
      .select("id");
    if (error || !data?.length) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true });
  }
  return NextResponse.json({ error: "bad_action" }, { status: 400 });
}
