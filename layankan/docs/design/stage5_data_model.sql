-- ╔════════════════════════════════════════════════════════════════════════╗
-- ║  DRAFT DATA MODEL — STAGE 5 DESIGN. NOT A MIGRATION. NOT APPLIED.      ║
-- ║                                                                        ║
-- ║  This file lives outside supabase/migrations/ on purpose: nothing here ║
-- ║  reaches a real database. It is applied ONLY to a throwaway Postgres   ║
-- ║  by `npm run test:design`, on top of the real migrations, to prove the ║
-- ║  design is coherent and that its safety rules hold                     ║
-- ║  (docs/design/stage5_design_check.sql).                                ║
-- ║                                                                        ║
-- ║  When a roadmap item is built, copy ITS section into a new numbered    ║
-- ║  migration, together with its app code and tests. See ROADMAP.md.      ║
-- ╚════════════════════════════════════════════════════════════════════════╝
--
-- Conventions kept from the existing schema:
--   • every tenant table has tenant_id + RLS, using is_tenant_member / is_tenant_owner;
--   • every reference to another tenant table goes through enforce_same_tenant();
--   • server-only tables have RLS with no member write policies;
--   • a junction table never puts tenant_id in its primary key (keeps REST embeds unambiguous);
--   • secrets go encrypted (AES-256-GCM, key id, AAD), never in plain columns.


-- ═════════════════════════════════════════════════════════════════════════
-- R1 + R6 · OPT-IN RECORDS, UNSUBSCRIBE, BROADCASTS
-- Rule: nobody gets a broadcast without a recorded, current opt-in. Enforced
-- by the DATABASE (trigger below), not only by app code.
-- ═════════════════════════════════════════════════════════════════════════

-- Append-only consent history. The latest event per contact is the current state.
create table public.marketing_consent_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  channel public.channel_kind not null,
  action text not null check (action in ('granted', 'withdrawn')),
  -- How it was captured. There is deliberately NO 'imported' method: lists
  -- bought or copied from elsewhere can never be broadcast to.
  method text not null check (method in (
    'chat_reply',            -- customer answered YES to an explicit question in chat
    'web_checkbox',          -- ticked an unticked box in the web chat
    'stop_keyword',          -- customer wrote STOP / BERHENTI (withdrawal)
    'unsubscribe_button',    -- tapped the unsubscribe quick-reply on a broadcast
    'staff_withdrawal'       -- customer asked a staff member to stop (withdrawal only)
  )),
  consent_text text not null check (char_length(consent_text) between 10 and 1000), -- exact wording shown
  consent_text_version text not null,
  evidence_message_id uuid references public.messages(id) on delete set null,      -- the customer's YES / STOP
  recorded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  -- a grant always comes from the customer's own action; staff can only record withdrawals
  constraint consent_method_matches_action check (
    (action = 'granted' and method in ('chat_reply', 'web_checkbox')) or
    (action = 'withdrawn' and method in ('stop_keyword', 'unsubscribe_button', 'staff_withdrawal')))
);
create index marketing_consent_contact_idx on public.marketing_consent_events(tenant_id, contact_id, id desc);
create trigger consent_same_tenant before insert on public.marketing_consent_events
  for each row execute function public.enforce_same_tenant('contact_id', 'contacts', 'evidence_message_id', 'messages');

-- Current state, one row per contact (RLS of the base table applies).
create view public.marketing_consent_current with (security_invoker = true) as
  select distinct on (contact_id) tenant_id, contact_id, channel, action, method, consent_text_version, id as event_id, created_at
  from public.marketing_consent_events
  order by contact_id, id desc;

-- STOP / BERHENTI already sets contacts.opted_out_at (Phase 2). It now also
-- writes a withdrawal into the consent history, so the record is complete.
create or replace function public.consent_withdraw_on_opt_out()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.opted_out_at is not null and old.opted_out_at is null then
    insert into public.marketing_consent_events (tenant_id, contact_id, channel, action, method, consent_text, consent_text_version)
    values (new.tenant_id, new.id, new.channel, 'withdrawn', 'stop_keyword', 'Customer replied STOP / BERHENTI.', 'system');
  end if;
  return new;
end;
$$;
create trigger contacts_opt_out_withdraws_consent after update of opted_out_at on public.contacts
  for each row execute function public.consent_withdraw_on_opt_out();

create table public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null references public.channel_connections(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 120),
  -- WhatsApp: an APPROVED marketing template, which must carry an opt-out line.
  template_name text not null check (template_name ~ '^[a-z0-9_]+$'),
  template_language text not null default 'ms',
  template_variables jsonb not null default '[]'::jsonb,
  -- Simple audience only (no flow builder): all opted-in, optionally by lead score.
  audience jsonb not null default '{"scores": []}'::jsonb,
  status text not null default 'draft' check (status in ('draft', 'scheduled', 'sending', 'sent', 'cancelled')),
  scheduled_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  recipients_total integer not null default 0,
  created_at timestamptz not null default now()
);
create trigger broadcasts_same_tenant before insert or update on public.broadcasts
  for each row execute function public.enforce_same_tenant('connection_id', 'channel_connections');

create table public.broadcast_recipients (
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  tenant_id uuid not null,  -- no FK on purpose (junction rule); same-tenant trigger below
  consent_event_id bigint not null references public.marketing_consent_events(id),
  status text not null default 'queued' check (status in ('queued', 'sent', 'delivered', 'read', 'failed', 'skipped')),
  message_id uuid references public.messages(id) on delete set null,
  error text,
  primary key (broadcast_id, contact_id)
);
create trigger broadcast_recipients_same_tenant before insert or update on public.broadcast_recipients
  for each row execute function public.enforce_same_tenant('broadcast_id', 'broadcasts', 'contact_id', 'contacts');

-- THE guard: a recipient row can only exist for a contact whose LATEST consent
-- event is a grant (and is the one cited), and who has not opted out.
create or replace function public.require_marketing_consent()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_latest record;
begin
  select id, action into v_latest from public.marketing_consent_events
    where tenant_id = new.tenant_id and contact_id = new.contact_id
    order by id desc limit 1;
  if v_latest.id is null or v_latest.action <> 'granted' or v_latest.id <> new.consent_event_id then
    raise exception 'no current marketing opt-in for this contact' using errcode = 'check_violation';
  end if;
  if exists (select 1 from public.contacts where id = new.contact_id and opted_out_at is not null) then
    raise exception 'contact has opted out' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
create trigger broadcast_recipients_need_consent before insert on public.broadcast_recipients
  for each row execute function public.require_marketing_consent();

-- Flat per-business broadcast allowance (never per contact).
alter table public.plans add column broadcast_message_limit integer not null default 0 check (broadcast_message_limit >= 0);
alter table public.usage_counters add column broadcast_messages integer not null default 0;


-- ═════════════════════════════════════════════════════════════════════════
-- R2 · PAYMENT LINKS (FPX / DuitNow via the BUSINESS'S OWN Billplz or ToyyibPay)
-- Money goes to the business, never through Layankan. Amounts are typed by
-- staff; the AI never invents an amount.
-- ═════════════════════════════════════════════════════════════════════════

create table public.payment_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  gateway text not null check (gateway in ('billplz', 'toyyibpay')),
  is_active boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'connected', 'error', 'disconnected')),
  collection_ref text,               -- Billplz collection id / ToyyibPay category code (not secret)
  sandbox boolean not null default false,
  account_holder_name text,          -- shown to the owner to confirm money goes to THEM
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index payment_accounts_one_active on public.payment_accounts(tenant_id) where is_active;

-- API keys / X-Signature keys: encrypted exactly like channel_credentials
-- (and included in the /admin key rotation when built).
create table public.payment_account_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  account_id uuid not null references public.payment_accounts(id) on delete cascade,
  name text not null,
  key_id text not null,
  ciphertext text not null,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index payment_account_credentials_one_current
  on public.payment_account_credentials(account_id, name) where is_current and revoked_at is null;
create trigger payment_credentials_same_tenant before insert or update on public.payment_account_credentials
  for each row execute function public.enforce_same_tenant('account_id', 'payment_accounts');

create table public.payment_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  account_id uuid not null references public.payment_accounts(id) on delete restrict,
  conversation_id uuid references public.conversations(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,   -- a staff member, always
  amount_cents integer not null check (amount_cents between 100 and 10000000),  -- RM1 – RM100,000
  currency text not null default 'MYR' check (currency = 'MYR'),
  description text not null check (char_length(description) between 1 and 200),
  gateway_bill_id text,
  url text check (url is null or url ~ '^https://'),
  status text not null default 'open' check (status in ('open', 'paid', 'expired', 'cancelled', 'failed')),
  expires_at timestamptz not null default now() + interval '7 days',
  paid_at timestamptz,
  paid_amount_cents integer,
  message_id uuid references public.messages(id) on delete set null,  -- chat message that carried the link
  created_at timestamptz not null default now(),
  unique (account_id, gateway_bill_id)
);
create index payment_links_conversation_idx on public.payment_links(tenant_id, conversation_id);
create trigger payment_links_same_tenant before insert or update on public.payment_links
  for each row execute function public.enforce_same_tenant('account_id', 'payment_accounts', 'conversation_id', 'conversations', 'contact_id', 'contacts', 'message_id', 'messages');

-- Gateway callbacks, verified and idempotent (same pattern as payment_events).
create table public.payment_link_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  link_id uuid references public.payment_links(id) on delete set null,
  gateway text not null,
  event_key text not null unique,
  verified boolean not null,
  paid boolean not null,
  paid_amount_cents integer,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
create trigger payment_link_events_same_tenant before insert on public.payment_link_events
  for each row execute function public.enforce_same_tenant('link_id', 'payment_links');


-- ═════════════════════════════════════════════════════════════════════════
-- R3 · CUSTOMER MEMORY
-- A "customer" groups a person's contacts across channels (web, WhatsApp, IG…).
-- Contacts are linked to a customer only on a VERIFIED identifier (e.g. the
-- WhatsApp number) or by a staff member, never on a phone number typed into a chat.
-- ═════════════════════════════════════════════════════════════════════════

create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);
alter table public.contacts add column customer_id uuid references public.customers(id) on delete set null;
create trigger contacts_customer_same_tenant before insert or update of customer_id on public.contacts
  for each row execute function public.enforce_same_tenant('customer_id', 'customers');

create table public.customer_memories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  kind text not null check (kind in ('preference', 'fact', 'purchase', 'note')),
  content text not null check (char_length(content) between 1 and 300),
  source text not null check (source in ('ai', 'staff')),
  source_message_id uuid references public.messages(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '12 months',  -- retention (PDPA)
  deleted_at timestamptz
);
create index customer_memories_customer_idx on public.customer_memories(tenant_id, customer_id) where deleted_at is null;
create trigger customer_memories_same_tenant before insert or update on public.customer_memories
  for each row execute function public.enforce_same_tenant('customer_id', 'customers', 'source_message_id', 'messages');

-- PDPA: deleting a customer's last contact deletes the customer and its memories.
create or replace function public.delete_orphan_customer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.customer_id is not null and not exists (select 1 from public.contacts where customer_id = old.customer_id) then
    delete from public.customers where id = old.customer_id;
  end if;
  return old;
end;
$$;
create trigger contacts_delete_orphan_customer after delete on public.contacts
  for each row execute function public.delete_orphan_customer();


-- ═════════════════════════════════════════════════════════════════════════
-- R4 · INSTAGRAM + MESSENGER ADAPTERS (official Meta APIs, same app)
-- ═════════════════════════════════════════════════════════════════════════

alter type public.channel_kind add value if not exists 'instagram';
alter type public.channel_kind add value if not exists 'messenger';
alter type public.channel_provider add value if not exists 'meta_instagram';
alter type public.channel_provider add value if not exists 'meta_messenger';

alter table public.channel_connections
  add column page_id text,          -- Facebook Page id (Messenger routing key; also owns the IG account)
  add column ig_account_id text;    -- Instagram professional account id (Instagram routing key)
create unique index channel_connections_active_page
  on public.channel_connections(page_id) where is_active and page_id is not null and provider = 'meta_messenger';
create unique index channel_connections_active_ig
  on public.channel_connections(ig_account_id) where is_active and ig_account_id is not null;


-- ═════════════════════════════════════════════════════════════════════════
-- R5 · COMMENT-TO-CHAT (needs R4)
-- A comment with one of the owner's keywords on the business's IG/FB post
-- gets ONE private reply (Meta's private-replies feature), which opens a
-- normal AI chat. Settings live in the Brain (no flow builder).
-- ═════════════════════════════════════════════════════════════════════════

alter table public.business_brains add column comment_to_chat jsonb not null default
  '{"enabled": false, "keywords": [], "opening_message": "", "public_reply": ""}'::jsonb;

-- Every comment we saw and what we did with it (dedupe + audit + per-person cap).
create table public.social_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null references public.channel_connections(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'facebook')),
  post_id text not null,
  comment_id text not null,
  author_external_id text not null,
  body text not null,
  received_at timestamptz not null default now(),
  matched_keyword text,
  decision text not null default 'pending' check (decision in (
    'pending', 'replied', 'ignored_no_keyword', 'skipped_already_replied_to_author',
    'skipped_opted_out', 'skipped_expired', 'skipped_plan_limit', 'failed')),
  private_reply_message_id uuid references public.messages(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete set null,
  unique (connection_id, comment_id)   -- one decision (and at most one private reply) per comment
);
create index social_comments_author_idx on public.social_comments(tenant_id, author_external_id, received_at desc);
create trigger social_comments_same_tenant before insert or update on public.social_comments
  for each row execute function public.enforce_same_tenant('connection_id', 'channel_connections', 'private_reply_message_id', 'messages', 'conversation_id', 'conversations');


-- ═════════════════════════════════════════════════════════════════════════
-- RLS for every new table
-- ═════════════════════════════════════════════════════════════════════════
alter table public.marketing_consent_events enable row level security;
alter table public.broadcasts enable row level security;
alter table public.broadcast_recipients enable row level security;
alter table public.payment_accounts enable row level security;
alter table public.payment_account_credentials enable row level security;
alter table public.payment_links enable row level security;
alter table public.payment_link_events enable row level security;
alter table public.customers enable row level security;
alter table public.customer_memories enable row level security;
alter table public.social_comments enable row level security;

-- Consent: members read; members may RECORD A WITHDRAWAL only. No update or
-- delete by anyone but the server: history is append-only.
create policy consent_member_select on public.marketing_consent_events for select to authenticated using (public.is_tenant_member(tenant_id));
create policy consent_member_withdraw on public.marketing_consent_events for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and action = 'withdrawn' and method = 'staff_withdrawal' and recorded_by = auth.uid());
revoke update, delete on public.marketing_consent_events from authenticated;

-- Broadcasts: owners create/edit; recipients and sending are server-only.
create policy broadcasts_member_select on public.broadcasts for select to authenticated using (public.is_tenant_member(tenant_id));
create policy broadcasts_owner_write on public.broadcasts for all to authenticated
  using (public.is_tenant_owner(tenant_id)) with check (public.is_tenant_owner(tenant_id));
create policy broadcast_recipients_member_select on public.broadcast_recipients for select to authenticated using (public.is_tenant_member(tenant_id));
revoke insert, update, delete on public.broadcast_recipients from authenticated;

-- Payments: owners manage the account; credentials invisible; members create
-- links as themselves; status changes only via verified gateway callbacks (server).
create policy payment_accounts_member_select on public.payment_accounts for select to authenticated using (public.is_tenant_member(tenant_id));
create policy payment_accounts_owner_write on public.payment_accounts for all to authenticated
  using (public.is_tenant_owner(tenant_id)) with check (public.is_tenant_owner(tenant_id));
revoke all on public.payment_account_credentials from authenticated;
create policy payment_links_member_select on public.payment_links for select to authenticated using (public.is_tenant_member(tenant_id));
create policy payment_links_member_insert on public.payment_links for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and created_by = auth.uid() and status = 'open' and paid_at is null);
revoke update, delete on public.payment_links from authenticated;
revoke all on public.payment_link_events from authenticated;

-- Memory: members read and curate (staff can add, correct or delete).
create policy customers_member_all on public.customers for all to authenticated
  using (public.is_tenant_member(tenant_id)) with check (public.is_tenant_member(tenant_id));
create policy customer_memories_member_select on public.customer_memories for select to authenticated using (public.is_tenant_member(tenant_id));
create policy customer_memories_member_insert on public.customer_memories for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and source = 'staff' and created_by = auth.uid());
create policy customer_memories_member_update on public.customer_memories for update to authenticated
  using (public.is_tenant_member(tenant_id)) with check (public.is_tenant_member(tenant_id));

-- Comments: written by the webhook (server); members read.
create policy social_comments_member_select on public.social_comments for select to authenticated using (public.is_tenant_member(tenant_id));
revoke insert, update, delete on public.social_comments from authenticated;

revoke all on public.marketing_consent_events, public.broadcasts, public.broadcast_recipients, public.payment_accounts,
  public.payment_account_credentials, public.payment_links, public.payment_link_events, public.customers,
  public.customer_memories, public.social_comments from anon;
revoke all on public.marketing_consent_current from anon;
