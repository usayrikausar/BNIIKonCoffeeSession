-- Layankan — initial schema
-- Multi-tenant: every tenant-owned row carries tenant_id and is protected by RLS.
-- Rule of thumb: the browser (anon / authenticated roles) can only ever see rows
-- for tenants the signed-in user is a member of. Public chat + background jobs
-- run server-side with the service role and scope every query by tenant_id in code.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------------------
-- Enums
-- ---------------------------------------------------------------------------
create type public.member_role as enum ('owner', 'staff');
create type public.tenant_status as enum ('draft', 'live', 'suspended');
create type public.lead_score as enum ('PANAS', 'SUAM', 'SEJUK');
create type public.conversation_status as enum ('ai', 'needs_human', 'human', 'closed');
create type public.channel_kind as enum ('web', 'whatsapp');
-- 'web' = our own web chat; 'murpati' and 'meta_cloud' are the two WhatsApp
-- transports (Phase 2). Selecting one is a per-tenant data setting, not code.
create type public.channel_provider as enum ('web', 'murpati', 'meta_cloud');
create type public.message_direction as enum ('inbound', 'outbound');
create type public.message_sender as enum ('customer', 'ai', 'human', 'system');
create type public.message_status as enum ('received', 'queued', 'sent', 'delivered', 'read', 'failed');

-- ---------------------------------------------------------------------------
-- Tenants & membership
-- ---------------------------------------------------------------------------
create table public.tenants (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique check (slug ~ '^[a-z0-9]([a-z0-9-]{1,46}[a-z0-9])$'),
  name text not null check (char_length(name) between 1 and 120),
  status public.tenant_status not null default 'draft',
  timezone text not null default 'Asia/Kuala_Lumpur',
  default_locale text not null default 'ms' check (default_locale in ('ms', 'en')),
  summary_hour smallint not null default 8 check (summary_hour between 0 and 23),
  plan text not null default 'founding',
  live_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.tenant_members (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  role public.member_role not null default 'staff',
  email text,
  -- {"email_handoff": true, "email_daily_summary": true}
  notification_prefs jsonb not null default '{"email_handoff": true, "email_daily_summary": true}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, user_id)
);
create index tenant_members_user_idx on public.tenant_members(user_id);

create table public.tenant_invites (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  email text not null,
  role public.member_role not null default 'staff',
  invited_by uuid references auth.users(id) on delete set null,
  accepted_at timestamptz,
  created_at timestamptz not null default now(),
  unique (tenant_id, email)
);

-- ---------------------------------------------------------------------------
-- Membership helpers (SECURITY DEFINER so policies don't recurse through RLS)
-- ---------------------------------------------------------------------------
create or replace function public.is_tenant_member(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = t and m.user_id = auth.uid()
  );
$$;

create or replace function public.is_tenant_owner(t uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.tenant_members m
    where m.tenant_id = t and m.user_id = auth.uid() and m.role = 'owner'
  );
$$;

revoke all on function public.is_tenant_member(uuid) from public;
revoke all on function public.is_tenant_owner(uuid) from public;
grant execute on function public.is_tenant_member(uuid) to authenticated, service_role;
grant execute on function public.is_tenant_owner(uuid) to authenticated, service_role;

-- Onboarding: creates a tenant + owner membership + empty brain atomically.
create or replace function public.create_workspace(p_name text, p_slug text, p_industry text default 'umum')
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_tenant uuid;
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'not authenticated';
  end if;
  insert into public.tenants (name, slug) values (p_name, lower(p_slug)) returning id into v_tenant;
  insert into public.tenant_members (tenant_id, user_id, role, email)
    values (v_tenant, v_uid, 'owner', (select email from auth.users where id = v_uid));
  insert into public.business_brains (tenant_id, profile)
    values (v_tenant, jsonb_build_object('name', p_name, 'industry', p_industry,
      'tone', 'santai', 'languages', jsonb_build_array('ms', 'en')));
  return v_tenant;
end;
$$;
revoke all on function public.create_workspace(text, text, text) from public;
grant execute on function public.create_workspace(text, text, text) to authenticated;

-- Accept pending invites for the signed-in user's email.
create or replace function public.accept_my_invites()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_count integer := 0;
begin
  if v_uid is null then return 0; end if;
  select lower(email) into v_email from auth.users where id = v_uid;
  with acc as (
    insert into public.tenant_members (tenant_id, user_id, role, email)
    select i.tenant_id, v_uid, i.role, v_email
    from public.tenant_invites i
    where lower(i.email) = v_email and i.accepted_at is null
    on conflict do nothing
    returning tenant_id
  )
  select count(*) into v_count from acc;
  update public.tenant_invites set accepted_at = now()
    where lower(email) = v_email and accepted_at is null;
  return v_count;
end;
$$;
revoke all on function public.accept_my_invites() from public;
grant execute on function public.accept_my_invites() to authenticated;

-- ---------------------------------------------------------------------------
-- Business Brain (one row per tenant; JSON validated in app with zod)
-- ---------------------------------------------------------------------------
create table public.business_brains (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  profile jsonb not null default '{}'::jsonb,
  products jsonb not null default '[]'::jsonb,
  faqs jsonb not null default '[]'::jsonb,
  policies jsonb not null default '{}'::jsonb,
  qualifying_questions jsonb not null default '[]'::jsonb,
  handoff_rules jsonb not null default '{"ready_to_buy": true, "complaint": true, "ai_unsure": true, "asked_for_human": true, "owner_whatsapp": ""}'::jsonb,
  extra_knowledge text not null default '',
  version integer not null default 1,
  updated_by uuid references auth.users(id) on delete set null,
  updated_at timestamptz not null default now()
);

-- Every save is snapshotted so assessments can be traced to the exact brain.
create table public.brain_revisions (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  version integer not null,
  snapshot jsonb not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (tenant_id, version)
);

create or replace function public.bump_brain_version()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'UPDATE' then
    new.version := old.version + 1;
  end if;
  new.updated_at := now();
  return new;
end;
$$;
create trigger business_brains_bump before insert or update on public.business_brains
  for each row execute function public.bump_brain_version();

create or replace function public.snapshot_brain()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.brain_revisions (tenant_id, version, snapshot, created_by)
  values (new.tenant_id, new.version,
    jsonb_build_object('profile', new.profile, 'products', new.products, 'faqs', new.faqs,
      'policies', new.policies, 'qualifying_questions', new.qualifying_questions,
      'handoff_rules', new.handoff_rules, 'extra_knowledge', new.extra_knowledge),
    new.updated_by)
  on conflict (tenant_id, version) do nothing;
  return new;
end;
$$;
create trigger business_brains_snapshot after insert or update on public.business_brains
  for each row execute function public.snapshot_brain();

-- Uploaded PDFs / URLs / pasted text, extracted into a draft the owner reviews.
create table public.brain_sources (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  kind text not null check (kind in ('pdf', 'url', 'text')),
  storage_path text,
  source_url text,
  raw_text text,
  extracted jsonb,
  status text not null default 'pending' check (status in ('pending', 'extracted', 'applied', 'discarded', 'failed')),
  error text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index brain_sources_tenant_idx on public.brain_sources(tenant_id, created_at desc);

-- ---------------------------------------------------------------------------
-- Channels (designed for Phase 2 WhatsApp now, so no migration pain later)
-- ---------------------------------------------------------------------------
create table public.channel_connections (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel public.channel_kind not null,
  provider public.channel_provider not null,
  is_active boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'connected', 'error', 'disconnected')),
  -- WhatsApp identifiers (null for web)
  display_phone_number text,
  phone_number_id text,          -- Meta phone number ID (routing key for webhooks)
  waba_id text,                  -- WhatsApp Business Account ID
  meta_business_id text,         -- Meta Business (Business Manager) ID
  provider_account_ref text,     -- e.g. Murpati account/channel ID
  -- Ownership record for portability: who legally owns the Meta Business + WABA.
  -- Should be the client, so the number can be migrated between transports.
  meta_business_owner text check (meta_business_owner in ('client', 'layankan', 'reseller', 'unknown')),
  waba_owner text check (waba_owner in ('client', 'layankan', 'reseller', 'unknown')),
  owner_legal_name text,
  owner_contact_email text,
  ownership_verified_at timestamptz,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
-- At most one ACTIVE connection per tenant per channel. Switching transport =
-- deactivate old row, activate new row (data change, no code change).
create unique index channel_connections_one_active
  on public.channel_connections(tenant_id, channel) where is_active;
create index channel_connections_phone_idx on public.channel_connections(provider, phone_number_id);

-- Encrypted credentials. NEVER readable from the browser: RLS on, no policies
-- for anon/authenticated. Multiple rows per connection allow zero-downtime
-- rotation (insert new current row, then revoke the old one).
create table public.channel_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null references public.channel_connections(id) on delete cascade,
  name text not null,                 -- e.g. 'access_token', 'app_secret', 'api_key'
  key_id text not null,               -- which ENCRYPTION_KEYS entry encrypted it
  ciphertext text not null,           -- base64(iv | tag | ciphertext), AES-256-GCM
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index channel_credentials_one_current
  on public.channel_credentials(connection_id, name) where is_current and revoked_at is null;

-- ---------------------------------------------------------------------------
-- Contacts, conversations, messages
-- ---------------------------------------------------------------------------
create table public.contacts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  channel public.channel_kind not null,
  external_id text not null,          -- web visitor id, or WhatsApp wa_id
  name text,
  phone text,
  email text,
  created_at timestamptz not null default now(),
  unique (tenant_id, channel, external_id)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  channel public.channel_kind not null,
  channel_connection_id uuid references public.channel_connections(id) on delete set null,
  status public.conversation_status not null default 'ai',
  is_test boolean not null default false,
  lead_score public.lead_score,
  score_confidence real,
  score_reason text,
  lead_details jsonb not null default '{}'::jsonb,
  next_action text,
  handoff_reason text,
  customer_message_count integer not null default 0,
  last_message_at timestamptz,
  last_message_preview text,
  last_inbound_at timestamptz,        -- drives WhatsApp 24h customer-service window
  visitor_token_hash text,            -- web chat: proves the browser owns this conversation
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index conversations_inbox_idx on public.conversations(tenant_id, is_test, last_message_at desc);
create index conversations_score_idx on public.conversations(tenant_id, lead_score);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  direction public.message_direction not null,
  sender public.message_sender not null,
  body text not null,
  channel public.channel_kind not null,
  provider public.channel_provider not null default 'web',
  provider_message_id text,
  status public.message_status not null,
  status_updated_at timestamptz not null default now(),
  error text,
  sent_by uuid references auth.users(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index messages_conversation_idx on public.messages(conversation_id, created_at);
-- Idempotency for provider webhooks (retries must not duplicate messages).
create unique index messages_provider_dedupe
  on public.messages(tenant_id, provider, provider_message_id) where provider_message_id is not null;

-- Delivery receipts history (sent → delivered → read / failed), our own copy.
create table public.message_status_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  message_id uuid not null references public.messages(id) on delete cascade,
  status public.message_status not null,
  occurred_at timestamptz not null default now(),
  detail jsonb not null default '{}'::jsonb
);
create index message_status_events_msg_idx on public.message_status_events(message_id);

-- ---------------------------------------------------------------------------
-- AI assessment audit log (append-only)
-- ---------------------------------------------------------------------------
create table public.ai_assessments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  inbound_message_id uuid references public.messages(id) on delete set null,
  reply_message_id uuid references public.messages(id) on delete set null,
  score public.lead_score,
  confidence real,
  reason text,
  captured jsonb not null default '{}'::jsonb,
  next_action text,
  handoff_required boolean not null default false,
  handoff_decision jsonb not null default '{}'::jsonb,
  raw_output jsonb,
  model text not null,
  prompt_template_version text not null,
  brain_version integer,
  input_tokens integer,
  output_tokens integer,
  latency_ms integer,
  stop_reason text,
  error text,
  created_at timestamptz not null default now()
);
create index ai_assessments_conv_idx on public.ai_assessments(conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- Notifications & scheduled jobs
-- ---------------------------------------------------------------------------
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  conversation_id uuid references public.conversations(id) on delete cascade,
  kind text not null check (kind in ('handoff', 'daily_summary', 'follow_up')),
  transport text not null check (transport in ('email', 'whatsapp')),
  recipient text not null,
  status text not null default 'pending' check (status in ('pending', 'sent', 'failed', 'skipped')),
  error text,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notifications_tenant_idx on public.notifications(tenant_id, created_at desc);

create table public.daily_summary_runs (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  local_date date not null,
  stats jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  primary key (tenant_id, local_date)
);

-- ---------------------------------------------------------------------------
-- Rate limiting (fixed window, atomic). Service role only.
-- ---------------------------------------------------------------------------
create table public.rate_limits (
  key text primary key,
  window_start timestamptz not null,
  hits integer not null
);

create or replace function public.rate_limit_hit(p_key text, p_window_seconds integer, p_max integer)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_hits integer;
begin
  insert into public.rate_limits as r (key, window_start, hits)
  values (p_key, now(), 1)
  on conflict (key) do update set
    hits = case when r.window_start < now() - make_interval(secs => p_window_seconds) then 1 else r.hits + 1 end,
    window_start = case when r.window_start < now() - make_interval(secs => p_window_seconds) then now() else r.window_start end
  returning hits into v_hits;
  return v_hits <= p_max;
end;
$$;
revoke all on function public.rate_limit_hit(text, integer, integer) from public, anon, authenticated;
grant execute on function public.rate_limit_hit(text, integer, integer) to service_role;

-- ---------------------------------------------------------------------------
-- updated_at triggers
-- ---------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end;
$$;
create trigger tenants_touch before update on public.tenants for each row execute function public.touch_updated_at();
create trigger conversations_touch before update on public.conversations for each row execute function public.touch_updated_at();
create trigger channel_connections_touch before update on public.channel_connections for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Row Level Security — on EVERY tenant table
-- ---------------------------------------------------------------------------
alter table public.tenants enable row level security;
alter table public.tenant_members enable row level security;
alter table public.tenant_invites enable row level security;
alter table public.business_brains enable row level security;
alter table public.brain_revisions enable row level security;
alter table public.brain_sources enable row level security;
alter table public.channel_connections enable row level security;
alter table public.channel_credentials enable row level security;
alter table public.contacts enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.message_status_events enable row level security;
alter table public.ai_assessments enable row level security;
alter table public.notifications enable row level security;
alter table public.daily_summary_runs enable row level security;
alter table public.rate_limits enable row level security;

-- tenants: members read; owners update. Creation only via create_workspace().
create policy tenants_select on public.tenants for select to authenticated using (public.is_tenant_member(id));
create policy tenants_update on public.tenants for update to authenticated
  using (public.is_tenant_owner(id)) with check (public.is_tenant_owner(id));
create policy tenants_delete on public.tenants for delete to authenticated using (public.is_tenant_owner(id));

-- members: members see teammates; owners manage. Staff change their own
-- notification prefs via update_my_notification_prefs() (cannot touch role).
create policy members_select on public.tenant_members for select to authenticated using (public.is_tenant_member(tenant_id));
create policy members_owner_write on public.tenant_members for all to authenticated
  using (public.is_tenant_owner(tenant_id)) with check (public.is_tenant_owner(tenant_id));

create policy invites_owner on public.tenant_invites for all to authenticated
  using (public.is_tenant_owner(tenant_id)) with check (public.is_tenant_owner(tenant_id));

-- Standard "members of this tenant" policies.
do $$
declare t text;
begin
  foreach t in array array['business_brains', 'brain_sources', 'contacts', 'conversations'] loop
    execute format('create policy %1$s_member_select on public.%1$s for select to authenticated using (public.is_tenant_member(tenant_id))', t);
    execute format('create policy %1$s_member_insert on public.%1$s for insert to authenticated with check (public.is_tenant_member(tenant_id))', t);
    execute format('create policy %1$s_member_update on public.%1$s for update to authenticated using (public.is_tenant_member(tenant_id)) with check (public.is_tenant_member(tenant_id))', t);
  end loop;
end $$;

-- Messages are an audit trail: members may read, and may only insert manual
-- outbound replies as themselves. No update/delete from the browser.
create policy messages_member_select on public.messages for select to authenticated using (public.is_tenant_member(tenant_id));
create policy messages_member_insert on public.messages for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and sender = 'human' and direction = 'outbound' and sent_by = auth.uid());

-- Deletion of customer data (PDPA) is owner-only.
create policy contacts_owner_delete on public.contacts for delete to authenticated using (public.is_tenant_owner(tenant_id));
create policy conversations_owner_delete on public.conversations for delete to authenticated using (public.is_tenant_owner(tenant_id));
create policy brain_sources_member_delete on public.brain_sources for delete to authenticated using (public.is_tenant_member(tenant_id));

-- Read-only to members (written by server).
create policy brain_revisions_select on public.brain_revisions for select to authenticated using (public.is_tenant_member(tenant_id));
create policy msg_status_select on public.message_status_events for select to authenticated using (public.is_tenant_member(tenant_id));
create policy ai_assessments_select on public.ai_assessments for select to authenticated using (public.is_tenant_member(tenant_id));
create policy notifications_select on public.notifications for select to authenticated using (public.is_tenant_member(tenant_id));
create policy summary_runs_select on public.daily_summary_runs for select to authenticated using (public.is_tenant_member(tenant_id));

-- Channel connections: members read metadata; owners manage. Credentials: no
-- policy at all → invisible to anon/authenticated, service role only.
create policy channel_conn_select on public.channel_connections for select to authenticated using (public.is_tenant_member(tenant_id));
create policy channel_conn_owner_write on public.channel_connections for all to authenticated
  using (public.is_tenant_owner(tenant_id)) with check (public.is_tenant_owner(tenant_id));

-- Belt and braces: anon gets nothing on tenant tables (public chat goes through the server).
revoke all on all tables in schema public from anon;
revoke all on public.channel_credentials from authenticated;
revoke all on public.rate_limits from authenticated;
-- Owners may edit workspace settings, but not plan/slug/ids (billing is Phase 3).
revoke update on public.tenants from authenticated;
grant update (name, status, timezone, default_locale, summary_hour, live_at) on public.tenants to authenticated;

create or replace function public.update_my_notification_prefs(p_tenant uuid, p_prefs jsonb)
returns void language sql security definer set search_path = public as $$
  update public.tenant_members set notification_prefs = p_prefs
  where tenant_id = p_tenant and user_id = auth.uid();
$$;
revoke all on function public.update_my_notification_prefs(uuid, jsonb) from public;
grant execute on function public.update_my_notification_prefs(uuid, jsonb) to authenticated;
