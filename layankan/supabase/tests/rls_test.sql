-- Tenant isolation tests. Each check raises an exception on failure, so the
-- script exits non-zero (ON_ERROR_STOP) the moment isolation breaks.
\set ON_ERROR_STOP 1
set client_min_messages = notice;

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a@example.com'),
  ('00000000-0000-0000-0000-0000000000a2', 'staff-a@example.com'),
  ('00000000-0000-0000-0000-0000000000b1', 'owner-b@example.com');

create function public._t_as(uid text) returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false);
end $$;

create function public._t_assert(cond boolean, msg text) returns void language plpgsql as $$
begin
  if cond is distinct from true then raise exception 'RLS TEST FAILED: %', msg; end if;
  raise notice 'ok - %', msg;
end $$;

-- Expect a statement to be rejected (permission/RLS error) or to affect 0 rows.
create function public._t_rejects(stmt text, msg text) returns void language plpgsql as $$
declare n integer;
begin
  begin
    execute stmt;
    get diagnostics n = row_count;
    if n > 0 then raise exception 'RLS TEST FAILED: % (affected % rows)', msg, n; end if;
  exception
    when insufficient_privilege or check_violation or not_null_violation or no_data_found then null;
  end;
  raise notice 'ok - %', msg;
end $$;
grant execute on function public._t_as(text), public._t_assert(boolean, text), public._t_rejects(text, text) to authenticated, anon;

-- Owners create their workspaces through the onboarding RPC.
select public._t_as('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public.create_workspace('Klinik Ana', 'klinik-ana', 'klinik') as tenant_a \gset
reset role;
select public._t_as('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
select public.create_workspace('Kedai Bob', 'kedai-bob', 'runcit') as tenant_b \gset
reset role;
select set_config('test.a', :'tenant_a', false), set_config('test.b', :'tenant_b', false);

insert into public.tenant_members (tenant_id, user_id, role) values
  (:'tenant_a', '00000000-0000-0000-0000-0000000000a2', 'staff');

insert into public.contacts (id, tenant_id, channel, external_id) values
  ('10000000-0000-0000-0000-00000000000a', :'tenant_a', 'web', 'visitor-a'),
  ('10000000-0000-0000-0000-00000000000b', :'tenant_b', 'web', 'visitor-b');
insert into public.conversations (id, tenant_id, contact_id, channel, lead_score) values
  ('20000000-0000-0000-0000-00000000000a', :'tenant_a', '10000000-0000-0000-0000-00000000000a', 'web', 'PANAS'),
  ('20000000-0000-0000-0000-00000000000b', :'tenant_b', '10000000-0000-0000-0000-00000000000b', 'web', 'SEJUK');
insert into public.messages (tenant_id, conversation_id, direction, sender, body, channel, status) values
  (:'tenant_a', '20000000-0000-0000-0000-00000000000a', 'inbound', 'customer', 'Nak book', 'web', 'received'),
  (:'tenant_b', '20000000-0000-0000-0000-00000000000b', 'inbound', 'customer', 'Harga?', 'web', 'received');
insert into public.ai_assessments (tenant_id, conversation_id, score, model, prompt_template_version) values
  (:'tenant_a', '20000000-0000-0000-0000-00000000000a', 'PANAS', 'test', 'v1'),
  (:'tenant_b', '20000000-0000-0000-0000-00000000000b', 'SEJUK', 'test', 'v1');
insert into public.channel_connections (id, tenant_id, channel, provider, waba_owner) values
  ('30000000-0000-0000-0000-00000000000a', :'tenant_a', 'whatsapp', 'murpati', 'client'),
  ('30000000-0000-0000-0000-00000000000b', :'tenant_b', 'whatsapp', 'meta_cloud', 'client');
insert into public.channel_credentials (tenant_id, connection_id, name, key_id, ciphertext) values
  (:'tenant_a', '30000000-0000-0000-0000-00000000000a', 'api_key', 'k1', 'c2VjcmV0'),
  (:'tenant_b', '30000000-0000-0000-0000-00000000000b', 'access_token', 'k1', 'c2VjcmV0');

-- ===================================================================== owner A
select public._t_as('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public._t_assert((select count(*) from public.tenants) = 1, 'owner A sees exactly one tenant');
select public._t_assert((select slug from public.tenants) = 'klinik-ana', 'owner A sees only own tenant');
select public._t_assert((select count(*) from public.conversations) = 1, 'owner A sees only own conversations');
select public._t_assert((select count(*) from public.messages) = 1, 'owner A sees only own messages');
select public._t_assert((select count(*) from public.contacts) = 1, 'owner A sees only own contacts');
select public._t_assert((select count(*) from public.ai_assessments) = 1, 'owner A sees only own AI assessments');
select public._t_assert((select count(*) from public.business_brains) = 1, 'owner A sees only own brain');
select public._t_assert((select count(*) from public.brain_revisions) >= 1, 'owner A sees own brain revisions');
select public._t_assert((select count(*) from public.channel_connections) = 1, 'owner A sees only own channel connection');

select public._t_rejects('select * from public.channel_credentials', 'credentials table unreadable from browser (even own tenant)');
select public._t_rejects(format($q$insert into public.contacts (tenant_id, channel, external_id) values (%L, 'web', 'evil')$q$, current_setting('test.b')),
  'owner A cannot insert contact into tenant B');
select public._t_rejects(format($q$update public.conversations set status = 'closed' where tenant_id = %L$q$, current_setting('test.b')),
  'owner A cannot update tenant B conversations');
select public._t_rejects(format($q$update public.business_brains set extra_knowledge = 'pwned' where tenant_id = %L$q$, current_setting('test.b')),
  'owner A cannot edit tenant B brain');
select public._t_rejects(format($q$delete from public.conversations where tenant_id = %L$q$, current_setting('test.b')),
  'owner A cannot delete tenant B conversations');
select public._t_rejects(format($q$insert into public.tenant_members (tenant_id, user_id, role) values (%L, '00000000-0000-0000-0000-0000000000a1', 'owner')$q$, current_setting('test.b')),
  'owner A cannot add themselves to tenant B');
select public._t_rejects(format($q$insert into public.messages (tenant_id, conversation_id, direction, sender, body, channel, status, sent_by) values (%L, '20000000-0000-0000-0000-00000000000b', 'outbound', 'human', 'hi', 'web', 'sent', '00000000-0000-0000-0000-0000000000a1')$q$, current_setting('test.b')),
  'owner A cannot post a message into tenant B conversation');
select public._t_rejects($q$update public.tenants set plan = 'free-forever'$q$, 'owner cannot change own plan');
select public._t_rejects($q$update public.messages set body = 'edited'$q$, 'messages are immutable from browser');
select public._t_rejects($q$delete from public.ai_assessments$q$, 'assessment log is append-only from browser');
select public._t_assert(public.is_tenant_member(current_setting('test.b')::uuid) = false, 'is_tenant_member false for other tenant');

-- Owner can legitimately reply in own tenant.
insert into public.messages (tenant_id, conversation_id, direction, sender, body, channel, status, sent_by)
values (current_setting('test.a')::uuid, '20000000-0000-0000-0000-00000000000a', 'outbound', 'human', 'Boleh!', 'web', 'sent', '00000000-0000-0000-0000-0000000000a1');
select public._t_assert(true, 'owner A can reply in own conversation');
select public._t_rejects($q$insert into public.messages (tenant_id, conversation_id, direction, sender, body, channel, status, sent_by) values (current_setting('test.a')::uuid, '20000000-0000-0000-0000-00000000000a', 'outbound', 'ai', 'spoof', 'web', 'sent', '00000000-0000-0000-0000-0000000000a1')$q$,
  'browser cannot spoof AI messages');
reset role;

-- ===================================================================== staff A
select public._t_as('00000000-0000-0000-0000-0000000000a2');
set role authenticated;
select public._t_assert((select count(*) from public.conversations) = 1, 'staff A sees tenant A conversations');
select public._t_rejects(format($q$update public.tenant_members set role = 'owner' where user_id = '00000000-0000-0000-0000-0000000000a2'$q$),
  'staff cannot promote themselves to owner');
select public._t_rejects(format($q$delete from public.conversations where tenant_id = %L$q$, current_setting('test.a')),
  'staff cannot delete customer data (owner-only)');
select public._t_rejects(format($q$update public.tenants set name = 'hijack' where id = %L$q$, current_setting('test.a')),
  'staff cannot edit workspace settings');
select public.update_my_notification_prefs(current_setting('test.a')::uuid, '{"email_handoff": false}');
select public._t_assert((select role from public.tenant_members where user_id = auth.uid()) = 'staff', 'prefs RPC does not change role');
reset role;

-- ===================================================================== owner B
select public._t_as('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
select public._t_assert((select count(*) from public.messages) = 1, 'owner B sees only own messages (not A''s reply)');
select public._t_assert((select string_agg(slug, ',') from public.tenants) = 'kedai-bob', 'owner B sees only own tenant');
reset role;

-- ===================================================================== anonymous
select set_config('request.jwt.claims', '', false);
set role anon;
select public._t_rejects('select * from public.conversations', 'anon cannot read conversations');
select public._t_rejects('select * from public.tenants', 'anon cannot read tenants');
select public._t_rejects('select * from public.business_brains', 'anon cannot read brains');
select public._t_rejects($q$select public.rate_limit_hit('x', 60, 5)$q$, 'anon cannot call rate limiter');
reset role;

-- ===================================================================== no-membership user
insert into auth.users (id, email) values ('00000000-0000-0000-0000-0000000000c1', 'stranger@example.com');
select public._t_as('00000000-0000-0000-0000-0000000000c1');
set role authenticated;
select public._t_assert((select count(*) from public.tenants) = 0, 'signed-in stranger sees no tenants');
select public._t_assert((select count(*) from public.messages) = 0, 'signed-in stranger sees no messages');
reset role;

-- ===================================================================== Phase 2: WhatsApp
insert into public.message_templates (tenant_id, name, body_text) values
  (current_setting('test.a')::uuid, 'follow_up_a', 'Hi {{1}}'),
  (current_setting('test.b')::uuid, 'follow_up_b', 'Hi {{1}}');
select public._t_rejects($q$insert into public.channel_connections (tenant_id, channel, provider, official_api) values (current_setting('test.a')::uuid, 'whatsapp', 'murpati', false)$q$,
  'unofficial WhatsApp connections are refused by the database');
update public.channel_connections set phone_number_id = 'PN-1' where id = '30000000-0000-0000-0000-00000000000a';
do $$ begin
  update public.channel_connections set phone_number_id = 'PN-1' where id = '30000000-0000-0000-0000-00000000000b';
  raise exception 'RLS TEST FAILED: same phone number active in two workspaces';
exception when unique_violation then raise notice 'ok - a phone number can be active in only one workspace';
end $$;

select public._t_as('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public._t_assert((select count(*) from public.message_templates) = 1, 'owner A sees only own templates');
select public._t_rejects(format($q$select public.switch_active_connection(%L, '30000000-0000-0000-0000-00000000000b')$q$, current_setting('test.b')),
  'owner A cannot switch tenant B channel');
select public._t_rejects($q$select public.switch_active_connection(current_setting('test.a')::uuid, '30000000-0000-0000-0000-00000000000b')$q$,
  'owner A cannot activate tenant B connection inside own tenant');
-- legitimate switch inside own tenant
insert into public.channel_connections (id, tenant_id, channel, provider, is_active) values
  ('30000000-0000-0000-0000-0000000000a2', current_setting('test.a')::uuid, 'whatsapp', 'meta_cloud', false);
select public.switch_active_connection(current_setting('test.a')::uuid, '30000000-0000-0000-0000-0000000000a2');
select public._t_assert((select provider from public.channel_connections where channel = 'whatsapp' and is_active) = 'meta_cloud', 'owner A switched Murpati -> Meta Cloud atomically');
select public._t_assert((select count(*) from public.channel_connections where channel = 'whatsapp' and is_active) = 1, 'exactly one active WhatsApp connection after switch');
reset role;

select public._t_as('00000000-0000-0000-0000-0000000000a2');
set role authenticated;
select public._t_rejects($q$select public.switch_active_connection(current_setting('test.a')::uuid, '30000000-0000-0000-0000-00000000000a')$q$,
  'staff cannot switch channel provider');
select public._t_rejects($q$insert into public.message_templates (tenant_id, name) values (current_setting('test.a')::uuid, 'x')$q$,
  'staff cannot add templates');
reset role;

-- ===================================================================== Phase 3: billing & analytics
select public._t_assert((select count(*) from public.subscriptions where tenant_id in (current_setting('test.a')::uuid, current_setting('test.b')::uuid) and plan_id = 'trial' and status = 'trialing') = 2,
  'new workspaces start on a trial automatically');
select public._t_assert((select plan_id from public.subscriptions where tenant_id = '00000000-0000-4000-8000-000000000001') = 'internal', 'platform workspace is on the internal plan');
insert into public.invoices (tenant_id, number, plan_id, description, amount_cents, period_start, period_end, gateway) values
  (current_setting('test.a')::uuid, 'T-A-1', 'asas', 'test', 9900, now(), now() + interval '1 month', 'manual'),
  (current_setting('test.b')::uuid, 'T-B-1', 'asas', 'test', 9900, now(), now() + interval '1 month', 'manual');
select public.increment_usage(current_setting('test.a')::uuid, 3, 4, 3);
select public.increment_usage(current_setting('test.a')::uuid, 2);
select public._t_assert((select ai_replies from public.usage_counters where tenant_id = current_setting('test.a')::uuid) = 5, 'usage counter increments atomically');
update public.conversations set outcome = 'won', outcome_value_cents = 50000 where id = '20000000-0000-0000-0000-00000000000a';

select public._t_as('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public._t_assert((select count(*) from public.subscriptions) = 1, 'owner A sees only own subscription');
select public._t_assert((select count(*) from public.invoices) = 1, 'owner A sees only own invoices');
select public._t_assert((select count(*) from public.usage_counters) = 1, 'owner A sees only own usage');
select public._t_assert((select count(*) from public.plans) >= 5, 'plans catalogue is readable');
select public._t_rejects($q$update public.subscriptions set plan_id = 'pro', status = 'active'$q$, 'owner cannot self-upgrade the subscription');
select public._t_rejects($q$update public.invoices set status = 'paid'$q$, 'owner cannot mark an invoice paid');
select public._t_rejects($q$insert into public.invoices (tenant_id, number, plan_id, description, amount_cents, period_start, period_end, gateway) values (current_setting('test.a')::uuid, 'X', 'pro', 'x', 0, now(), now(), 'manual')$q$, 'owner cannot create invoices');
select public._t_rejects($q$update public.usage_counters set ai_replies = 0$q$, 'owner cannot reset usage');
select public._t_rejects($q$select public.increment_usage(current_setting('test.a')::uuid, -1000)$q$, 'owner cannot call the usage meter');
select public._t_rejects($q$select * from public.payment_events$q$, 'payment events are server-only');
select public._t_rejects($q$update public.plans set price_cents = 0$q$, 'owner cannot edit plan prices');
select public._t_rejects($q$select * from public.admin_current_usage()$q$, 'owners cannot read the cross-tenant admin usage overview');
select public._t_assert((public.analytics_summary(current_setting('test.a')::uuid, now() - interval '1 day', now() + interval '1 day') -> 'conversion' -> 'PANAS' ->> 'won')::int = 1, 'owner A analytics includes own conversion');
select public._t_assert((public.analytics_summary(current_setting('test.b')::uuid, now() - interval '1 day', now() + interval '1 day') ->> 'conversations')::int = 0, 'owner A gets ZERO analytics for tenant B (RLS)');
reset role;
select public._t_assert(public.usage_period_start('2026-01-31 10:00+00', '2026-03-01 09:00+00') = '2026-02-28 10:00+00', 'usage period clamps month ends (Jan 31 → Feb 28)');
select public._t_assert(public.usage_period_start('2026-01-15 00:00+00', '2026-01-20 00:00+00') = '2026-01-15 00:00+00', 'usage period: first month');
-- response-time trigger
update public.conversations set handoff_at = now() - interval '30 seconds' where id = '20000000-0000-0000-0000-00000000000b';
insert into public.messages (tenant_id, conversation_id, direction, sender, body, channel, status) values
  (current_setting('test.b')::uuid, '20000000-0000-0000-0000-00000000000b', 'outbound', 'human', 'Ya saya', 'web', 'sent');
select public._t_assert((select first_response_seconds is not null and human_response_seconds between 29 and 31 from public.conversations where id = '20000000-0000-0000-0000-00000000000b'), 'response times are tracked by trigger');

-- ===================================================================== Chat assignment
select public._t_as('00000000-0000-0000-0000-0000000000a2');
set role authenticated;
update public.conversations set assigned_to = '00000000-0000-0000-0000-0000000000a2', status = 'human' where id = '20000000-0000-0000-0000-00000000000a';
select public._t_assert((select assigned_to = '00000000-0000-0000-0000-0000000000a2' and assigned_at is not null from public.conversations where id = '20000000-0000-0000-0000-00000000000a'), 'staff can take a chat (assigned_at stamped)');
select public._t_rejects($q$update public.conversations set assigned_to = '00000000-0000-0000-0000-0000000000b1' where id = '20000000-0000-0000-0000-00000000000a'$q$,
  'cannot assign a chat to someone outside the workspace');
select public._t_assert((public.take_conversation('20000000-0000-0000-0000-00000000000a') ->> 'ok')::boolean, 'holder can re-take own chat');
select public._t_assert((public.take_conversation('20000000-0000-0000-0000-00000000000b') ->> 'ok') = 'false', 'cannot take another workspace''s chat (RLS: nothing to update)');
select public.update_my_display_name(current_setting('test.a')::uuid, 'Aisyah');
select public._t_assert((select display_name from public.tenant_members where user_id = auth.uid()) = 'Aisyah', 'staff can set own display name');
select public._t_assert((select role from public.tenant_members where user_id = auth.uid()) = 'staff', 'display-name RPC does not change role');
reset role;
-- owner A tries to grab staff's chat without force → refused, with force → allowed
select public._t_as('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public._t_assert((public.take_conversation('20000000-0000-0000-0000-00000000000a') ->> 'ok') = 'false', 'colleague cannot silently take a held chat');
select public._t_assert((public.take_conversation('20000000-0000-0000-0000-00000000000a', true) ->> 'assigned_to') = '00000000-0000-0000-0000-0000000000a1', 'explicit take-over (force) works');
reset role;
update public.conversations set assigned_to = '00000000-0000-0000-0000-0000000000a2' where id = '20000000-0000-0000-0000-00000000000a';
delete from public.tenant_members where user_id = '00000000-0000-0000-0000-0000000000a2';
select public._t_assert((select assigned_to is null from public.conversations where id = '20000000-0000-0000-0000-00000000000a'), 'removing a staff member releases their chats');

\echo 'ALL RLS TESTS PASSED'
