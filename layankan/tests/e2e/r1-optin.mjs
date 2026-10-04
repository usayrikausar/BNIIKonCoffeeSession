// R1 end-to-end: marketing opt-in capture over the real WhatsApp (Meta) path.
// Uses its OWN business (tenant C), so it doesn't depend on other suites.
// Requires the local stack: `bash tests/e2e/stack.sh up`, then `npm run test:r1`.
import { spawnSync } from "node:child_process";
import { createCipheriv, createHmac, randomBytes } from "node:crypto";
import { sessionCookie, sign } from "./jwt.mjs";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const REST = "http://127.0.0.1:54321/rest/v1";
const SERVICE = sign({ role: "service_role", iss: "supabase" });
const C = { tenant: "cccccccc-0000-4000-8000-0000000000c0", conn: "eeeeeeee-0000-4000-8000-0000000000c0", owner: "00000000-0000-0000-0000-0000000000c1" };
const OWNER = sessionCookie(C.owner, "owner-c@r1.test");
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
const rest = async (path) => {
  const r = await fetch(`${REST}/${path}`, { headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}` } });
  return r.json();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- setup: business C, live, WhatsApp via Meta, promotions question ON
sql(`
  insert into auth.users (id, email, email_confirmed_at) values ('${C.owner}', 'owner-c@r1.test', now()) on conflict do nothing;
  insert into tenants (id, slug, name, status) values ('${C.tenant}', 'kedai-c', 'Kedai C', 'live') on conflict do nothing;
  insert into tenant_members (tenant_id, user_id, role, email) values ('${C.tenant}', '${C.owner}', 'owner', 'owner-c@r1.test') on conflict do nothing;
  insert into business_brains (tenant_id, profile, promotions) values ('${C.tenant}', '{"name":"Kedai C"}', '{"ask_optin": true}')
    on conflict (tenant_id) do update set promotions = excluded.promotions;
  insert into channel_connections (id, tenant_id, channel, provider, status, is_active, phone_number_id, display_phone_number)
    values ('${C.conn}', '${C.tenant}', 'whatsapp', 'meta_cloud', 'connected', true, 'PN-R1', '+60 3-3333 4444') on conflict do nothing;
`);
const key = Buffer.alloc(32, 7), iv = randomBytes(12);
const ci = createCipheriv("aes-256-gcm", key, iv);
ci.setAAD(Buffer.from(`layankan:cred:${C.tenant}:${C.conn}:access_token`));
const enc = Buffer.concat([ci.update("EAAG-fake", "utf8"), ci.final()]);
sql(`insert into channel_credentials (tenant_id, connection_id, name, key_id, ciphertext)
  select '${C.tenant}', '${C.conn}', 'access_token', 'k1', '${Buffer.concat([iv, ci.getAuthTag(), enc]).toString("base64")}'
  where not exists (select 1 from channel_credentials where connection_id = '${C.conn}')`);

let seq = 0;
/** Customer `wa` sends `text` on WhatsApp (signed Meta webhook); waits until the turn is fully done. */
async function say(wa, text) {
  const before = Number(sql(`select count(*) from messages where tenant_id = '${C.tenant}'`));
  const body = JSON.stringify({ object: "whatsapp_business_account", entry: [{ id: "W", changes: [{ field: "messages", value: {
    messaging_product: "whatsapp", metadata: { display_phone_number: "60333334444", phone_number_id: "PN-R1" },
    contacts: [{ profile: { name: "Pelanggan" }, wa_id: wa }],
    messages: [{ from: wa, id: `wamid.R1.${Date.now()}.${++seq}`, timestamp: String(Math.floor(Date.now() / 1000)), type: "text", text: { body: text } }],
  } }] }] });
  const r = await fetch(`${BASE}/api/webhooks/meta`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": `sha256=${createHmac("sha256", "metasecret").update(body).digest("hex")}` }, body });
  if (!r.ok) throw new Error(`webhook ${r.status}`);
  // debounce is 2.5s; then wait until no new messages appear for a moment
  await sleep(3000);
  let last = -1;
  for (let i = 0; i < 30; i++) {
    const n = Number(sql(`select count(*) from messages where tenant_id = '${C.tenant}'`));
    if (n === last && n > before) break;
    last = n;
    await sleep(500);
  }
}
const outbound = (wa) => sql(`select coalesce(json_agg(json_build_object('body', m.body, 'sender', m.sender, 'meta', m.metadata) order by m.created_at), '[]')
  from messages m join conversations c on c.id = m.conversation_id join contacts k on k.id = c.contact_id
  where m.tenant_id = '${C.tenant}' and k.external_id = '${wa}' and m.direction = 'outbound'`);
const outs = (wa) => JSON.parse(outbound(wa));
const consent = (wa) => sql(`select coalesce(json_agg(json_build_object('action', e.action, 'method', e.method, 'text', e.consent_text, 'version', e.consent_text_version, 'evidence', m.body) order by e.id), '[]')
  from marketing_consent_events e join contacts k on k.id = e.contact_id left join messages m on m.id = e.evidence_message_id
  where e.tenant_id = '${C.tenant}' and k.external_id = '${wa}'`);
const assessments = () => Number(sql(`select count(*) from ai_assessments where tenant_id = '${C.tenant}'`));
const questions = (wa) => outs(wa).filter((m) => m.meta?.optin_question);

// --- 1. Asked once, at a natural moment, as its own message
const ALI = "60190000001";
await say(ALI, "Hi, harga?");
check("not asked on the first message", questions(ALI).length === 0);
await say(ALI, "Untuk 2 orang, minggu depan");
const q = questions(ALI);
check("asked after an engaged SUAM exchange, as a SEPARATE message", q.length === 1 && outs(ALI).length === 3, `${outs(ALI).length} outbound`);
check("question names the business and explains PROMO / STOP", /Kedai C/.test(q[0]?.body) && /PROMO/.test(q[0]?.body) && /STOP/.test(q[0]?.body));

// --- 2. A bare "ya" is NOT consent (it may answer the AI's own question)
await say(ALI, "ya");
check('"ya" is not recorded as consent', JSON.parse(consent(ALI)).length === 0);
check("…and is answered by the AI as normal", outs(ALI).at(-1)?.sender === "ai");

// --- 3. PROMO = consent, recorded with proof; no AI call, no usage
const aBefore = assessments();
const usageBefore = sql(`select coalesce(sum(conversations),0)||'/'||coalesce(sum(ai_replies),0) from usage_counters where tenant_id = '${C.tenant}'`);
await say(ALI, "PROMO");
const ev = JSON.parse(consent(ALI));
check("PROMO records an opt-in", ev.length === 1 && ev[0].action === "granted" && ev[0].method === "chat_reply", JSON.stringify(ev));
check("…with the EXACT question text the customer saw", ev[0]?.text === q[0]?.body);
check("…the wording version", /^optin-/.test(ev[0]?.version ?? ""));
check("…and the customer's own reply as evidence", ev[0]?.evidence === "PROMO");
check("customer gets a confirmation that says how to stop", /STOP/.test(outs(ALI).at(-1)?.body ?? "") && outs(ALI).at(-1)?.sender === "system");
check("no AI call for the PROMO reply", assessments() === aBefore);
check("…and no usage counted", sql(`select coalesce(sum(conversations),0)||'/'||coalesce(sum(ai_replies),0) from usage_counters where tenant_id = '${C.tenant}'`) === usageBefore);

// --- 4. Never asked twice; a second PROMO doesn't duplicate
await say(ALI, "Ok terima kasih, nanti saya datang");
await say(ALI, "promo");
check("never asked twice", questions(ALI).length === 1);
check("a repeated PROMO adds no second record", JSON.parse(consent(ALI)).length === 1);

// --- 5. Staff records "customer asked to stop" from the dashboard
const convId = sql(`select c.id from conversations c join contacts k on k.id = c.contact_id where c.tenant_id = '${C.tenant}' and k.external_id = '${ALI}'`);
const page = await (await fetch(`${BASE}/dashboard/inbox/${convId}`, { headers: { cookie: OWNER } })).text();
check("chat panel shows the customer agreed to promotions", /Promosi/.test(page) && /setuju/.test(page));
const stop = await fetch(`${BASE}/api/dashboard/conversations/${convId}`, { method: "POST", headers: { cookie: OWNER, "content-type": "application/json" }, body: JSON.stringify({ action: "record_optout" }) });
const ev2 = JSON.parse(consent(ALI));
check("staff can record a withdrawal (kept in history, not deleted)", stop.ok && ev2.length === 2 && ev2[1].action === "withdrawn" && ev2[1].method === "staff_withdrawal");

// --- 6. STOP after agreeing → withdrawal recorded automatically
const SITI = "60190000002";
await say(SITI, "Hi, harga?");
await say(SITI, "Saya nak tahu pakej");
await say(SITI, "PROMO");
await say(SITI, "STOP");
const ev3 = JSON.parse(consent(SITI));
check("STOP after agreeing writes a withdrawal", ev3.length === 2 && ev3[0].action === "granted" && ev3[1].method === "stop_keyword", JSON.stringify(ev3.map((e) => e.method)));

// --- 7. PROMO without having been asked is not consent
const ADAM = "60190000003";
await say(ADAM, "PROMO");
check("PROMO from someone never asked is not consent", JSON.parse(consent(ADAM)).length === 0);

// --- 8. Switch off → nobody new is asked
sql(`update business_brains set promotions = '{"ask_optin": false}' where tenant_id = '${C.tenant}'`);
const MEI = "60190000004";
await say(MEI, "Hi, harga?");
await say(MEI, "Untuk 3 orang");
check("with the switch off, nobody is asked", questions(MEI).length === 0);
check("…while the AI still answered normally (so the check above is meaningful)", outs(MEI).filter((m) => m.sender === "ai").length === 2, JSON.stringify(outs(MEI).map((m) => m.sender)));

// --- 9. Owner sees the count and exact wording in the Brain; PDPA export includes consent history
const brainPage = await (await fetch(`${BASE}/dashboard/brain`, { headers: { cookie: OWNER } })).text();
check("Brain page shows the exact question and the opted-in count", /Balas PROMO untuk setuju/.test(brainPage) && /<b>0<\/b>/.test(brainPage), "(both opted-in customers later withdrew → 0)");
const exp = await (await fetch(`${BASE}/api/dashboard/export`, { headers: { cookie: OWNER } })).json();
check("PDPA export includes consent history", Array.isArray(exp.marketing_consent_events) && exp.marketing_consent_events.length === 4, `${exp.marketing_consent_events?.length}`);
const other = await rest(`marketing_consent_events?tenant_id=eq.${C.tenant}&select=id`);
check("(sanity) 4 consent events stored for business C", other.length === 4);

console.log(failures ? `\n${failures} R1 FAILURE(S)` : "\nALL R1 OPT-IN CHECKS PASSED");
process.exit(failures ? 1 : 0);
