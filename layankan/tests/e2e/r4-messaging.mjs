// R4 end-to-end: Facebook Messenger + Instagram DMs through the official Meta
// APIs (fake Graph). Uses its own business (tenant F).
// Requires the local stack: `bash tests/e2e/stack.sh up`, then `npm run test:r4`.
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { sessionCookie } from "./jwt.mjs";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const F = { tenant: "f0f0f0f0-0000-4000-8000-0000000000f0", slug: "kedai-f", owner: "00000000-0000-0000-0000-0000000000f1", staff: "00000000-0000-0000-0000-0000000000f2" };
const OWNER = sessionCookie(F.owner, "owner-f@r4.test");
const STAFF = sessionCookie(F.staff, "staff-f@r4.test");
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
const sends = async () => (await fetch("http://127.0.0.1:4010/__graph_sends")).json();

/** POST to the Meta webhook as Meta would (signed with the app secret unless `signed` is false). */
async function webhook(payload, signed = true) {
  const body = JSON.stringify(payload);
  const headers = { "content-type": "application/json" };
  if (signed) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", "metasecret").update(body).digest("hex")}`;
  return fetch(`${BASE}/api/webhooks/meta`, { method: "POST", headers, body });
}
let mseq = 0;
const dm = (object, accountId, from, text) => ({
  object, entry: [{ id: accountId, time: Date.now(), messaging: [{ sender: { id: from }, recipient: { id: accountId }, timestamp: Date.now(), message: { mid: `in.${object}.${++mseq}`, text } }] }],
});
async function waitForReply(contact, before) {
  for (let i = 0; i < 30; i++) {
    await sleep(500);
    const n = Number(sql(`select count(*) from messages m join conversations c on c.id = m.conversation_id join contacts k on k.id = c.contact_id where k.external_id = '${contact}' and m.direction = 'outbound'`));
    if (n > before) return n;
  }
  return before;
}

sql(`
  insert into auth.users (id, email, email_confirmed_at) values ('${F.owner}', 'owner-f@r4.test', now()), ('${F.staff}', 'staff-f@r4.test', now()) on conflict do nothing;
  insert into tenants (id, slug, name, status) values ('${F.tenant}', '${F.slug}', 'Kedai F', 'live') on conflict do nothing;
  insert into tenant_members (tenant_id, user_id, role, email) values ('${F.tenant}', '${F.owner}', 'owner', 'owner-f@r4.test'), ('${F.tenant}', '${F.staff}', 'staff', 'staff-f@r4.test') on conflict do nothing;
  insert into business_brains (tenant_id, profile) values ('${F.tenant}', '{"name":"Kedai F"}') on conflict do nothing;
`);

// --- 1. Connect the business's own Page + Instagram (Facebook Login → pick a Page)
const api = (body, cookie = OWNER, extra = "") => fetch(`${BASE}/api/dashboard/meta-pages`, { method: "POST", headers: { cookie: cookie + extra, "content-type": "application/json" }, body: JSON.stringify(body) });
check("staff cannot connect Pages", (await api({ action: "list", code: "code-f" }, STAFF)).status === 403);
check("connecting without logging in first is refused", (await api({ action: "connect", page_id: "PAGE_F", instagram: true })).status === 401);
const list = await api({ action: "list", code: "code-f" });
const listBody = await list.json();
const setCookie = list.headers.get("set-cookie") ?? "";
const pagesCookie = "; " + setCookie.split(";")[0];
check("Facebook Login lists the person's Pages and linked Instagram", list.ok && listBody.pages?.length === 2 && listBody.pages[0].instagram?.username === "kedai.f");
check("Page tokens are never sent to the browser", !JSON.stringify(listBody).includes("page-tok"));
check("the Meta token is held only in an encrypted, httpOnly cookie", /HttpOnly/i.test(setCookie) && !setCookie.includes("long-short-code-f"));
check("a Page not in the person's list can't be connected", (await api({ action: "connect", page_id: "PAGE_SOMEONE_ELSE", instagram: true }, OWNER, pagesCookie)).status === 404);
const conn = await api({ action: "connect", page_id: "PAGE_F", instagram: true }, OWNER, pagesCookie);
const connBody = await conn.json();
check("owner connects Messenger + Instagram in one go", conn.ok && connBody.connected?.join(",") === "messenger,instagram", JSON.stringify(connBody));
const rows = JSON.parse(sql(`select json_agg(json_build_object('channel', channel, 'provider', provider, 'page', page_id, 'ig', ig_account_id, 'name', display_name, 'active', is_active)) from channel_connections where tenant_id = '${F.tenant}'`));
check("connections stored (Page id / Instagram id as routing keys)", rows.length === 2 && rows.some((r) => r.provider === "meta_messenger" && r.page === "PAGE_F" && r.name === "Kedai F Page") && rows.some((r) => r.provider === "meta_instagram" && r.ig === "IG_F" && r.name === "@kedai.f"));
const creds = sql(`select string_agg(ciphertext, ' ') from channel_credentials where tenant_id = '${F.tenant}' and name = 'page_access_token'`);
check("Page token stored encrypted for both", creds.split(" ").length === 2 && !creds.includes("page-tok"));
const sub = (await sends()).find((s) => s.kind === "subscribe" && s.path === "PAGE_F/subscribed_apps");
check("our app is subscribed to the Page's messages", !!sub && /messages/.test(sub.fields) && /message_echoes/.test(sub.fields));
// another business can't take the same Page
const listB = await api({ action: "list", code: "code-b" }, OWNER_B);
const cookieB = "; " + (listB.headers.get("set-cookie") ?? "").split(";")[0];
check("the same Page can't be live in two businesses", (await api({ action: "connect", page_id: "PAGE_F", instagram: false }, OWNER_B, cookieB)).status === 409);

// --- 2. Messenger: customer message → AI reply through the Send API
check("unsigned Messenger webhook refused", (await webhook(dm("page", "PAGE_F", "PSID_ALI", "Hi"), false)).status === 401);
let n = await waitForReply("PSID_ALI", 0);
check("…and nothing was stored from it", n === 0);
await webhook(dm("page", "PAGE_F", "PSID_ALI", "Hi, harga?"));
n = await waitForReply("PSID_ALI", 0);
const msgSend = (await sends()).filter((s) => s.kind === "send" && s.body.recipient.id === "PSID_ALI");
check("Messenger customer gets an AI reply", n === 1 && msgSend.length === 1);
check("…sent via the business's Page with its own token, as a normal RESPONSE", msgSend[0]?.path === "PAGE_F/messages" && msgSend[0]?.auth === "Bearer long-short-code-f".replace("long-short-code-f", "page-tok-PAGE_F-f") && msgSend[0]?.body.messaging_type === "RESPONSE");
const out1 = JSON.parse(sql(`select row_to_json(m) from (select m.status, m.provider, m.provider_message_id, c.channel from messages m join conversations c on c.id = m.conversation_id join contacts k on k.id = c.contact_id where k.external_id = 'PSID_ALI' and m.direction = 'outbound') m`));
check("reply stored in OUR database with the Meta message id", out1.status === "sent" && out1.provider === "meta_messenger" && out1.channel === "messenger" && /^m_out_/.test(out1.provider_message_id));

// --- 3. Instagram DM → AI reply (sent through the linked Page)
await webhook(dm("instagram", "IG_F", "IGSID_SITI", "Ada saiz M?"));
await waitForReply("IGSID_SITI", 0);
const igSend = (await sends()).filter((s) => s.kind === "send" && s.body.recipient.id === "IGSID_SITI");
check("Instagram DM gets an AI reply through the linked Page", igSend.length === 1 && igSend[0].path === "PAGE_F/messages");
check("Instagram conversation stored as channel 'instagram'", sql(`select c.channel from conversations c join contacts k on k.id = c.contact_id where k.external_id = 'IGSID_SITI'`) === "instagram");

// --- 4. Receipts and messages sent from Meta Business Suite
await webhook({ object: "page", entry: [{ id: "PAGE_F", messaging: [{ sender: { id: "PSID_ALI" }, recipient: { id: "PAGE_F" }, timestamp: Date.now(), delivery: { mids: [out1.provider_message_id], watermark: Date.now() } }] }] });
await sleep(300);
check("delivery receipt updates our message", sql(`select status from messages where provider_message_id = '${out1.provider_message_id}'`) === "delivered");
await webhook({ object: "page", entry: [{ id: "PAGE_F", messaging: [{ sender: { id: "PAGE_F" }, recipient: { id: "PSID_ALI" }, timestamp: Date.now(), message: { mid: "echo.bs.1", text: "Ditaip di Business Suite", is_echo: true } }] }] });
await sleep(300);
check("a reply typed in Meta Business Suite is kept in our history", sql(`select sender || '/' || direction from messages where provider_message_id = 'echo.bs.1'`) === "human/outbound");

// --- 5. Meta's windows: AI 24h; staff up to 7 days with the HUMAN_AGENT tag; then closed
const CONV = sql(`select c.id from conversations c join contacts k on k.id = c.contact_id where k.external_id = 'PSID_ALI'`);
sql(`update conversations set last_inbound_at = now() - interval '2 days', status = 'human', assigned_to = '${F.staff}' where id = '${CONV}'`);
const late = await fetch(`${BASE}/api/dashboard/conversations/${CONV}/reply`, { method: "POST", headers: { cookie: STAFF, "content-type": "application/json" }, body: JSON.stringify({ body: "Maaf lambat balas" }) });
const tagged = (await sends()).filter((s) => s.kind === "send" && s.body.message.text === "Maaf lambat balas");
check("staff reply 2 days later is allowed, with Meta's HUMAN_AGENT tag", late.ok && tagged[0]?.body.messaging_type === "MESSAGE_TAG" && tagged[0]?.body.tag === "HUMAN_AGENT", `HTTP ${late.status}`);
sql(`update conversations set last_inbound_at = now() - interval '8 days' where id = '${CONV}'`);
const tooLate = await fetch(`${BASE}/api/dashboard/conversations/${CONV}/reply`, { method: "POST", headers: { cookie: STAFF, "content-type": "application/json" }, body: JSON.stringify({ body: "Masih ada?" }) });
check("after 7 days even staff can't send (wait for the customer)", !tooLate.ok && !(await sends()).some((s) => s.kind === "send" && s.body.message.text === "Masih ada?"), `HTTP ${tooLate.status}`);
check("the AI never used the HUMAN_AGENT tag", (await sends()).filter((s) => s.kind === "send" && s.body.tag).every((s) => s.body.message.text === "Maaf lambat balas"));

// --- 6. Routing safety
const before = Number(sql(`select count(*) from messages`));
await webhook(dm("page", "PAGE_UNKNOWN", "PSID_X", "hello"));
await sleep(500);
check("a message for an unknown Page is dropped (not stored anywhere)", Number(sql(`select count(*) from messages`)) === before);
await webhook(dm("page", "PAGE_F", "PSID_ALI", "STOP"));
await sleep(3500);
check("STOP on Messenger opts the customer out", sql(`select opted_out_at is not null from contacts where external_id = 'PSID_ALI'`) === "t");

// --- 7. Dashboard
const inbox = await (await fetch(`${BASE}/dashboard/inbox`, { headers: { cookie: OWNER } })).text();
check("Inbox shows Messenger 💙 and Instagram 📸 chats", inbox.includes("💙") && inbox.includes("📸"));
const channels = await (await fetch(`${BASE}/dashboard/channels`, { headers: { cookie: OWNER } })).text();
check("Channels page lists the connected Page and Instagram account", channels.includes("Kedai F Page") && channels.includes("@kedai.f"));
const chat = await (await fetch(`${BASE}/dashboard/inbox/${CONV}`, { headers: { cookie: OWNER } })).text();
// (the customer just wrote STOP, so the 24h window is open again)
check("chat shows the channel and its messaging window to staff", /💙(<!-- -->| )*Messenger/.test(chat) && /tetingkap 24j terbuka/.test(chat));
sql(`update conversations set last_inbound_at = now() - interval '3 days' where id = '${CONV}'`);
const chat2 = await (await fetch(`${BASE}/dashboard/inbox/${CONV}`, { headers: { cookie: OWNER } })).text();
check("…and explains when only staff can reply (24h–7 days)", /hanya staf boleh balas/.test(chat2));

console.log(failures ? `\n${failures} R4 FAILURE(S)` : "\nALL R4 MESSENGER/INSTAGRAM CHECKS PASSED");
process.exit(failures ? 1 : 0);
