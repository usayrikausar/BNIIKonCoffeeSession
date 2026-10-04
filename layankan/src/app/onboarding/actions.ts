"use server";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { DEFAULT_QUALIFYING_QUESTIONS, isIndustry } from "@/lib/brain/schema";
import { TENANT_COOKIE } from "@/lib/session";

export async function createWorkspace(_prev: { error?: string } | null, form: FormData) {
  const name = String(form.get("name") ?? "").trim();
  const slug = String(form.get("slug") ?? "").trim().toLowerCase();
  const industryRaw = String(form.get("industry") ?? "umum");
  const industry = isIndustry(industryRaw) ? industryRaw : "umum";
  if (!name || name.length > 120) return { error: "Nama diperlukan / Name required" };
  if (!/^[a-z0-9]([a-z0-9-]{1,46}[a-z0-9])$/.test(slug)) {
    return { error: "Pautan: 3–48 huruf kecil, nombor atau '-' / Link: 3–48 lowercase letters, digits or '-'" };
  }
  if (["layankan", "admin", "api", "dashboard", "app", "www", "support"].includes(slug)) {
    return { error: "Pautan ini dikhaskan / This link is reserved" };
  }

  const supabase = await createClient();
  const { data: tenantId, error } = await supabase.rpc("create_workspace", { p_name: name, p_slug: slug, p_industry: industry });
  if (error || !tenantId) {
    if (error?.code === "23505") return { error: "Pautan ini sudah diambil. Cuba yang lain. / That link is taken." };
    return { error: "Tidak dapat mencipta ruang kerja / Could not create workspace" };
  }
  await supabase
    .from("business_brains")
    .update({ qualifying_questions: DEFAULT_QUALIFYING_QUESTIONS[industry] })
    .eq("tenant_id", tenantId);
  await supabase.from("channel_connections").insert({ tenant_id: tenantId, channel: "web", provider: "web", status: "connected" });

  (await cookies()).set(TENANT_COOKIE, tenantId as string, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/" });
  redirect("/dashboard/brain?welcome=1");
}
