# Layankan

An AI agent that answers a business's customer enquiries 24/7 in Bahasa Malaysia and
English. It filters out empty "Hi, harga?" enquiries, scores every lead
**PANAS / SUAM / SEJUK** and hands only serious buyers to the owner, who also gets a
daily summary.

One system for many businesses: each business signs up, fills in its **Business
Brain**, tests the agent and goes live with a chat link, a QR code and a website widget.

> **Status: Phases 1–3 built.** Web chat, dashboard, lead scoring, handoff, email alerts and
> daily summary (Phase 1), plus WhatsApp via the official API (direct Meta or
> Murpati), WhatsApp owner alerts/summaries and SUAM follow-ups (Phase 2).
> Phase 3 adds subscription billing (FPX via Billplz or ToyyibPay, or manual
> bank transfer), usage metering with plan limits, analytics and an admin console.

## Screenshots

Captured from the running app with a demo clinic (AI replies came from a local stand-in, not Claude):
[landing + widget](docs/screenshots/02-landing-widget-open.png) ·
[public chat (mobile)](docs/screenshots/03-public-chat-mobile.png) ·
[inbox](docs/screenshots/04-inbox.png) ·
[conversation & handoff](docs/screenshots/05-conversation-handoff.png) ·
[leads](docs/screenshots/06-leads.png) ·
[Business Brain](docs/screenshots/07-business-brain.png) ·
[test agent](docs/screenshots/08-test-agent.png) ·
[channels & WhatsApp](docs/screenshots/09-channels.png) ·
[analytics](docs/screenshots/10-analytics.png) ·
[billing](docs/screenshots/11-billing.png) ·
[settings](docs/screenshots/12-settings.png) ·
[admin](docs/screenshots/13-admin.png) ·
[English UI](docs/screenshots/14-dashboard-english.png) ·
[inbox with assignment](docs/screenshots/15-inbox-assignment.png) ·
[chat held by a colleague](docs/screenshots/16-chat-held-by-colleague.png) ·
[owner reassign](docs/screenshots/17-owner-assign.png)

![Inbox](docs/screenshots/04-inbox.png)

---

## What you need (accounts)

| Service | What for | Cost to start |
|---|---|---|
| [Supabase](https://supabase.com) | Database, logins, file storage | Free tier OK |
| [Anthropic Console](https://console.anthropic.com) | The AI (Claude) | Pay as you go: add a card and some credit |
| [Resend](https://resend.com) | Sending emails (alerts, daily summary) | Free tier OK |
| [Vercel](https://vercel.com) | Hosting the website/app | Free (Hobby) OK |
| [GitHub](https://github.com) | Where the code lives (you already have this) | Free |
| Google Cloud (optional) | "Continue with Google" login button | Free |
| A domain (optional) | e.g. `layankan.com` for the app and email sender | ~RM50/year |

---

## Setup: step by step (about 45 minutes)

### 1. Create the database (Supabase)

1. Go to supabase.com → **New project**. Pick region **Southeast Asia (Singapore)**, set a strong database password and save it somewhere safe.
2. When it's ready, open **SQL Editor** → **New query**.
3. Open `supabase/migrations/20261004000001_init.sql` from this folder, copy **everything**, paste it in, press **Run**. You should see "Success".
4. Do the same with `supabase/migrations/20261004000002_storage.sql`, then `20261004000003_whatsapp.sql`, `20261004000004_billing_analytics.sql` and `20261004000005_assignment.sql` (always in number order).
5. Do the same with `supabase/seed.sql`. This creates tenant #1, **Layankan itself**, which is the live demo on your landing page.
6. Go to **Project Settings → API** and copy these three values for later:
   - Project URL → `NEXT_PUBLIC_SUPABASE_URL`
   - `anon` / publishable key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
   - `service_role` / secret key → `SUPABASE_SERVICE_ROLE_KEY` (**keep this secret, never share it**)

### 2. Get the AI key (Anthropic)

1. console.anthropic.com → **API Keys** → **Create Key** → copy it → `ANTHROPIC_API_KEY`.
2. **Billing** → add credit (RM50–100 is plenty to start).

### 3. Get the email key (Resend)

1. resend.com → **API Keys** → create → `RESEND_API_KEY`.
2. To send from your own address (e.g. `noti@layankan.com`), add your domain under **Domains** and follow the DNS steps. Until then, keep `EMAIL_FROM` as `Layankan <onboarding@resend.dev>`. This sender can only email the address you signed up to Resend with, so it's fine for testing only.

### 4. Make two secrets

You need two random values. On a Mac/Linux terminal:

```bash
openssl rand -hex 32       # → CRON_SECRET
openssl rand -base64 32    # → use as   ENCRYPTION_KEYS=k1:<paste here>
```

(No terminal? Any password generator that makes a long random string works for `CRON_SECRET`. For the encryption key you need exactly 32 random bytes in base64, so ask a developer once, or use the terminal command.)

### 5. Deploy the app (Vercel)

1. vercel.com → **Add New → Project** → import this GitHub repository.
2. **Root Directory**: choose `layankan` (important: the repo also contains an older app).
3. Under **Environment Variables**, add every variable from `.env.example` with your values:
   `NEXT_PUBLIC_APP_URL` (your Vercel URL, e.g. `https://layankan.vercel.app`, no trailing `/`),
   the three Supabase values, `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL`, `RESEND_API_KEY`,
   `EMAIL_FROM`, `CRON_SECRET`, `ENCRYPTION_KEYS`, `ENCRYPTION_KEY_CURRENT=k1`.
4. Press **Deploy**. When it finishes, open the URL and you should see the landing page.
5. Once you know the final URL, update `NEXT_PUBLIC_APP_URL` if needed and redeploy.

### 6. Tell Supabase where your app lives

Supabase → **Authentication → URL Configuration**:
- **Site URL**: your app URL (e.g. `https://layankan.vercel.app`)
- **Redirect URLs**: add `https://layankan.vercel.app/auth/callback`

(Optional) **Google login**: Supabase → Authentication → Providers → Google → follow the guide to create a Google OAuth client. Without it, email + password login still works.

### 7. Turn on the hourly job (billing, daily summaries, follow-ups)

Every hour the app issues renewal invoices and updates subscription status, sends each business's daily summary at its chosen hour (in its own timezone), and sends SUAM follow-ups between 9am and 9pm. Something must call the app once an hour. The free way is Supabase's built-in scheduler. In **SQL Editor**, run (replace the two `YOUR-…` values):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule(
  'layankan-hourly',
  '5 * * * *',   -- every hour at :05
  $$ select net.http_get(
       url := 'https://YOUR-APP.vercel.app/api/cron/hourly',
       headers := jsonb_build_object('Authorization', 'Bearer YOUR-CRON-SECRET')
     ); $$
);
```

If you set this up in Phase 1 with `/api/cron/daily-summary`, switch it over: `select cron.unschedule('layankan-daily-summary');` then run the block above.

(Paid Vercel Pro alternative: add a `vercel.json` with `{"crons":[{"path":"/api/cron/hourly","schedule":"5 * * * *"}]}`. Vercel then sends the secret automatically.)

### 8. Claim the Layankan demo workspace

1. Open your app → **Daftar** (sign up) with your founder email.
2. In Supabase **SQL Editor**, run (with your email):
   ```sql
   insert into tenant_members (tenant_id, user_id, role, email)
   select '00000000-0000-4000-8000-000000000001', id, 'owner', email
   from auth.users where email = 'YOU@EXAMPLE.COM';
   ```
3. Refresh the dashboard. You now manage the Layankan demo: edit its Brain, see prospects' chats from the landing page and get their alerts.

You're live. 🎉

---

## WhatsApp setup (Phase 2)

Layankan only uses the **official WhatsApp Business Platform**. Every business
connects its **own** number, which stays in its **own** Meta Business account.
There are two transports, and each workspace picks one on the Channels page.
Switching later is a button, not a code change.

| | Direct Meta Cloud API (recommended) | Murpati (official API numbers only) |
|---|---|---|
| Who sets it up | You, once (Meta app). Then each business clicks "Facebook · WhatsApp". | Each business has a Murpati account with an **official-API** number. |
| Never allowed | — | Murpati's "regular" QR-scan devices (unofficial). The database refuses them. |
| Data | Every message is stored in our database. | Same. Murpati is only a pipe: we never use its AI, docs or history. |

### A. Create the Meta app (once, about 1 hour, plus Meta's review)

1. **business.facebook.com**: make sure *Layankan* has its own Meta Business account and complete **Business Verification** (needs SSM documents).
2. **developers.facebook.com → My Apps → Create app** → type **Business** → add the **WhatsApp** product.
3. **App settings → Basic**: copy **App ID** → `NEXT_PUBLIC_META_APP_ID`, **App secret** → `META_APP_SECRET`.
4. **WhatsApp → Configuration → Webhook**:
   - Callback URL: `https://YOUR-APP.vercel.app/api/webhooks/meta`
   - Verify token: make up a long random string → also put it in `META_WEBHOOK_VERIFY_TOKEN`
   - Subscribe to the **messages** field.
5. **Facebook Login for Business → Configurations → Create**: choose *WhatsApp Embedded Signup*, with permissions `whatsapp_business_management` and `whatsapp_business_messaging`. Copy the **Configuration ID** → `NEXT_PUBLIC_META_EMBEDDED_SIGNUP_CONFIG_ID`.
6. Add your app domain under **App settings → Basic → App domains**, and the Vercel URL under Facebook Login's **Allowed domains for the JavaScript SDK**.
7. Request **Advanced access** for the two WhatsApp permissions (App Review) and become a **Tech Provider** in the WhatsApp settings. Until approved, only your own test business can connect.
8. Put `META_PLATFORM_BUSINESS_ID` = your own Meta Business ID (Business settings → Business info). Then redeploy.

### B. Connect Layankan's own number (for owner alerts)

Owner alerts and daily summaries are WhatsApped **from Layankan's number** to each owner's number (the "Owner WhatsApp" field in their Business Brain).

1. Log in as the Layankan workspace owner → **Channels → Facebook · WhatsApp** → connect Layankan's number.
2. In **WhatsApp Manager → Message templates**, create these two templates (category **Utility**, language **Malay `ms`**) and wait for approval:

   **`layankan_handoff_alert`**
   > 🔔 {{1}}: pelanggan perlukan anda. Sebab: {{2}}. Mesej pelanggan: "{{3}}". Buka perbualan: {{4}} — Layankan

   **`layankan_daily_summary`**
   > 📊 Ringkasan harian {{1}}: 🔥 {{2}} PANAS, 🌤 {{3}} SUAM, ❄️ {{4}} SEJUK. Lihat semua prospek: {{5}} — Layankan

   (Other names or language? Set `WA_TEMPLATE_HANDOFF`, `WA_TEMPLATE_DAILY_SUMMARY`, `WA_TEMPLATE_LANGUAGE`.)

### C. Each business connects (self-serve, about 3 minutes)

**Direct Meta:** Channels → **Facebook · WhatsApp** → log in → pick (or create) *their own* Meta Business, WhatsApp Business Account and number → done. Layankan records who owns the account, subscribes to webhooks, registers the number and syncs their approved templates.

**Murpati:** in Murpati, the number must be on the **official API** (not a regular device). On Channels → Murpati, enter the number, the Murpati device ID, the API key and the webhook secret, then tick the official-API box. Copy the **webhook URL** shown and paste it into Murpati's webhook settings.

> ⚠️ The Murpati adapter was written without access to Murpati's API reference (their docs site was unreachable from the build environment). Webhook events (`message.received`, `message.sent`) and the `X-Murpati-Signature` HMAC header match their public docs. The **send endpoint and the exact field names** are best guesses, kept in `src/lib/channels/whatsapp/murpati*.ts` and `verifyMurpatiSignature`. Test with one number before onboarding clients, and send us Murpati's API reference so we can lock it down.

### D. Follow-ups for SUAM leads

Business Brain → **SUAM lead follow-ups**: turn on, choose the delay (default 24h) and the number of attempts. Because a follow-up usually lands more than 24h after the customer's last message, WhatsApp requires an **approved template**. Create one in WhatsApp Manager, e.g. `susulan_suam`:

> Hai {{1}}, terima kasih kerana bertanya tentang {{2}}. Ada apa-apa lagi yang boleh kami bantu? Balas STOP jika tidak mahu menerima mesej lagi.

Then (Meta) press **Sync from Meta** on Channels, or (Murpati) add it by name. Pick it in the Brain and map {{1}} to the customer name and {{2}} to their need. Follow-ups only go out 9am–9pm local time and never to anyone who replied STOP / BERHENTI.

### E. Moving a client between Murpati and Meta

See [`EXIT_RUNBOOK.md`](EXIT_RUNBOOK.md). In short: connect the other transport (it waits as **Standby**), move the number's webhook, press **Make active**. History stays in one conversation.

---

## Billing setup (Phase 3)

**How it works:** every new workspace starts a **14-day free trial** (150 AI replies). Plans are in the `plans` table (Supabase → Table editor). Edit names, prices (in sen: `24900` = RM249) and limits there, with no code change. The starting catalogue is a placeholder:

| Plan | Price | AI replies / month | WhatsApp numbers | Staff logins |
|---|---|---|---|---|
| Asas | RM99 | 500 | 1 | 2 |
| Niaga | RM249 | 2,000 | 1 | 5 |
| Pro | RM499 | 6,000 | 3 | 15 |
| Founding Offer (3 slots, hidden when full) | RM300 + RM500 setup | 3,000 | 2 | 5 |

* The owner picks a plan on **Langganan / Billing** and is sent to the payment page (FPX online banking or card). When the payment is confirmed, the plan is active for one month.
* Seven days before the month ends, the hourly job emails a **renewal invoice** with a payment link. If it isn't paid, the AI keeps working for a **7-day grace period**, then pauses.
* **Limits:** at 80% the dashboard warns. At the limit (+5% buffer so nobody is cut off mid-chat) the AI **pauses**: customers get a polite "our team will reply" message, the chat is marked *Needs you*, and the owner gets one email. **No message is ever lost.** Upgrading or paying resumes the AI immediately.
* Changing plan starts a fresh month right away (no proration).

**Choose a gateway** (set `BILLING_GATEWAY`, plus that gateway's keys from `.env.example`):

1. **Billplz** (recommended): sign up at billplz.com (sandbox: billplz-sandbox.com). Create a **Collection**, then copy the API key, Collection ID and **X Signature Key**, and turn X Signature on in settings. Callbacks are verified with that signature.
2. **ToyyibPay**: create a **Category**, then copy the User Secret Key and Category Code. ToyyibPay callbacks aren't signed, so Layankan double-checks every payment with ToyyibPay's API before activating anything.
3. **manual**: no gateway. The Billing page shows `BILLING_BANK_DETAILS`. When a client transfers, open **/admin** and press **Mark paid**.

Test with the sandbox first: pick a plan, pay with the sandbox bank, and check the invoice shows ✓ and the plan is active.

**Admin console (`/admin`):** put your email in `PLATFORM_ADMIN_EMAILS`. You'll see all workspaces, their plan, usage and MRR. You can **mark bank transfers paid**, **grant a plan** (e.g. a Founding client who paid you directly; it creates a manual invoice for the record) and **extend a trial**.

**Analytics** (dashboard → Analitik): leads per day by score, conversion rate by score, first-response time, your response time after a handoff, empty enquiries filtered, and usage. To measure conversion, open a conversation and press **Jadi pelanggan (Won)** or **Tak jadi (Lost)**, optionally with the sale value. CSV export includes these too.

> Stripe: the gateway interface (`src/lib/billing/gateway.ts`) is ready for a Stripe adapter if you ever need cards/subscriptions outside Malaysia. It isn't built yet.

---

## How a business uses it

1. **Sign up** → **create workspace** (name, link like `/c/klinik-ana`, industry).
2. **Business Brain**: profile, products/prices, FAQ, policies, 2–4 qualifying questions (pre-filled for the industry), handoff rules. You can also import from a PDF, a website URL or pasted text: the AI extracts a draft, the owner reviews it, merges it, then presses Save.
3. **Test Agent**: chat as a customer and see the score and handoff decisions live. Test chats never appear in the inbox.
4. **Channels → Go Live**: chat link, QR code (PNG download), WhatsApp connection (plus its wa.me link and QR once connected), and a one-line website widget:
   ```html
   <script src="https://YOUR-APP/widget.js" data-layankan="klinik-ana" async></script>
   ```
   Optional: `data-color="#e11d48"`, `data-position="left"`.
5. **Inbox**: conversations sorted by score (PANAS first; 🟢 = WhatsApp, 💬 = web). "Needs you" means the AI paused and alerted the owner by email and WhatsApp. **Take over** to reply yourself; **Hand back to AI** when done. If a WhatsApp customer hasn't written in 24h, you can only send an approved template (the screen offers one).
6. **Leads**: filter by score and date, **Export CSV**.
7. **Team (shared inbox):** every staff login sees all chats. Pressing **Ambil alih** (or replying) assigns the chat to you, and everyone sees "👤 Dilayan oleh Aisyah". A colleague who tries to reply gets asked "Ambil alih daripada Aisyah?", so two people never answer the same customer by accident. **Chat saya** shows your chats. The owner can reassign any chat. **Serah balik kepada AI** releases it. Handoff alerts go to everyone; whoever takes it first owns it. Each person sets their display name in Tetapan.
8. **Analitik**: leads by score per day, conversion, response times.
9. **Langganan**: plan, usage meter, invoices, pay or upgrade.
10. **Settings**: invite staff, notification preferences, timezone and summary hour, **export all data** or **delete the workspace** (PDPA).

## Day-to-day operations

| Task | Where |
|---|---|
| Change the AI model | Vercel env `ANTHROPIC_MODEL` → redeploy. No code change. |
| Faster/cheaper vs. smarter replies | `ANTHROPIC_EFFORT` = `low` (default) / `medium` / `high` |
| See why the AI scored a lead | Supabase → table `ai_assessments` (every turn is logged with model, prompt version and brain version) |
| A customer asks to delete their data | Inbox → open conversation → **Delete customer data (PDPA)** |
| Abuse / spam on the chat | Built-in limits: 12 msgs/min per visitor IP, 600/hour per business (env `RATE_LIMIT_*`) |
| Running cost | Each customer message is one Claude call. Watch usage in the Anthropic Console. |

---

## Quality & security checks

The latest audit is in [`AUDIT_REPORT.md`](AUDIT_REPORT.md): what's done, what's partial, and what's broken, with critical issues first. In plain words, these checks prove that one business can never see or change another business's data, and that customers can't trick the AI:

| Check | Command | What it proves |
|---|---|---|
| Database isolation | `npm run test:rls` | Every table only shows a business its own rows |
| Isolation probes | `npm run test:probe` | Lists *every* cross-business attack and whether it's blocked (PASS/FAIL) |
| Full-app isolation | `npm run e2e:up` then `npm run test:e2e` | Business A attacks every page, API, export and webhook with business B's ids |
| AI manipulation | `npm test` (includes BM/English attack tests) | Customer messages can't rewrite the AI's instructions |
| Live AI check (costs a few sen) | `ANTHROPIC_API_KEY=… npx vitest run tests/injection.live.test.ts` | The real model refuses to leak its instructions or invent prices |

## For developers

```bash
cd layankan
cp .env.example .env.local     # fill in values
npm install
npm run dev                    # http://localhost:3000
npm test                       # unit tests: agent schema, handoff, prompt/injection, crypto, webhooks…
npm run test:rls               # tenant-isolation tests on a throwaway local Postgres (needs PostgreSQL 15+ binaries, no Docker)
npm run lint                   # TypeScript
npm run build
```

* Architecture, data model and folder structure: [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)
* Moving a tenant's WhatsApp from Murpati to the direct Meta API: [`EXIT_RUNBOOK.md`](EXIT_RUNBOOK.md)
* The agent prompt is in `src/lib/agent/prompt.ts`. Bump `PROMPT_TEMPLATE_VERSION` whenever you change it.
* Schema changes: add a new file in `supabase/migrations/` (never edit an applied one) and add RLS policies + a test in `supabase/tests/rls_test.sql` for any new tenant table.
