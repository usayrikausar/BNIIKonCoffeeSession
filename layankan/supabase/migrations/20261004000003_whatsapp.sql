-- Phase 2: WhatsApp (Murpati official API + direct Meta Cloud API), owner
-- alerts via WhatsApp, follow-ups for SUAM leads. Additive only.

-- Only the OFFICIAL WhatsApp Business Platform is allowed. Murpati also sells
-- unofficial QR-linked "devices"; those must never be connected here.
alter table public.channel_connections
  add column official_api boolean not null default true,
  add constraint channel_connections_official_only check (official_api);

-- A phone number can be live in only one workspace at a time (webhook routing).
create unique index channel_connections_active_phone
  on public.channel_connections(phone_number_id) where is_active and phone_number_id is not null;

-- Customer asked us to stop messaging them (no follow-ups after this).
alter table public.contacts add column opted_out_at timestamptz;

alter table public.conversations
  add column follow_up_count integer not null default 0,
  add column last_follow_up_at timestamptz;
create index conversations_follow_up_idx on public.conversations(tenant_id, lead_score, status) where not is_test;

-- Follow-up settings live with the rest of the tenant's behaviour.
alter table public.business_brains
  add column follow_up jsonb not null default
    '{"enabled": false, "delay_hours": 24, "max_attempts": 1, "message": "", "template_name": "", "template_language": "ms", "template_variables": ["{name}"]}'::jsonb;

-- WhatsApp provider message ids for alerts we send, so delivery receipts can be matched.
alter table public.notifications add column provider_message_id text;
create index notifications_provider_msg_idx on public.notifications(provider_message_id) where provider_message_id is not null;

-- Approved message templates (needed outside the 24h customer-service window).
create table public.message_templates (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid references public.channel_connections(id) on delete cascade,
  name text not null check (name ~ '^[a-z0-9_]+$' and char_length(name) <= 512),
  language text not null default 'ms',
  category text,
  status text not null default 'APPROVED',
  body_text text not null default '',
  variable_count integer not null default 0,
  source text not null default 'manual' check (source in ('manual', 'meta_sync')),
  updated_at timestamptz not null default now(),
  unique (tenant_id, name, language)
);
alter table public.message_templates enable row level security;
create policy templates_select on public.message_templates for select to authenticated using (public.is_tenant_member(tenant_id));
create policy templates_owner_write on public.message_templates for all to authenticated
  using (public.is_tenant_owner(tenant_id)) with check (public.is_tenant_owner(tenant_id));
revoke all on public.message_templates from anon;

-- Atomic, owner-only switch of the active transport for a channel
-- (e.g. Murpati -> Meta Cloud API). Data change only; no code change.
create or replace function public.switch_active_connection(p_tenant uuid, p_connection uuid)
returns void language plpgsql security definer set search_path = public as $$
declare
  v_channel public.channel_kind;
begin
  if auth.uid() is not null and not public.is_tenant_owner(p_tenant) then
    raise exception 'only the workspace owner can switch channels' using errcode = '42501';
  end if;
  select channel into v_channel from public.channel_connections where id = p_connection and tenant_id = p_tenant;
  if v_channel is null then
    raise exception 'connection not found' using errcode = 'P0002';
  end if;
  update public.channel_connections set is_active = false, status = 'disconnected'
    where tenant_id = p_tenant and channel = v_channel and is_active and id <> p_connection;
  update public.channel_connections set is_active = true, status = 'connected'
    where id = p_connection and tenant_id = p_tenant;
  update public.conversations set channel_connection_id = p_connection
    where tenant_id = p_tenant and channel = v_channel;
end;
$$;
revoke all on function public.switch_active_connection(uuid, uuid) from public, anon;
grant execute on function public.switch_active_connection(uuid, uuid) to authenticated, service_role;
