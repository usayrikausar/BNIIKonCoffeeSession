// Route-level tenant isolation test. Logs in as the owner of tenant A and
// attacks every HTTP route and page with tenant B's ids. Passes only if every
// attempt is refused AND no tenant-B marker ("RAHSIAB") appears in any response.
// Requires the local stack: `bash tests/e2e/stack.sh up`, then
// `node tests/e2e/isolation-routes.mjs`.
import { sessionCookie } from "./jwt.mjs";

const BASE = process.env.E2E_BASE ?? "http://localhost:3000";
const A_COOKIE = sessionCookie("00000000-0000-0000-0000-0000000000a1", "owner-a@klinik.test");
const B = {
  tenant: "bbbbbbbb-0000-4000-8000-000000000001",
  slug: "kedai-b",
  conversation: "dddddddd-0000-4000-8000-0000000000bb",
  connection: "eeeeeeee-0000-4000-8000-0000000000bb",
};
const MARKER = "RAHSIAB";
let failures = 0;

async function call(method, path, { body, cookie = A_COOKIE, headers = {} } = {}) {
  const res = await fetch(BASE + path, {
    method,
    redirect: "manual",
    headers: { cookie, ...(body ? { "content-type": "application/json" } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, text: await res.text() };
}

function check(label, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} | ${label}${detail ? ` — ${detail}` : ""}`);
}

async function expectRefused(label, method, path, opts) {
  const r = await call(method, path, opts);
  const refused = [401, 403, 404, 405, 409].includes(r.status) || r.status >= 300 && r.status < 400;
  check(label, refused && !r.text.includes(MARKER), `HTTP ${r.status}${r.text.includes(MARKER) ? ", LEAKED B data" : ""}`);
}

async function expectNoLeak(label, method, path, opts) {
  const r = await call(method, path, opts);
  check(label, !r.text.includes(MARKER), `HTTP ${r.status}${r.text.includes(MARKER) ? ", LEAKED B data" : ""}`);
}

// Sanity: A can see its own data, otherwise the test proves nothing.
const own = await call("GET", "/api/dashboard/conversations/dddddddd-0000-4000-8000-0000000000aa/messages");
check("sanity: A can read its own conversation", own.status === 200 && own.text.includes("hello A"), `HTTP ${own.status}`);

// --- Dashboard API with B's conversation id
const C = `/api/dashboard/conversations/${B.conversation}`;
await expectRefused("read B messages", "GET", `${C}/messages`);
await expectRefused("take over B chat", "POST", C, { body: { action: "take_over", force: true } });
await expectRefused("assign B chat", "POST", C, { body: { action: "assign", user_id: "00000000-0000-0000-0000-0000000000a1" } });
await expectRefused("mark B outcome", "POST", C, { body: { action: "set_outcome", outcome: "won" } });
await expectRefused("close B chat", "POST", C, { body: { action: "close" } });
await expectRefused("reply into B chat", "POST", `${C}/reply`, { body: { body: "hi", force: true } });
await expectRefused("delete B customer data", "DELETE", C);

// --- Exports / lists must contain only A data
await expectNoLeak("leads CSV export", "GET", "/api/dashboard/leads/export");
await expectNoLeak("PDPA data export", "GET", "/api/dashboard/export");
await expectNoLeak("templates list", "GET", "/api/dashboard/templates");

// --- Forged workspace cookie pointing at B must fall back to A's own workspace
const forged = `${A_COOKIE}; layankan_tenant=${B.tenant}`;
await expectNoLeak("export with forged tenant cookie", "GET", "/api/dashboard/export", { cookie: forged });
await expectNoLeak("leads export with forged tenant cookie", "GET", "/api/dashboard/leads/export", { cookie: forged });
await expectNoLeak("test chat with forged tenant cookie", "POST", "/api/dashboard/test-chat", { cookie: forged, body: { message: "hi" } });

// --- Dashboard pages (server-rendered) with B ids / forged cookie
await expectRefused("open B conversation page", "GET", `/dashboard/inbox/${B.conversation}`);
for (const page of ["/dashboard/inbox", "/dashboard/leads", "/dashboard/brain", "/dashboard/channels", "/dashboard/analytics", "/dashboard/billing", "/dashboard/settings"]) {
  await expectNoLeak(`page ${page} (forged tenant cookie)`, "GET", page, { cookie: forged });
}
await expectRefused("platform admin console as a normal owner", "GET", "/admin");

// --- Public & webhook endpoints
await expectNoLeak("public chat poll for B with a random visitor token", "GET", `/api/public/chat/${B.slug}`, {
  cookie: "",
  headers: { "x-visitor-token": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
});
await expectRefused("unsigned Murpati webhook into B's connection", "POST", `/api/webhooks/murpati/${B.connection}`, { cookie: "", body: { event: "message.received" } });
await expectRefused("unsigned Meta webhook", "POST", "/api/webhooks/meta", { cookie: "", body: { object: "whatsapp_business_account", entry: [] } });
await expectRefused("cron without secret", "GET", "/api/cron/hourly", { cookie: "" });

// --- Supabase REST directly with A's JWT (bypassing our app)
const jwt = decodeURIComponent(A_COOKIE.split("=")[1]).replace("base64-", "");
const token = JSON.parse(Buffer.from(jwt, "base64url").toString()).access_token;
for (const table of ["conversations", "messages", "contacts", "business_brains", "channel_connections", "channel_credentials", "invoices", "ai_assessments"]) {
  const res = await fetch(`http://127.0.0.1:54321/rest/v1/${table}?tenant_id=eq.${B.tenant}&select=*`, {
    headers: { apikey: "x", Authorization: `Bearer ${token}` },
  });
  const text = await res.text();
  const rows = res.ok ? JSON.parse(text).length : 0;
  check(`REST ${table} rows of B visible to A`, rows === 0 && !text.includes(MARKER), `HTTP ${res.status}, ${rows} rows`);
}

// --- Supabase REST WRITES with A's JWT: rows in A that point at B's records
async function restWrite(label, table, row) {
  const res = await fetch(`http://127.0.0.1:54321/rest/v1/${table}`, {
    method: "POST",
    headers: { apikey: "x", Authorization: `Bearer ${token}`, "content-type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(row),
  });
  check(label, !res.ok, `HTTP ${res.status}${res.ok ? " (accepted!)" : ""}`);
}
const A_TENANT = "aaaaaaaa-0000-4000-8000-000000000001";
await restWrite("REST: A attaches a message to B's conversation", "messages", {
  tenant_id: A_TENANT, conversation_id: B.conversation, direction: "outbound", sender: "human", body: "x", channel: "web", status: "sent",
  sent_by: "00000000-0000-0000-0000-0000000000a1",
});
await restWrite("REST: A opens a conversation on B's contact", "conversations", {
  tenant_id: A_TENANT, contact_id: "cccccccc-0000-4000-8000-0000000000bb", channel: "web",
});
await restWrite("REST: A creates a template on B's connection", "message_templates", {
  tenant_id: A_TENANT, connection_id: B.connection, name: "x_probe",
});

console.log(failures ? `\n${failures} ISOLATION FAILURE(S)` : "\nALL ROUTE ISOLATION CHECKS PASSED");
process.exit(failures ? 1 : 0);
