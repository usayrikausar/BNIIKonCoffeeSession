# Layankan roadmap (Stage 5 design)

**Status: all six items (R1–R6) are BUILT.** Each section below says what was built, how it differs from the original design, and what to check before going live, followed by the original design.

The draft data model in [`docs/design/stage5_data_model.sql`](docs/design/stage5_data_model.sql) has moved, section by section, into real migrations. `npm run test:design` still runs the original 32 design checks (e.g. "nobody without an opt-in can get a broadcast") against the real schema.

## The rules every item must keep

1. **No flow builder.** Owners fill in the Business Brain and flip simple switches. If a feature needs a diagram, it's the wrong design.
2. **No bulk messaging to anyone who hasn't opted in.** The database itself refuses it, not just the app.
3. **Official APIs only.** WhatsApp Cloud API, Messenger, Instagram and payment gateways. No unofficial libraries, no "WhatsApp Web" tricks, no scraping.
4. **Our database is the system of record.** Murpati, Meta and the payment gateways are pipes, and every message and payment event is stored by us.
5. **Same safety model as today:**
   - every new table is locked to its own business (RLS);
   - cross-business links are refused (`enforce_same_tenant`);
   - secrets are encrypted and rotatable;
   - PDPA export and delete cover the new data.
6. **Flat price per business.** New limits are a monthly cap per plan, never a charge per contact or per staff member.

## Recommended order

| # | Item | Why this order | Size* | Needs from outside |
|---|---|---|---|---|
| R1 ✅ | **Opt-in capture** (the first half of broadcasts): **BUILT**, see below | Cheap, and every week we wait is a week of opt-ins not collected. Broadcasts later can only go to people who opted in. | S | — |
| R2 ✅ | **Payment links** (FPX, cards, DuitNow where available): **BUILT**, see below | Turns PANAS leads into paid customers inside the chat: the biggest revenue win for SMEs. | M | Each business needs its own Billplz or ToyyibPay account |
| R3 ✅ | **Customer memory**: **BUILT**, see below | Makes returning customers feel known; no outside approvals needed. | M | — |
| R4 ✅ | **Instagram + Messenger**: **BUILT**, see below | Many Malaysian SMEs sell on IG/FB first. Prerequisite for R5. | L | Meta App Review for the messaging permissions |
| R5 ✅ | **Comment-to-chat**: **BUILT**, see below | Turns "harga?" comments into real chats. Needs R4. | M | Same Meta approvals as R4, plus the comment permissions |
| R6 ✅ | **Opt-in broadcasts**: **BUILT**, see below | Needs R1's opt-ins to have built up, plus approved marketing templates. | M | Approved WhatsApp marketing templates; the business pays Meta's per-message fee directly |

\*S ≈ up to 3 days, M ≈ 1–2 weeks, L ≈ 2–4 weeks for one developer, including tests. Rough estimates only.

---

## R1 · Opt-in capture: BUILT

Migration `supabase/migrations/20261004000008_optin.sql`, with code in `src/lib/optin/` and the engine. Tested in `tests/optin.test.ts`, the RLS suite and `npm run test:r1` (23 end-to-end checks).

Two changes from the original design, both made to be safer:
- **The customer agrees by replying PROMO, not "YA".** The AI asks its own yes/no questions ("Nak saya tempah Sabtu?"), so a bare "ya" could be answering that instead. Only a clear PROMO counts. The question is sent as its own message, so the record shows exactly what the customer saw.
- **WhatsApp only for now (no web-chat checkbox yet).** Broadcasts go out over WhatsApp, and a web visitor has no verified WhatsApp number to tie consent to. The `web_checkbox` method is reserved for when R3 (customer memory) links a web visitor to a verified number.

## R6 · Broadcasts: BUILT

The code:
- migration `…0014_broadcasts.sql`: `broadcasts`, `broadcast_recipients`, the consent guard (on queue **and** on send), the 7-day frequency cap, the monthly allowance (`plans.broadcast_message_limit`, `usage_counters.broadcast_messages`, `consume_broadcast_message`), RLS; owners can no longer mark their own templates as synced from Meta;
- the pure rules in `src/lib/broadcasts/rules.ts` and the server side in `…/service.ts` (audience, create, cancel, the paced sender);
- `/api/dashboard/broadcasts` (preview, create) and `/api/dashboard/broadcasts/<id>` (cancel), owner only; the hourly job sends scheduled and held-back messages;
- the **Promosi** page; the PDPA export includes broadcasts and recipients.

It's tested in `tests/broadcasts.test.ts`, the RLS suite (18 new checks), the isolation probe and `npm run test:r6` (39 end-to-end checks against a fake Graph API).

**Decisions:**
- **The audience starts from the consent history, never from the contact list.** The database checks each recipient's **latest** consent when it's queued, and again when its message starts sending, so a STOP between scheduling and sending still stops it.
- **Templates:** only APPROVED, MARKETING templates **synced from Meta** whose text contains STOP or BERHENTI. Owners can't type in their own "synced" template (database policy), so the STOP line we check is the one Meta approved.
- **"Stop promotions" buttons count as STOP.** The STOP detector now also accepts "Stop promotions", "Berhenti promosi" and similar button texts.
- **Broadcasts are written by the server only** (the original design let owners write them directly). The route checks the owner, the template and the allowance first.
- **Sending is paced:** 9am–9pm business time; 250 per number per 24h by default (`channel_connections.settings.broadcast_daily_limit` raises it); a short pause between messages; whatever is held back goes out on later hourly runs.
- **A message Meta refuses** is marked failed with Meta's reason and given back to the monthly allowance.
- **WhatsApp only.** The web-chat checkbox (`web_checkbox`) stays reserved: a web visitor has no WhatsApp number to send to.

**Before going live:**
- Confirm Meta's current marketing-template rules and the per-message price for Malaysia, and tell owners it's billed to their own WhatsApp account.
- Have the consent wording (R1) and the STOP line checked against PDPA by someone qualified.
- Set the real monthly allowances in `plans.broadcast_message_limit` (the current values are placeholders).
- Send a real broadcast from a test number; the automated tests use a fake Graph API.

### Original design

**What the owner sees**
- **Brain → Promotions:** switch on "Ask customers if they'd like promotions".
- The AI then asks once, at a natural moment in a chat that's going well: *"Boleh kami hantar promosi sekali-sekala? Balas YA. (Balas STOP bila-bila masa)"*. Web chat shows an unticked checkbox instead.
- **Promotions → New broadcast:** pick an approved WhatsApp template, choose who gets it (everyone who opted in, optionally only PANAS/SUAM), pick a time, then press **Send** or **Schedule**. That's the whole feature: no journeys and no flow builder.

**Rules, enforced by the database**
- **Consent history:** every opt-in and opt-out is stored with the exact wording shown, its version, and the customer's own message as evidence. The history can't be edited or deleted by staff.
- **No imported lists:** there is no "imported" opt-in method, so contact lists copied from elsewhere can never be broadcast to.
- **Staff can't opt someone in:** staff can record "customer asked us to stop", but can never record an opt-in for a customer.
- **Opt-in checked at send time:** a broadcast recipient row is only accepted when that contact's **latest** consent is an opt-in and they haven't sent STOP. This is a database trigger, checked in `npm run test:design`.
- **STOP / BERHENTI** (already handled today) also writes an opt-out into the consent history automatically. Every broadcast template must include "Balas STOP untuk berhenti".
- **Built in the app:**
  - a frequency cap per contact (e.g. one broadcast a week);
  - quiet hours (9am–9pm);
  - sending spread out to respect Meta's messaging limits;
  - a flat monthly allowance per plan (`plans.broadcast_message_limit`).

**Data model:** `marketing_consent_events` (append-only), view `marketing_consent_current`, `broadcasts`, `broadcast_recipients` (with the consent guard), plan and usage columns.

**Before building:**
- Confirm Meta's current marketing-template rules and per-message pricing for Malaysia.
- Note that the business pays Meta's per-message fees through **their own** WhatsApp account, so Layankan never carries that cost.
- Have the consent wording checked against PDPA by someone qualified.

**Done when:**
- Opt-in from chat and from the web checkbox both work.
- STOP stops broadcasts immediately.
- A broadcast to a list containing non-opted-in contacts skips them, which is proven by tests.
- The PDPA export includes consent history.

## R2 · Payment links: BUILT

The code:
- migration `supabase/migrations/20261004000009_payment_links.sql`;
- the rules in `src/lib/payments/links.ts` (pure, unit tested) and the server side in `src/lib/payments/service.ts`;
- routes `/api/payments/<account>/callback` and `/pay/<account>/return`;
- dashboard: Channels → Payments, and the chat side panel.

It's tested in `tests/payment-links.test.ts`, the RLS suite and `npm run test:r2` (37 end-to-end checks, Billplz and ToyyibPay against fake gateways).

**Differences from the design:**
- Payment accounts are written **only by the server** (after checking the keys with the gateway), not by owners directly.
- A link's payment URL can only be set by the server, from the gateway.
- The AI-offers-a-link option for fixed-price products is **not built**: links are staff-only for now.
- DuitNow QR depends on what each business's gateway account offers. Confirm with Billplz and ToyyibPay before advertising it.

**Before going live:** test with each gateway's sandbox using a real sandbox account (the automated tests use fake gateways). Also check the key-check endpoints Layankan uses: Billplz `GET /api/v3/collections/{id}` and ToyyibPay `getCategoryDetails`.

### Original design

**What the owner sees**
- **Channels → Payments:** connect **their own** Billplz or ToyyibPay account. The money goes straight to the business; Layankan never touches it.
- In any chat, the **Send payment link** button opens a form for amount and description. It creates a bill, posts the link in the chat, and shows *Unpaid → Paid ✓* live.
- When paid, the chat is marked **Won** with the amount (this feeds the Analytics conversion figures), and the owner is told.

**Rules**
- **Amounts are always typed by a person.** The AI never invents an amount. A later option, off by default: the AI may offer a link only for a product with a fixed price in the Brain, and only to a PANAS lead.
- **Payment status changes only through verified gateway callbacks**, using the same checks as Layankan's own billing (Billplz X-Signature; ToyyibPay re-confirmed with its API). Staff can't mark a link paid, and the database refuses it.
- **Links stay inside their own business:** a link can't point to another business's payment account or chat.
- **Limits:** RM1–RM100,000; links expire after 7 days by default.
- **No card data** ever touches Layankan; payers use the gateway's hosted page.
- **Gateway API keys are encrypted** like WhatsApp tokens and included in /admin key rotation.

**Data model:** `payment_accounts`, `payment_account_credentials` (encrypted), `payment_links`, `payment_link_events` (verified, idempotent).

**Code to reuse:** the `PaymentGateway` interface and the Billplz/ToyyibPay adapters from Phase 3. They currently use Layankan's own account; R2 runs them with each business's account instead.

**Before building:**
- Confirm with Billplz and ToyyibPay which methods each account type offers (FPX and cards on both; **DuitNow QR only where the business's gateway account supports it**).
- Confirm their callback signing for links, and whether sub-accounts are needed.

**Done when:**
- Sandbox payments work end to end with both gateways.
- Forged, underpaid and duplicate callbacks are rejected (the same tests as Phase 3 billing).
- Paid links show in the chat and in Analytics.

## R3 · Customer memory: BUILT

The code:
- migration `supabase/migrations/20261004000010_customer_memory.sql`;
- the rules in `src/lib/memory/memory.ts` (pure: sensitive-data filter, price/promise/instruction filter, clinic rule, de-duplication) and storage in `src/lib/memory/store.ts`;
- the AI side: new `memory_updates` in its structured output, and a `<customer_memory>` data block in the user turn (JSON-escaped like the conversation, never in the system prompt);
- the chat panel's "Apa kami tahu"; the Brain switch.

It's tested in `tests/memory.test.ts`, the RLS suite and `npm run test:r3` (18 end-to-end checks).

**Decisions made while building:**
- **"Purchase" memories come only from verified payments (R2).** The database refuses AI- or staff-created purchases. The AI may only propose preferences or facts, and a filter also refuses anything mentioning prices, discounts, promises or instructions.
- **Staff can add notes and remove memories, but can't rewrite one.** A removed memory is kept hidden for audit until it expires; to correct something, remove it and add a note.
- **One customer per contact for now.** Linking a web visitor and a WhatsApp number as the same person (by staff, or on a verified number) is planned. The `customers` table already supports it.
- **Retention:** each memory expires 12 months after it was created and is then deleted by the hourly job.

### Original design

**What the owner sees**
- **Brain → Remember returning customers:** on/off.
- Each chat's side panel gets a short **What we know** list, for example "Prefers Saturday morning slots" or "Bought scaling package in March". Staff can add, correct or delete items.
- The AI uses these facts to greet returning customers properly and skip questions it already knows the answer to.

**Rules**
- **Short, typed memories:** each one is a preference, fact, purchase or staff note, at most 300 characters. They expire after 12 months by default (PDPA retention).
- **What the AI may save:** it proposes a memory only from what the customer said, with the source message kept.
- **What it must never save:** health conditions, religion, IC or passport numbers, or bank or card details. The prompt says so, and a filter checks it.
  - For **clinics** this matters most: by default only appointment preferences are stored, never medical details.
- **Kept away from the instructions:** memories go to the AI as **data**, JSON-escaped like the conversation, and never into the system prompt. A memory planted by a customer therefore can't act as an instruction, and prompt caching keeps working.
- **No auto-merging on unverified numbers:** one person's web chat and WhatsApp are linked only on a verified identifier (their WhatsApp number) or by staff, never on a phone number someone typed into a web chat.
- **PDPA delete:** deleting a customer's last contact deletes the customer and all their memories. This is a database trigger, tested in `npm run test:design`.

**Data model:** `customers`, `contacts.customer_id`, `customer_memories` (soft delete, expiry).

**Done when:**
- A returning WhatsApp customer is greeted with relevant context.
- Prompt-injection tests cover memory text.
- The sensitive-data filter has BM/EN tests.
- Export and delete include memories.

## R4 · Instagram + Messenger: BUILT

The code:
- migrations `…0011_channel_kinds.sql` (enum values only, run on its own) and `…0012_instagram_messenger.sql`;
- the parser and send body in `src/lib/channels/meta-messaging/parse.ts` (pure);
- the adapters in `…/adapters.ts`, which pass the shared contract test;
- the Page connection in `…/connect.ts`, `/api/dashboard/meta-pages` and Channels → Facebook Messenger & Instagram;
- `/api/webhooks/meta`, which now routes the `page` and `instagram` objects too.

It's tested in `tests/meta-messaging.test.ts`, the contract test, the RLS suite and `npm run test:r4` (29 end-to-end checks against a fake Graph API).

**Decisions:**
- **Instagram uses the Page-linked flow:** the "Messenger API for Instagram", with messages sent through the linked Facebook Page. Meta's newer "Instagram API with Instagram Login" (no Page needed) isn't used yet.
- **The AI never replies outside the 24h window.** Staff replies between 24h and 7 days automatically carry Meta's `HUMAN_AGENT` tag, which needs Meta's Human Agent approval.
- **Page tokens never reach the browser.** Between "list Pages" and "connect", the person's Meta token is held only in a 10-minute, encrypted, httpOnly cookie, and the Page token is re-fetched from Meta when connecting.
- **One live Page / Instagram account per business,** and the same one can't be live in two businesses (database unique index).

**Before going live:**
- Complete Meta App Review for the permissions and the Human Agent feature.
- Test with a real Page and Instagram account. The automated tests use a fake Graph API, so re-check the field names (`instagram_business_account`, `subscribed_fields`) and the Send API responses.

### Original design

**What the owner sees:** Channels → **Connect Facebook Page / Instagram**, a Meta login like today's WhatsApp signup. Chats from IG and Messenger arrive in the same Inbox with a 📸 or 💬 icon, and the same AI, Brain, scoring and handoff apply.

**Rules**
- **Official Meta messaging APIs only, through the same Meta app.** Webhooks reuse `/api/webhooks/meta`, which already verifies Meta's signature.
- **Each new adapter passes `tests/adapter-contract.test.ts`** like every other transport.
- **Messaging windows:** the AI only replies inside the platform's standard window (24 hours after the customer's last message). After that, only a **human** may reply, using Meta's human-agent allowance (currently 7 days). The 24-hour window logic already used for WhatsApp is reused.
- **Ownership:** the business must own its Facebook Page and Instagram account. This uses the same ownership record and /admin check as WhatsApp.

**Data model:**
- New channel kinds `instagram` and `messenger`, and providers `meta_instagram` and `meta_messenger`.
- `channel_connections.page_id` and `ig_account_id`, each unique while active.
- Contacts already work: their `external_id` is the platform's user id.

**Before building:**
- Meta App Review for the Page and Instagram messaging permissions.
- Confirm Meta's current Instagram login option, which has changed recently.
- Confirm the human-agent rules at build time.

**Done when:** a real IG DM and a real Messenger message get AI replies in the sandbox; the contract tests pass; and the window rules are tested.

## R5 · Comment-to-chat: BUILT

The code:
- migration `…0013_comment_to_chat.sql` (`business_brains.comment_to_chat`, `social_comments`, RLS, PDPA delete trigger);
- the pure rules in `src/lib/comments/rules.ts` (keyword match, decision, opening message) and the webhook parser in `…/parse.ts`;
- the handler in `…/handler.ts`, called from `/api/webhooks/meta` (after the 200) for `page` `feed` and `instagram` `comments` changes;
- Brain → **Komen → Chat**; the Page subscription now includes `feed`.

It's tested in `tests/comments.test.ts`, the RLS suite and `npm run test:r5` (35 end-to-end checks against a fake Graph API).

**Decisions:**
- **Claim first, then send.** Each comment is inserted into `social_comments` (unique per connection + comment) before anything is sent, so a Meta retry or a duplicate delivery can never cause a second private reply.
- **Order of checks:** off → own comment → no keyword → older than 7 days → opted out → already messaged this person in 24h → plan limit. Every comment gets a recorded decision.
- **Keywords match whole words** after lower-casing and removing accents and punctuation ("harga?" matches *harga*; "hargai" does not).
- **The private reply does not open Meta's 24h window.** The chat is created with the person's comment and our reply, but `last_inbound_at` stays empty, so neither the AI nor staff can send more until the person writes back.
- **The private reply always goes through the Page** (`POST /{page_id}/messages` with `recipient.comment_id`), for Facebook and Instagram. The public reply uses `/{comment_id}/comments` (Facebook) or `/{comment_id}/replies` (Instagram), best effort.
- **PDPA:** the comment log is in the export; deleting the chat deletes its comment record, and deleting a Messenger/Instagram contact deletes the comments logged from that account id.

**Before going live:**
- Meta App Review for `pages_read_engagement`, `pages_manage_engagement` and `instagram_manage_comments`, and the webhook fields `feed` (Page) and `comments` (Instagram).
- Test with a real Page. The automated tests use a fake Graph API, so re-check: the private-reply response (`recipient_id`), whether Instagram comment webhooks arrive for every comment, and the `from` fields.
- Comment webhooks don't carry the Instagram comment time, so Instagram comments are treated as new when they arrive.

### Original design

**What the owner sees:** Brain → **Comments → Chat**:
- switch it on;
- enter keywords (e.g. *harga, info, PM, berapa*);
- optionally write an opening message and a short public reply such as "Dah DM ya! 😊".

When someone comments a keyword on the business's IG or Facebook post, they get **one private message**, which starts a normal AI chat.

**Rules**
- **One private reply per comment** (Meta's rule, and the database guarantees one record per comment). It's only sent within Meta's allowed time after the comment.
- **At most one per person per day,** so commenting many times doesn't trigger many DMs. It's never sent to someone who wrote STOP.
- **Only the business's own posts.** Only public comments the person chose to write; no scraping, and no following people around.
- **Counts like any other conversation** under the monthly plan limit.

**Data model:** `business_brains.comment_to_chat` (off by default) and `social_comments` (every comment seen, what we decided, and the private reply sent).

**Done when:** a keyword comment produces exactly one DM and an AI chat; repeat comments and opted-out people are skipped; everything is visible in the Inbox.

---

## What's deliberately not on the roadmap

- **Drag-and-drop flows, journeys, multi-step sequences:** against rule 1.
- **Buying, scraping or importing contact lists for messaging:** against rule 2.
- **Unofficial WhatsApp, Instagram or Facebook automation:** against rule 3.
- **Per-contact or per-seat pricing:** against rule 6.

## Still waiting on

- **Murpati's API documentation.** The Murpati connection stays a stub until then ([`docs/MURPATI_INTEGRATION.md`](docs/MURPATI_INTEGRATION.md)). None of the roadmap items depend on it.
