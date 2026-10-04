# Layankan — Architecture

One codebase, one database, many businesses (tenants). Nothing is customised per
client in code: a tenant's behaviour comes **only** from its Business Brain row.

## Request flows

```
Customer (web chat / widget)                     Owner (dashboard)
        │                                               │  RLS-scoped Supabase client
        ▼                                               ▼
POST /api/public/chat/{slug} ── rate limit ──►  pages + /api/dashboard/*
        │                                               │
        ▼                                               │ take over / hand back / reply
 web adapter (ChannelAdapter) ──► recordInbound()  ◄────┘
        │                          (message persisted FIRST)
        ▼
 runAgentTurn()  ── conversation.status != 'ai' → stay silent (owner has it)
        │
        ├─ buildSystemPrompt(brain)       versioned template, tenant data only
        ├─ buildConversationTurn(history) JSON-escaped transcript (injection-safe)
        ├─ Claude (structured output: reply + assessment)
        ├─ planTurn() → validate, decideHandoff(rules)   pure + unit tested
        ├─ sendOutbound()  persist "queued" → adapter.sendMessage → record status
        ├─ ai_assessments row (audit: model, prompt version, brain version, tokens)
        ├─ conversation: score, details, status (needs_human on handoff)
        └─ notifyHandoff() → email owner(s) (Phase 2: WhatsApp too)

Hourly cron → /api/cron/hourly → daily summaries (per tenant timezone, once per local day, email + WhatsApp)
                              → SUAM follow-ups (9am–9pm, templates outside the 24h window, opt-out respected)
```

### WhatsApp (Phase 2)

```
Meta  ── POST /api/webhooks/meta ── X-Hub-Signature-256 (app secret) ── route by phone_number_id ─┐
Murpati ─ POST /api/webhooks/murpati/{connectionId} ── X-Murpati-Signature (connection secret) ──┤
                                                                                                 ▼
               ingestEvents(): messages (dedupe on provider id), delivery receipts (never backwards),
               messages typed in the provider's own dashboard, STOP opt-outs → all stored in OUR DB
                                                                                                 │ 200 OK (~100ms)
                                                                                                 ▼ after()
               respondIfLatest(): 2.5s debounce so a burst gets ONE reply → runAgentTurn()
                                                                                                 │
               sendOutbound(): 24h window enforced (free text) / approved template → adapter.sendMessage()
```

* Transport per tenant = `channel_connections` row with `is_active`; `switch_active_connection()` flips it atomically.
* Owner alerts/summaries go out from the platform tenant's own number (`PLATFORM_TENANT_ID`) as templates.
* `official_api` check constraint: unofficial (QR-linked) WhatsApp connections cannot be stored.

## Data model (Postgres / Supabase)

Every tenant-owned table has `tenant_id` and **RLS enabled**. The browser can
only see rows of tenants the signed-in user belongs to (`is_tenant_member()`).
Server paths without a user (public chat, cron, engine) use the service role
and scope every query by `tenant_id` in code.

| Table | Purpose |
|---|---|
| `tenants` | Workspace: `slug` (public link), status draft/live, timezone (default Asia/Kuala_Lumpur), summary hour, default customer language, plan |
| `tenant_members` | user ↔ tenant with role `owner` / `staff`, per-member notification prefs |
| `tenant_invites` | pending staff invites (accepted automatically on sign-in) |
| `business_brains` | one row per tenant: profile, products, faqs, policies, qualifying_questions, handoff_rules, extra_knowledge, `version` |
| `brain_revisions` | snapshot of every brain save (trigger) — assessments reference `brain_version` |
| `brain_sources` | uploaded PDF / URL / text and the extracted **draft** (owner reviews before merge) |
| `channel_connections` | per tenant per channel: `provider` (`web` / `murpati` / `meta_cloud`), WhatsApp ids (`phone_number_id`, `waba_id`, `meta_business_id`), **ownership record** (`meta_business_owner`, `waba_owner`, legal name, contact), one *active* row per channel |
| `channel_credentials` | AES-256-GCM encrypted secrets, key-id tagged, multiple rows for zero-downtime rotation. **No RLS policy at all** → invisible to browsers |
| `contacts` | a customer per tenant per channel (`external_id` = hashed web visitor id or WhatsApp wa_id) |
| `conversations` | status `ai` / `needs_human` / `human` / `closed`, lead score + confidence + reason, merged lead details, `last_inbound_at` (WhatsApp 24h window), `is_test` |
| `messages` | every inbound/outbound message, sender, provider, `provider_message_id` (dedupe index), delivery `status` — immutable from the browser |
| `message_status_events` | delivery receipt history (sent → delivered → read / failed) |
| `ai_assessments` | append-only audit of every AI turn: score, confidence, captured details, handoff decision, raw output, model, prompt template version, brain version, tokens, latency, error |
| `notifications` | every alert / digest sent (email now, WhatsApp in Phase 2) |
| `daily_summary_runs` | one row per tenant per local date (idempotency) |
| `rate_limits` | fixed-window counters for public endpoints (service role only) |
| `message_templates` | approved WhatsApp templates per tenant (synced from Meta or added by name) |

| `plans` | catalogue: price, setup fee, AI-reply limit, number/member caps (editable data) |
| `subscriptions` | one per tenant: plan, status, `billing_anchor` (usage month), `current_period_end` (paid through) |
| `invoices` | every bill: lines, period, gateway bill id + payment link, paid amount |
| `payment_events` | raw gateway callbacks/redirects with `verified` flag (audit, service role only) |
| `usage_counters` | per tenant per usage month: AI replies, messages in/out, templates, tokens |

Phase 3 also added `conversations.outcome / outcome_value_cents` (won/lost), response-time
columns maintained by a trigger, `analytics_summary()` (SECURITY INVOKER, RLS applies) and
`increment_usage()` / `current_usage_period()` (server-side meter).

Phase 2 also added: `contacts.opted_out_at`, `conversations.follow_up_count / last_follow_up_at`,
`business_brains.follow_up`, `notifications.provider_message_id`, `channel_connections.official_api`
(must be true) and a unique index so one phone number is live in only one workspace.

### Why Phase 2 (WhatsApp) needs no migration

* `channel_kind` already has `whatsapp`; `channel_provider` already has `murpati` and `meta_cloud`.
* WhatsApp routing (`phone_number_id`), WABA ownership, encrypted tokens, delivery
  statuses, dedupe of webhook retries and the 24h window (`last_inbound_at`) all exist now.
* Switching a tenant from Murpati to the direct Cloud API = deactivate one
  `channel_connections` row and activate another. No code change (see `EXIT_RUNBOOK.md`).

## Folder structure

```
layankan/
├─ src/
│  ├─ proxy.ts                     session refresh + dashboard guard (Next 16 "proxy")
│  ├─ app/
│  │  ├─ page.tsx                  landing page (live demo = tenant "layankan")
│  │  ├─ c/[slug]/                 public chat page (also loaded by the widget iframe)
│  │  ├─ login, signup, auth/      Supabase Auth (email+password, Google)
│  │  ├─ onboarding/               workspace wizard (slug, industry defaults)
│  │  ├─ dashboard/                inbox, conversation, leads, brain, test, channels, settings
│  │  └─ api/
│  │     ├─ public/chat/[slug]     customer messages + polling (rate limited)
│  │     ├─ dashboard/*            owner actions (RLS-authorised)
│  │     ├─ webhooks/meta          WhatsApp Cloud API webhook (all tenants)
│  │     ├─ webhooks/murpati/[id]  Murpati webhook (per connection)
│  │     ├─ billing/callback|return/[gateway]   payment confirmations
│  │     └─ cron/hourly            billing jobs + summaries + follow-ups (CRON_SECRET)
│  ├─ app/admin/                   platform admin console (PLATFORM_ADMIN_EMAILS)
│  └─ lib/
│     ├─ agent/                    prompt template, schema, handoff policy, engine, Claude call
│     ├─ brain/                    Brain schema, industry defaults, PDF/URL/text extraction
│     ├─ channels/                 ChannelAdapter interface, web adapter, registry, signatures, credentials
│     │  └─ whatsapp/              policy (24h window, opt-out), meta + murpati adapters & pure parsers
│     ├─ chat/                     conversations + webhook ingestion
│     ├─ followup/                 SUAM follow-up planner (pure) + runner
│     ├─ billing/                  plans/entitlement logic (pure), Billplz/ToyyibPay gateways, invoices, metering
│     ├─ crypto/                   AES-GCM keyring (rotation)
│     ├─ notify/                   email, handoff alerts, daily digest
│     └─ supabase/                 server (RLS) / admin (service role) / browser clients
├─ public/widget.js                standalone embed script (shadow DOM + iframe)
├─ supabase/
│  ├─ migrations/                  schema + RLS (source of truth)
│  ├─ seed.sql                     tenant #1 = Layankan (dogfooding)
│  └─ tests/                       RLS isolation tests (plain Postgres, no Docker)
├─ tests/                          unit tests (vitest)
└─ docs/
```

## Billing flow (Phase 3)

```
choose plan / renewal job ──► invoice (open) ──► gateway bill (Billplz / ToyyibPay) ──► customer pays (FPX)
                                                                  │
         callback (server→server, authoritative) ──┬── Billplz: X-Signature HMAC verified
         return (browser redirect, fast feedback) ─┘   ToyyibPay: re-confirmed via getBillTransactions
                                                                  ▼
            payment_events (audit) → markInvoicePaid (idempotent open→paid, amount checked) → subscription extended
```

Before every AI turn the engine evaluates the entitlement (`src/lib/billing/logic.ts`):
trial ended / unpaid beyond 7-day grace / over limit (+5%) → no model call; the customer gets
a holding reply, the conversation goes to *Needs you*, the owner is emailed once per period.
If billing data is missing the check fails **open**, so a billing bug never silences customers.

## Security notes

* **Tenant isolation**: RLS on every tenant table; dashboard writes that need
  privileges first prove access through RLS, then act with the service client
  scoped to that tenant. Credentials table has no browser policy at all.
* **Prompt injection**: customer text is JSON-encoded (with `<`, `>`, `&` escaped)
  inside a single data block; the system prompt states it is untrusted; output is
  schema-constrained and re-validated; any failure → safe fallback + human handoff.
  Only the current tenant's brain is ever in context.
* **Public endpoints**: per-IP and per-tenant rate limits (Postgres, fail-open),
  body size caps, visitor identified by a random token whose hash is stored.
* **Embedding**: only `/c/*` may be framed; all other pages send `frame-ancestors 'none'`.
* **Brain import from URL**: SSRF guard (public IPs only, re-checked per redirect, size/time caps).
* **Logging**: no prompts, message bodies, tokens or keys in logs — only ids and error classes.
