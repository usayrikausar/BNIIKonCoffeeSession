import "server-only";
import { env } from "@/lib/env";
import { getCredential } from "../credentials";
import { verifyMetaSignature } from "../signature";
import type { ChannelAdapter, OutboundMessage, SendResult } from "../types";
import { parseMetaWebhook } from "./meta-parse";
import { countTemplateVariables, sanitizeTemplateVariable, SERVICE_WINDOW_HOURS } from "./policy";

/** Direct Meta WhatsApp Cloud API (official). One Meta app; each business connects its OWN WABA via Embedded Signup. */

export class GraphError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: number,
  ) {
    super(message);
  }
}

export async function graph<T = Record<string, unknown>>(
  path: string,
  opts: { method?: "GET" | "POST" | "DELETE"; token?: string; body?: unknown; query?: Record<string, string> } = {},
): Promise<T> {
  const url = new URL(`${env.metaGraphBaseUrl()}/${env.metaGraphVersion()}/${path.replace(/^\//, "")}`);
  for (const [k, v] of Object.entries(opts.query ?? {})) url.searchParams.set(k, v);
  const res = await fetch(url, {
    method: opts.method ?? "GET",
    headers: {
      ...(opts.token ? { Authorization: `Bearer ${opts.token}` } : {}),
      ...(opts.body ? { "Content-Type": "application/json" } : {}),
    },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
    signal: AbortSignal.timeout(15_000),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { message?: string; code?: number } } & T;
  if (!res.ok || data.error) {
    // Graph error messages never contain the token; safe to surface.
    throw new GraphError(data.error?.message ?? `Graph API ${res.status}`, res.status, data.error?.code);
  }
  return data;
}

export function buildMetaSendBody(msg: OutboundMessage) {
  if (msg.template) {
    const vars = msg.template.variables.map((v) => sanitizeTemplateVariable(v));
    return {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: msg.to,
      type: "template",
      template: {
        name: msg.template.name,
        language: { code: msg.template.language },
        ...(vars.length ? { components: [{ type: "body", parameters: vars.map((text) => ({ type: "text", text })) }] } : {}),
      },
    };
  }
  return {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: msg.to,
    type: "text",
    text: { body: msg.body.slice(0, 4096), preview_url: false },
  };
}

export const metaCloudAdapter: ChannelAdapter = {
  metadata: () => ({
    channel: "whatsapp",
    provider: "meta_cloud",
    available: true,
    serviceWindowHours: SERVICE_WINDOW_HOURS,
    supportsTemplates: true,
    maxMessageLength: 4096,
  }),

  async receiveMessage(req) {
    // Meta signs with OUR app secret (one app for all tenants).
    if (!verifyMetaSignature(req.rawBody, req.headers.get("x-hub-signature-256"), env.metaAppSecret())) {
      throw new Error("invalid signature");
    }
    return parseMetaWebhook(JSON.parse(req.rawBody));
  },

  async sendMessage(conn, msg): Promise<SendResult> {
    if (!conn.phone_number_id) return { status: "failed", providerMessageId: null, error: "connection has no phone_number_id" };
    const token = await getCredential(conn.tenant_id, conn.id, "access_token");
    if (!token) return { status: "failed", providerMessageId: null, error: "missing access token" };
    try {
      const data = await graph<{ messages?: { id: string }[] }>(`${conn.phone_number_id}/messages`, {
        method: "POST",
        token,
        body: buildMetaSendBody(msg),
      });
      return { status: "sent", providerMessageId: data.messages?.[0]?.id ?? null };
    } catch (e) {
      return { status: "failed", providerMessageId: null, error: e instanceof Error ? e.message.slice(0, 300) : "send failed" };
    }
  },
};

// ---------------------------------------------------------------------------
// Embedded Signup + account helpers
// ---------------------------------------------------------------------------

/** Exchange the Embedded Signup `code` for a business integration system-user token. */
export async function exchangeCodeForToken(code: string): Promise<string> {
  const data = await graph<{ access_token?: string }>("oauth/access_token", {
    query: { client_id: env.metaAppId(), client_secret: env.metaAppSecret(), code },
  });
  if (!data.access_token) throw new Error("No access token returned by Meta");
  return data.access_token;
}

export async function fetchPhoneNumber(phoneNumberId: string, token: string) {
  return graph<{ id: string; display_phone_number?: string; verified_name?: string; quality_rating?: string }>(phoneNumberId, {
    token,
    query: { fields: "id,display_phone_number,verified_name,quality_rating" },
  });
}

/** Who owns the WABA (Business Manager id + name) — recorded for portability. */
export async function fetchWabaOwner(wabaId: string, token: string) {
  const d = await graph<{ id: string; name?: string; owner_business_info?: { id?: string; name?: string } }>(wabaId, {
    token,
    query: { fields: "id,name,owner_business_info" },
  });
  return { businessId: d.owner_business_info?.id ?? null, businessName: d.owner_business_info?.name ?? null, wabaName: d.name ?? null };
}

/** Subscribe our app to the WABA so its webhooks reach us. */
export async function subscribeAppToWaba(wabaId: string, token: string) {
  await graph(`${wabaId}/subscribed_apps`, { method: "POST", token });
}

/** Register the number on Cloud API with a two-step verification PIN. */
export async function registerPhoneNumber(phoneNumberId: string, token: string, pin: string) {
  await graph(`${phoneNumberId}/register`, { method: "POST", token, body: { messaging_product: "whatsapp", pin } });
}

export interface SyncedTemplate {
  name: string;
  language: string;
  status: string;
  category: string | null;
  body_text: string;
  variable_count: number;
}

export async function listTemplates(wabaId: string, token: string): Promise<SyncedTemplate[]> {
  const out: SyncedTemplate[] = [];
  let after: string | undefined;
  for (let page = 0; page < 10; page++) {
    const d = await graph<{
      data?: { name: string; language: string; status: string; category?: string; components?: { type: string; text?: string }[] }[];
      paging?: { cursors?: { after?: string }; next?: string };
    }>(`${wabaId}/message_templates`, {
      token,
      query: { fields: "name,language,status,category,components", limit: "100", ...(after ? { after } : {}) },
    });
    for (const t of d.data ?? []) {
      const body = t.components?.find((c) => c.type === "BODY")?.text ?? "";
      out.push({ name: t.name, language: t.language, status: t.status, category: t.category ?? null, body_text: body, variable_count: countTemplateVariables(body) });
    }
    if (!d.paging?.next || !d.paging.cursors?.after) break;
    after = d.paging.cursors.after;
  }
  return out;
}
