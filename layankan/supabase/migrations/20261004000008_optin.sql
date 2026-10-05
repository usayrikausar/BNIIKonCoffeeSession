-- R1 (ROADMAP.md): marketing opt-in capture. Broadcasts themselves are NOT
-- built yet (R6, still in docs/design/stage5_data_model.sql). This records
-- consent now, so future broadcasts can only reach people who said yes.

-- Owner switch, in the Brain: "Ask customers if they'd like promotions".
alter table public.business_brains
  add column promotions jsonb not null default '{"ask_optin": false}'::jsonb;

-- Revisions keep the promotions setting too.
create or replace function public.snapshot_brain()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.brain_revisions (tenant_id, version, snapshot, created_by)
  values (new.tenant_id, new.version,
    jsonb_build_object('profile', new.profile, 'products', new.products, 'faqs', new.faqs,
      'policies', new.policies, 'qualifying_questions', new.qualifying_questions,
      'handoff_rules', new.handoff_rules, 'extra_knowledge', new.extra_knowledge,
      'follow_up', new.follow_up, 'booking', new.booking, 'promotions', new.promotions),
    new.updated_by)
  on conflict (tenant_id, version) do nothing;
  return new;
end;
$$;

-- Each customer is asked at most once.
alter table public.contacts add column marketing_optin_asked_at timestamptz;

-- Append-only consent history. The latest event per contact is the current state.
create table public.marketing_consent_events (
  id bigint generated always as identity primary key,
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  contact_id uuid not null references public.contacts(id) on delete cascade,
  channel public.channel_kind not null,
  action text not null check (action in ('granted', 'withdrawn')),
  -- There is deliberately NO 'imported' method: lists bought or copied from
  -- elsewhere can never become opted-in.
  method text not null check (method in (
    'chat_reply',          -- customer answered YES to the opt-in question (grant)
    'web_checkbox',        -- reserved for a future web-chat checkbox (grant)
    'stop_keyword',        -- customer wrote STOP / BERHENTI (withdrawal)
    'unsubscribe_button',  -- reserved for broadcasts (withdrawal)
    'staff_withdrawal'     -- customer asked a staff member to stop (withdrawal)
  )),
  consent_text text not null check (char_length(consent_text) between 10 and 1000),  -- exact wording shown
  consent_text_version text not null,
  evidence_message_id uuid references public.messages(id) on delete set null,       -- the customer's YES / STOP
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

-- Current state, one row per contact (the base table's RLS applies).
create view public.marketing_consent_current with (security_invoker = true) as
  select distinct on (contact_id) tenant_id, contact_id, channel, action, method, consent_text_version, id as event_id, created_at
  from public.marketing_consent_events
  order by contact_id, id desc;

-- STOP / BERHENTI already sets contacts.opted_out_at (Phase 2); it now also
-- writes a withdrawal into the consent history so the record is complete.
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
revoke all on function public.consent_withdraw_on_opt_out() from public, anon, authenticated;
create trigger contacts_opt_out_withdraws_consent after update of opted_out_at on public.contacts
  for each row execute function public.consent_withdraw_on_opt_out();

-- RLS: members read; members may only RECORD A WITHDRAWAL, as themselves.
-- Grants are written by the server when the customer says YES. Nobody but
-- the server can update or delete: the history is append-only.
alter table public.marketing_consent_events enable row level security;
create policy consent_member_select on public.marketing_consent_events for select to authenticated
  using (public.is_tenant_member(tenant_id));
create policy consent_member_withdraw on public.marketing_consent_events for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and action = 'withdrawn' and method = 'staff_withdrawal' and recorded_by = auth.uid());
revoke update, delete, truncate on public.marketing_consent_events from authenticated;
revoke all on public.marketing_consent_events from anon;
revoke all on public.marketing_consent_current from anon;
grant select on public.marketing_consent_current to authenticated;
