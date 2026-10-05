-- R6 (ROADMAP.md): opt-in WhatsApp broadcasts. The owner picks an approved
-- marketing template and who gets it (everyone who opted in, optionally by
-- lead score), then presses Send or Schedule. No journeys, no flow builder.
--
-- The rule "nobody gets a broadcast without a current opt-in" is enforced
-- HERE, by the database, twice: when a recipient is queued and again at the
-- moment of sending (so a STOP between the two still stops it).

-- ---------------------------------------------------------------------------
-- Templates: only templates synced from Meta can be used for broadcasts, so
-- owners must not be able to label their own rows as synced.
-- ---------------------------------------------------------------------------
drop policy templates_owner_write on public.message_templates;
create policy templates_owner_insert on public.message_templates for insert to authenticated
  with check (public.is_tenant_owner(tenant_id) and source = 'manual');
create policy templates_owner_update on public.message_templates for update to authenticated
  using (public.is_tenant_owner(tenant_id) and source = 'manual')
  with check (public.is_tenant_owner(tenant_id) and source = 'manual');
create policy templates_owner_delete on public.message_templates for delete to authenticated
  using (public.is_tenant_owner(tenant_id));

-- ---------------------------------------------------------------------------
-- Flat per-business monthly allowance (never per contact). Placeholder values,
-- edit in the table.
-- ---------------------------------------------------------------------------
alter table public.plans add column broadcast_message_limit integer not null default 0 check (broadcast_message_limit >= 0);
update public.plans set broadcast_message_limit = case id
  when 'trial' then 50
  when 'asas' then 500
  when 'niaga' then 2000
  when 'pro' then 6000
  when 'founding' then 3000
  when 'internal' then 1000000
  else 0 end;
alter table public.usage_counters add column broadcast_messages integer not null default 0;

-- ---------------------------------------------------------------------------
-- Broadcasts. Written only by the server (after checking the owner, the
-- template and the allowance); members read.
-- ---------------------------------------------------------------------------
create table public.broadcasts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null references public.channel_connections(id) on delete restrict,
  name text not null check (char_length(name) between 1 and 120),
  -- An APPROVED MARKETING template synced from Meta, which carries an opt-out line.
  template_name text not null check (template_name ~ '^[a-z0-9_]+$'),
  template_language text not null default 'ms',
  template_variables jsonb not null default '[]'::jsonb check (jsonb_typeof(template_variables) = 'array'),
  -- Simple audience only: everyone opted in, optionally only some lead scores.
  audience jsonb not null default '{"scores": []}'::jsonb,
  status text not null default 'scheduled' check (status in ('scheduled', 'sending', 'sent', 'cancelled')),
  scheduled_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  created_by uuid references auth.users(id) on delete set null,
  cancelled_by uuid references auth.users(id) on delete set null,
  recipients_total integer not null default 0,
  sent_count integer not null default 0,
  failed_count integer not null default 0,
  skipped_count integer not null default 0,
  created_at timestamptz not null default now()
);
create index broadcasts_due_idx on public.broadcasts(status, scheduled_at) where status in ('scheduled', 'sending');
create index broadcasts_tenant_idx on public.broadcasts(tenant_id, created_at desc);
create trigger broadcasts_same_tenant before insert or update on public.broadcasts
  for each row execute function public.enforce_same_tenant('connection_id', 'channel_connections');

create table public.broadcast_recipients (
  broadcast_id uuid not null references public.broadcasts(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  tenant_id uuid not null,  -- no FK on purpose (junction rule: keeps REST embeds unambiguous); same-tenant trigger below
  consent_event_id bigint not null references public.marketing_consent_events(id) on delete cascade,
  status text not null default 'queued' check (status in ('queued', 'sending', 'sent', 'failed', 'skipped')),
  skip_reason text check (skip_reason in ('consent_withdrawn', 'too_recent', 'plan_limit', 'cancelled', 'no_conversation')),
  message_id uuid references public.messages(id) on delete set null,
  error text,
  queued_at timestamptz not null default now(),
  sent_at timestamptz,
  primary key (broadcast_id, contact_id)
);
create index broadcast_recipients_contact_idx on public.broadcast_recipients(tenant_id, contact_id, queued_at desc);
create index broadcast_recipients_queue_idx on public.broadcast_recipients(broadcast_id, status);
create trigger broadcast_recipients_same_tenant before insert or update on public.broadcast_recipients
  for each row execute function public.enforce_same_tenant('broadcast_id', 'broadcasts', 'contact_id', 'contacts', 'message_id', 'messages');

-- THE guard. A recipient can only be queued, and a message can only start
-- sending, while the contact's LATEST consent event is a grant (the one
-- cited), the contact never wrote STOP, and the contact is on WhatsApp.
create or replace function public.require_marketing_consent()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_latest record;
  v_contact record;
begin
  if tg_op = 'UPDATE' and not (new.status = 'sending' and old.status = 'queued') then
    return new;
  end if;
  if tg_op = 'INSERT' and new.status not in ('queued', 'skipped') then
    raise exception 'new recipients start queued or skipped' using errcode = 'check_violation';
  end if;
  select id, action into v_latest from public.marketing_consent_events
    where tenant_id = new.tenant_id and contact_id = new.contact_id
    order by id desc limit 1;
  if v_latest.id is null or v_latest.action <> 'granted' or v_latest.id <> new.consent_event_id then
    raise exception 'no current marketing opt-in for this contact' using errcode = 'check_violation';
  end if;
  select channel, opted_out_at into v_contact from public.contacts where id = new.contact_id;
  if v_contact.opted_out_at is not null then
    raise exception 'contact has opted out' using errcode = 'check_violation';
  end if;
  if v_contact.channel <> 'whatsapp' then
    raise exception 'broadcasts go to WhatsApp contacts only' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.require_marketing_consent() from public, anon, authenticated;
create trigger broadcast_recipients_need_consent before insert or update of status on public.broadcast_recipients
  for each row execute function public.require_marketing_consent();

-- Frequency cap: at most one broadcast per contact per 7 days (queued, sending
-- or sent in any other broadcast of the business counts).
create or replace function public.broadcast_frequency_cap()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.status = 'queued' and exists (
    select 1 from public.broadcast_recipients r
    where r.tenant_id = new.tenant_id and r.contact_id = new.contact_id and r.broadcast_id <> new.broadcast_id
      and r.status in ('queued', 'sending', 'sent')
      and coalesce(r.sent_at, r.queued_at) > now() - interval '7 days'
  ) then
    raise exception 'this contact already got a broadcast in the last 7 days' using errcode = 'check_violation';
  end if;
  return new;
end;
$$;
revoke all on function public.broadcast_frequency_cap() from public, anon, authenticated;
create trigger broadcast_recipients_frequency_cap before insert on public.broadcast_recipients
  for each row execute function public.broadcast_frequency_cap();

-- Monthly allowance, atomic. True = one broadcast message may be sent now.
create or replace function public.consume_broadcast_message(p_tenant uuid)
returns boolean language plpgsql security definer set search_path = public as $$
declare
  v_limit integer;
  v_period timestamptz := public.current_usage_period(p_tenant);
  v_ok boolean;
begin
  select p.broadcast_message_limit into v_limit
    from public.subscriptions s join public.plans p on p.id = s.plan_id where s.tenant_id = p_tenant;
  if coalesce(v_limit, 0) <= 0 then return false; end if;
  insert into public.usage_counters as u (tenant_id, period_start, broadcast_messages)
  values (p_tenant, v_period, 1)
  on conflict (tenant_id, period_start) do update
    set broadcast_messages = u.broadcast_messages + 1, updated_at = now()
    where u.broadcast_messages < v_limit
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;
-- Give one back (the send failed, so Meta didn't charge and neither do we).
create or replace function public.release_broadcast_message(p_tenant uuid)
returns void language sql security definer set search_path = public as $$
  update public.usage_counters set broadcast_messages = greatest(broadcast_messages - 1, 0), updated_at = now()
  where tenant_id = p_tenant and period_start = public.current_usage_period(p_tenant);
$$;
revoke all on function public.consume_broadcast_message(uuid), public.release_broadcast_message(uuid) from public, anon, authenticated;
grant execute on function public.consume_broadcast_message(uuid), public.release_broadcast_message(uuid) to service_role;

-- ---------------------------------------------------------------------------
-- RLS: members read; every write is the server's.
-- ---------------------------------------------------------------------------
alter table public.broadcasts enable row level security;
alter table public.broadcast_recipients enable row level security;
create policy broadcasts_member_select on public.broadcasts for select to authenticated using (public.is_tenant_member(tenant_id));
create policy broadcast_recipients_member_select on public.broadcast_recipients for select to authenticated using (public.is_tenant_member(tenant_id));
revoke insert, update, delete on public.broadcasts, public.broadcast_recipients from authenticated;
revoke all on public.broadcasts, public.broadcast_recipients from anon;
