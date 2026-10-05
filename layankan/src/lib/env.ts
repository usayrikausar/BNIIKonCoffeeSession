// Central place to read configuration. Server-only values throw a clear error
// when missing so misconfiguration fails loudly instead of leaking undefined.
function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name} (see .env.example)`);
  return v;
}

export const env = {
  appUrl: () => (process.env.NEXT_PUBLIC_APP_URL ?? "http://localhost:3000").replace(/\/$/, ""),
  supabaseUrl: () => required("NEXT_PUBLIC_SUPABASE_URL"),
  supabaseAnonKey: () => required("NEXT_PUBLIC_SUPABASE_ANON_KEY"),
  supabaseServiceKey: () => required("SUPABASE_SERVICE_ROLE_KEY"),
  anthropicModel: () => process.env.ANTHROPIC_MODEL || "claude-opus-5-5",
  anthropicEffort: (): "low" | "medium" | "high" => {
    const e = process.env.ANTHROPIC_EFFORT;
    return e === "medium" || e === "high" ? e : "low";
  },
  anthropicFallbacks: () => (process.env.ANTHROPIC_FALLBACKS ?? "default") !== "off",
  resendKey: () => process.env.RESEND_API_KEY || "",
  emailFrom: () => process.env.EMAIL_FROM || "Layankan <onboarding@resend.dev>",
  cronSecret: () => required("CRON_SECRET"),
  rateLimitPerIpPerMin: () => Number(process.env.RATE_LIMIT_PER_IP_PER_MIN ?? 12),
  // --- Phase 2: WhatsApp -------------------------------------------------
  metaAppId: () => process.env.NEXT_PUBLIC_META_APP_ID || "",
  metaAppSecret: () => process.env.META_APP_SECRET || "",
  metaWebhookVerifyToken: () => process.env.META_WEBHOOK_VERIFY_TOKEN || "",
  metaEmbeddedSignupConfigId: () => process.env.NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID || "",
  metaPagesConfigId: () => process.env.NEXT_PUBLIC_META_PAGES_CONFIG_ID || "",
  metaGraphVersion: () => process.env.META_GRAPH_VERSION || "v23.0",
  metaGraphBaseUrl: () => (process.env.META_GRAPH_BASE_URL || "https://graph.facebook.com").replace(/\/$/, ""),
  /** Our own Meta Business ID — used to flag WABAs that are NOT client-owned. */
  metaPlatformBusinessId: () => process.env.META_PLATFORM_BUSINESS_ID || "",
  /** Workspace whose WhatsApp number sends owner alerts + summaries (default: Layankan itself). */
  platformTenantId: () => process.env.PLATFORM_TENANT_ID || "00000000-0000-4000-8000-000000000001",
  waTemplateHandoff: () => process.env.WA_TEMPLATE_HANDOFF || "layankan_handoff_alert",
  waTemplateDailySummary: () => process.env.WA_TEMPLATE_DAILY_SUMMARY || "layankan_daily_summary",
  waTemplateLanguage: () => process.env.WA_TEMPLATE_LANGUAGE || "ms",
  rateLimitPerTenantPerHour: () => Number(process.env.RATE_LIMIT_PER_TENANT_PER_HOUR ?? 600),
};
