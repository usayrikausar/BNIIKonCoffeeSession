import "server-only";
import type { SupabaseClient } from "@supabase/supabase-js";
import { env } from "@/lib/env";
import { open, paymentCredentialAad, seal } from "@/lib/crypto/secrets";
import type { PaymentGateway, PaymentNotice } from "@/lib/billing/gateway";
import { billplzGateway } from "@/lib/billing/billplz";
import { toyyibpayGateway } from "@/lib/billing/toyyibpay";
import { emailLayout, escapeHtml, sendEmail } from "@/lib/notify/email";
import { loadConnection, sendOutbound } from "@/lib/agent/engine";
import { ServiceWindowClosedError } from "@/lib/channels/whatsapp/policy";
import type { ChannelKind } from "@/lib/channels/types";
import { decidePayment, formatRm, linkMessage, LINK_VALID_DAYS, paidMessage, type Lang, type PaymentDecision } from "./links";

export type GatewayKind = "billplz" | "toyyibpay";

export interface PaymentAccount {
  id: string;
  tenant_id: string;
  gateway: GatewayKind;
  collection_ref: string | null;
  sandbox: boolean;
  status: string;
  is_active: boolean;
}

// ---------------------------------------------------------------------------
// Encrypted gateway keys (same scheme as WhatsApp credentials, own AAD)
// ---------------------------------------------------------------------------
async function putSecret(db: SupabaseClient, tenantId: string, accountId: string, name: string, value: string) {
  const sealed = seal(value, paymentCredentialAad(tenantId, accountId, name));
  await db.from("payment_account_credentials").update({ is_current: false, revoked_at: new Date().toISOString() })
    .eq("tenant_id", tenantId).eq("account_id", accountId).eq("name", name).eq("is_current", true);
  const { error } = await db.from("payment_account_credentials").insert({
    tenant_id: tenantId, account_id: accountId, name, key_id: sealed.keyId, ciphertext: sealed.ciphertext,
  });
  if (error) throw new Error(`could not store payment key: ${error.message}`);
}

async function getSecret(db: SupabaseClient, tenantId: string, accountId: string, name: string): Promise<string | null> {
  const { data } = await db
    .from("payment_account_credentials")
    .select("key_id, ciphertext")
    .eq("tenant_id", tenantId).eq("account_id", accountId).eq("name", name)
    .eq("is_current", true).is("revoked_at", null)
    .maybeSingle();
  return data ? open({ keyId: data.key_id, ciphertext: data.ciphertext }, paymentCredentialAad(tenantId, accountId, name)) : null;
}

function billplzBase(sandbox: boolean) {
  return process.env.BILLPLZ_API_BASE_URL ?? (sandbox ? "https://www.billplz-sandbox.com" : "https://www.billplz.com");
}
function toyyibBase(sandbox: boolean) {
  return process.env.TOYYIBPAY_API_BASE_URL ?? (sandbox ? "https://dev.toyyibpay.com" : "https://toyyibpay.com");
}

// ---------------------------------------------------------------------------
// Connect a business's OWN gateway account (owner only; checked by the caller)
// ---------------------------------------------------------------------------
export interface ConnectInput {
  gateway: GatewayKind;
  sandbox: boolean;
  accountHolderName: string;
  billplz?: { apiKey: string; collectionId: string; xSignatureKey: string };
  toyyibpay?: { secretKey: string; categoryCode: string };
}

/** Prove the keys work before saving them (a wrong key would only fail when a customer tries to pay). */
export async function checkGatewayKeys(input: ConnectInput): Promise<string | null> {
  try {
    if (input.gateway === "billplz") {
      const k = input.billplz!;
      if (!k.apiKey || !k.collectionId || !k.xSignatureKey) return "API key, Collection ID dan X Signature Key diperlukan / required";
      const res = await fetch(`${billplzBase(input.sandbox)}/api/v3/collections/${encodeURIComponent(k.collectionId)}`, {
        headers: { Authorization: `Basic ${Buffer.from(`${k.apiKey}:`).toString("base64")}` },
        signal: AbortSignal.timeout(15_000),
      });
      if (res.status === 401) return "Billplz menolak API key ini / Billplz rejected this API key";
      if (!res.ok) return `Billplz: koleksi tidak dijumpai / collection not found (${res.status})`;
      return null;
    }
    const k = input.toyyibpay!;
    if (!k.secretKey || !k.categoryCode) return "User Secret Key dan Category Code diperlukan / required";
    const res = await fetch(`${toyyibBase(input.sandbox)}/index.php/api/getCategoryDetails`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ userSecretKey: k.secretKey, categoryCode: k.categoryCode }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = await res.json().catch(() => null);
    const row = Array.isArray(data) ? (data[0] as Record<string, unknown> | undefined) : undefined;
    if (!res.ok || !row || !row.categoryName) return "ToyyibPay menolak kunci / kategori ini / ToyyibPay rejected this key or category";
    return null;
  } catch (e) {
    return `Tidak dapat menghubungi gateway / Could not reach the gateway: ${e instanceof Error ? e.message.slice(0, 120) : "error"}`;
  }
}

export async function connectPaymentAccount(db: SupabaseClient, tenantId: string, input: ConnectInput): Promise<{ id: string }> {
  // Retire any previous account (one active per business), keeping it for audit.
  await db.from("payment_accounts").update({ is_active: false, status: "disconnected" }).eq("tenant_id", tenantId).eq("is_active", true);
  const { data, error } = await db
    .from("payment_accounts")
    .insert({
      tenant_id: tenantId,
      gateway: input.gateway,
      status: "connected",
      is_active: true,
      sandbox: input.sandbox,
      collection_ref: input.gateway === "billplz" ? input.billplz!.collectionId : input.toyyibpay!.categoryCode,
      account_holder_name: input.accountHolderName.slice(0, 200),
      verified_at: new Date().toISOString(),
    })
    .select("id")
    .single();
  if (error || !data) throw new Error(`could not save payment account: ${error?.message}`);
  if (input.gateway === "billplz") {
    await putSecret(db, tenantId, data.id, "api_key", input.billplz!.apiKey);
    await putSecret(db, tenantId, data.id, "x_signature_key", input.billplz!.xSignatureKey);
  } else {
    await putSecret(db, tenantId, data.id, "secret_key", input.toyyibpay!.secretKey);
  }
  return { id: data.id };
}

export async function disconnectPaymentAccount(db: SupabaseClient, tenantId: string) {
  const { data } = await db.from("payment_accounts").select("id").eq("tenant_id", tenantId).eq("is_active", true);
  for (const a of data ?? []) {
    await db.from("payment_account_credentials").update({ is_current: false, revoked_at: new Date().toISOString() }).eq("tenant_id", tenantId).eq("account_id", a.id);
  }
  await db.from("payment_accounts").update({ is_active: false, status: "disconnected" }).eq("tenant_id", tenantId).eq("is_active", true);
}

export async function activeAccount(db: SupabaseClient, tenantId: string): Promise<PaymentAccount | null> {
  const { data } = await db
    .from("payment_accounts")
    .select("id, tenant_id, gateway, collection_ref, sandbox, status, is_active")
    .eq("tenant_id", tenantId).eq("is_active", true).eq("status", "connected")
    .maybeSingle();
  return (data as PaymentAccount | null) ?? null;
}

export async function accountById(db: SupabaseClient, id: string): Promise<PaymentAccount | null> {
  if (!/^[0-9a-f-]{36}$/.test(id)) return null;
  const { data } = await db.from("payment_accounts").select("id, tenant_id, gateway, collection_ref, sandbox, status, is_active").eq("id", id).maybeSingle();
  return (data as PaymentAccount | null) ?? null;
}

/** The business's own gateway, built from its encrypted keys. */
export async function gatewayFor(db: SupabaseClient, a: PaymentAccount): Promise<PaymentGateway> {
  if (a.gateway === "billplz") {
    const [apiKey, xSignatureKey] = await Promise.all([getSecret(db, a.tenant_id, a.id, "api_key"), getSecret(db, a.tenant_id, a.id, "x_signature_key")]);
    if (!apiKey || !xSignatureKey || !a.collection_ref) throw new Error("payment account keys missing");
    return billplzGateway({ apiKey, xSignatureKey, collectionId: a.collection_ref, sandbox: a.sandbox });
  }
  const secretKey = await getSecret(db, a.tenant_id, a.id, "secret_key");
  if (!secretKey || !a.collection_ref) throw new Error("payment account keys missing");
  return toyyibpayGateway({ secretKey, categoryCode: a.collection_ref, sandbox: a.sandbox });
}

// ---------------------------------------------------------------------------
// Create and send a link (a staff member, from a chat)
// ---------------------------------------------------------------------------
export class PaymentLinkError extends Error {
  constructor(public code: "no_account" | "window_closed" | "gateway" | "not_found", message: string) {
    super(message);
  }
}

/**
 * `member` is the staff member's RLS-scoped client: the link row is inserted
 * AS THEM (RLS proves they belong to this business and stamps created_by).
 * `admin` is used only for the gateway keys and to record the bill id/URL.
 */
export async function createAndSendLink(
  member: SupabaseClient,
  admin: SupabaseClient,
  a: { tenantId: string; conversationId: string; userId: string; amountCents: number; description: string; lang: Lang; timeZone: string },
) {
  const account = await activeAccount(admin, a.tenantId);
  if (!account) throw new PaymentLinkError("no_account", "Sambung akaun Billplz atau ToyyibPay anda dahulu (Saluran → Pembayaran) / Connect your Billplz or ToyyibPay account first (Channels → Payments)");
  const { data: conv } = await admin
    .from("conversations")
    .select("id, channel, channel_connection_id, last_inbound_at, lead_details, contact:contacts(id, external_id, name, phone, email)")
    .eq("tenant_id", a.tenantId).eq("id", a.conversationId).maybeSingle();
  if (!conv) throw new PaymentLinkError("not_found", "not found");
  const contact = (Array.isArray(conv.contact) ? conv.contact[0] : conv.contact) as { id: string; external_id: string; name: string | null; phone: string | null; email: string | null } | null;
  const details = (conv.lead_details ?? {}) as Record<string, string>;

  const expiresAt = new Date(Date.now() + LINK_VALID_DAYS * 86_400_000);
  const { data: link, error } = await member
    .from("payment_links")
    .insert({
      tenant_id: a.tenantId, account_id: account.id, conversation_id: conv.id, contact_id: contact?.id ?? null,
      created_by: a.userId, amount_cents: a.amountCents, description: a.description, expires_at: expiresAt.toISOString(),
    })
    .select("id")
    .single();
  if (error || !link) throw new PaymentLinkError("not_found", `could not create link: ${error?.message}`);

  const phone = conv.channel === "whatsapp" ? contact?.external_id : (details.phone ?? contact?.phone ?? "").replace(/[^\d]/g, "") || null;
  let email = details.email || contact?.email || "";
  if (!email && !phone) {
    // Billplz needs an email or mobile to create a bill. A web-chat customer often
    // hasn't shared either, so the bill uses the business's own email (the receipt
    // goes to the business); the customer still pays normally through the link.
    const { data: o } = await admin.from("tenant_members").select("email").eq("tenant_id", a.tenantId).eq("role", "owner").not("email", "is", null).limit(1).maybeSingle();
    email = (o?.email as string | undefined) ?? "";
  }
  let bill;
  try {
    const gw = await gatewayFor(admin, account);
    bill = await gw.createBill({
      invoiceId: link.id,
      invoiceNumber: link.id.slice(0, 8).toUpperCase(),
      referenceLabel: "Rujukan",
      amountCents: a.amountCents,
      description: a.description,
      customerName: details.name || contact?.name || "Pelanggan",
      customerEmail: email,
      customerPhone: phone,
      callbackUrl: `${env.appUrl()}/api/payments/${account.id}/callback`,
      returnUrl: `${env.appUrl()}/pay/${account.id}/return`,
    });
  } catch (e) {
    await admin.from("payment_links").update({ status: "failed" }).eq("tenant_id", a.tenantId).eq("id", link.id);
    throw new PaymentLinkError("gateway", `Gateway: ${e instanceof Error ? e.message.slice(0, 200) : "error"}`);
  }
  if (!bill.paymentUrl?.startsWith("https://")) {
    await admin.from("payment_links").update({ status: "failed" }).eq("tenant_id", a.tenantId).eq("id", link.id);
    throw new PaymentLinkError("gateway", "Gateway did not return a secure payment URL");
  }
  await admin.from("payment_links").update({ gateway_bill_id: bill.billId, url: bill.paymentUrl }).eq("tenant_id", a.tenantId).eq("id", link.id);

  const body = linkMessage({ description: a.description, amountCents: a.amountCents, url: bill.paymentUrl, expiresAt }, a.lang, a.timeZone);
  try {
    const msg = await sendOutbound(admin, {
      tenantId: a.tenantId, conversationId: conv.id, body, sender: "human", sentBy: a.userId,
      connection: await loadConnection(admin, a.tenantId, conv.channel_connection_id as string | null),
      channel: conv.channel as ChannelKind, contactExternalId: contact?.external_id ?? "",
      lastInboundAt: conv.last_inbound_at as string | null,
      metadata: { payment_link_id: link.id },
    });
    await admin.from("payment_links").update({ message_id: msg.id }).eq("tenant_id", a.tenantId).eq("id", link.id);
    return { linkId: link.id, url: bill.paymentUrl, messageStatus: msg.status };
  } catch (e) {
    // WhatsApp 24h window closed: the bill exists but can't be sent as free text.
    await admin.from("payment_links").update({ status: "cancelled" }).eq("tenant_id", a.tenantId).eq("id", link.id);
    if (e instanceof ServiceWindowClosedError) {
      throw new PaymentLinkError("window_closed", "Pelanggan belum menulis dalam 24 jam — WhatsApp tidak membenarkan mesej bebas. Tunggu pelanggan menulis dahulu. / The customer hasn't written in 24h, so WhatsApp doesn't allow free messages.");
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Gateway notices (callback / return) — the ONLY way a link becomes paid
// ---------------------------------------------------------------------------
export async function processPaymentNotice(db: SupabaseClient, account: PaymentAccount, n: PaymentNotice): Promise<PaymentDecision> {
  const { data: link } = await db
    .from("payment_links")
    .select("id, tenant_id, status, amount_cents, description, conversation_id, contact_id")
    .eq("tenant_id", account.tenant_id).eq("account_id", account.id).eq("gateway_bill_id", n.billId)
    .maybeSingle();
  const decision = decidePayment(link, n);
  // Audit every notice (idempotent on event_key); never store card data — gateways don't send any.
  const { error: dup } = await db.from("payment_link_events").insert({
    tenant_id: account.tenant_id, link_id: link?.id ?? null, gateway: account.gateway, event_key: n.eventKey,
    verified: n.verified, paid: n.paid, paid_amount_cents: n.paidAmountCents, payload: { ...n.raw, decision },
  });
  if (dup?.code === "23505") return link?.status === "paid" ? "already_paid" : decision; // replay of a notice we already handled
  if (decision !== "paid" || !link) return decision;

  // Claim: only one notice can flip the link (status guard).
  const { data: flipped } = await db
    .from("payment_links")
    .update({ status: "paid", paid_at: new Date().toISOString(), paid_amount_cents: n.paidAmountCents })
    .eq("tenant_id", account.tenant_id).eq("id", link.id).in("status", ["open", "expired"])
    .select("id");
  if (!flipped?.length) return "already_paid";
  await afterPaid(db, account.tenant_id, { ...link, paidCents: n.paidAmountCents! });
  return "paid";
}

async function afterPaid(
  db: SupabaseClient,
  tenantId: string,
  link: { id: string; description: string; conversation_id: string | null; paidCents: number },
) {
  const { data: t } = await db.from("tenants").select("name, default_locale").eq("id", tenantId).single();
  const lang: Lang = (t?.default_locale as Lang) ?? "ms";
  if (link.conversation_id) {
    const { data: conv } = await db
      .from("conversations")
      .select("id, channel, channel_connection_id, last_inbound_at, outcome, outcome_value_cents, contact:contacts(external_id, name)")
      .eq("tenant_id", tenantId).eq("id", link.conversation_id).maybeSingle();
    if (conv) {
      // Conversion tracking: the lead is Won, with the amount paid added to its value.
      await db.from("conversations").update({
        outcome: "won",
        outcome_value_cents: ((conv.outcome === "won" ? conv.outcome_value_cents : 0) ?? 0) + link.paidCents,
        outcome_at: new Date().toISOString(),
      }).eq("tenant_id", tenantId).eq("id", conv.id);
      const contact = (Array.isArray(conv.contact) ? conv.contact[0] : conv.contact) as { external_id: string } | null;
      // Tell the customer in the chat (skipped quietly if WhatsApp's 24h window has closed).
      await sendOutbound(db, {
        tenantId, conversationId: conv.id, body: paidMessage({ description: link.description, paidCents: link.paidCents }, lang), sender: "system",
        connection: await loadConnection(db, tenantId, conv.channel_connection_id as string | null),
        channel: conv.channel as ChannelKind, contactExternalId: contact?.external_id ?? "",
        lastInboundAt: conv.last_inbound_at as string | null, metadata: { payment_link_id: link.id, payment_received: true },
      }).catch((e) => console.warn(`[payments] tenant=${tenantId} confirmation not sent to customer: ${e instanceof Error ? e.name : e}`));
    }
  }
  // Tell the owners by email.
  const { data: owners } = await db.from("tenant_members").select("email").eq("tenant_id", tenantId).eq("role", "owner");
  const url = link.conversation_id ? `${env.appUrl()}/dashboard/inbox/${link.conversation_id}` : `${env.appUrl()}/dashboard`;
  for (const o of owners ?? []) {
    if (!o.email) continue;
    const res = await sendEmail({
      to: o.email,
      subject: `💰 Bayaran diterima ${formatRm(link.paidCents)} — ${link.description}`,
      html: emailLayout("Bayaran diterima", `<p><b>${formatRm(link.paidCents)}</b> untuk "${escapeHtml(link.description)}" telah dibayar terus ke akaun ${escapeHtml(t?.name ?? "")}.</p><p><a href="${url}">Buka perbualan</a></p>`),
      text: `Bayaran ${formatRm(link.paidCents)} diterima untuk "${link.description}". ${url}`,
    });
    await db.from("notifications").insert({
      tenant_id: tenantId, conversation_id: link.conversation_id, kind: "payment", transport: "email", recipient: o.email,
      status: res.ok ? "sent" : "failed", error: res.error ?? null, sent_at: res.ok ? new Date().toISOString() : null,
    });
  }
}

/** Hourly: open links past their expiry become "expired" (a late payment is still accepted). */
export async function expirePaymentLinks(db: SupabaseClient, now = new Date()) {
  const { data } = await db.from("payment_links").update({ status: "expired" }).eq("status", "open").lt("expires_at", now.toISOString()).select("id");
  return data?.length ?? 0;
}
