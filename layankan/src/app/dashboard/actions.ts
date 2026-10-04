"use server";
import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { LANG_COOKIE } from "@/lib/i18n";
import { TENANT_COOKIE } from "@/lib/session";

const cookieOpts = { httpOnly: true, sameSite: "lax" as const, secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 24 * 365 };

export async function setLang(lang: "ms" | "en") {
  (await cookies()).set(LANG_COOKIE, lang === "en" ? "en" : "ms", cookieOpts);
  revalidatePath("/dashboard", "layout");
}

export async function switchTenant(form: FormData) {
  const id = String(form.get("tenant") ?? "");
  // No trust needed: requireTenant() only honours ids the user is a member of (RLS).
  if (/^[0-9a-f-]{36}$/.test(id)) (await cookies()).set(TENANT_COOKIE, id, cookieOpts);
  revalidatePath("/dashboard", "layout");
}
