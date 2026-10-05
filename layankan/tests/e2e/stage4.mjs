// Stage 4 end-to-end: the Murpati adapter is a STUB on the real request path.
// Its webhook stores nothing, sends through a Murpati connection fail cleanly
// with no network call, and the Meta path still works.
// Requires the local stack: `bash tests/e2e/stack.sh up`, then `npm run test:stage4`.
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { sessionCookie, sign } from "./jwt.mjs";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const REST = "http://127.0.0.1:54321/rest/v1";
const SERVICE = sign({ role: "service_role", iss: "supabase" });
const B = { tenant: "bbbbbbbb-0000-4000-8000-000000000001", murpati: "eeeeeeee-0000-4000-8000-0000000000bb" };
const OWNER_B = sessionCookie("00000000-0000-0000-0000-0000000000b1", "owner-b@kedai.test");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? ` — ${detail}` : ""}`);
};
const rest = async (path, init = {}) => {
  const r = await fetch(`${REST}/${path}`, { ...init, headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "content-type": "application/json", Prefer: "return=representation,count=exact", ...(init.headers ?? {}) } });
  const text = await r.text();
  return { data: text ? JSON.parse(text) : null, count: Number((r.headers.get("content-range") ?? "/0").split("/")[1]) };
};
const count = async (table, filter) => (await rest(`${table}?${filter}&select=id`, { method: "HEAD" })).count;

// 1. Webhook: a well-formed, "signed-looking" Murpati event is refused and NOT stored
const before = await count("messages", `tenant_id=eq.${B.tenant}`);
const contactsBefore = await count("contacts", `tenant_id=eq.${B.tenant}`);
const wh = await fetch(`${BASE}/api/webhooks/murpati/${B.murpati}`, {
  method: "POST",
  headers: { "content-type": "application/json", "x-murpati-signature": "sha256=deadbeef", "x-murpati-timestamp": String(Math.floor(Date.now() / 1000)) },
  body: JSON.stringify({ event: "message.received", data: { id: "m-stage4", from: "60199999999", body: "hello from murpati" } }),
});
check("Murpati webhook answers 501 Not Implemented", wh.status === 501, `HTTP ${wh.status}`);
check("…and stores no message", (await count("messages", `tenant_id=eq.${B.tenant}`)) === before);
check("…and creates no contact", (await count("contacts", `tenant_id=eq.${B.tenant}`)) === contactsBefore);
const unknown = await fetch(`${BASE}/api/webhooks/murpati/00000000-0000-4000-8000-00000000dead`, { method: "POST", body: "{}" });
check("unknown connection id → 404", unknown.status === 404, `HTTP ${unknown.status}`);

// 2. Sending through a Murpati connection fails cleanly (owner reply via dashboard)
await rest(`channel_connections?id=eq.${B.murpati}`, { method: "PATCH", body: JSON.stringify({ is_active: true, display_phone_number: "+60 3-1111 2222" }) });
await rest(`contacts`, { method: "POST", body: JSON.stringify({ id: "cccccccc-0000-4000-8000-0000000004bb", tenant_id: B.tenant, channel: "whatsapp", external_id: "60188888888" }) });
await rest(`conversations`, { method: "POST", body: JSON.stringify({ id: "dddddddd-0000-4000-8000-0000000004bb", tenant_id: B.tenant, contact_id: "cccccccc-0000-4000-8000-0000000004bb", channel: "whatsapp", channel_connection_id: B.murpati, status: "human", last_inbound_at: new Date().toISOString() }) });
const reply = await fetch(`${BASE}/api/dashboard/conversations/dddddddd-0000-4000-8000-0000000004bb/reply`, {
  method: "POST", headers: { cookie: OWNER_B, "content-type": "application/json" }, body: JSON.stringify({ body: "Terima kasih", force: true }),
});
const [msg] = (await rest(`messages?conversation_id=eq.dddddddd-0000-4000-8000-0000000004bb&direction=eq.outbound&select=status,error,provider&order=created_at.desc&limit=1`)).data ?? [];
check("owner reply through Murpati is saved in OUR database first", !!msg, `HTTP ${reply.status}`);
check("…and marked failed with MURPATI_NOT_IMPLEMENTED", msg?.status === "failed" && String(msg?.error ?? "").includes("MURPATI_NOT_IMPLEMENTED"), JSON.stringify(msg));
// (That the stub makes no network call is proven in tests/adapter-contract.test.ts with fetch spied.)

// 3. Channels page tells the owner Murpati is not available, and offers no Murpati form
const page = await (await fetch(`${BASE}/dashboard/channels`, { headers: { cookie: OWNER_B } })).text();
check("Channels page shows Murpati as 'coming soon'", /akan datang|coming soon/.test(page) && /dokumentasi API/.test(page));
check("…and no Murpati API-key form", !/Murpati API key/.test(page));
check("…and warns about the existing Murpati connection", /tidak boleh menghantar atau menerima/.test(page));

// 4. The Meta (direct) path still works end to end: signed webhook → stored → AI reply → sent via Graph.
// Uses tenant B (tenant A's usage is reserved for the Stage 3 test). Murpati goes back to standby first:
// only one WhatsApp connection can be active per business.
await rest(`channel_connections?id=eq.${B.murpati}`, { method: "PATCH", body: JSON.stringify({ is_active: false }) });
const A = { tenant: B.tenant, conn: "eeeeeeee-0000-4000-8000-0000000004aa" };
await rest(`channel_connections`, { method: "POST", body: JSON.stringify({ id: A.conn, tenant_id: A.tenant, channel: "whatsapp", provider: "meta_cloud", status: "connected", is_active: true, phone_number_id: "PN-STAGE4", display_phone_number: "+60 3-2222 3333" }) });
// store the access token exactly as the app would (AES-256-GCM, stack key k1, AAD bound to tenant+connection+name)
const key = Buffer.alloc(32, 7), iv = randomBytes(12);
const c = createCipheriv("aes-256-gcm", key, iv);
c.setAAD(Buffer.from(`layankan:cred:${A.tenant}:${A.conn}:access_token`));
const data = Buffer.concat([c.update("EAAG-fake-token", "utf8"), c.final()]);
await rest(`channel_credentials`, { method: "POST", body: JSON.stringify({ tenant_id: A.tenant, connection_id: A.conn, name: "access_token", key_id: "k1", ciphertext: Buffer.concat([iv, c.getAuthTag(), data]).toString("base64") }) });
const metaBody = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA", changes: [{ field: "messages", value: {
  messaging_product: "whatsapp", metadata: { display_phone_number: "60322223333", phone_number_id: "PN-STAGE4" },
  contacts: [{ profile: { name: "Siti" }, wa_id: "60177777777" }],
  messages: [{ from: "60177777777", id: "wamid.STAGE4", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Hi, harga?" } }],
} }] }] });
const unsigned = await fetch(`${BASE}/api/webhooks/meta`, { method: "POST", headers: { "content-type": "application/json" }, body: metaBody });
check("Meta webhook without a valid signature is refused", unsigned.status === 401 || unsigned.status === 403, `HTTP ${unsigned.status}`);
const signed = await fetch(`${BASE}/api/webhooks/meta`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", "metasecret").update(metaBody).digest("hex")}` }, body: metaBody });
check("signed Meta webhook accepted", signed.ok, `HTTP ${signed.status}`);
let out;
for (let i = 0; i < 20 && !out?.provider_message_id; i++) {
  await new Promise((r) => setTimeout(r, 500));
  [out] = (await rest(`messages?tenant_id=eq.${A.tenant}&provider=eq.meta_cloud&direction=eq.outbound&select=status,provider_message_id,sender&order=created_at.desc&limit=1`)).data ?? [];
}
const [inMsg] = (await rest(`messages?tenant_id=eq.${A.tenant}&provider_message_id=eq.wamid.STAGE4&select=body`)).data ?? [];
check("customer message stored in OUR database", inMsg?.body === "Hi, harga?");
check("AI reply sent through Meta (Graph message id recorded)", out?.status === "sent" && String(out?.provider_message_id).startsWith("wamid.OUT"), JSON.stringify(out));

// 5. Admin console: encryption keys + WhatsApp ownership (platform admin only)
const ADMIN = sessionCookie("00000000-0000-0000-0000-00000000ad01", "admin@layankan.test");
const adminPage = await fetch(`${BASE}/admin`, { headers: { cookie: ADMIN } });
const adminHtml = await adminPage.text();
check("admin console shows encryption key status", adminPage.ok && /Encryption keys/.test(adminHtml) && /current/.test(adminHtml), `HTTP ${adminPage.status}`);
check("admin console lists WhatsApp numbers needing attention (Murpati stub, unverified owners)", /WhatsApp numbers needing attention/.test(adminHtml) && /Murpati \(stub/.test(adminHtml));
const notAdmin = await fetch(`${BASE}/admin`, { headers: { cookie: OWNER_B } });
check("…and is hidden from business owners", notAdmin.status === 404, `HTTP ${notAdmin.status}`);

console.log(failures ? `\n${failures} STAGE 4 FAILURE(S)` : "\nALL STAGE 4 CHECKS PASSED");
process.exit(failures ? 1 : 0);
