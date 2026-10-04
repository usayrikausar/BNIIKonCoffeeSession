import type { Metadata } from "next";
import { createAdminClient } from "@/lib/supabase/admin";
import { getTenantBySlug } from "@/lib/chat/conversations";
import PublicChat from "./PublicChat";

export const dynamic = "force-dynamic";

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const tenant = await getTenantBySlug(createAdminClient(), slug);
  return { title: tenant ? `Chat · ${tenant.name}` : "Chat", robots: { index: false } };
}

export default async function ChatPage({ params, searchParams }: { params: Promise<{ slug: string }>; searchParams: Promise<{ embed?: string }> }) {
  const { slug } = await params;
  const embed = (await searchParams).embed === "1";
  const tenant = await getTenantBySlug(createAdminClient(), slug);
  if (!tenant || tenant.status !== "live") {
    return (
      <div className="flex min-h-screen items-center justify-center p-6 text-center text-sm text-zinc-500">
        Chat ini belum tersedia. / This chat is not available yet.
      </div>
    );
  }
  return <PublicChat slug={tenant.slug} name={tenant.name} locale={tenant.default_locale} embed={embed} />;
}
