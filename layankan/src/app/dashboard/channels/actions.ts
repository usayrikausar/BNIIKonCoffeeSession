"use server";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/session";

export async function setLive(live: boolean) {
  const { supabase, tenant, role } = await requireTenant();
  if (role !== "owner") return { ok: false };
  const { error } = await supabase
    .from("tenants")
    .update(live ? { status: "live", live_at: new Date().toISOString() } : { status: "draft" })
    .eq("id", tenant.id);
  revalidatePath("/dashboard", "layout");
  return { ok: !error };
}
