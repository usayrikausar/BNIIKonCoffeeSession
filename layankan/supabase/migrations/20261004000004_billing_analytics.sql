-- Phase 3: plans, subscriptions, invoices, payment gateway events, usage
-- metering and analytics. Additive only.

-- ---------------------------------------------------------------------------
-- Plans (global catalogue; prices in sen, MYR)
-- ---------------------------------------------------------------------------
create table public.plans (
  id text primary key check (id ~ '^[a-z0-9_]+$'),
  name text not null,
  description text not null default '',
  price_cents integer not null check (price_cents >= 0),
  setup_fee_cents integer not null default 0 check (setup_fee_cents >= 0),
  currency text not null default 'MYR',
  ai_reply_limit integer not null check (ai_reply_limit >= 0),  -- per billing period
  max_whatsapp_numbers integer not null default 1,
  max_members integer not null default 2,
  trial_days integer not null default 0,
  is_public boolean not null default true,   -- shown on the pricing/billing page
  is_active boolean not null default true,
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- Placeholder catalogue — edit prices/limits in the table, no code change needed.
insert into public.plans (id, name, description, price_cents, setup_fee_cents, ai_reply_limit, max_whatsapp_numbers, max_members, trial_days, is_public, sort_order) values
  ('trial',    'Percubaan 14 hari', 'Cuba semua ciri secara percuma.',                  0,     0,   150, 1,  2, 14, false, 0),
  ('asas',     'Asas',              'Untuk perniagaan kecil yang baru bermula.',      9900,     0,   500, 1,  2,  0, true,  10),
  ('niaga',    'Niaga',             'Untuk perniagaan dengan pertanyaan harian tinggi.', 24900, 0,  2000, 1,  5,  0, true,  20),
  ('pro',      'Pro',               'Untuk cawangan / pasukan jualan.',              49900,     0,  6000, 3, 15,  0, true,  30),
  ('founding', 'Founding Offer',    '3 slot sahaja. Setup penuh oleh pasukan kami.', 30000, 50000, 3000, 2,  5,  0, false, 5),
  ('internal', 'Dalaman',           'Untuk ruang kerja Layankan sendiri.',               0,     0, 1000000, 10, 50, 0, false, 99);

-- ---------------------------------------------------------------------------
-- Subscriptions (one per tenant) — written only by the server
-- ---------------------------------------------------------------------------
create table public.subscriptions (
  tenant_id uuid primary key references public.tenants(id) on delete cascade,
  plan_id text not null references public.plans(id),
  status text not null default 'trialing' check (status in ('trialing', 'active', 'past_due', 'canceled', 'expired')),
  -- Usage resets every month from this anchor (independent of early payments).
  billing_anchor timestamptz not null default now(),
  current_period_start timestamptz not null default now(),
  -- "Paid through": AI service is covered until this moment (+ grace).
  current_period_end timestamptz not null,
  -- Plan to switch to at the next paid period (downgrades / changes).
  next_plan_id text references public.plans(id),
  cancel_at_period_end boolean not null default false,
  gateway text not null default 'manual' check (gateway in ('billplz', 'toyyibpay', 'stripe', 'manual')),
  gateway_customer_ref text,
  setup_fee_paid boolean not null default false,
  quota_alerted_period timestamptz,          -- avoid repeated "limit reached" alerts
  updated_at timestamptz not null default now()
);

create table public.invoices (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  number text not null unique,
  plan_id text not null references public.plans(id),
  description text not null,
  amount_cents integer not null check (amount_cents >= 0),
  currency text not null default 'MYR',
  lines jsonb not null default '[]'::jsonb,
  period_start timestamptz not null,
  period_end timestamptz not null,
  includes_setup_fee boolean not null default false,
  status text not null default 'open' check (status in ('open', 'paid', 'void', 'failed')),
  gateway text not null check (gateway in ('billplz', 'toyyibpay', 'stripe', 'manual')),
  gateway_bill_id text,
  payment_url text,
  paid_at timestamptz,
  paid_amount_cents integer,
  created_at timestamptz not null default now(),
  unique (gateway, gateway_bill_id)
);
create index invoices_tenant_idx on public.invoices(tenant_id, created_at desc);
create sequence public.invoice_number_seq start 1001;

-- Raw gateway callbacks (idempotency + audit). Service role only.
create table public.payment_events (
  id bigint generated always as identity primary key,
  gateway text not null,
  event_key text not null,
  invoice_id uuid references public.invoices(id) on delete set null,
  tenant_id uuid references public.tenants(id) on delete set null,
  verified boolean not null,
  paid boolean,
  payload jsonb not null,
  created_at timestamptz not null default now(),
  unique (gateway, event_key)
);

-- ---------------------------------------------------------------------------
-- Usage metering — one row per tenant per billing period
-- ---------------------------------------------------------------------------
create table public.usage_counters (
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  period_start timestamptz not null,
  ai_replies integer not null default 0,
  inbound_messages integer not null default 0,
  outbound_messages integer not null default 0,
  template_messages integer not null default 0,
  input_tokens bigint not null default 0,
  output_tokens bigint not null default 0,
  updated_at timestamptz not null default now(),
  primary key (tenant_id, period_start)
);

-- Monthly usage period containing p_now, counted from the subscription anchor.
create or replace function public.usage_period_start(p_anchor timestamptz, p_now timestamptz default now())
returns timestamptz language sql immutable as $$
  select p_anchor + make_interval(months => greatest(0,
    (extract(year from age(p_now, p_anchor)) * 12 + extract(month from age(p_now, p_anchor)))::int));
$$;

create or replace function public.current_usage_period(p_tenant uuid)
returns timestamptz language sql stable security definer set search_path = public as $$
  select coalesce(
    (select public.usage_period_start(billing_anchor) from public.subscriptions where tenant_id = p_tenant),
    date_trunc('month', now()));
$$;
revoke all on function public.current_usage_period(uuid) from public, anon;
grant execute on function public.current_usage_period(uuid) to authenticated, service_role;

-- Atomic meter. Server only. Returns AI replies used in the current period.
create or replace function public.increment_usage(
  p_tenant uuid,
  p_ai integer default 0, p_in integer default 0, p_out integer default 0, p_tpl integer default 0,
  p_input_tokens bigint default 0, p_output_tokens bigint default 0)
returns integer language sql security definer set search_path = public as $$
  insert into public.usage_counters as u (tenant_id, period_start, ai_replies, inbound_messages, outbound_messages, template_messages, input_tokens, output_tokens)
  values (p_tenant, public.current_usage_period(p_tenant), p_ai, p_in, p_out, p_tpl, p_input_tokens, p_output_tokens)
  on conflict (tenant_id, period_start) do update set
    ai_replies = u.ai_replies + excluded.ai_replies,
    inbound_messages = u.inbound_messages + excluded.inbound_messages,
    outbound_messages = u.outbound_messages + excluded.outbound_messages,
    template_messages = u.template_messages + excluded.template_messages,
    input_tokens = u.input_tokens + excluded.input_tokens,
    output_tokens = u.output_tokens + excluded.output_tokens,
    updated_at = now()
  returning ai_replies;
$$;
revoke all on function public.increment_usage(uuid, integer, integer, integer, integer, bigint, bigint) from public, anon, authenticated;
grant execute on function public.increment_usage(uuid, integer, integer, integer, integer, bigint, bigint) to service_role;

create or replace function public.next_invoice_number()
returns text language sql security definer set search_path = public as $$
  select 'LYK-' || to_char(now(), 'YYYYMM') || '-' || nextval('public.invoice_number_seq');
$$;
revoke all on function public.next_invoice_number() from public, anon, authenticated;
grant execute on function public.next_invoice_number() to service_role;

-- Every new workspace starts on a free trial.
create or replace function public.start_trial()
returns trigger language plpgsql security definer set search_path = public as $$
declare v_days integer;
begin
  select trial_days into v_days from public.plans where id = 'trial';
  insert into public.subscriptions (tenant_id, plan_id, status, billing_anchor, current_period_start, current_period_end)
  values (new.id, 'trial', 'trialing', now(), now(), now() + make_interval(days => coalesce(v_days, 14)))
  on conflict (tenant_id) do nothing;
  return new;
end;
$$;
create trigger tenants_start_trial after insert on public.tenants for each row execute function public.start_trial();

-- Backfill: the platform's own workspace is internal; everyone else gets a fresh trial.
insert into public.subscriptions (tenant_id, plan_id, status, current_period_start, current_period_end)
select t.id,
       case when t.id = '00000000-0000-4000-8000-000000000001' then 'internal' else 'trial' end,
       case when t.id = '00000000-0000-4000-8000-000000000001' then 'active' else 'trialing' end,
       now(),
       case when t.id = '00000000-0000-4000-8000-000000000001' then now() + interval '100 years' else now() + interval '14 days' end
from public.tenants t
on conflict (tenant_id) do nothing;

-- ---------------------------------------------------------------------------
-- Conversion tracking (owner marks the outcome of a lead)
-- ---------------------------------------------------------------------------
alter table public.conversations
  add column outcome text check (outcome in ('won', 'lost')),
  add column outcome_value_cents integer check (outcome_value_cents >= 0),
  add column outcome_at timestamptz,
  add column first_response_seconds integer,      -- customer's first message → our first reply
  add column handoff_at timestamptz,
  add column human_response_seconds integer;      -- handoff → first human reply

-- Response-time metrics, maintained by the database on every outbound message
-- (covers AI, owner replies and messages typed in a provider dashboard).
create or replace function public.track_response_times()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_first_in timestamptz;
begin
  if new.direction <> 'outbound' then return new; end if;
  select min(created_at) into v_first_in from public.messages
    where conversation_id = new.conversation_id and direction = 'inbound';
  if v_first_in is not null then
    update public.conversations
      set first_response_seconds = greatest(0, extract(epoch from new.created_at - v_first_in))::int
      where id = new.conversation_id and first_response_seconds is null;
  end if;
  if new.sender = 'human' then
    update public.conversations
      set human_response_seconds = greatest(0, extract(epoch from new.created_at - handoff_at))::int
      where id = new.conversation_id and handoff_at is not null and human_response_seconds is null;
  end if;
  return new;
end;
$$;
create trigger messages_response_times after insert on public.messages
  for each row execute function public.track_response_times();

alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('handoff', 'daily_summary', 'follow_up', 'quota', 'billing'));

-- ---------------------------------------------------------------------------
-- RLS
-- ---------------------------------------------------------------------------
alter table public.plans enable row level security;
alter table public.subscriptions enable row level security;
alter table public.invoices enable row level security;
alter table public.payment_events enable row level security;
alter table public.usage_counters enable row level security;

create policy plans_read on public.plans for select to authenticated using (is_active);
create policy subscriptions_member_read on public.subscriptions for select to authenticated using (public.is_tenant_member(tenant_id));
create policy invoices_member_read on public.invoices for select to authenticated using (public.is_tenant_member(tenant_id));
create policy usage_member_read on public.usage_counters for select to authenticated using (public.is_tenant_member(tenant_id));
-- payment_events: no policies → service role only.

revoke all on public.plans, public.subscriptions, public.invoices, public.payment_events, public.usage_counters from anon;
revoke insert, update, delete on public.plans, public.subscriptions, public.invoices, public.usage_counters from authenticated;
revoke all on public.payment_events from authenticated;
revoke all on sequence public.invoice_number_seq from anon, authenticated;

-- Outcome is the only conversation field owners set for conversion tracking;
-- the existing member update policy already covers it.

-- ---------------------------------------------------------------------------
-- Analytics (SECURITY INVOKER → RLS applies; a non-member gets zeros)
-- ---------------------------------------------------------------------------
create or replace function public.analytics_summary(p_tenant uuid, p_from timestamptz, p_to timestamptz)
returns jsonb language sql stable security invoker set search_path = public as $$
  with conv as (
    select c.* from public.conversations c
    where c.tenant_id = p_tenant and not c.is_test and c.created_at >= p_from and c.created_at < p_to
  ),
  tz as (select coalesce((select timezone from public.tenants where id = p_tenant), 'Asia/Kuala_Lumpur') as z)
  select jsonb_build_object(
    'conversations', (select count(*) from conv),
    'by_score', (select coalesce(jsonb_object_agg(coalesce(lead_score::text, 'NONE'), n), '{}'::jsonb)
                 from (select lead_score, count(*) n from conv group by lead_score) s),
    'by_channel', (select coalesce(jsonb_object_agg(channel::text, n), '{}'::jsonb)
                   from (select channel, count(*) n from conv group by channel) s),
    'daily', (select coalesce(jsonb_agg(d order by d->>'day'), '[]'::jsonb) from (
               select jsonb_build_object('day', to_char(date_trunc('day', created_at at time zone (select z from tz)), 'YYYY-MM-DD'),
                                         'PANAS', count(*) filter (where lead_score = 'PANAS'),
                                         'SUAM', count(*) filter (where lead_score = 'SUAM'),
                                         'SEJUK', count(*) filter (where lead_score = 'SEJUK'),
                                         'NONE', count(*) filter (where lead_score is null)) d
               from conv group by date_trunc('day', created_at at time zone (select z from tz))) x),
    'conversion', (select coalesce(jsonb_object_agg(coalesce(lead_score::text, 'NONE'),
                     jsonb_build_object('leads', n, 'won', won, 'lost', lost, 'value_cents', val)), '{}'::jsonb)
                   from (select lead_score, count(*) n,
                                count(*) filter (where outcome = 'won') won,
                                count(*) filter (where outcome = 'lost') lost,
                                coalesce(sum(outcome_value_cents) filter (where outcome = 'won'), 0) val
                         from conv group by lead_score) s),
    'handoffs', (select count(*) from conv where handoff_at is not null),
    'empty_enquiries', (select count(*) from conv where customer_message_count <= 1 and coalesce(lead_score::text, 'SEJUK') = 'SEJUK'),
    'first_response_median_s', (select percentile_cont(0.5) within group (order by first_response_seconds) from conv where first_response_seconds is not null),
    'first_response_p90_s', (select percentile_cont(0.9) within group (order by first_response_seconds) from conv where first_response_seconds is not null),
    'human_response_median_s', (select percentile_cont(0.5) within group (order by human_response_seconds) from conv where human_response_seconds is not null),
    'messages', (select jsonb_build_object(
                   'customer', count(*) filter (where m.sender = 'customer'),
                   'ai', count(*) filter (where m.sender = 'ai'),
                   'human', count(*) filter (where m.sender = 'human'),
                   'system', count(*) filter (where m.sender = 'system'))
                 from public.messages m join conv on conv.id = m.conversation_id)
  );
$$;
revoke all on function public.analytics_summary(uuid, timestamptz, timestamptz) from public, anon;
grant execute on function public.analytics_summary(uuid, timestamptz, timestamptz) to authenticated, service_role;

-- Platform admin overview: AI replies used in each tenant's CURRENT usage period. Service role only.
create or replace function public.admin_current_usage()
returns table (tenant_id uuid, period_start timestamptz, ai_replies integer)
language sql stable security definer set search_path = public as $$
  select s.tenant_id, public.usage_period_start(s.billing_anchor), coalesce(u.ai_replies, 0)
  from public.subscriptions s
  left join public.usage_counters u
    on u.tenant_id = s.tenant_id and u.period_start = public.usage_period_start(s.billing_anchor);
$$;
revoke all on function public.admin_current_usage() from public, anon, authenticated;
grant execute on function public.admin_current_usage() to service_role;
