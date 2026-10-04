// R6 end-to-end: opt-in WhatsApp broadcasts through the official Meta API
// (fake Graph). Uses its own business (tenant H).
// Requires the local stack: `bash tests/e2e/stack.sh up`, then `npm run test:r6`.
import { spawnSync } from "node:child_process";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { sessionCookie } from "./jwt.mjs";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const H = { tenant: "b8b8b8b8-0000-4000-8000-0000000000b8", slug: "kedai-h", owner: "00000000-0000-0000-0000-0000000000c8", staff: "00000000-0000-0000-0000-0000000000c9", conn: "b8b8b8b8-0000-4000-8000-0000000001b8" };
const OWNER = sessionCookie(H.owner, "owner-h@r6.test");
const STAFF = sessionCookie(H.staff, "staff-h@r6.test");
const OWNER_B = sessionCookie("00000000-0000-0000-0000-0000000000b1", "owner-b@kedai.test");
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? ` — ${detail}` : ""}`);
};
const sql = (q) => {
  const r = spawnSync("psql", ["-h", "127.0.0.1", "-p", "54330", "-U", "postgres", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qtAc", q], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waSends = async () => (await (await fetch("http://127.0.0.1:4010/__graph_sends")).json()).filter((s) => s.kind === "wa_send" && s.body.type === "template" && s.body.template?.name?.startsWith("promo_"));
const api = (body, cookie = OWNER) => fetch(`${BASE}/api/dashboard/broadcasts`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify(body) });
const cron = () => fetch(`${BASE}/api/cron/hourly`, { headers: { authorization: "Bearer testcron" } });
/** A fixed-offset zone where it's currently `hour` o'clock (Etc/GMT signs are inverted). */
const zoneAt = (hour) => {
  let off = hour - new Date().getUTCHours();
  if (off > 14) off -= 24;
  if (off < -12) off += 24;
  return off === 0 ? "Etc/GMT" : `Etc/GMT${off > 0 ? "-" : "+"}${Math.abs(off)}`;
};
const status = (id) => JSON.parse(sql(`select row_to_json(b) from (select status, recipients_total, sent_count, failed_count, skipped_count from broadcasts where id = '${id}') b`) || "null");
async function waitDone(id, want = "sent") {
  for (let i = 0; i < 40; i++) {
    if (status(id)?.status === want) return status(id);
    await sleep(300);
  }
  return status(id);
}
const recipients = (id) => JSON.parse(sql(`select coalesce(json_object_agg(k.name, coalesce(r.skip_reason, r.status)), '{}') from broadcast_recipients r join contacts k on k.id = r.contact_id where r.broadcast_id = '${id}'`));
const usage = () => Number(sql(`select coalesce(sum(broadcast_messages), 0) from usage_counters where tenant_id = '${H.tenant}'`));

// ---------------------------------------------------------------- setup
sql(`
  insert into auth.users (id, email, email_confirmed_at) values ('${H.owner}', 'owner-h@r6.test', now()), ('${H.staff}', 'staff-h@r6.test', now()) on conflict do nothing;
  insert into tenants (id, slug, name, status, timezone) values ('${H.tenant}', '${H.slug}', 'Kedai H', 'live', '${zoneAt(12)}') on conflict do nothing;
  insert into tenant_members (tenant_id, user_id, role, email) values ('${H.tenant}', '${H.owner}', 'owner', 'owner-h@r6.test'), ('${H.tenant}', '${H.staff}', 'staff', 'staff-h@r6.test') on conflict do nothing;
  insert into business_brains (tenant_id, profile) values ('${H.tenant}', '{"name":"Kedai H"}') on conflict do nothing;
  insert into channel_connections (id, tenant_id, channel, provider, status, is_active, phone_number_id, waba_id, display_phone_number)
    values ('${H.conn}', '${H.tenant}', 'whatsapp', 'meta_cloud', 'connected', true, 'PN_H', 'WABA_H', '+60 3-8888 0000');
`);
const key = Buffer.alloc(32, 7), iv = randomBytes(12);
const c = createCipheriv("aes-256-gcm", key, iv);
c.setAAD(Buffer.from(`layankan:cred:${H.tenant}:${H.conn}:access_token`));
const enc = Buffer.concat([c.update("EAAG-kedai-h", "utf8"), c.final()]);
sql(`insert into channel_credentials (tenant_id, connection_id, name, key_id, ciphertext) values ('${H.tenant}', '${H.conn}', 'access_token', 'k1', '${Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64")}')`);
sql(`insert into message_templates (tenant_id, connection_id, name, language, category, status, body_text, variable_count, source) values
  ('${H.tenant}', '${H.conn}', 'promo_ok', 'ms', 'MARKETING', 'APPROVED', 'Hai {{1}}! Diskaun 20% di {{2}} minggu ini. Balas STOP untuk berhenti.', 2, 'meta_sync'),
  ('${H.tenant}', '${H.conn}', 'promo_nostop', 'ms', 'MARKETING', 'APPROVED', 'Diskaun 20% minggu ini!', 0, 'meta_sync'),
  ('${H.tenant}', '${H.conn}', 'promo_util', 'ms', 'UTILITY', 'APPROVED', 'Tempahan anda disahkan. Balas STOP untuk berhenti.', 0, 'meta_sync'),
  ('${H.tenant}', null, 'promo_manual', 'ms', 'MARKETING', 'APPROVED', 'Promo! Balas STOP untuk berhenti.', 0, 'manual')`);

let n = 0;
/** A WhatsApp customer with a chat (lead score) and, optionally, a recorded PROMO opt-in. */
function customer(name, wa, score, optedIn) {
  const id = `b8b8b8b8-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  sql(`
    insert into contacts (id, tenant_id, channel, external_id, name) values ('${id}', '${H.tenant}', 'whatsapp', '${wa}', '${name}');
    insert into conversations (tenant_id, contact_id, channel, channel_connection_id, lead_score, last_message_at)
      values ('${H.tenant}', '${id}', 'whatsapp', '${H.conn}', ${score ? `'${score}'` : "null"}, now() - interval '3 days');
  `);
  if (optedIn) {
    const conv = sql(`select id from conversations where contact_id = '${id}'`);
    const msg = sql(`insert into messages (tenant_id, conversation_id, direction, sender, body, channel, status) values ('${H.tenant}', '${conv}', 'inbound', 'customer', 'PROMO', 'whatsapp', 'received') returning id`);
    sql(`insert into marketing_consent_events (tenant_id, contact_id, channel, action, method, consent_text, consent_text_version, evidence_message_id)
      values ('${H.tenant}', '${id}', 'whatsapp', 'granted', 'chat_reply', 'Nak terima promosi melalui WhatsApp? Balas PROMO untuk setuju.', 'v1', '${msg}')`);
  }
  return { id, wa, name };
}
const aisyah = customer("Aisyah Rahman", "60110000001", "PANAS", true);
customer("Ben", "60110000002", "SUAM", true);
customer("Chong", "60110000003", "SEJUK", true);
const dina = customer("Dina", "60110000004", "PANAS", false); // never agreed
const eva = customer("Eva", "60110000005", "PANAS", true);
sql(`update contacts set opted_out_at = now() where id = '${eva.id}'`); // replied STOP → withdrawal recorded automatically
const faiz = customer("Faiz", "60110000006", "SUAM", true);
sql(`insert into marketing_consent_events (tenant_id, contact_id, channel, action, method, consent_text, consent_text_version, recorded_by)
  values ('${H.tenant}', '${faiz.id}', 'whatsapp', 'withdrawn', 'staff_withdrawal', 'Customer asked by phone to stop promotions', 'v1', '${H.staff}')`);

// ---------------------------------------------------------------- 1. The page and who may use it
const clean = (h) => h.replace(/<!-- -->/g, ""); // React text markers
const page = clean(await (await fetch(`${BASE}/dashboard/promotions`, { headers: { cookie: OWNER } })).text());
check("Promosi page: opted-in count (STOP and staff withdrawals excluded) and allowance", /Promosi \(WhatsApp\)/.test(page) && />3<\/div>/.test(page) && />0 <span[^>]*>\/ 50</.test(page));
check("…only Meta-synced MARKETING templates with a STOP line can be picked",
  /<option value="promo_ok\|ms"[^>]*>promo_ok \(ms\)<\/option>/.test(page) && /disabled="">promo_manual \(ms\) — Bukan dari Meta/.test(page)
  && /disabled="">promo_nostop[^<]*Tiada ayat/.test(page) && /disabled="">promo_util[^<]*Bukan kategori MARKETING/.test(page));
const staffPage = await (await fetch(`${BASE}/dashboard/promotions`, { headers: { cookie: STAFF } })).text();
check("staff see the history but not the send form", /Promosi terdahulu/.test(staffPage) && !/Promosi baharu/.test(staffPage));
check("staff cannot send a broadcast", (await api({ action: "preview", audience: {} }, STAFF)).status === 403);

// ---------------------------------------------------------------- 2. Audience and template checks
let pv = await (await api({ action: "preview", audience: { scores: [] } })).json();
check("preview: everyone who agreed = 3 (Dina never agreed, Eva wrote STOP, Faiz asked staff to stop)", pv.optedIn === 3 && pv.eligible === 3 && pv.left === 50, JSON.stringify(pv));
pv = await (await api({ action: "preview", audience: { scores: ["PANAS"] } })).json();
check("preview: only PANAS = 1 (Aisyah; Dina is PANAS but never agreed)", pv.eligible === 1, JSON.stringify(pv));
const base = { action: "create", name: "Promo Merdeka", template_name: "promo_ok", template_language: "ms", variables: ["{name}", "{business}"], audience: { scores: [] }, confirm: true };
const bad = async (o) => { const r = await api({ ...base, ...o }); return { s: r.status, d: await r.json() }; };
let r = await bad({ template_name: "promo_nostop", variables: [] });
check("a template without \"Balas STOP\" is refused", r.s === 400 && r.d.problem === "no_opt_out_line");
r = await bad({ template_name: "promo_manual", variables: [] });
check("a template typed in by the owner (not from Meta) is refused", r.s === 400 && r.d.problem === "not_synced");
r = await bad({ template_name: "promo_util", variables: [] });
check("a non-MARKETING template is refused", r.s === 400 && r.d.problem === "not_marketing");
check("the owner must tick the confirmation", (await bad({ confirm: false })).s === 400);
check("all template variables are required", (await bad({ variables: ["{name}"] })).s === 400);
sql(`insert into usage_counters (tenant_id, period_start, broadcast_messages) values ('${H.tenant}', current_usage_period('${H.tenant}'), 49)
  on conflict (tenant_id, period_start) do update set broadcast_messages = 49`);
r = await bad({});
check("more recipients than this month's allowance → refused with a clear message", r.s === 409 && /Baki bulan ini 1 mesej/.test(r.d.error), JSON.stringify(r.d));
sql(`update usage_counters set broadcast_messages = 0 where tenant_id = '${H.tenant}'`);
check("nothing was sent by any refused attempt", (await waSends()).length === 0 && sql(`select count(*) from broadcasts where tenant_id = '${H.tenant}'`) === "0");

// ---------------------------------------------------------------- 3. Send now
const created = await (await api(base)).json();
check("Send now → queued for the 3 who agreed", created.ok && created.status === "sending" && created.queued === 3, JSON.stringify(created));
const B1 = created.broadcastId;
const s1 = await waitDone(B1);
check("…all 3 sent, broadcast marked done", s1?.status === "sent" && s1.sent_count === 3 && s1.failed_count === 0, JSON.stringify(s1));
let sends = await waSends();
check("exactly 3 WhatsApp template messages left, none to Dina, Eva or Faiz",
  sends.length === 3 && !sends.some((s) => [dina.wa, eva.wa, faiz.wa].includes(s.body.to)), sends.map((s) => s.body.to).join(","));
const toAisyah = sends.find((s) => s.body.to === aisyah.wa);
check("the approved template, with {name} / {business} filled in",
  toAisyah?.body.template.name === "promo_ok" && toAisyah.body.template.language.code === "ms"
  && JSON.stringify(toAisyah.body.template.components?.[0]?.parameters?.map((p) => p.text)) === JSON.stringify(["Aisyah", "Kedai H"]), JSON.stringify(toAisyah?.body.template));
const chatMsg = JSON.parse(sql(`select row_to_json(m) from (select m.sender, m.body, m.metadata->>'broadcast_id' as b from messages m join conversations c on c.id = m.conversation_id where c.contact_id = '${aisyah.id}' and m.direction = 'outbound') m`));
check("the promotion shows in the customer's chat, as the template text", chatMsg.sender === "system" && chatMsg.b === B1 && chatMsg.body === "Hai Aisyah! Diskaun 20% di Kedai H minggu ini. Balas STOP untuk berhenti.", JSON.stringify(chatMsg));
check("3 messages counted against this month's allowance", usage() === 3);
check("each recipient row cites the opt-in it relied on", sql(`select count(*) from broadcast_recipients r join marketing_consent_events e on e.id = r.consent_event_id where r.broadcast_id = '${B1}' and e.action = 'granted' and e.contact_id = r.contact_id`) === "3");

// ---------------------------------------------------------------- 4. Once a week per person
pv = await (await api({ action: "preview", audience: {} })).json();
check("a second promotion now would reach nobody (all got one in the last 7 days)", pv.eligible === 0 && pv.tooRecent === 3, JSON.stringify(pv));
check("…so it is refused", (await bad({ name: "Promo lagi" })).s === 400);

// ---------------------------------------------------------------- 5. STOP between scheduling and sending
const hana = customer("Hana", "60110000008", "SUAM", true);
const ian = customer("Ian", "60110000009", "SUAM", true);
const later = new Date(Date.now() + 3600_000).toISOString();
const sch = await (await api({ ...base, name: "Promo Sabtu", scheduled_at: later })).json();
check("Schedule → waits (2 queued, the 3 from earlier skipped as too recent)", sch.ok && sch.status === "scheduled" && sch.queued === 2 && sch.skipped === 3, JSON.stringify(sch));
const stop = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA_H", changes: [{ field: "messages", value: {
  messaging_product: "whatsapp", metadata: { display_phone_number: "60388880000", phone_number_id: "PN_H" },
  contacts: [{ profile: { name: "Hana" }, wa_id: hana.wa }],
  messages: [{ from: hana.wa, id: "wamid.R6STOP", timestamp: String(Math.floor(Date.now() / 1000)), type: "button", button: { text: "Stop promotions" } }],
} }] }] });
const st = await fetch(`${BASE}/api/webhooks/meta`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", "metasecret").update(stop).digest("hex")}` }, body: stop });
check("Hana taps the template's \"Stop promotions\" button → opted out", st.ok && sql(`select opted_out_at is not null from contacts where id = '${hana.id}'`) === "t");
sql(`update broadcasts set scheduled_at = now() - interval '1 minute' where id = '${sch.broadcastId}'`);
await cron();
const s2 = await waitDone(sch.broadcastId);
const rc2 = recipients(sch.broadcastId);
check("when it's due: Ian gets it, Hana does not (database re-checks the opt-in at send time)", s2?.status === "sent" && rc2.Ian === "sent" && rc2.Hana === "consent_withdrawn", JSON.stringify(rc2));
check("…and nothing was sent to Hana", !(await waSends()).some((s) => s.body.to === hana.wa));

// ---------------------------------------------------------------- 6. Cancel
const jun = customer("Jun", "60110000010", "PANAS", true);
const c3 = await (await api({ ...base, name: "Promo batal", scheduled_at: later })).json();
check("another business can't cancel it", (await fetch(`${BASE}/api/dashboard/broadcasts/${c3.broadcastId}`, { method: "POST", headers: { cookie: OWNER_B, "content-type": "application/json" }, body: '{"action":"cancel"}' })).status === 404);
check("staff can't cancel it", (await fetch(`${BASE}/api/dashboard/broadcasts/${c3.broadcastId}`, { method: "POST", headers: { cookie: STAFF, "content-type": "application/json" }, body: '{"action":"cancel"}' })).status === 403);
const cx = await fetch(`${BASE}/api/dashboard/broadcasts/${c3.broadcastId}`, { method: "POST", headers: { cookie: OWNER, "content-type": "application/json" }, body: '{"action":"cancel"}' });
sql(`update broadcasts set scheduled_at = now() - interval '1 minute' where id = '${c3.broadcastId}'`);
await cron();
check("owner cancels a scheduled promotion → nothing is sent", cx.ok && status(c3.broadcastId).status === "cancelled" && recipients(c3.broadcastId).Jun === "cancelled" && !(await waSends()).some((s) => s.body.to === jun.wa));

// ---------------------------------------------------------------- 7. Quiet hours (9am–9pm)
sql(`update tenants set timezone = '${zoneAt(3)}' where id = '${H.tenant}'`);
const kai = customer("Kai", "60110000011", "SEJUK", true);
const q = await (await api({ ...base, name: "Promo malam" })).json();
await sleep(1500);
check("at 3am local time a \"send now\" waits (nothing sent)", q.ok && status(q.broadcastId).status === "sending" && !(await waSends()).some((s) => s.body.to === kai.wa));
sql(`update tenants set timezone = '${zoneAt(12)}' where id = '${H.tenant}'`);
await cron();
check("…and goes out at the next hourly run in daytime", (await waitDone(q.broadcastId))?.status === "sent" && (await waSends()).some((s) => s.body.to === kai.wa));

// ---------------------------------------------------------------- 8. Daily cap per number, and a failed send
const sentSoFar = Number(sql(`select count(*) from broadcast_recipients where tenant_id = '${H.tenant}' and status = 'sent'`));
// The platform admin sets the cap in /admin (the same route the admin page's Save button uses).
const ADMIN = sessionCookie("00000000-0000-0000-0000-00000000ad01", "admin@layankan.test");
const setCap = (limit, cookie = ADMIN) => fetch(`${BASE}/api/admin/broadcast-cap`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: JSON.stringify({ connection_id: H.conn, limit }) });
check("only the platform admin can change a number's daily cap (owner → 404)", (await setCap(5, OWNER)).status === 404 && (await setCap(5, OWNER_B)).status === 404);
check("…nonsense caps are refused", (await setCap(0)).status === 400 && (await setCap(100_001)).status === 400 && (await setCap("lots")).status === 400);
const capSet = await setCap(sentSoFar + 2);
check("admin sets the cap; it's stored with who set it", capSet.ok && (await capSet.json()).cap === sentSoFar + 2
  && sql(`select settings->>'broadcast_daily_limit_set_by' from channel_connections where id = '${H.conn}'`) === "admin@layankan.test");
const adminHtml = (await (await fetch(`${BASE}/admin`, { headers: { cookie: ADMIN } })).text()).replace(/<!-- -->/g, "");
check("/admin lists the number with its sends in the last 24h and its cap", /Broadcast daily cap per WhatsApp number/.test(adminHtml)
  && new RegExp(`data-connection="${H.conn}"[\\s\\S]*?>${sentSoFar}</td>[\\s\\S]*?>${sentSoFar + 2} <span[^>]*>\\(set by admin@layankan.test\\)`).test(adminHtml));
for (const [nm, wa] of [["Lim", "60110000012"], ["Mei", "60110000013"], ["Nor", "60110000014"], ["Oz", "60199990000"]]) customer(nm, wa, "SUAM", true);
const d = await (await api({ ...base, name: "Promo besar" })).json();
await sleep(2500);
const s4 = status(d.broadcastId);
check("daily cap reached → only 2 sent today, the rest wait", s4.status === "sending" && s4.sent_count === 2, JSON.stringify(s4));
const reset = await setCap(null);
check("admin resets the cap to the default (250)", reset.ok && (await reset.json()).cap === 250 && sql(`select settings ? 'broadcast_daily_limit' from channel_connections where id = '${H.conn}'`) === "f");
const usedBefore = usage();
await cron();
const s5 = await waitDone(d.broadcastId);
check("…the rest go out on a later run", s5?.status === "sent" && s5.sent_count + s5.failed_count === 4, JSON.stringify(s5));
check("a message Meta refuses is marked failed with the reason, and not counted", s5.failed_count === 1
  && /not in allowed list/.test(sql(`select error from broadcast_recipients where broadcast_id = '${d.broadcastId}' and status = 'failed'`)) && usage() === usedBefore + 1, `${usedBefore}→${usage()}`);

// ---------------------------------------------------------------- 9. Replies, history, PDPA, isolation
const reply = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "WABA_H", changes: [{ field: "messages", value: {
  messaging_product: "whatsapp", metadata: { display_phone_number: "60388880000", phone_number_id: "PN_H" },
  contacts: [{ profile: { name: "Aisyah" }, wa_id: aisyah.wa }],
  messages: [{ from: aisyah.wa, id: "wamid.R6REPLY", timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: "Nak tempah, diskaun tu sampai bila?" } }],
} }] }] });
await fetch(`${BASE}/api/webhooks/meta`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", "metasecret").update(reply).digest("hex")}` }, body: reply });
let ai = "0";
for (let i = 0; i < 30 && ai === "0"; i++) { await sleep(500); ai = sql(`select count(*) from messages m join conversations c on c.id = m.conversation_id where c.contact_id = '${aisyah.id}' and m.sender = 'ai'`); }
check("a customer who replies to the promotion gets a normal AI chat", ai !== "0");
const list = await (await fetch(`${BASE}/dashboard/promotions`, { headers: { cookie: OWNER } })).text();
check("history shows each promotion with sent / skipped / failed", /Promo Merdeka/.test(list) && /Promo batal/.test(list) && /Dibatalkan/.test(list) && /gagal(<!-- -->)? (<!-- -->)?1/.test(list));
const exp = await (await fetch(`${BASE}/api/dashboard/export`, { headers: { cookie: OWNER } })).json();
check("PDPA export includes broadcasts and who got them", exp.broadcasts?.length === 5 && exp.broadcast_recipients?.length > 10);
const pageB = await (await fetch(`${BASE}/dashboard/promotions`, { headers: { cookie: OWNER_B } })).text();
check("another business sees none of these promotions", !/Promo Sabtu/.test(pageB) && !/Promo batal/.test(pageB) && /Promosi/.test(pageB));
const del = await fetch(`${BASE}/api/dashboard/conversations/${sql(`select id from conversations where contact_id = '${aisyah.id}'`)}`, { method: "DELETE", headers: { cookie: OWNER } });
check("deleting a customer's data removes their broadcast records too", del.ok && sql(`select count(*) from broadcast_recipients where contact_id = '${aisyah.id}'`) === "0");

console.log(failures ? `\n${failures} R6 FAILURE(S)` : "\nALL R6 BROADCAST CHECKS PASSED");
process.exit(failures ? 1 : 0);
