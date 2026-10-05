-- R4 (ROADMAP.md): Instagram + Messenger, part 2 of 2 (run after ...0011).
-- Official Meta messaging APIs only, through the same Meta app as WhatsApp.
-- A business connects its OWN Facebook Page (Messenger) and the Instagram
-- professional account linked to it. Our database stays the system of record.

alter table public.channel_connections
  add column page_id text,         -- Facebook Page id (Messenger routing key; also used to send Instagram messages)
  add column ig_account_id text,   -- Instagram professional account id (Instagram routing key)
  add column display_name text;    -- Page name / @instagram username, for the dashboard

-- One live Page / Instagram account per business at a time (webhook routing).
create unique index channel_connections_active_page
  on public.channel_connections(page_id) where is_active and page_id is not null and provider = 'meta_messenger';
create unique index channel_connections_active_ig
  on public.channel_connections(ig_account_id) where is_active and ig_account_id is not null and provider = 'meta_instagram';

-- Webhook routing lookups.
create index channel_connections_page_idx on public.channel_connections(provider, page_id);
create index channel_connections_ig_idx on public.channel_connections(provider, ig_account_id);
