# Layankan

An AI agent that answers a business's customer enquiries 24/7 in Bahasa Malaysia and
English. It filters out empty "Hi, harga?" enquiries, scores every lead
**PANAS / SUAM / SEJUK** and hands only serious buyers to the owner, who also gets a
daily summary.

One system for many businesses: each business signs up, fills in its **Business
Brain**, tests the agent and goes live with a chat link, a QR code and a website widget.

> **Status: Phase 1 (MVP).** Web chat, dashboard, lead scoring, handoff, email
> alerts and daily summary are done. WhatsApp is Phase 2, billing is Phase 3.

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
4. Do the same with `supabase/migrations/20261004000002_storage.sql`.
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

### 7. Turn on the daily summary (hourly job)

The daily summary is sent at each business's chosen hour, in its own timezone. Something must call the app once an hour. The free way is Supabase's built-in scheduler. In **SQL Editor**, run (replace the two `YOUR-…` values):

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
select cron.schedule(
  'layankan-daily-summary',
  '5 * * * *',   -- every hour at :05
  $$ select net.http_get(
       url := 'https://YOUR-APP.vercel.app/api/cron/daily-summary',
       headers := jsonb_build_object('Authorization', 'Bearer YOUR-CRON-SECRET')
     ); $$
);
```

(Paid Vercel Pro alternative: add a `vercel.json` with `{"crons":[{"path":"/api/cron/daily-summary","schedule":"5 * * * *"}]}`. Vercel then sends the secret automatically.)

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

## How a business uses it

1. **Sign up** → **create workspace** (name, link like `/c/klinik-ana`, industry).
2. **Business Brain**: profile, products/prices, FAQ, policies, 2–4 qualifying questions (pre-filled for the industry), handoff rules. You can also import from a PDF, a website URL or pasted text: the AI extracts a draft, the owner reviews it, merges it, then presses Save.
3. **Test Agent**: chat as a customer and see the score and handoff decisions live. Test chats never appear in the inbox.
4. **Channels → Go Live**: chat link, QR code (PNG download), and a one-line website widget:
   ```html
   <script src="https://YOUR-APP/widget.js" data-layankan="klinik-ana" async></script>
   ```
   Optional: `data-color="#e11d48"`, `data-position="left"`.
5. **Inbox**: conversations sorted by score (PANAS first). "Needs you" means the AI paused and emailed the owner. **Take over** to reply yourself; **Hand back to AI** when done.
6. **Leads**: filter by score and date, **Export CSV**.
7. **Settings**: invite staff, notification preferences, timezone and summary hour, **export all data** or **delete the workspace** (PDPA).

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
