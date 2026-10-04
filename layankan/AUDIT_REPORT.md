# Layankan — Audit Report

**Stage 1 (audit):** 2026-10-04, commit `53ff913`, whole `layankan/` codebase, read-only.
**Stage 2 (fixes):** 2026-10-04. Every critical and broken item is fixed, plus H1, all medium items and L1–L4, L6.
**Stage 3 (Phase 1 additions):** 2026-10-04. Booking link, SUAM follow-ups (max 2, per-chat switch), conversation-based usage with 80%/100% warnings, "Why PANAS?".
**Stage 4 (vendor independence):** 2026-10-04. Murpati adapter replaced by a clearly marked stub (H2 fixed), adapter contract tests, key rotation usable from /admin, ownership overview, EXIT_RUNBOOK updated.
Each fix is proven by a test that failed before the fix and passes now (see "Test & build results").

Status key: **done** · **partial** (works, with gaps) · **missing** · **broken** (does not do what it should) · **FIXED (Stage 2)**.

## Stage 2 summary

| # | Was | Now | How it was fixed | Proof |
|---|---|---|---|---|
| C1 | Tenant A could create rows pointing at tenant B's records, and a trigger then wrote into B's analytics | **FIXED** | New migration `supabase/migrations/20261004000006_security_fixes.sql`: trigger `enforce_same_tenant()` on `messages`, `conversations`, `message_templates`, `channel_credentials`, `message_status_events`, `ai_assessments`, `notifications` refuses any reference to another workspace's row. It applies to the server too, so a coding mistake can't mix tenants either. `track_response_times` now also filters by `tenant_id`. | `rls_test.sql` (6 new hard checks, incl. server-side); probe 3/3; E2E REST writes now HTTP 400 (3/3) |
| C2 | Unconfirmed email could accept an invite | **FIXED** | `accept_my_invites()` only runs for users whose `email_confirmed_at` is set. Keep **Confirm email** switched ON in Supabase (README step 6): if it is off, Supabase marks every new address as confirmed. | `rls_test.sql`: unconfirmed → 0 invites accepted; after confirming → 1 |
| C3 | Phone visitors could not close the chat | **FIXED** | `public/widget.js`: on phones the chat fills the screen below a dimmed 60px strip that keeps the ✕ button visible. Tapping the strip, the ✕, or pressing Escape closes it. `aria-expanded` and labels added. | `npm run test:widget` (new, Playwright, hostile host CSS): 10/10 on desktop + 390×844 phone |
| H1 | A fooled model's reply could quote our instructions | **FIXED** | `src/lib/agent/leak-guard.ts`, called from `planTurn`: blocks replies containing instruction headings/phrases or any 10-word run copied from the instruction part of the prompt. The customer gets the safe fallback, and the chat is handed to a human. Business facts and the owner's own qualifying questions are deliberately *not* blocked, because the AI is meant to say them. | `tests/prompt-injection.test.ts`: former `it.fails` "KNOWN GAP" tests are now normal tests, plus a no-false-positive test |
| H2 | Murpati adapter guesses the API | **FIXED (Stage 4)** | see Stage 4 summary | `tests/adapter-contract.test.ts`, `npm run test:stage4` |
| M1 | Logged-out callers had EXECUTE on database functions | **FIXED** | `revoke execute on all functions … from anon` + default privileges, then explicit grants to signed-in users | `rls_test.sql` + probe |
| M2 | `current_usage_period` revealed other tenants' billing anchor | **FIXED** | Only the server (service role) may call it, and only the server does | `rls_test.sql` + probe (refused, 42501) |
| M3 | Rate limit trusted the first `X-Forwarded-For` hop; failed fully open | **FIXED** | `src/lib/ratelimit.ts`: platform header (`x-vercel-forwarded-for` / `x-real-ip`) first, else the **last** hop; on database error an in-memory per-instance window applies instead of "no limit" | `tests/misc.test.ts` (2 new tests) |
| L1 | Dev email log showed full recipient address | **FIXED** | `maskEmail()` in `src/lib/notify/email.ts` | — |
| L2 | `secrets.ts` lacked `server-only` | **FIXED** | `import "server-only"` | build ✓ |
| L3 | Privacy page didn't name the business | **FIXED** | `/privacy?b=<slug>` shows the business name (live workspaces only, public name only) | checked on E2E stack |
| L4 | PDPA export lacked billing + delivery records | **FIXED** | export now includes `message_status_events`, `daily_summary_runs`, `billing.{subscription, invoices, usage_counters}` | checked on E2E stack |
| L6 | 3 optional test variables undocumented | **FIXED** | `.env.example` "Optional: testing only" block | — |
| L5, L7, L8 | i18n gaps; no ESLint; first-day summary | open (not critical) | planned alongside Stage 3 UI work | — |

## Stage 3 summary (Phase 1 additions)

| Requirement | Status | Where | Proof |
|---|---|---|---|
| Booking link offered to PANAS leads | **done** | Brain field `booking` (https only) → `src/lib/agent/booking.ts` appends it to a PANAS reply **once per chat** (`conversations.booking_link_sent_at`), in the customer's language; also in the prompt so the AI can share it when asked | `tests/booking.test.ts` (6); `tests/e2e/stage3.mjs` (link sent, recorded, not repeated, not for SUAM) |
| SUAM follow-ups: max 2, owner-set intervals | **done** | `FollowUpSchema` (`delay_hours`, `second_delay_hours`, `max_attempts` ≤ 2; old rows with 3 are clamped, never break the Brain); `src/lib/followup/plan.ts` (`MAX_FOLLOW_UPS = 2`) | `tests/followup.test.ts` (intervals, cap, clamp) |
| …per-tenant and per-conversation off switch | **done** | per tenant: Brain → *Aktifkan susulan*; per chat: `conversations.follow_up_disabled`, toggle in the chat side panel (any team member), API action `set_follow_up` | unit test; RLS test; E2E (own chat ✓, other business's chat → 404); cron run skipped the switched-off chat |
| …respects WhatsApp 24h window + templates | **done** (unchanged, re-verified) | free text only inside the window, approved template outside it, otherwise skip; 9am–9pm; never after STOP | `tests/followup.test.ts` |
| Conversation-based monthly metering | **done** | `plans.conversation_limit`, `usage_conversations` + `count_conversation()` (once per chat per month), `usage_counters.conversations`; counted when the AI answers (or a follow-up is sent); test chats and human-only chats don't count | RLS tests (idempotent count, cross-tenant refused, members read-only); E2E (2 chats / 4 replies = 2) |
| 80% / 100% warnings | **done** | `usageAlertDue()` + `claim_usage_alert()` (exactly once per level per month) → owner email + dashboard banner (yellow/red) | unit + RLS + E2E (one email, no duplicate) |
| Flat per-business caps; no per-contact / per-seat pricing | **done** | one flat monthly price per plan; at 100% only **new** chats pause, chats already counted continue (no mid-conversation cut-off; replaces the old +5% buffer) | unit (`conversationCounted`); E2E (new chat → owner, ongoing chat → AI) |
| "Why Panas?" on each lead | **done** | `WhyScore` component: Leads table column, Inbox (PANAS rows), chat side panel; prompt asks for a reason that quotes the customer (`PROMPT_TEMPLATE_VERSION` → `2026-10-04.2`) | E2E (leads + inbox pages) |

**Found and fixed while building Stage 3:**

| Problem | Cause | Fix |
|---|---|---|
| Dashboard usage meter would read 0 for members | Stage 2's M2 fix revoked `current_usage_period` from signed-in users, but the dashboard uses it | `current_usage_period` now answers for the caller's **own** workspace only (null for others), so M2 stays fixed; RLS + probe tests for both cases |
| A new junction table broke every "conversation + business" query (`PGRST201` ambiguous embed) | `usage_conversations` had foreign keys to both `tenants` and `conversations` | No FK on its `tenant_id` (same-tenant trigger still applies); a unit test now fails if any future table repeats the pattern |

## Stage 4 summary (vendor independence)

| Requirement | Status | Where | Proof |
|---|---|---|---|
| Murpati adapter = clearly marked **stub**, no guessed endpoints or payloads | **done** | `src/lib/channels/whatsapp/murpati.ts` (banner "STUB. NOT IMPLEMENTED"). **Removed:** the guessed send endpoint and body, the guessed webhook parser (`murpati-parse.ts`), the guessed multi-format signature verifier, `MURPATI_API_BASE_URL`, and the fake Murpati API in the test stack. Stub: `available: false`; `receiveMessage` throws `MurpatiNotImplementedError`; `sendMessage` returns `failed` / `MURPATI_NOT_IMPLEMENTED` with no network call | contract tests: unavailable, refuses webhooks however signed, send fails with `fetch` never called, **source contains no URL, `fetch(`, HMAC or Murpati header** (guards against re-introducing guesses) |
| …refuses at every entry point | **done** | webhook `/api/webhooks/murpati/<id>` → **501**, body never parsed or stored; dashboard: Murpati card "coming soon" (no connect form), no **Make active** on Murpati rows, server action `switchProvider` refuses any adapter with `available: false` | E2E: 501, 0 messages/contacts stored, unknown id → 404; reply via a Murpati connection is saved in our DB first and marked `failed` (`MURPATI_NOT_IMPLEMENTED`); Channels page shows the stub warning |
| …what we need from Murpati is written down | **done** | `docs/MURPATI_INTEGRATION.md`: 12 questions the docs must answer, mapped to code, plus fixed rules and a definition of done | — |
| Against the interface | **done** | `ChannelAdapter` + new `metadata().available` / `unavailableReason`; `listAdapters()`; `tests/adapter-contract.test.ts` runs the same contract on **every** registered transport (web, Meta, Murpati): correct metadata, WhatsApp rules (24h, templates), rejects unauthenticated input, never throws on send, never touches our database | 14 contract tests |
| Meta adapter (direct, official) | **done** (re-verified) | `src/lib/channels/whatsapp/meta.ts` (Graph API, Embedded Signup, X-Hub-Signature-256) | E2E: unsigned webhook → 401; signed → stored in our DB → AI reply → sent via Graph with a `wamid` recorded |
| Encryption (AES-256-GCM, rotatable) | **done**, rotation now usable | new `src/lib/crypto/rotation.ts`: `resealAll()` (batched, idempotent, never overwrites a token rotated meanwhile, reports unreadable rows rather than dropping them), `keyStatus()` (rows per key, **safe to remove**, **unreadable keys**); /admin → *Encryption keys* + **Re-encrypt with current key** | `tests/key-rotation.test.ts` (4); `tests/rotation.stack.test.ts` against the real DB/REST API |
| Ownership record (who owns the Meta Business + WABA) | **done** (existed; now monitored) | per-connection record and *Verified* tick on Channels; new /admin table **WhatsApp numbers needing attention** (not client-owned, unverified, or on the Murpati stub) | E2E: admin page lists them; hidden (404) from business owners |
| EXIT_RUNBOOK | **updated** | honest status (Meta live; Murpati steps are the plan once the adapter is real), key rotation via /admin, new **"A client leaves Layankan entirely"** and **"Other vendors"** (Anthropic model is a setting; Supabase is plain Postgres) sections | — |

**Found and fixed while testing Stage 4:** the end-to-end suites shared tenant data, so results depended on run order (the Stage 4 Meta check used up tenant A's monthly conversations, and the live rotation test counted another suite's credential). Now each suite uses its own tenant or connection. All suites pass in any order, which was verified by running Stage 4 before Stage 3.

> The tables below are the **original Stage 1 findings**, kept for the record. Use the summaries above for current status.

---

## Critical issues (fix first)

| # | Issue | Severity | Evidence | Proof | Fix needed |
|---|---|---|---|---|---|
| C1 | **Cross-tenant references are accepted.** A signed-in member of tenant A can create rows *in A* that point at tenant B's records: a message on B's conversation, a conversation on B's contact, a conversation or template on B's WhatsApp connection. A database trigger then **writes into B's data**: A changed B's response-time analytics (null → 7200s / 3600s). | **Critical** (cross-tenant write) | `supabase/migrations/20261004000001_init.sql:473` (`messages_member_insert` only checks the row's own `tenant_id`); member insert/update policies on `conversations` (same file, policy loop `:463-465`); `message_templates` owner policy (`20261004000003_whatsapp.sql:48`); trigger `track_response_times` updates by `conversation_id` with no tenant check (`20261004000004_billing_analytics.sql:190`) | `isolation_probe.sql` (3 FAILs) · `tests/e2e/isolation-routes.mjs` (3 FAILs via the public Supabase REST API, HTTP 201) · manual reproduction in this audit | Enforce "same tenant" on every reference: composite foreign keys `(tenant_id, id)` or `BEFORE INSERT/UPDATE` checks on `messages.conversation_id`, `conversations.contact_id / channel_connection_id`, `message_templates.connection_id`, `channel_credentials.connection_id`, `message_status_events.message_id`, `ai_assessments.*`. Make SECURITY DEFINER triggers filter by `tenant_id`. |
| C2 | **Invites can be accepted with an unverified email.** `accept_my_invites()` matches any auth user whose email equals an invite. If email confirmation is ever off (or for any future sign-in method that doesn't verify), someone who registers the invited address joins that business and sees all its customers. | **Critical** (account takeover into a tenant) | `supabase/migrations/20261004000001_init.sql:111-124` | `isolation_probe.sql` → `FAIL unconfirmed email cannot accept an invite into B` | Require `email_confirmed_at is not null` in `accept_my_invites()` (and in the app before showing "pending invites"). |
| C3 | **Embed widget traps mobile visitors.** On screens ≤480px the chat opens full-screen and the CSS hides the only close button (`.panel.open + .btn{display:none}`), so a visitor cannot close it without reloading the host site. | **Broken** (requirement 8) | `public/widget.js:31` | Playwright on a 390×844 phone viewport: open ✓, close ✗ (screenshots taken during audit) | Keep a visible close button on mobile (inside the panel header area or as an overlay), plus Escape/back-button handling. |

## High / medium findings

| # | Issue | Severity | Evidence | Fix needed |
|---|---|---|---|---|
| H1 | **No output-side guard against prompt leaks.** Input-side defences are strong (see table below), but if the model is fooled, a reply quoting the system prompt or internal notes would be sent to the customer: replies are only checked for shape and length. | High | `src/lib/agent/interpret.ts:24` (`planTurn`), `src/lib/agent/schema.ts:42-57` | Add a leak filter: block replies containing template section markers or long verbatim spans of the system prompt / `extra_knowledge`; fall back + hand off. Two `it.fails` tests in `tests/prompt-injection.test.ts` already describe the expected behaviour. |
| H2 | **Murpati adapter guesses the API.** Send endpoint, payload fields and accepted signature formats were inferred because Murpati's docs were unreachable. This conflicts with the new rule "do NOT guess endpoints or payloads". | High (vendor rule) | `src/lib/channels/whatsapp/murpati.ts:19-22`, `murpati-parse.ts`, `src/lib/channels/signature.ts:63-105` | Stage 4: replace with a clearly marked stub that refuses to send/accept until the real docs are wired in. |
| M1 | **Logged-out callers can execute several database functions** (`create_workspace`, `accept_my_invites`, `update_my_notification_prefs`, trigger functions). Today each one refuses or no-ops without a user, so no data is exposed; it is defence-in-depth. Supabase grants `anon` EXECUTE by default, so `revoke … from public` was not enough. | Medium | `supabase/migrations/20261004000001_init.sql:83-84,107,134,507` (`revoke … from public` only); probe output | `revoke execute … from anon` explicitly on every function meant for signed-in users. |
| M2 | **`current_usage_period(tenant)` leaks another tenant's billing anchor date** to any signed-in user who knows the tenant id (SECURITY DEFINER, no membership check). | Medium (small info leak) | `…0004_billing_analytics.sql:116-123` | Check `is_tenant_member(p_tenant)` (or make it SECURITY INVOKER). |
| M3 | **Rate limiting trusts the first `X-Forwarded-For` entry** (spoofable behind some proxies) and **fails open** on database errors. On Vercel the header is set by the platform, so the risk is host-dependent. | Medium | `src/lib/ratelimit.ts:9-19` | Prefer the platform's client-IP header (`x-real-ip` / `x-vercel-forwarded-for`), take the right-most trusted hop; keep fail-open but add a per-tenant hard cap in memory. |

## Low findings

| # | Issue | Evidence | Fix needed |
|---|---|---|---|
| L1 | Dev-mode email logging writes the recipient address to logs (only when `RESEND_API_KEY` is empty). | `src/lib/notify/email.ts:16` | Mask the address. |
| L2 | `src/lib/crypto/secrets.ts` has no `import "server-only"` guard (not imported by client code today). | `src/lib/crypto/secrets.ts:1` | Add the guard. |
| L3 | Privacy page is generic: it ignores the `?b=` business parameter, so it doesn't name the business (data controller) or its contact. | `src/app/privacy/page.tsx`, link at `src/app/c/[slug]/PublicChat.tsx` | Show the business name/contact from the slug. |
| L4 | PDPA export omits `subscriptions`, `invoices`, `usage_counters`, `daily_summary_runs`, `message_status_events`. Customer data is complete; billing records aren't. | `src/app/api/dashboard/export/route.ts` | Include them. |
| L5 | BM/EN toggle doesn't cover everything: login/signup are BM-only, the admin console is EN-only, and several screens carry inline bilingual text instead of the dictionary. | `src/app/components/AuthForm.tsx:49`, `src/app/admin/page.tsx`, `src/app/onboarding/OnboardingForm.tsx` | Move strings into `src/lib/i18n.ts`. |
| L6 | `.env.example` lacks 3 optional test-override variables (`META_GRAPH_BASE_URL`, `BILLPLZ_API_BASE_URL`, `TOYYIBPAY_API_BASE_URL`). All required variables are present. | `grep process.env` vs `.env.example` | Document as optional. |
| L7 | No linter configured (only `tsc`). | `package.json` | Add ESLint (`next lint` config). |
| L8 | Daily summaries depend on the founder setting up the hourly scheduler (`pg_cron`); a workspace created after its summary hour gets its first summary immediately that day. | README step 7; `src/lib/notify/digest.ts:18` | Document; optionally skip the first day. |

---

## Requirement checklist

| # | Requirement | Status | Evidence (file:line) | Fix needed |
|---|---|---|---|---|
| 1 | **Self-serve:** sign-up → workspace with unique slug → Brain editor → test pane → Go live → link, QR, embed | **done** (code + local E2E; real Supabase email/Google sign-up not runnable here) | sign-up `src/app/components/AuthForm.tsx:23`; unique slug `supabase/migrations/20261004000001_init.sql:29`, RPC `:89`; onboarding `src/app/onboarding/actions.ts`; test pane `src/app/dashboard/test/TestPane.tsx:33`; Go live `src/app/dashboard/channels/actions.ts:10`; QR `ChannelsClient.tsx:14`; embed `channels/page.tsx:31`; draft tenants hidden `src/app/c/[slug]/page.tsx:18` | Verify sign-up/Google once deployed to real Supabase. |
| 2 | **Business Brain:** profile, packages/prices, FAQ, policies, qualifying questions w/ industry defaults, handoff rules, PDF/URL/text import with owner review | **done** | schemas `src/lib/brain/schema.ts:9-36`; industry defaults `:124`; import never writes to the Brain `src/app/api/dashboard/brain/extract/route.ts:14`; review → merge `src/app/dashboard/brain/BrainEditor.tsx:51`; SSRF guard `src/lib/ssrf.ts` | — |
| 3 | **Agent:** only from tenant config via versioned template; answers only from Brain; honest "not sure" + handoff; short WhatsApp-style BM/EN/Manglish | **done** (instructions + structure); model compliance only testable live | template version `src/lib/agent/prompt.ts:7`, builder `:75`; language mirroring `:95`; short replies `:97`; only-from-Brain `:98`; unsure → handoff `src/lib/agent/handoff.ts` (`ai_unsure`); reply cap `src/lib/agent/schema.ts:42` | Run `tests/injection.live.test.ts` with a real key. |
| 4 | **Structured assessment after every customer message,** schema-validated, invalid output handled safely | **done** | schema `src/lib/agent/schema.ts:11-36`; enforced via structured output `src/lib/agent/llm.ts:34`; second validation `schema.ts:49`; refusal/invalid → fallback + handoff `src/lib/agent/interpret.ts:34-41`; audit log `src/lib/agent/engine.ts:297` | — |
| 5 | **Handoff:** owner alerted, AI paused, Take over / Hand back | **done** | pause `src/lib/agent/engine.ts:204`; status flip `:329`; alert (email + WhatsApp) `:339` → `src/lib/notify/handoff.ts`; actions `src/app/api/dashboard/conversations/[id]/route.ts:6-7` + atomic take-over | — |
| 6 | **Dashboard:** inbox sorted by score, conversation view, leads filters + CSV, BM UI + EN toggle | **partial** | sort `src/app/dashboard/inbox/page.tsx:22`; leads `src/lib/leads/query.ts:12`; CSV (formula-injection safe) `:30`; toggle `src/app/dashboard/layout.tsx:66` | i18n gaps → L5. |
| 7 | **Daily summary** in each tenant's timezone (default Asia/Kuala_Lumpur) | **done** (needs scheduler set up) | default TZ `…0001_init.sql:32`; due check `src/lib/notify/digest.ts:18`; runner `src/lib/notify/daily-summary.ts:16`; once per day `daily_summary_runs` PK | L8. |
| 8 | **Embed widget** doesn't break host styles; works on mobile | **broken** → **FIXED (Stage 2)** | isolation: closed shadow DOM `public/widget.js:20` + iframe `:47`: survived a hostile host stylesheet (`!important` rules on `button`, `iframe`, `div`), host styles untouched; mobile: `:31` | **C3**. |
| 9 | **Layankan demo tenant** seeded and working | **done** | `supabase/seed.sql:6` (+ Brain, web channel, internal plan); answered live on the E2E stack ("Founding Offer RM500 setup + RM300/bulan…") | — |

## Security & quality checklist

| Check | Status | Evidence | Fix needed |
|---|---|---|---|
| RLS enabled on **every** tenant table | **done** | DB scan: 0 tables without RLS (all 22 public tables). `channel_credentials`, `rate_limits`, `payment_events` have no policies on purpose (server-only) | — |
| RLS **correct**: tenant A cannot read B | **done** for reads | `supabase/tests/rls_test.sql` (73 checks ✓); `isolation_probe.sql` reads on all 18 tenant tables + 3 server-only tables ✓; `tests/e2e/isolation-routes.mjs`: 38 route/page/API/REST checks ✓ | — |
| …and cannot write into B | **broken** → **FIXED (Stage 2)** | see **C1** | C1 |
| Invites / membership | **broken** → **FIXED (Stage 2)** | see **C2** | C2 |
| SECURITY DEFINER functions | **partial** → **FIXED (Stage 2)** | M1, M2 | M1, M2 |
| Prompt injection: can't change instructions, reveal the prompt, or reach other tenants | **partial** → **done (Stage 2)**; live eval still to run with a real key | input side ✓: JSON-escaped transcript `src/lib/agent/prompt.ts:132-143`, system prompt built only from that tenant's Brain, explicit untrusted-input rules `:115-117`, schema-only output; 16 BM/EN/Manglish unit tests ✓; 18 request-path E2E checks ✓ (`tests/e2e/injection-request.mjs`). Output side ✗ (H1). Live model eval written, **not run** (no API key here) | H1; run live eval |
| Public chat rate-limited | **partial** → **FIXED (Stage 2)** | per-IP/min + per-tenant/hour `src/app/api/public/chat/[slug]/route.ts:27-28`, poll limit `:94`, test pane & import limited | M3 |
| No secrets in client code | **done** | only `NEXT_PUBLIC_*` (URL, anon key, app URL, Meta app/config id) in client code; built `.next/static` grep for service key / API keys / secrets: none; secret-using modules carry `server-only` | L2 |
| No secrets in logs | **done** | 19 log statements reviewed: ids + error classes only | L1 (PII) |
| `.env.example` complete | **done** | every required variable present | L6 |
| Webhook signature verification | **done** (Meta, billing, cron) / **partial** (Murpati) → Murpati webhook refuses everything until built (Stage 4) | Meta `src/lib/channels/signature.ts:14,23`; cron `:55`; Billplz X-Signature `src/lib/billing/billplz.ts`; ToyyibPay re-confirmed via API `src/lib/billing/toyyibpay.ts`; Murpati `signature.ts:76` accepts several guessed formats | H2 |
| PDPA: privacy notice on chat | **done** | `src/app/c/[slug]/PublicChat.tsx:11` + `/privacy` | L3 |
| PDPA: per-tenant export & deletion | **done** | export `src/app/api/dashboard/export/route.ts:5`; customer delete `conversations/[id]/route.ts` DELETE; workspace delete `src/app/dashboard/settings/actions.ts:94` (cascades + stored files) | L4 |
| Guardrails: no unofficial WhatsApp libs, no bulk messaging, no flow builder | **done** | `package.json` has no WhatsApp Web libraries; DB refuses unofficial connections (`channel_connections_official_only`); no broadcast feature exists | — |

## Test & build results

| Command | Stage 1 (audit) | Stage 2 | Stage 3 | Stage 4 |
|---|---|---|---|---|
| `npm run lint` (`tsc --noEmit`) | ✅ pass | ✅ pass | ✅ pass | ✅ pass |
| `npm test` (vitest) | ✅ 121 passed, 2 *expected-fail* (H1), 7 skipped | ✅ 127 passed, 7 skipped | ✅ 139 passed, 7 skipped | ✅ **151 passed**, 8 skipped (live model eval: no API key; DB rotation test runs with the stack) |
| `npm run test:rls` | ✅ 73/73 | ✅ 88/88 | ✅ 104/104 | ✅ **104/104** |
| `npm run test:probe` | ❌ 26 pass / 8 fail | ✅ 34/34 | ✅ 35/35 | ✅ **35/35** |
| `npm run test:e2e` (`isolation-routes.mjs`) | ❌ 35 pass / 3 fail | ✅ 38/38 | ✅ 38/38 | ✅ **38/38** (Murpati webhook now 501) |
| `node tests/e2e/injection-request.mjs` | ✅ 18/18 | ✅ 18/18 | ✅ 18/18 | ✅ **18/18** |
| `npm run test:widget` | desktop ✅ · phone ❌ | ✅ 10/10 | ✅ 10/10 | ✅ **10/10** |
| `npm run test:stage3` | — | — | ✅ 18/18 | ✅ **18/18** |
| `npm run test:stage4` *(new)* | — | — | — | ✅ **16/16** |
| `E2E_STACK=1 npx vitest run tests/rotation.stack.test.ts` *(new)* | — | — | — | ✅ **1/1** (real DB) |
| `next build` | ✅ pass | ✅ pass | ✅ pass | ✅ pass |
| ESLint | not configured (L7) | not configured (L7) | not configured (L7) | not configured (L7) |

## Notes for later stages (not defects against the original spec)

| Topic | Current state | Stage |
|---|---|---|
| Booking link for PANAS leads | **done in Stage 3** | 3 |
| SUAM follow-ups | **done in Stage 3** (max 2, two intervals, per-chat switch) | 3 |
| Metering | **done in Stage 3** (conversations per month, 80%/100% warnings) | 3 |
| "Why Panas?" on leads list | **done in Stage 3** | 3 |
| Murpati adapter | **stub in Stage 4**; real adapter waits for Murpati's API docs (`docs/MURPATI_INTEGRATION.md`) | 4 → when docs arrive |
| Comment-to-chat, payment links, customer memory, broadcasts, IG/Messenger | not designed in data model yet | 5 |

## Tests added in Stage 2

- `supabase/tests/rls_test.sql`: hard (script-stopping) checks for C1 (`_t_cross` only accepts the RLS or "same workspace" error, so an unrelated error can't fake a pass), C2, M1, M2.
- `supabase/tests/run-isolation-probe.sh`: exits non-zero if any probe fails.
- `tests/e2e/widget.mjs` (`npm run test:widget`): desktop + phone open/close (✕, Escape, dimmed strip) under hostile host CSS.
- `tests/prompt-injection.test.ts`: leak guard tests (blocked leaks + no false positives).
- `tests/misc.test.ts`: client IP selection and the rate-limit fallback.

## Tests added in the Stage 1 audit

- `supabase/tests/isolation_probe.sql` + `run-isolation-probe.sh`: non-aborting cross-tenant probes (reads on every table, RPCs, cross-references, invites, anon).
- `tests/e2e/` (`stack.sh`, `fixtures.sql`, `fake-services.mjs`, `jwt.mjs`): reproducible local stack, no Docker or accounts.
- `tests/e2e/isolation-routes.mjs`: tenant A attacks every route, page, export, webhook and the REST API with tenant B ids.
- `tests/e2e/injection-request.mjs`: what the model actually receives under attack.
- `tests/prompt-injection.test.ts`: 12 BM/EN/Manglish attacks + output-side gap (`it.fails`).
- `tests/injection.live.test.ts`: live adversarial eval against the real model (auto-skips without a key).
- `supabase/tests/supabase_shim.sql`: `auth.users.email_confirmed_at` added to match real Supabase.
