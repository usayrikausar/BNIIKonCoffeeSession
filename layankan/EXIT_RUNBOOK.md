# EXIT RUNBOOK — move a tenant from Murpati to the direct Meta WhatsApp Cloud API

**Status:** Phase 2. Both adapters (`murpati`, `meta_cloud`) are live, and this
exact switch was exercised end to end (Murpati → Meta: same conversation, full
history, next reply sent via Meta). Every step uses only data in our own database.

**Principle:** Murpati is a pipe. Our database already holds every message,
score, brain and contact, so leaving Murpati means re-pointing the pipe, not
moving data. Nothing is ever read back from Murpati.

---

## 0. Before you start (one-time per tenant)

| Check | How | Must be |
|---|---|---|
| Meta Business owner | `select meta_business_owner, waba_owner, owner_legal_name from channel_connections where tenant_id = '<T>' and channel = 'whatsapp' and is_active;` | `client` for both. If `layankan`/`reseller`/`unknown`, STOP: the client must first own (or be granted admin on) the Meta Business + WABA. |
| Client has admin access to Business Manager | Ask the client to log in at business.facebook.com and confirm they see the WABA and phone number | Yes |
| Number display name approved | WhatsApp Manager → Phone numbers | Approved |
| Message templates | WhatsApp Manager → Message templates | Templates live in the client's WABA (they move with it) |
| Our Meta app ready | Phase 2 setup: `META_APP_ID`, `META_APP_SECRET`, `META_WEBHOOK_VERIFY_TOKEN` set in Vercel; webhook URL verified | Yes |

Pick a low-traffic window (e.g. 11pm–1am MYT). Tell the client that during the
switch (≈5–15 minutes) messages may arrive a few minutes late, but none are lost.

## 1. Snapshot the data (proof nothing is lost)

Run in the Supabase SQL editor and save the output:

```sql
select
  (select count(*) from contacts      where tenant_id = '<T>' and channel = 'whatsapp') as contacts,
  (select count(*) from conversations where tenant_id = '<T>' and channel = 'whatsapp') as conversations,
  (select count(*) from messages      where tenant_id = '<T>' and channel = 'whatsapp') as messages,
  (select count(*) from messages      where tenant_id = '<T>' and channel = 'whatsapp' and status = 'queued') as queued,
  (select count(*) from ai_assessments where tenant_id = '<T>') as assessments,
  (select max(created_at) from messages where tenant_id = '<T>' and channel = 'whatsapp') as last_message_at;
```

Also export the tenant (Dashboard → Settings → Export all data) and keep the JSON.

`queued` should be 0. If not, wait a few minutes and re-run; investigate any
message stuck in `queued` for more than 5 minutes before continuing.

## 2. Connect the number to our Meta app (Embedded Signup)

1. The **client** (owner role) opens Dashboard → Channels → WhatsApp → **Facebook · WhatsApp** (Connect directly with Meta).
2. Embedded Signup asks them to log in to Facebook and pick **their existing**
   Business + WABA + phone number (not create new ones).
3. On success the app creates a **new standby** (inactive) `channel_connections` row
   with `provider = 'meta_cloud'`, the `phone_number_id` / `waba_id`, the WABA
   owner read from Meta (`owner_business_info`), and stores the access token in
   `channel_credentials` (encrypted). It shows as **Standby** on the Channels page.

Verify:

```sql
select id, provider, is_active, status, phone_number_id, waba_id, waba_owner
from channel_connections where tenant_id = '<T>' and channel = 'whatsapp' order by created_at;
```

You should see the old `murpati` row (`is_active = true`) and the new
`meta_cloud` row (`is_active = false`, same `phone_number_id`).

## 3. Move the number's webhook

A WhatsApp number can only deliver webhooks to one app at a time.

1. In Murpati: disconnect / release the number from Murpati (their dashboard or
   support). Note the exact time.
2. In Meta: confirm the WABA is subscribed to **our** app
   (`POST /{waba_id}/subscribed_apps` is done automatically by Embedded Signup;
   WhatsApp Manager → Settings → shows our app).
3. Register the number on Cloud API if Meta asks (`POST /{phone_number_id}/register` with the 2-step PIN — the client may need to provide the PIN).

## 4. Flip the active adapter (no code change, no deploy)

**Dashboard:** Channels → on the Meta connection press **Make active**. This calls
`switch_active_connection()`, which does everything below in one transaction.

**Or SQL** (operator, same effect):

```sql
select switch_active_connection('<T>', '<NEW_META_CLOUD_CONNECTION_ID>');
```

What it does, for reference:

```sql
begin;
update channel_connections set is_active = false, status = 'disconnected'
  where tenant_id = '<T>' and channel = 'whatsapp' and provider = 'murpati' and is_active;
update channel_connections set is_active = true, status = 'connected'
  where tenant_id = '<T>' and id = '<NEW_META_CLOUD_CONNECTION_ID>';
-- Point open conversations at the new connection so replies go out via Meta.
update conversations set channel_connection_id = '<NEW_META_CLOUD_CONNECTION_ID>'
  where tenant_id = '<T>' and channel = 'whatsapp';
commit;
```

The unique index `channel_connections_one_active` guarantees exactly one active
WhatsApp connection per tenant; the transaction keeps the switch atomic.

## 5. Smoke test (5 minutes)

1. From a personal phone, WhatsApp the business number: "test pindah".
2. Check the message is in our DB with `provider = 'meta_cloud'`:
   ```sql
   select provider, direction, status, body, created_at from messages
   where tenant_id = '<T>' and channel = 'whatsapp' order by created_at desc limit 5;
   ```
3. The AI reply should appear with `status` moving `queued → sent → delivered → read`
   (`message_status_events`).
4. Owner: Dashboard → Inbox → the test conversation → Take over → reply manually → arrives on the phone.
5. Message a conversation that is **older than 24h** from the dashboard: it must
   use an approved template (free text is blocked outside the window by design).

## 6. Data checks after the switch

Re-run the snapshot query from step 1. Expected:

* `contacts`, `conversations`, `assessments` ≥ the snapshot (never lower).
* `messages` = snapshot + the smoke-test messages.
* No message rows changed provider retroactively (history keeps `provider = 'murpati'`; that is correct and auditable).
* No `failed` outbound messages since the switch:
  ```sql
  select count(*) from messages where tenant_id = '<T>' and direction = 'outbound'
    and status = 'failed' and created_at > '<SWITCH_TIME>';
  ```

## 7. Clean up

1. Channels → old Murpati connection → **Disconnect** (revokes its encrypted credentials, keeps the row for audit). Or SQL:
   ```sql
   update channel_credentials set is_current = false, revoked_at = now()
   where tenant_id = '<T>' and connection_id = '<OLD_MURPATI_CONNECTION_ID>';
   ```
2. Ask Murpati to delete their copy of the tenant's message history (they are a
   transport only; we never relied on it). Keep their written confirmation.
3. Cancel the tenant's Murpati subscription.
4. Record the migration date and operator in the client's file.

## Rollback (if step 5 fails)

Run step 4 in reverse (re-activate the `murpati` row, deactivate `meta_cloud`,
re-point conversations) and re-attach the number in Murpati. Because both
adapters write to the same tables, no data needs to be merged afterwards.

## Credential rotation (any time, zero downtime)

* **Channel token** (e.g. new Meta system-user token): store via the app
  (`putCredential`) — it inserts the new encrypted value, retires the old one,
  and rolls back automatically if the insert fails.
* **Encryption key**: append a new key to `ENCRYPTION_KEYS`, set
  `ENCRYPTION_KEY_CURRENT` to it, redeploy, re-encrypt existing rows (`reseal`),
  then remove the old key and redeploy. Old ciphertexts stay readable until the
  last step.
