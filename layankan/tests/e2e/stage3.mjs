// Stage 3 end-to-end: booking link for PANAS leads, conversation-based usage
// (counted once per chat, 100% warning, new chats paused, ongoing chats kept),
// per-chat follow-up switch, and "Why PANAS?" on the leads page.
// Requires the local stack: `bash tests/e2e/stack.sh up`, then `npm run test:stage3`.
// NOTE: changes tenant A's data and the trial plan limit, so run it LAST (or re-run stack.sh up).
import { sessionCookie, sign } from "./jwt.mjs";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const REST = "http://127.0.0.1:54321/rest/v1";
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const OWNER = sessionCookie("00000000-0000-0000-0000-0000000000a1", "owner-a@klinik.test");
const SERVICE = sign({ role: "service_role", iss: "supabase" });
const LINK = "https://cal.com/klinik-a/temujanji";
let failures = 0;
const check = (label, ok, detail = "") => {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? ` — ${detail}` : ""}`);
};
const rest = async (path, init = {}) => {
  const r = await fetch(`${REST}/${path}`, {
    ...init,
    headers: { apikey: SERVICE, Authorization: `Bearer ${SERVICE}`, "content-type": "application/json", Prefer: "return=representation", ...(init.headers ?? {}) },
  });
  const text = await r.text();
  return text ? JSON.parse(text) : null;
};
const chat = async (message, visitorToken) => {
  const r = await fetch(`${BASE}/api/public/chat/klinik-a`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": `10.0.0.${Math.floor(Math.random() * 250)}` }, body: JSON.stringify({ message, visitorToken }) });
  return r.json();
};
// Public chat API: messages are { from: "customer" | "business", body }.
const FALLBACK = "Maaf, saya perlu semak dengan pasukan kami dahulu";
const lastReply = (d) => {
  const last = d.messages?.at(-1);
  return last && last.from === "business" ? last.body : "";
};
const aiCount = (d) => (d.messages ?? []).filter((m) => m.from === "business" && !m.body.startsWith(FALLBACK)).length;
const usage = async () => (await rest(`usage_counters?tenant_id=eq.${A}&select=conversations,ai_replies`))?.[0] ?? { conversations: 0 };

// --- setup: booking link in A's Brain, small monthly limit (3) on A's plan
await rest(`business_brains?tenant_id=eq.${A}`, { method: "PATCH", body: JSON.stringify({ booking: { url: LINK, label: "" } }) });
const [sub] = await rest(`subscriptions?tenant_id=eq.${A}&select=plan_id`);
await rest(`plans?id=eq.${sub.plan_id}`, { method: "PATCH", body: JSON.stringify({ conversation_limit: 3 }) });

// --- 1. Booking link for a PANAS lead
const v1 = await chat("Saya nak bayar sekarang");
const r1 = lastReply(v1);
check("PANAS lead gets the booking link", r1.includes(LINK), JSON.stringify(r1.slice(-80)));
const [c1] = await rest(`conversations?tenant_id=eq.${A}&lead_score=eq.PANAS&select=id,booking_link_sent_at,lead_score,score_reason,status&order=created_at.desc&limit=1`);
check("booking link recorded on the conversation", !!c1?.booking_link_sent_at);
// owner hands it back to the AI; another PANAS message must NOT repeat the link
await fetch(`${BASE}/api/dashboard/conversations/${c1.id}`, { method: "POST", headers: { cookie: OWNER, "content-type": "application/json" }, body: JSON.stringify({ action: "hand_back" }) });
const r1b = lastReply(await chat("ok nak bayar sekarang juga", v1.visitorToken));
check("booking link is offered only once per conversation", !!r1b && !r1b.includes(LINK), JSON.stringify(r1b.slice(-60)));
const v2 = await chat("Berapa harga?");
check("SUAM lead does not get the booking link", lastReply(v2).length > 0 && !lastReply(v2).includes(LINK));

// --- 2. Conversation-based usage
let u = await usage();
check("2 chats (3 AI replies) count as 2 conversations", u.conversations === 2, JSON.stringify(u));
await chat("harga pakej?", v2.visitorToken);
u = await usage();
check("more messages in the same chat do not add conversations", u.conversations === 2, JSON.stringify(u));
const v3 = await chat("hi, ada slot?");
u = await usage();
check("third chat reaches the limit (3/3)", u.conversations === 3, JSON.stringify(u));
const [subAfter] = await rest(`subscriptions?tenant_id=eq.${A}&select=usage_alert_level`);
check("100% warning recorded (sent once)", subAfter.usage_alert_level === 100, JSON.stringify(subAfter));
const quotaMails = await rest(`notifications?tenant_id=eq.${A}&kind=eq.quota&select=id`);
check("owner emailed about the limit (80% skipped straight to 100% is fine; one email per level)", quotaMails.length >= 1 && quotaMails.length <= 2, `${quotaMails.length} email(s)`);
const v4 = await chat("hello, nak tanya");
const [c4] = await rest(`conversations?tenant_id=eq.${A}&select=status,handoff_reason&order=created_at.desc&limit=1`);
check("a NEW chat over the limit goes to the owner (AI paused for it)", c4.status === "needs_human" && c4.handoff_reason === "billing_paused" && lastReply(v4).startsWith(FALLBACK), JSON.stringify(c4));
const v3b = await chat("bila boleh datang?", v3.visitorToken);
check("an ONGOING chat counted this month still gets AI replies", aiCount(v3b) === 2, `${aiCount(v3b)} AI replies`);
check("usage stays at 3 (paused chat not counted)", (await usage()).conversations === 3);
const mails2 = await rest(`notifications?tenant_id=eq.${A}&kind=eq.quota&select=id`);
check("no duplicate limit email", mails2.length === quotaMails.length, `${mails2.length}`);

// --- 3. Per-chat follow-up switch (team member, via dashboard API)
const off = await fetch(`${BASE}/api/dashboard/conversations/${c1.id}`, { method: "POST", headers: { cookie: OWNER, "content-type": "application/json" }, body: JSON.stringify({ action: "set_follow_up", disabled: true }) });
const [c1b] = await rest(`conversations?id=eq.${c1.id}&select=follow_up_disabled`);
check("owner can switch follow-ups off for one chat", off.ok && c1b.follow_up_disabled === true);
const offB = await fetch(`${BASE}/api/dashboard/conversations/dddddddd-0000-4000-8000-0000000000bb`, { method: "POST", headers: { cookie: OWNER, "content-type": "application/json" }, body: JSON.stringify({ action: "set_follow_up", disabled: true }) });
check("...but not for another business's chat", offB.status === 404, `HTTP ${offB.status}`);

// --- 4. "Why PANAS?" on the leads page and inbox
const leads = await (await fetch(`${BASE}/dashboard/leads`, { headers: { cookie: OWNER } })).text();
check("leads page shows 'Kenapa PANAS?' with the AI's reason", leads.includes("Kenapa PANAS?") && leads.includes("Mahu bayar sekarang"));
const inbox = await (await fetch(`${BASE}/dashboard/inbox`, { headers: { cookie: OWNER } })).text();
check("inbox shows the reason for PANAS leads", inbox.includes("Kenapa PANAS?"));
const billing = await (await fetch(`${BASE}/dashboard/billing`, { headers: { cookie: OWNER } })).text();
check("billing page meters conversations, not replies", billing.includes("Perbualan bulan ini") && /3(<!-- -->)? \/ (<!-- -->)?3/.test(billing));

console.log(failures ? `\n${failures} STAGE 3 FAILURE(S)` : "\nALL STAGE 3 CHECKS PASSED");
process.exit(failures ? 1 : 0);
