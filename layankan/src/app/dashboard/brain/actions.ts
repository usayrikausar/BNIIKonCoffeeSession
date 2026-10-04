"use server";
import { revalidatePath } from "next/cache";
import { requireTenant } from "@/lib/session";
import { BrainSchema, type Brain } from "@/lib/brain/schema";

export async function saveBrain(input: Brain): Promise<{ ok: boolean; error?: string; version?: number }> {
  const { supabase, tenant, user } = await requireTenant();
  const parsed = BrainSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, error: `${issue?.path.join(".")}: ${issue?.message}` };
  }
  const b = parsed.data;
  // Drop empty rows the owner left behind.
  b.products = b.products.filter((p) => p.name.trim());
  b.faqs = b.faqs.filter((f) => f.q.trim() && f.a.trim());
  b.qualifying_questions = b.qualifying_questions.filter((q) => q.trim());
  const { data, error } = await supabase
    .from("business_brains")
    .update({ ...b, updated_by: user.id })
    .eq("tenant_id", tenant.id)
    .select("version")
    .single();
  if (error) return { ok: false, error: "save failed" };
  revalidatePath("/dashboard/brain");
  return { ok: true, version: data.version };
}
