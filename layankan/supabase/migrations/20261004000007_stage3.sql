-- Stage 3: booking link, follow-up controls, conversation-based usage.

-- ---------------------------------------------------------------------------
-- Booking link (part of the Business Brain). Offered once to PANAS leads.
-- ---------------------------------------------------------------------------
alter table public.business_brains
  add column booking jsonb not null default '{}'::jsonb;

alter table public.conversations
  add column booking_link_sent_at timestamptz,
  -- Per-chat off switch for automatic follow-ups (any team member can flip it).
  add column follow_up_disabled boolean not null default false;

-- Follow-ups: at most 2 per conversation; first after `delay_hours` of
-- silence, second `second_delay_hours` after the first.
update public.business_brains
  set follow_up = jsonb_set(follow_up, '{max_attempts}', '2'::jsonb)
  where (follow_up ->> 'max_attempts')::int > 2;

-- Revisions also keep the follow-up and booking settings from now on.
create or replace function public.snapshot_brain()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.brain_revisions (tenant_id, version, snapshot, created_by)
  values (new.tenant_id, new.version,
    jsonb_build_object('profile', new.profile, 'products', new.products, 'faqs', new.faqs,
      'policies', new.policies, 'qualifying_questions', new.qualifying_questions,
      'handoff_rules', new.handoff_rules, 'extra_knowledge', new.extra_knowledge,
      'follow_up', new.follow_up, 'booking', new.booking),
    new.updated_by)
  on conflict (tenant_id, version) do nothing;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- Conversation-based usage. A plan includes N conversations per month: one
-- customer chat counts ONCE per month, however many messages it has. Flat
-- price per business — never per contact or per seat.
-- ---------------------------------------------------------------------------
alter table public.plans
  add column conversation_limit integer not null default 0 check (conversation_limit >= 0);
comment on column public.plans.ai_reply_limit is 'Deprecated (Stage 3): limits are per conversation, see conversation_limit.';

-- Placeholder limits — edit in the table, no code change needed.
update public.plans set conversation_limit = case id
  when 'trial' then 30
  when 'asas' then 100
  when 'niaga' then 400
  when 'pro' then 1200
  when 'founding' then 600
  when 'internal' then 1000000
  else 100 end;

alter table public.usage_counters
  add column conversations integer not null default 0;

-- Which conversations were already counted in which period (so each counts once).
-- tenant_id deliberately has NO foreign key: with FKs to both tenants and
-- conversations, the REST API would see a second tenants↔conversations path
-- and refuse every "conversation + tenant" query as ambiguous. Deleting a
-- tenant still cleans up here (via its conversations), and the same-tenant
-- trigger below keeps tenant_id honest.
create table public.usage_conversations (
  tenant_id uuid not null,
  period_start timestamptz not null,
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  counted_at timestamptz not null default now(),
  primary key (tenant_id, period_start, conversation_id)
);
alter table public.usage_conversations enable row level security;
create policy usage_conversations_member_read on public.usage_conversations
  for select to authenticated using (public.is_tenant_member(tenant_id));
revoke all on public.usage_conversations from anon;
revoke insert, update, delete on public.usage_conversations from authenticated;
create trigger usage_conversations_same_tenant before insert or update on public.usage_conversations
  for each row execute function public.enforce_same_tenant('conversation_id', 'conversations');

-- Count a conversation for the current period (idempotent). Server only.
create or replace function public.count_conversation(p_tenant uuid, p_conversation uuid)
returns table (is_new boolean, total integer)
language plpgsql security definer set search_path = public as $$
declare
  v_period timestamptz := public.current_usage_period(p_tenant);
  v_new boolean;
begin
  insert into public.usage_conversations (tenant_id, period_start, conversation_id)
  values (p_tenant, v_period, p_conversation)
  on conflict do nothing;
  v_new := found;
  insert into public.usage_counters as u (tenant_id, period_start, conversations)
  values (p_tenant, v_period, case when v_new then 1 else 0 end)
  on conflict (tenant_id, period_start) do update
    set conversations = u.conversations + excluded.conversations, updated_at = now();
  return query select v_new, (select c.conversations from public.usage_counters c where c.tenant_id = p_tenant and c.period_start = v_period);
end;
$$;
revoke all on function public.count_conversation(uuid, uuid) from public, anon, authenticated;
grant execute on function public.count_conversation(uuid, uuid) to service_role;

-- 80% and 100% usage warnings: remember the highest level already sent per period.
alter table public.subscriptions
  add column usage_alert_period timestamptz,
  add column usage_alert_level integer not null default 0;

-- Atomically claim a warning level for a period. True = caller should send it.
create or replace function public.claim_usage_alert(p_tenant uuid, p_period timestamptz, p_level integer)
returns boolean language plpgsql security definer set search_path = public as $$
begin
  update public.subscriptions
    set usage_alert_period = p_period, usage_alert_level = p_level
    where tenant_id = p_tenant
      and (usage_alert_period is distinct from p_period or usage_alert_level < p_level);
  return found;
end;
$$;
revoke all on function public.claim_usage_alert(uuid, timestamptz, integer) from public, anon, authenticated;
grant execute on function public.claim_usage_alert(uuid, timestamptz, integer) to service_role;

-- Admin overview now reports conversations too (return type changes → drop first).
drop function public.admin_current_usage();
create function public.admin_current_usage()
returns table (tenant_id uuid, period_start timestamptz, ai_replies integer, conversations integer)
language sql stable security definer set search_path = public as $$
  select s.tenant_id, public.usage_period_start(s.billing_anchor), coalesce(u.ai_replies, 0), coalesce(u.conversations, 0)
  from public.subscriptions s
  left join public.usage_counters u
    on u.tenant_id = s.tenant_id and u.period_start = public.usage_period_start(s.billing_anchor);
$$;
revoke all on function public.admin_current_usage() from public, anon, authenticated;
grant execute on function public.admin_current_usage() to service_role;

-- The dashboard (signed-in members) needs the usage period too. Members may
-- read it for their OWN workspace only (keeps audit fix M2); the server
-- (service role, no user) may read any.
create or replace function public.current_usage_period(p_tenant uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select case when auth.uid() is null or public.is_tenant_member(p_tenant) then
    coalesce(
      (select public.usage_period_start(billing_anchor) from public.subscriptions where tenant_id = p_tenant),
      date_trunc('month', now()))
  end;
$$;
revoke all on function public.current_usage_period(uuid) from public, anon;
grant execute on function public.current_usage_period(uuid) to authenticated, service_role;
