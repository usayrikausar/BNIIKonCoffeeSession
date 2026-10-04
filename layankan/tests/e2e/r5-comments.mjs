// R5 end-to-end: comment-to-chat on the business's own Facebook / Instagram
// posts, through the official Meta APIs (fake Graph). Uses its own business (tenant G).
// Requires the local stack: `bash tests/e2e/stack.sh up`, then `npm run test:r5`.
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { sessionCookie } from "./jwt.mjs";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const G = { tenant: "a7a7a7a7-0000-4000-8000-0000000000a7", slug: "kedai-g", owner: "00000000-0000-0000-0000-0000000000a8", staff: "00000000-0000-0000-0000-0000000000a9" };
const OWNER = sessionCookie(G.owner, "owner-g@r5.test");
const STAFF = sessionCookie(G.staff, "staff-g@r5.test");
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
const forComment = async (id) => (await sends()).filter((s) => s.body?.recipient?.comment_id === id || s.path?.startsWith(`${id}/`));

async function webhook(payload, signed = true) {
  const body = JSON.stringify(payload);
  const headers = { "content-type": "application/json" };
  if (signed) headers["x-hub-signature-256"] = `sha256=${createHmac("sha256", "metasecret").update(body).digest("hex")}`;
  return fetch(`${BASE}/api/webhooks/meta`, { method: "POST", headers, body });
}
const fbComment = (commentId, from, message, { page = "PAGE_G", ageDays = 0 } = {}) => ({
  object: "page",
  entry: [{ id: page, time: Date.now(), changes: [{ field: "feed", value: {
    item: "comment", verb: "add", comment_id: commentId, post_id: `${page}_POST1`, parent_id: `${page}_POST1`,
    from: { id: from.id, name: from.name }, message, created_time: Math.floor(Date.now() / 1000) - ageDays * 86400,
  } }] }],
});
const igComment = (commentId, from, text) => ({
  object: "instagram",
  entry: [{ id: "IG_G", time: Date.now(), changes: [{ field: "comments", value: { id: commentId, text, from: { id: from.id, username: from.name }, media: { id: "IGMEDIA1", media_product_type: "FEED" } } }] }],
});
/** Comments are handled just after Meta gets its 200; wait until the comment has a decision. */
async function decision(commentId) {
  for (let i = 0; i < 30; i++) {
    const d = sql(`select decision from social_comments where comment_id = '${commentId}'`);
    if (d && d !== "pending") return d;
    await sleep(300);
  }
  return sql(`select coalesce((select decision from social_comments where comment_id = '${commentId}'), 'none')`);
}

sql(`
  insert into auth.users (id, email, email_confirmed_at) values ('${G.owner}', 'owner-g@r5.test', now()), ('${G.staff}', 'staff-g@r5.test', now()) on conflict do nothing;
  insert into tenants (id, slug, name, status) values ('${G.tenant}', '${G.slug}', 'Kedai G', 'live') on conflict do nothing;
  insert into tenant_members (tenant_id, user_id, role, email) values ('${G.tenant}', '${G.owner}', 'owner', 'owner-g@r5.test'), ('${G.tenant}', '${G.staff}', 'staff', 'staff-g@r5.test') on conflict do nothing;
  insert into business_brains (tenant_id, profile) values ('${G.tenant}', '{"name":"Kedai G"}') on conflict do nothing;
`);

// --- 0. Connect the Page + Instagram (as in R4); our app now also listens to the Page's feed
const pages = (body, cookie = OWNER, extra = "") => fetch(`${BASE}/api/dashboard/meta-pages`, { method: "POST", headers: { cookie: cookie + extra, "content-type": "application/json" }, body: JSON.stringify(body) });
const list = await pages({ action: "list", code: "code-g" });
const cookie = "; " + (list.headers.get("set-cookie") ?? "").split(";")[0];
const conn = await pages({ action: "connect", page_id: "PAGE_G", instagram: true }, OWNER, cookie);
check("owner connects Page G + Instagram", conn.ok, `HTTP ${conn.status}`);
const sub = (await sends()).find((s) => s.kind === "subscribe" && s.path === "PAGE_G/subscribed_apps");
check("our app subscribes to the Page's comments (feed) as well as messages", !!sub && /\bfeed\b/.test(sub.fields) && /\bmessages\b/.test(sub.fields), sub?.fields);

// --- 1. Off by default: a keyword comment does nothing
await webhook(fbComment("C_G0", { id: "FBU_0", name: "Ali" }, "Harga?"));
check("switched off (the default): comment recorded, nothing sent", (await decision("C_G0")) === "ignored_disabled" && (await forComment("C_G0")).length === 0);

// The owner switches it on in the Brain.
const brainPage = await (await fetch(`${BASE}/dashboard/brain`, { headers: { cookie: OWNER } })).text();
check("Brain page has the 'Komen → Chat' section", /Komen → Chat/.test(brainPage) && /Kata kunci/.test(brainPage));
sql(`update business_brains set comment_to_chat = '{"enabled": true, "keywords": ["harga", "price", "berapa"], "opening_message": "Hai {name}! Terima kasih komen di post {business}. Nak tahu harga apa?", "public_reply": "Dah DM ya! 😊"}' where tenant_id = '${G.tenant}'`);

// --- 2. Facebook: a keyword comment → ONE private reply (+ the public reply)
check("unsigned comment webhook refused", (await webhook(fbComment("C_G1", { id: "FBU_1", name: "Aisyah Rahman" }, "Berapa harga set A?"), false)).status === 401);
const c1 = fbComment("C_G1", { id: "FBU_1", name: "Aisyah Rahman" }, "Berapa harga set A?");
const r1 = await webhook(c1);
check("Meta gets its 200 straight away", r1.status === 200);
check("keyword comment → replied", (await decision("C_G1")) === "replied");
let s1 = await forComment("C_G1");
const priv = s1.find((s) => s.kind === "private_reply");
check("ONE private reply, addressed to the comment (Meta private replies), with the Page token",
  s1.filter((s) => s.kind === "private_reply").length === 1 && priv.path === "PAGE_G/messages" && priv.auth === "Bearer page-tok-PAGE_G"
  && priv.body.message.text === "Hai Aisyah! Terima kasih komen di post Kedai G. Nak tahu harga apa?", JSON.stringify(priv));
const pub = s1.find((s) => s.kind === "public_reply");
check("…plus the short public reply under the comment (Facebook: /comments)", pub?.path === "C_G1/comments" && pub.body.message === "Dah DM ya! 😊");
const row1 = JSON.parse(sql(`select row_to_json(s) from social_comments s where comment_id = 'C_G1'`));
check("comment logged with the matched keyword, post and author", row1.matched_keyword === "harga" && row1.post_id === "PAGE_G_POST1" && row1.author_external_id === "FBU_1" && row1.platform === "facebook");
const CONV = row1.conversation_id;
const msgs = JSON.parse(sql(`select json_agg(json_build_object('dir', direction, 'sender', sender, 'body', body, 'src', metadata->>'source') order by created_at) from messages where conversation_id = '${CONV}'`));
check("a Messenger chat is opened: their comment, then our private reply",
  msgs.length === 2 && msgs[0].dir === "inbound" && msgs[0].src === "comment" && msgs[0].body.includes("Berapa harga set A?")
  && msgs[1].sender === "system" && msgs[1].src === "comment_private_reply" && row1.private_reply_message_id);
const cv = JSON.parse(sql(`select json_build_object('channel', c.channel, 'conn', c.channel_connection_id is not null, 'inbound', c.last_inbound_at, 'ext', k.external_id, 'name', k.name) from conversations c join contacts k on k.id = c.contact_id where c.id = '${CONV}'`));
check("the chat is with the person's Messenger id (from Meta), on the Page connection", cv.channel === "messenger" && cv.conn && cv.ext === "PSID_C_G1", JSON.stringify(cv));

// --- 3. Staff can't message them yet: a private reply does not open Meta's 24h window
check("Meta's 24h window stays closed until they write back", cv.inbound === null);
const early = await fetch(`${BASE}/api/dashboard/conversations/${CONV}/reply`, { method: "POST", headers: { cookie: STAFF, "content-type": "application/json" }, body: JSON.stringify({ body: "Hai, ada promosi!" }) });
check("…so a staff message before they reply is refused (window closed)", early.status === 409, `HTTP ${early.status}`);

// --- 4. Duplicates and limits
await webhook(c1);
await sleep(1200);
check("the same webhook again (Meta retry) sends nothing more", (await forComment("C_G1")).filter((s) => s.kind === "private_reply").length === 1
  && sql(`select count(*) from social_comments where comment_id = 'C_G1'`) === "1");
await webhook(fbComment("C_G2", { id: "FBU_1", name: "Aisyah Rahman" }, "price utk 2 orang?"));
check("same person, another keyword comment the same day → not messaged again", (await decision("C_G2")) === "skipped_already_replied_to_author" && (await forComment("C_G2")).length === 0);
await webhook(fbComment("C_G3", { id: "FBU_3", name: "Ben" }, "Cantiknya! Saya hargai"));
check("no keyword ('hargai' is not 'harga') → ignored", (await decision("C_G3")) === "ignored_no_keyword" && (await forComment("C_G3")).length === 0);
await webhook(fbComment("C_G4", { id: "PAGE_G", name: "Kedai G Page" }, "Harga RM50 sahaja!"));
check("the business's own comment → never replied to (no loops)", (await decision("C_G4")) === "ignored_own_comment" && (await forComment("C_G4")).length === 0);
await webhook(fbComment("C_G5", { id: "FBU_5", name: "Chong" }, "harga?", { ageDays: 8 }));
check("comment older than 7 days → skipped (Meta won't allow it)", (await decision("C_G5")) === "skipped_expired" && (await forComment("C_G5")).length === 0);
await webhook(fbComment("C_G6", { id: "FBU_6", name: "Dina" }, "harga?", { page: "PAGE_UNKNOWN" }));
await sleep(1000);
check("comment on a Page nobody connected → dropped, nothing stored", sql(`select count(*) from social_comments where comment_id = 'C_G6'`) === "0" && (await forComment("C_G6")).length === 0);
await webhook(fbComment("C_FAIL7", { id: "FBU_7", name: "Eva" }, "harga?"));
check("Meta refuses the private reply → logged as failed with the reason", (await decision("C_FAIL7")) === "failed"
  && /comment not found/.test(sql(`select error from social_comments where comment_id = 'C_FAIL7'`)));

// --- 5. Instagram
await webhook(igComment("IC_G1", { id: "IGU_1", name: "farah.k" }, "PRICE pls"));
check("Instagram keyword comment → replied", (await decision("IC_G1")) === "replied");
const ig = await forComment("IC_G1");
check("…private reply via the Page, public reply via Instagram /replies",
  ig.some((s) => s.kind === "private_reply" && s.path === "PAGE_G/messages") && ig.some((s) => s.kind === "public_reply" && s.path === "IC_G1/replies"));
check("…and an Instagram chat is opened", sql(`select c.channel from social_comments s join conversations c on c.id = s.conversation_id where s.comment_id = 'IC_G1'`) === "instagram");
sql(`insert into contacts (tenant_id, channel, external_id, name, opted_out_at) values ('${G.tenant}', 'instagram', 'IGU_STOP', 'stop.me', now())`);
await webhook(igComment("IC_G2", { id: "IGU_STOP", name: "stop.me" }, "harga?"));
check("someone who replied STOP before → never messaged", (await decision("IC_G2")) === "skipped_opted_out" && (await forComment("IC_G2")).length === 0);

// --- 6. They write back → a normal AI chat, in the same conversation
const before = Number(sql(`select count(*) from messages where conversation_id = '${CONV}'`));
await webhook({ object: "page", entry: [{ id: "PAGE_G", time: Date.now(), messaging: [{ sender: { id: "PSID_C_G1" }, recipient: { id: "PAGE_G" }, timestamp: Date.now(), message: { mid: "in.r5.1", text: "Set A untuk 2 orang berapa?" } }] }] });
let n = before;
for (let i = 0; i < 30 && n < before + 2; i++) { await sleep(500); n = Number(sql(`select count(*) from messages where conversation_id = '${CONV}'`)); }
const last = JSON.parse(sql(`select json_build_object('sender', sender, 'dir', direction) from messages where conversation_id = '${CONV}' order by created_at desc limit 1`));
check("their reply lands in the same chat and the AI answers", n >= before + 2 && last.sender === "ai" && last.dir === "outbound", `${before}→${n}`);
check("only one chat for this person", sql(`select count(*) from conversations c join contacts k on k.id = c.contact_id where k.external_id = 'PSID_C_G1'`) === "1");
check("…and now the 24h window is open", sql(`select last_inbound_at is not null from conversations where id = '${CONV}'`) === "t");

// --- 7. Dashboard + isolation
const chat = await (await fetch(`${BASE}/dashboard/inbox/${CONV}`, { headers: { cookie: STAFF } })).text();
check("staff see the comment and the private reply in the chat", /Komen di post/.test(chat) && /Nak tahu harga apa/.test(chat));
check("another business can't open this chat", (await fetch(`${BASE}/dashboard/inbox/${CONV}`, { headers: { cookie: OWNER_B }, redirect: "manual" })).status !== 200
  || !/Komen di post/.test(await (await fetch(`${BASE}/dashboard/inbox/${CONV}`, { headers: { cookie: OWNER_B } })).text()));

// --- PDPA: export includes the comment log; deleting the person removes their comments
const exp = await (await fetch(`${BASE}/api/dashboard/export`, { headers: { cookie: OWNER } })).json();
check("PDPA export includes the comment log", Array.isArray(exp.social_comments) && exp.social_comments.some((c) => c.comment_id === "C_G1"));
const IGCONV = sql(`select conversation_id from social_comments where comment_id = 'IC_G1'`);
const del = await fetch(`${BASE}/api/dashboard/conversations/${IGCONV}`, { method: "DELETE", headers: { cookie: OWNER } });
check("deleting a customer's data removes their comment record too", del.ok && sql(`select count(*) from social_comments where comment_id = 'IC_G1'`) === "0");

// --- 8. Switched off again → nothing sent
sql(`update business_brains set comment_to_chat = jsonb_set(comment_to_chat, '{enabled}', 'false') where tenant_id = '${G.tenant}'`);
await webhook(fbComment("C_G9", { id: "FBU_9", name: "Faiz" }, "harga?"));
check("switched off → nothing sent", (await decision("C_G9")) === "ignored_disabled" && (await forComment("C_G9")).length === 0);
check("in total, exactly 2 private replies were sent for this business",
  (await sends()).filter((s) => s.kind === "private_reply" && s.auth === "Bearer page-tok-PAGE_G" && !String(s.body.recipient.comment_id).includes("FAIL")).length === 2);
check("…and every comment we saw is logged once, with a decision", sql(`select count(*) filter (where decision = 'pending') || '/' || count(*) from social_comments where tenant_id = '${G.tenant}'`) === "0/9");

console.log(failures ? `\n${failures} R5 FAILURE(S)` : "\nALL R5 COMMENT-TO-CHAT CHECKS PASSED");
process.exit(failures ? 1 : 0);
