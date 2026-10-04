import { NextResponse, type NextRequest } from "next/server";
import { createClient } from "@/lib/supabase/server";

// OAuth (Google) and email-confirmation links land here.
export async function GET(req: NextRequest) {
  const code = req.nextUrl.searchParams.get("code");
  const nextParam = req.nextUrl.searchParams.get("next") ?? "/dashboard";
  // Only allow same-site relative redirects (no open redirect).
  const next = nextParam.startsWith("/") && !nextParam.startsWith("//") ? nextParam : "/dashboard";
  if (code) {
    const supabase = await createClient();
    await supabase.auth.exchangeCodeForSession(code);
  }
  return NextResponse.redirect(new URL(next, req.nextUrl.origin));
}
