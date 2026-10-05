// R2 end-to-end: payment links paid to the business's OWN Billplz / ToyyibPay.
// Uses its own business (tenant D), so it doesn't depend on other suites.
// Requires the local stack: `bash tests/e2e/stack.sh up`, then `npm run test:r2`.
import { spawnSync } from "node:child_process";
import { createHmac } from "node:crypto";
import { sessionCookie, sign } from "./jwt.mjs";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const REST = "http://127.0.0.1:54321/rest/v1";
const D = { tenant: "dddddddd-0000-4000-8000-0000000000d0", slug: "kedai-d", owner: "00000000-0000-0000-0000-0000000000d1", staff: "00000000-0000-0000-0000-0000000000d2" };
const OWNER = sessionCookie(D.owner, "owner-d@r2.test");
const STAFF = sessionCookie(D.staff, "staff-d@r2.test");
const OWNER_B = sessionCookie("00000000-0000-0000-0000-0000000000b1", "owner-b@kedai.test");
const ADMIN = sessionCookie("00000000-0000-0000-0000-00000000ad01", "admin@layankan.test");
const XSIG = "bp-xsig-secret-of-kedai-d";
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
const api = (path, { cookie = OWNER, method = "POST", body } = {}) =>
  fetch(BASE + path, { method, headers: { cookie, "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
const bpSign = (f) => createHmac("sha256", XSIG).update(Object.entries(f).map(([k, v]) => `${k}${v}`).sort((a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : 1)).join("|")).digest("hex");
const callback = (account, form) => fetch(`${BASE}/api/payments/${account}/callback`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(form).toString() });
const link = (id) => JSON.parse(sql(`select row_to_json(l) from (select status, amount_cents, paid_amount_cents, gateway_bill_id, url, account_id from payment_links where id = '${id}') l`) || "null");

// --- setup: business D (live, web chat), owner + staff
sql(`
  insert into auth.users (id, email, email_confirmed_at) values ('${D.owner}', 'owner-d@r2.test', now()), ('${D.staff}', 'staff-d@r2.test', now()) on conflict do nothing;
  insert into tenants (id, slug, name, status) values ('${D.tenant}', '${D.slug}', 'Kedai D', 'live') on conflict do nothing;
  insert into tenant_members (tenant_id, user_id, role, email) values ('${D.tenant}', '${D.owner}', 'owner', 'owner-d@r2.test'), ('${D.tenant}', '${D.staff}', 'staff', 'staff-d@r2.test') on conflict do nothing;
  insert into business_brains (tenant_id, profile) values ('${D.tenant}', '{"name":"Kedai D"}') on conflict do nothing;
`);

// --- 1. Connecting the business's own Billplz
const bp = { gateway: "billplz", account_holder_name: "Kedai D Enterprise", api_key: "bp-good", collection_id: "col_d", x_signature_key: XSIG, sandbox: true, confirm_own_account: true };
check("staff cannot connect a payment account", (await api("/api/dashboard/payments", { cookie: STAFF, body: bp })).status === 403);
check("must confirm the money goes to their own account", (await api("/api/dashboard/payments", { body: { ...bp, confirm_own_account: false } })).status === 400);
const wrong = await api("/api/dashboard/payments", { body: { ...bp, api_key: "bp-wrong" } });
check("a wrong API key is rejected by checking with Billplz first", wrong.status === 400 && /menolak|rejected/.test((await wrong.json()).error));
const conn = await api("/api/dashboard/payments", { body: bp });
check("owner connects Billplz", conn.ok);
const BP_ACC = sql(`select id from payment_accounts where tenant_id = '${D.tenant}' and is_active`);
const stored = sql(`select string_agg(name || ':' || key_id || ':' || ciphertext, ' ') from payment_account_credentials where account_id = '${BP_ACC}'`);
check("keys are stored encrypted (never in plain text)", /api_key:k1:/.test(stored) && /x_signature_key:k1:/.test(stored) && !stored.includes("bp-good") && !stored.includes(XSIG));
const token = JSON.parse(Buffer.from(decodeURIComponent(OWNER.split("=")[1]).replace("base64-", ""), "base64url").toString()).access_token;
const credRes = await fetch(`${REST}/payment_account_credentials?select=*`, { headers: { apikey: "x", Authorization: `Bearer ${token}` } });
const credText = await credRes.text();
check("the owner cannot read the keys back through the API", !credRes.ok || JSON.parse(credText).length === 0, `HTTP ${credRes.status}`);

// --- 2. A customer chats on the web; staff sends a link
const chat = await (await fetch(`${BASE}/api/public/chat/${D.slug}`, { method: "POST", headers: { "content-type": "application/json", "x-real-ip": "10.9.0.1" }, body: JSON.stringify({ message: "Nak bayar untuk cuci gigi" }) })).json();
const CONV = sql(`select id from conversations where tenant_id = '${D.tenant}' order by created_at desc limit 1`);
check("invalid amount refused", (await api(`/api/dashboard/conversations/${CONV}/payment-link`, { cookie: STAFF, body: { amount_rm: "0", description: "x" } })).status === 400);
check("over RM100,000 refused", (await api(`/api/dashboard/conversations/${CONV}/payment-link`, { cookie: STAFF, body: { amount_rm: "100000.01", description: "x" } })).status === 400);
const sent = await api(`/api/dashboard/conversations/${CONV}/payment-link`, { cookie: STAFF, body: { amount_rm: "80", description: "Cuci gigi" } });
const sentBody = await sent.json();
check("staff sends an RM80 link from the chat", sent.ok && /^https:\/\//.test(sentBody.url ?? ""), JSON.stringify(sentBody));
const L1 = sentBody.linkId;
const l1 = link(L1);
check("link stored as open, on the business's own account, with the gateway bill id", l1?.status === "open" && l1.amount_cents === 8000 && l1.account_id === BP_ACC && /^bp_/.test(l1.gateway_bill_id ?? ""));
check("link created as the staff member", sql(`select created_by from payment_links where id = '${L1}'`) === D.staff);
const poll = await (await fetch(`${BASE}/api/public/chat/${D.slug}`, { headers: { "x-visitor-token": chat.visitorToken } })).json();
check("customer sees the link in the chat", poll.messages?.some((m) => m.body.includes(l1.url) && m.body.includes("RM80.00")));
check("another business cannot send a link into this chat", (await api(`/api/dashboard/conversations/${CONV}/payment-link`, { cookie: OWNER_B, body: { amount_rm: "1", description: "x" } })).status === 404);

// --- 3. Callbacks: only a verified, full payment counts
const fields = (paid_amount) => ({ id: l1.gateway_bill_id, collection_id: "col_d", paid: "true", state: "paid", amount: "8000", paid_amount: String(paid_amount), paid_at: "2026-10-04 12:00:00 +0800" });
const forged = fields(8000);
const forgedRes = await callback(BP_ACC, { ...forged, x_signature: createHmac("sha256", "attacker").update("x").digest("hex") });
check("forged callback (wrong signature) refused", forgedRes.status === 401 && link(L1).status === "open");
const under = fields(5000);
await callback(BP_ACC, { ...under, x_signature: bpSign(under) });
check("underpaid callback (valid signature, RM50 of RM80) does NOT mark paid", link(L1).status === "open");
check("…both the forged and the underpaid notice are kept in the audit log", Number(sql(`select count(*) from payment_link_events where link_id = '${L1}'`)) === 2);
const good = fields(8000);
const goodRes = await callback(BP_ACC, { ...good, x_signature: bpSign(good) });
const l1p = link(L1);
check("genuine callback marks the link paid", goodRes.ok && l1p.status === "paid" && l1p.paid_amount_cents === 8000);
const conv = JSON.parse(sql(`select row_to_json(c) from (select outcome, outcome_value_cents from conversations where id = '${CONV}') c`));
check("conversation marked Won with the amount (feeds Analytics)", conv.outcome === "won" && conv.outcome_value_cents === 8000);
const poll2 = await (await fetch(`${BASE}/api/public/chat/${D.slug}`, { headers: { "x-visitor-token": chat.visitorToken } })).json();
const confirms = poll2.messages.filter((m) => m.body.startsWith("✅ Bayaran RM80.00"));
check("customer gets a 'payment received' message in the chat", confirms.length === 1);
check("owner is emailed", Number(sql(`select count(*) from notifications where tenant_id = '${D.tenant}' and kind = 'payment'`)) === 1);
await callback(BP_ACC, { ...good, x_signature: bpSign(good) }); // gateway retry
const poll3 = await (await fetch(`${BASE}/api/public/chat/${D.slug}`, { headers: { "x-visitor-token": chat.visitorToken } })).json();
check("a repeated callback changes nothing (no double message, no double Won value)",
  poll3.messages.filter((m) => m.body.startsWith("✅ Bayaran")).length === 1 && JSON.parse(sql(`select row_to_json(c) from (select outcome_value_cents from conversations where id = '${CONV}') c`)).outcome_value_cents === 8000);
const ret = await (await fetch(`${BASE}/pay/${BP_ACC}/return?billplz%5Bid%5D=${l1.gateway_bill_id}&billplz%5Bpaid%5D=true`)).text();
check("return page shows 'payment received' (from OUR database, not the URL)", /Bayaran diterima/.test(ret) && /RM80\.00/.test(ret));
const fakeRet = await (await fetch(`${BASE}/pay/${BP_ACC}/return?billplz%5Bid%5D=bp_nope&billplz%5Bpaid%5D=true`)).text();
check("a made-up return URL does not show 'received'", !/Bayaran diterima/.test(fakeRet) && /disahkan/.test(fakeRet));
check("callback for an unknown account → 404", (await callback("00000000-0000-4000-8000-00000000dead", good)).status === 404);

// --- 4. Members can't mark links paid themselves
const patch = await fetch(`${REST}/payment_links?id=eq.${L1}`, { method: "PATCH", headers: { apikey: "x", Authorization: `Bearer ${token}`, "content-type": "application/json", Prefer: "return=representation" }, body: JSON.stringify({ status: "open" }) });
check("owner cannot change a link's status through the API", !patch.ok || (await patch.json()).length === 0, `HTTP ${patch.status}`);

// --- 5. Switch to ToyyibPay (callbacks unsigned → every one re-confirmed with ToyyibPay)
const ty = await api("/api/dashboard/payments", { body: { gateway: "toyyibpay", account_holder_name: "Kedai D Enterprise", secret_key: "ty-good", category_code: "cat_d", sandbox: true, confirm_own_account: true } });
check("owner switches to ToyyibPay (old account kept for audit, inactive)", ty.ok && sql(`select count(*) filter (where is_active) || '/' || count(*) from payment_accounts where tenant_id = '${D.tenant}'`) === "1/2");
const TY_ACC = sql(`select id from payment_accounts where tenant_id = '${D.tenant}' and is_active`);
const s2 = await (await api(`/api/dashboard/conversations/${CONV}/payment-link`, { cookie: STAFF, body: { amount_rm: "50", description: "Ubat gigi" } })).json();
const l2 = link(s2.linkId);
check("ToyyibPay link created", l2?.account_id === TY_ACC && /^ty/.test(l2.gateway_bill_id ?? ""));
await callback(TY_ACC, { billcode: l2.gateway_bill_id, status_id: "1", refno: "R1" });
check("a ToyyibPay callback claiming 'paid' is NOT trusted before ToyyibPay confirms", link(s2.linkId).status === "open");
await fetch(`http://127.0.0.1:4010/__toyyib/pay?billCode=${l2.gateway_bill_id}&amount=50.00`, { method: "POST" });
await callback(TY_ACC, { billcode: l2.gateway_bill_id, status_id: "1", refno: "R2" });
check("after ToyyibPay confirms RM50, the link is paid", link(s2.linkId).status === "paid" && link(s2.linkId).paid_amount_cents === 5000);
check("Won value now RM130 (both payments)", JSON.parse(sql(`select row_to_json(c) from (select outcome_value_cents from conversations where id = '${CONV}') c`)).outcome_value_cents === 13000);

// --- 6. Expiry, then a late payment is still accepted
const s3 = await (await api(`/api/dashboard/conversations/${CONV}/payment-link`, { cookie: STAFF, body: { amount_rm: "20", description: "Lewat" } })).json();
sql(`update payment_links set expires_at = now() - interval '1 minute' where id = '${s3.linkId}'`);
await fetch(`${BASE}/api/cron/hourly`, { headers: { authorization: "Bearer testcron" } });
check("hourly job marks old unpaid links expired", link(s3.linkId).status === "expired");
const l3 = link(s3.linkId);
await fetch(`http://127.0.0.1:4010/__toyyib/pay?billCode=${l3.gateway_bill_id}&amount=20.00`, { method: "POST" });
await callback(TY_ACC, { billcode: l3.gateway_bill_id, status_id: "1", refno: "R3" });
check("a payment that arrives after expiry is still recorded (the money arrived)", link(s3.linkId).status === "paid");

// --- 7. The old Billplz account's link can't be paid through the new account's URL
const crossFields = fields(8000);
await callback(TY_ACC, { billcode: l1.gateway_bill_id, status_id: "1" });
check("a bill id from one account does nothing on another account", link(L1).status === "paid" && Number(sql(`select count(*) from payment_link_events where link_id = '${L1}'`)) === 3);
void crossFields;

// --- 8. Owner sees it; export; admin key rotation covers payment keys
const page = await (await fetch(`${BASE}/dashboard/inbox/${CONV}`, { headers: { cookie: OWNER } })).text();
check("chat panel lists the links and their status", /Cuci gigi/.test(page) && /Dibayar ✓/.test(page));
const channels = await (await fetch(`${BASE}/dashboard/channels`, { headers: { cookie: OWNER } })).text();
check("Channels page shows the active ToyyibPay account and this month's total", /ToyyibPay/.test(channels) && /RM150\.00/.test(channels));
const exp = await (await fetch(`${BASE}/api/dashboard/export`, { headers: { cookie: OWNER } })).text();
check("PDPA export includes payment links and accounts, never keys", /"payment_links"/.test(exp) && /"payment_accounts"/.test(exp) && !/ciphertext|bp-good|ty-good/.test(exp));
const admin = await (await fetch(`${BASE}/admin`, { headers: { cookie: ADMIN } })).text();
check("admin key status now counts payment keys too", /payment-gateway keys/.test(admin) && Number((admin.match(/k1<\/td><td[^>]*>(\d+)/) ?? [])[1] ?? 0) >= 3);

console.log(failures ? `\n${failures} R2 FAILURE(S)` : "\nALL R2 PAYMENT-LINK CHECKS PASSED");
process.exit(failures ? 1 : 0);
