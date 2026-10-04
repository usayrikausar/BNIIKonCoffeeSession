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

-- R1 IS BUILT: marketing_consent_events, the marketing_consent_current view,
-- the STOP → withdrawal trigger and their RLS now live in the real migration
-- supabase/migrations/20261004000008_optin.sql. What follows is R6 (not built).

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
-- R2 IS BUILT: payment_accounts, payment_account_credentials, payment_links,
-- payment_link_events and their RLS now live in the real migration
-- supabase/migrations/20261004000009_payment_links.sql.
-- ═════════════════════════════════════════════════════════════════════════

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
alter table public.broadcasts enable row level security;
alter table public.broadcast_recipients enable row level security;
alter table public.customers enable row level security;
alter table public.customer_memories enable row level security;
alter table public.social_comments enable row level security;

-- Broadcasts: owners create/edit; recipients and sending are server-only.
create policy broadcasts_member_select on public.broadcasts for select to authenticated using (public.is_tenant_member(tenant_id));
create policy broadcasts_owner_write on public.broadcasts for all to authenticated
  using (public.is_tenant_owner(tenant_id)) with check (public.is_tenant_owner(tenant_id));
create policy broadcast_recipients_member_select on public.broadcast_recipients for select to authenticated using (public.is_tenant_member(tenant_id));
revoke insert, update, delete on public.broadcast_recipients from authenticated;

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

revoke all on public.broadcasts, public.broadcast_recipients, public.customers,
  public.customer_memories, public.social_comments from anon;
