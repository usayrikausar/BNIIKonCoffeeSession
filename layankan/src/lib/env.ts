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
  rateLimitPerTenantPerHour: () => Number(process.env.RATE_LIMIT_PER_TENANT_PER_HOUR ?? 600),
};
