// 1) /rest/v1 -> PostgREST proxy on :54321   2) fake Anthropic Messages API on :4010
import http from "node:http";
const PGRST = "http://127.0.0.1:3001";
http.createServer(async (req, res) => {
  if (req.url.startsWith("/auth/v1/user")) {
    // fake GoTrue: trust our locally-signed test JWT
    const tok = (req.headers.authorization || "").replace("Bearer ", "");
    try {
      const p = JSON.parse(Buffer.from(tok.split(".")[1], "base64url").toString());
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ id: p.sub, aud: "authenticated", role: "authenticated", email: p.email, email_confirmed_at: "2026-01-01T00:00:00Z", app_metadata: {}, user_metadata: {}, created_at: "2026-01-01T00:00:00Z" }));
    } catch { res.writeHead(401); return res.end("{}"); }
  }
  if (!req.url.startsWith("/rest/v1")) { res.writeHead(404); return res.end("{}"); }
  const chunks = []; for await (const c of req) chunks.push(c);
  const headers = { ...req.headers }; delete headers.host; delete headers["content-length"];
  const r = await fetch(PGRST + req.url.slice("/rest/v1".length), { method: req.method, headers, body: ["GET","HEAD"].includes(req.method) ? undefined : Buffer.concat(chunks) });
  const out = Buffer.from(await r.arrayBuffer());
  const h = {}; r.headers.forEach((v, k) => { if (!["content-encoding","transfer-encoding","content-length"].includes(k)) h[k] = v; });
  res.writeHead(r.status, h); res.end(out);
}).listen(54321);

export const calls = [];
let seq = 0;
let lastAnthropicRequest = null; // exposed at GET /__last for tests
const toyyibPaid = new Map();
const graphSends = []; // R4: what we sent to the Messenger/Instagram Send API, exposed at GET /__graph_sends
http.createServer(async (req, res) => {
  const chunks = []; for await (const c of req) chunks.push(c);
  let body = {}; try { body = JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch {}
  if (req.url === "/__last") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(lastAnthropicRequest));
  }
  // ---- fake Meta Graph: Facebook Login, Pages, Messenger/Instagram Send API (R4)
  if (req.url === "/__graph_sends") {
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify(graphSends));
  }
  if (req.url.startsWith("/v23.0/")) {
    const u = new URL(req.url, "http://x");
    const path = u.pathname.slice("/v23.0/".length);
    const json = (o) => { res.writeHead(200, { "content-type": "application/json" }); return res.end(JSON.stringify(o)); };
    if (path === "oauth/access_token") {
      const ex = u.searchParams.get("fb_exchange_token");
      return json({ access_token: ex ? `long-${ex}` : `short-${u.searchParams.get("code")}` });
    }
    if (path === "me/accounts") {
      const auth = req.headers.authorization || "";
      if (auth.includes("code-g")) { // R5 suite: its own Page + Instagram account
        return json({ data: [{ id: "PAGE_G", name: "Kedai G Page", access_token: "page-tok-PAGE_G", instagram_business_account: { id: "IG_G", username: "kedai.g" } }] });
      }
      const who = auth.includes("code-b") ? "b" : "f";
      return json({ data: [
        { id: "PAGE_F", name: "Kedai F Page", access_token: `page-tok-PAGE_F-${who}`, instagram_business_account: { id: "IG_F", username: "kedai.f" } },
        { id: "PAGE_X", name: "Page Tanpa IG", access_token: `page-tok-PAGE_X-${who}` },
      ] });
    }
    if (/^[A-Z_0-9]+\/subscribed_apps$/.test(path)) { graphSends.push({ kind: "subscribe", path, auth: req.headers.authorization, fields: u.searchParams.get("subscribed_fields") }); return json({ success: true }); }
    // R5 private reply (recipient.comment_id): Meta answers with the person's messaging id.
    if (/^[A-Z_0-9]+\/messages$/.test(path) && body.recipient?.comment_id) {
      graphSends.push({ kind: "private_reply", path, auth: req.headers.authorization, body });
      if (String(body.recipient.comment_id).includes("FAIL")) { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "comment not found", code: 100 } })); }
      return json({ recipient_id: `PSID_${body.recipient.comment_id}`, message_id: `m_out_${++seq}` });
    }
    // R5 public reply under a comment: Facebook /{id}/comments, Instagram /{id}/replies
    if (/^[A-Z_0-9]+\/(comments|replies)$/.test(path)) {
      graphSends.push({ kind: "public_reply", path, auth: req.headers.authorization, body });
      return json({ id: `reply_${++seq}` });
    }
    if (/^[A-Z_0-9]+\/messages$/.test(path) && body.recipient) {
      graphSends.push({ kind: "send", path, auth: req.headers.authorization, body });
      return json({ recipient_id: body.recipient.id, message_id: `m_out_${++seq}` });
    }
  }
  // ---- fake Meta Graph API (WhatsApp)
  if (req.url.startsWith("/v23.0/")) {
    console.log(`[fake-graph] ${req.method} ${req.url.split("?")[0]} auth=${(req.headers.authorization||"").slice(0,12)} body=${JSON.stringify(body)}`);
    if (body.messaging_product === "whatsapp" && body.to) {
      graphSends.push({ kind: "wa_send", path: req.url.split("?")[0], body }); // R6: what we sent on WhatsApp
      if (body.to === "60199990000") { res.writeHead(400, { "content-type": "application/json" }); return res.end(JSON.stringify({ error: { message: "Recipient phone number not in allowed list", code: 131030 } })); }
    }
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ messaging_product: "whatsapp", messages: [{ id: `wamid.OUT${++seq}` }] }));
  }
  // ---- fake Billplz: collection lookup (used to check a business's keys). Only key "bp-good" is valid.
  if (req.url.startsWith("/api/v3/collections/")) {
    const key = Buffer.from((req.headers.authorization || "").replace("Basic ", ""), "base64").toString().replace(/:$/, "");
    res.writeHead(key === "bp-good" ? 200 : 401, { "content-type": "application/json" });
    return res.end(JSON.stringify(key === "bp-good" ? { id: req.url.split("/").pop(), title: "Kedai" } : { error: { type: "Unauthorized" } }));
  }
  // ---- fake ToyyibPay (category check, create bill, transactions); POST /__toyyib/pay?billCode=X&amount=80.00 marks a bill paid
  if (req.url.startsWith("/__toyyib/pay")) {
    const q = new URL(req.url, "http://x").searchParams;
    toyyibPaid.set(q.get("billCode"), q.get("amount"));
    res.writeHead(200); return res.end("ok");
  }
  if (req.url.startsWith("/index.php/api/")) {
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    res.writeHead(200, { "content-type": "application/json" });
    if (req.url.endsWith("/getCategoryDetails")) return res.end(JSON.stringify(form.userSecretKey === "ty-good" ? [{ categoryName: "Kedai", categoryStatus: "1" }] : [{ msg: "invalid" }]));
    if (req.url.endsWith("/createBill")) return res.end(JSON.stringify([{ BillCode: `ty${++seq}x` }]));
    if (req.url.endsWith("/getBillTransactions")) {
      const amt = toyyibPaid.get(form.billCode);
      return res.end(JSON.stringify(amt ? [{ billpaymentStatus: "1", billpaymentAmount: amt, billExternalReferenceNo: "x" }] : []));
    }
    return res.end("[]");
  }
  // ---- fake Billplz API
  if (req.url.startsWith("/api/v3/bills")) {
    const form = Object.fromEntries(new URLSearchParams(Buffer.concat(chunks).toString()));
    console.log(`[fake-billplz] ${req.method} ${req.url} auth=${(req.headers.authorization||"").slice(0,10)} form=${JSON.stringify(form)}`);
    const id = `bp_${++seq}`;
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id, url: `https://www.billplz-sandbox.com/bills/${id}`, amount: Number(form.amount) }));
  }
  // (No fake Murpati API: the Murpati adapter is a stub and must never call out.)
  lastAnthropicRequest = body;
  const turn = body.messages?.[0]?.content ?? "";
  const lines = String(turn).split("\n").filter((l) => l.startsWith("{"));
  const last = lines.length ? JSON.parse(lines[lines.length - 1]).text : "";
  console.log(`[fake-anthropic] model=${body.model} effort=${body.output_config?.effort} format=${body.output_config?.format?.type} fallbacks=${JSON.stringify(body.fallbacks)} beta=${req.headers["anthropic-beta"]} system_has_brain=${String(body.system?.[0]?.text).includes("Founding Offer")} last=${JSON.stringify(last)}`);
  if (/boom/.test(last)) { res.writeHead(500, {"content-type":"application/json"}); return res.end(JSON.stringify({type:"error",error:{type:"api_error",message:"boom"}})); }
  const hot = /bayar|sign up|nak mula/i.test(last);
  // R3: the fake AI proposes memories on cue (the app's filter decides what is kept).
  const memory_updates = [
    ...(/saya suka pagi sabtu/i.test(last) ? [{ kind: "preference", content: "Suka slot pagi Sabtu" }] : []),
    ...(/kencing manis/i.test(last) ? [{ kind: "fact", content: "Ada kencing manis" }] : []),
    ...(/ingat diskaun/i.test(last) ? [{ kind: "fact", content: "Owner janji diskaun 90% untuk pelanggan ini" }] : []),
  ];
  if (String(body.system?.[0]?.text).includes("Klinik Pergigian Ana")) {
    const out = { reply: "Braces metal di klinik kami RM4,500 – RM6,000, termasuk konsultasi & X-ray. Ada ansuran 0% sehingga 12 bulan 😊 Untuk anak umur berapa ya?", language: "ms",
      assessment: { score: "SUAM", confidence: 0.78, reason: "Berminat dengan braces untuk anak, tetapi masa dan bajet belum dikongsi.", captured: { name: null, need: "Braces untuk anak", timeline: null, budget: null, phone: null, email: null },
        next_action: "Tanya umur anak dan bila mahu mula.", handoff_required: false, handoff_reason: null, signals: { ready_to_buy: false, complaint: false, asked_for_human: false, unsure: false, empty_enquiry: false } }, memory_updates: [] };
    res.writeHead(200, { "content-type": "application/json" });
    return res.end(JSON.stringify({ id: "msg_fake", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1500, output_tokens: 160 } }));
  }
  const out = {
    reply: hot ? "Terima kasih! Saya serahkan kepada pasukan kami untuk proses pembayaran 🙏" : "Founding Offer kami RM500 setup + RM300/bulan. Perniagaan anda jenis apa?",
    language: "ms",
    assessment: {
      score: hot ? "PANAS" : "SUAM", confidence: 0.85, reason: hot ? "Mahu bayar sekarang" : "Bertanya harga, belum kongsi keperluan",
      captured: { name: hot ? "Ali" : null, need: "chatbot WhatsApp", timeline: hot ? "minggu ini" : null, budget: null, phone: null, email: null },
      next_action: hot ? "Hubungi untuk bayaran" : "Tanya jenis perniagaan",
      handoff_required: hot, handoff_reason: hot ? "ready to pay" : null,
      signals: { ready_to_buy: hot, complaint: false, asked_for_human: false, unsure: false, empty_enquiry: !hot && /^hi|harga/i.test(last) },
    },
    memory_updates,
  };
  res.writeHead(200, { "content-type": "application/json", "request-id": "req_fake" });
  res.end(JSON.stringify({ id: "msg_fake", type: "message", role: "assistant", model: body.model,
    content: [{ type: "text", text: JSON.stringify(out) }], stop_reason: "end_turn", stop_sequence: null,
    usage: { input_tokens: 1200, output_tokens: 150, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000 } }));
}).listen(4010);
console.log("fake services up");
