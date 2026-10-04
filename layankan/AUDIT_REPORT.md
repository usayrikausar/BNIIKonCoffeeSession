# Layankan — Audit Report (Stage 1)

**Date:** 2026-10-04 · **Commit audited:** `53ff913` · **Scope:** whole `layankan/` codebase, read-only.
Nothing in the app was changed. The only additions are tests (listed at the end) and this report.

Status key: **done** · **partial** (works, with gaps) · **missing** · **broken** (does not do what it should).

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
| 8 | **Embed widget** doesn't break host styles; works on mobile | **broken** | isolation: closed shadow DOM `public/widget.js:20` + iframe `:47`: survived a hostile host stylesheet (`!important` rules on `button`, `iframe`, `div`), host styles untouched; mobile: `:31` | **C3**. |
| 9 | **Layankan demo tenant** seeded and working | **done** | `supabase/seed.sql:6` (+ Brain, web channel, internal plan); answered live on the E2E stack ("Founding Offer RM500 setup + RM300/bulan…") | — |

## Security & quality checklist

| Check | Status | Evidence | Fix needed |
|---|---|---|---|
| RLS enabled on **every** tenant table | **done** | DB scan: 0 tables without RLS (all 22 public tables). `channel_credentials`, `rate_limits`, `payment_events` have no policies on purpose (server-only) | — |
| RLS **correct**: tenant A cannot read B | **done** for reads | `supabase/tests/rls_test.sql` (73 checks ✓); `isolation_probe.sql` reads on all 18 tenant tables + 3 server-only tables ✓; `tests/e2e/isolation-routes.mjs`: 38 route/page/API/REST checks ✓ | — |
| …and cannot write into B | **broken** | see **C1** | C1 |
| Invites / membership | **broken** | see **C2** | C2 |
| SECURITY DEFINER functions | **partial** | M1, M2 | M1, M2 |
| Prompt injection: can't change instructions, reveal the prompt, or reach other tenants | **partial** | input side ✓: JSON-escaped transcript `src/lib/agent/prompt.ts:132-143`, system prompt built only from that tenant's Brain, explicit untrusted-input rules `:115-117`, schema-only output; 16 BM/EN/Manglish unit tests ✓; 18 request-path E2E checks ✓ (`tests/e2e/injection-request.mjs`). Output side ✗ (H1). Live model eval written, **not run** (no API key here) | H1; run live eval |
| Public chat rate-limited | **partial** | per-IP/min + per-tenant/hour `src/app/api/public/chat/[slug]/route.ts:27-28`, poll limit `:94`, test pane & import limited | M3 |
| No secrets in client code | **done** | only `NEXT_PUBLIC_*` (URL, anon key, app URL, Meta app/config id) in client code; built `.next/static` grep for service key / API keys / secrets: none; secret-using modules carry `server-only` | L2 |
| No secrets in logs | **done** | 19 log statements reviewed: ids + error classes only | L1 (PII) |
| `.env.example` complete | **done** | every required variable present | L6 |
| Webhook signature verification | **done** (Meta, billing, cron) / **partial** (Murpati) | Meta `src/lib/channels/signature.ts:14,23`; cron `:55`; Billplz X-Signature `src/lib/billing/billplz.ts`; ToyyibPay re-confirmed via API `src/lib/billing/toyyibpay.ts`; Murpati `signature.ts:76` accepts several guessed formats | H2 |
| PDPA: privacy notice on chat | **done** | `src/app/c/[slug]/PublicChat.tsx:11` + `/privacy` | L3 |
| PDPA: per-tenant export & deletion | **done** | export `src/app/api/dashboard/export/route.ts:5`; customer delete `conversations/[id]/route.ts` DELETE; workspace delete `src/app/dashboard/settings/actions.ts:94` (cascades + stored files) | L4 |
| Guardrails: no unofficial WhatsApp libs, no bulk messaging, no flow builder | **done** | `package.json` has no WhatsApp Web libraries; DB refuses unofficial connections (`channel_connections_official_only`); no broadcast feature exists | — |

## Test & build results

| Command | Result |
|---|---|
| `npx tsc --noEmit` | ✅ pass |
| `npm test` (vitest) | ✅ **121 passed**, 2 *expected-fail* (documented gap H1), 7 skipped (live model eval: no API key) |
| `npm run test:rls` | ✅ **73/73** |
| `bash supabase/tests/run-isolation-probe.sh` *(new)* | ❌ **26 pass / 8 fail** → C1 (3), C2 (1), M1 (3), M2 (1) |
| `node tests/e2e/isolation-routes.mjs` *(new, needs `tests/e2e/stack.sh up`)* | ❌ **38 pass / 3 fail** → C1 via REST |
| `node tests/e2e/injection-request.mjs` *(new)* | ✅ **18/18** |
| Widget (Playwright, hostile host CSS, desktop + phone) | desktop ✅ · mobile ❌ (C3) |
| `next build` | ✅ pass |
| Lint | not configured (L7) |

## Notes for later stages (not defects against the original spec)

| Topic | Current state | Stage |
|---|---|---|
| Booking link for PANAS leads | not built | 3 |
| SUAM follow-ups | 1–3 attempts, one fixed interval, 9am–9pm, STOP respected, templates outside 24h; **no per-conversation off switch** | 3 |
| Metering | counts **AI replies** per month (`src/lib/billing/logic.ts`); spec now wants **conversations** per month | 3 |
| "Why Panas?" on leads list | reason shown in conversation view only, not in the leads table | 3 |
| Murpati adapter | guessed implementation (H2) | 4 |
| Comment-to-chat, payment links, customer memory, broadcasts, IG/Messenger | not designed in data model yet | 5 |

## Tests added in this audit

- `supabase/tests/isolation_probe.sql` + `run-isolation-probe.sh`: non-aborting cross-tenant probes (reads on every table, RPCs, cross-references, invites, anon).
- `tests/e2e/` (`stack.sh`, `fixtures.sql`, `fake-services.mjs`, `jwt.mjs`): reproducible local stack, no Docker or accounts.
- `tests/e2e/isolation-routes.mjs`: tenant A attacks every route, page, export, webhook and the REST API with tenant B ids.
- `tests/e2e/injection-request.mjs`: what the model actually receives under attack.
- `tests/prompt-injection.test.ts`: 12 BM/EN/Manglish attacks + output-side gap (`it.fails`).
- `tests/injection.live.test.ts`: live adversarial eval against the real model (auto-skips without a key).
- `supabase/tests/supabase_shim.sql`: `auth.users.email_confirmed_at` added to match real Supabase.
