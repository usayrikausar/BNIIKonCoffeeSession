-- Tenant isolation tests. Each check raises an exception on failure, so the
-- script exits non-zero (ON_ERROR_STOP) the moment isolation breaks.
\set ON_ERROR_STOP 1
set client_min_messages = notice;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a@example.com', now()),
  ('00000000-0000-0000-0000-0000000000a2', 'staff-a@example.com', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'owner-b@example.com', now()),
  ('00000000-0000-0000-0000-0000000000d1', 'invited@example.com', null);  -- email not confirmed yet

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
  ('30000000-0000-0000-0000-0000000000cb', :'tenant_b', 'whatsapp', 'meta_cloud', 'client');
insert into public.channel_credentials (tenant_id, connection_id, name, key_id, ciphertext) values
  (:'tenant_a', '30000000-0000-0000-0000-00000000000a', 'api_key', 'k1', 'c2VjcmV0'),
  (:'tenant_b', '30000000-0000-0000-0000-0000000000cb', 'access_token', 'k1', 'c2VjcmV0');

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
  update public.channel_connections set phone_number_id = 'PN-1' where id = '30000000-0000-0000-0000-0000000000cb';
  raise exception 'RLS TEST FAILED: same phone number active in two workspaces';
exception when unique_violation then raise notice 'ok - a phone number can be active in only one workspace';
end $$;

select public._t_as('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public._t_assert((select count(*) from public.message_templates) = 1, 'owner A sees only own templates');
select public._t_rejects(format($q$select public.switch_active_connection(%L, '30000000-0000-0000-0000-0000000000cb')$q$, current_setting('test.b')),
  'owner A cannot switch tenant B channel');
select public._t_rejects($q$select public.switch_active_connection(current_setting('test.a')::uuid, '30000000-0000-0000-0000-0000000000cb')$q$,
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

-- ===================================================================== Cross-tenant references (audit C1)
-- Expect a cross-tenant write to be refused by RLS or by the same-workspace trigger
-- (and not "passed" by some unrelated error such as a typo in the test).
create function public._t_cross(stmt text, msg text) returns void language plpgsql as $$
begin
  begin
    execute stmt;
    raise exception 'RLS TEST FAILED: % (write accepted)', msg;
  exception
    when insufficient_privilege then null;
    when check_violation then
      if sqlerrm not like '%same workspace%' then raise exception 'RLS TEST FAILED: % (wrong error: %)', msg, sqlerrm; end if;
  end;
  raise notice 'ok - %', msg;
end $$;
grant execute on function public._t_cross(text, text) to authenticated;
select public._t_as('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public._t_cross(format($q$insert into public.messages (tenant_id, conversation_id, direction, sender, body, channel, status, sent_by)
  values (%L, '20000000-0000-0000-0000-00000000000b', 'outbound', 'human', 'x', 'web', 'sent', '00000000-0000-0000-0000-0000000000a1')$q$, current_setting('test.a')),
  'A cannot attach a message to B''s conversation');
select public._t_cross(format($q$insert into public.conversations (tenant_id, contact_id, channel) values (%L, '10000000-0000-0000-0000-00000000000b', 'web')$q$, current_setting('test.a')),
  'A cannot open a conversation on B''s contact');
select public._t_cross($q$update public.conversations set channel_connection_id = '30000000-0000-0000-0000-0000000000cb' where id = '20000000-0000-0000-0000-00000000000a'$q$,
  'A cannot point its conversation at B''s WhatsApp connection');
select public._t_cross(format($q$insert into public.message_templates (tenant_id, connection_id, name) values (%L, '30000000-0000-0000-0000-0000000000cb', 'x_probe')$q$, current_setting('test.a')),
  'A cannot create a template on B''s connection');
reset role;
-- even the server (service role) cannot mix tenants by mistake
select public._t_cross(format($q$insert into public.ai_assessments (tenant_id, conversation_id, score, model, prompt_template_version)
  values (%L, '20000000-0000-0000-0000-00000000000b', 'PANAS', 'm', 'v')$q$, current_setting('test.a')),
  'server cannot store an assessment of B''s chat under A');
select public._t_cross(format($q$insert into public.notifications (tenant_id, conversation_id, kind, transport, recipient)
  values (%L, '20000000-0000-0000-0000-00000000000b', 'handoff', 'email', 'x@example.com')$q$, current_setting('test.a')),
  'server cannot file a notification about B''s chat under A');
select public._t_assert((select count(*) = 1 from public.messages where conversation_id = '20000000-0000-0000-0000-00000000000a' and direction = 'inbound'), 'same-tenant writes still work');

-- ===================================================================== Invites need a confirmed email (audit C2)
insert into public.tenant_invites (tenant_id, email, role) values (current_setting('test.b')::uuid, 'invited@example.com', 'staff');
select public._t_as('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select public._t_assert(public.accept_my_invites() = 0, 'unconfirmed email cannot accept an invite');
select public._t_assert((select count(*) from public.tenants) = 0, 'unconfirmed user sees no workspace');
reset role;
update auth.users set email_confirmed_at = now() where id = '00000000-0000-0000-0000-0000000000d1';
select public._t_as('00000000-0000-0000-0000-0000000000d1');
set role authenticated;
select public._t_assert(public.accept_my_invites() = 1, 'confirmed email accepts the invite');
reset role;

-- ===================================================================== Anonymous callers (audit M1, M2)
select public._t_assert(not has_function_privilege('anon', 'public.accept_my_invites()', 'execute'), 'anon cannot run accept_my_invites');
select public._t_assert(not has_function_privilege('anon', 'public.create_workspace(text,text,text)', 'execute'), 'anon cannot run create_workspace');
select public._t_assert(not has_function_privilege('anon', 'public.update_my_notification_prefs(uuid,jsonb)', 'execute'), 'anon cannot run update_my_notification_prefs');
select public._t_as('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public._t_assert(public.current_usage_period(current_setting('test.b')::uuid) is null, 'members cannot read another workspace''s billing period');
select public._t_assert(public.current_usage_period(current_setting('test.a')::uuid) is not null, 'members can read their own billing period (dashboard meter)');
reset role;
select public._t_assert(has_function_privilege('service_role', 'public.current_usage_period(uuid)', 'execute'), 'server can still read the usage period');

-- ===================================================================== Stage 3: conversation-based usage
select public._t_assert((select conversation_limit from public.plans where id = 'niaga') = 400, 'plans carry a monthly conversation limit');
select public._t_assert((select is_new from public.count_conversation(current_setting('test.a')::uuid, '20000000-0000-0000-0000-00000000000a')), 'first AI reply in a month counts the conversation');
select public._t_assert(not (select is_new from public.count_conversation(current_setting('test.a')::uuid, '20000000-0000-0000-0000-00000000000a')), 'further replies in the same month do not count again');
select public._t_assert((select conversations from public.usage_counters where tenant_id = current_setting('test.a')::uuid and period_start = public.current_usage_period(current_setting('test.a')::uuid)) = 1, 'usage counter shows 1 conversation');
select public._t_rejects(format($q$select public.count_conversation(%L, '20000000-0000-0000-0000-00000000000b')$q$, current_setting('test.a')),
  'server cannot count B''s conversation under A');
select public._t_assert(public.claim_usage_alert(current_setting('test.a')::uuid, '2026-10-01', 80), '80% warning claimed once');
select public._t_assert(not public.claim_usage_alert(current_setting('test.a')::uuid, '2026-10-01', 80), '80% warning not sent twice');
select public._t_assert(public.claim_usage_alert(current_setting('test.a')::uuid, '2026-10-01', 100), '100% warning still sent after 80%');
select public._t_assert(public.claim_usage_alert(current_setting('test.a')::uuid, '2026-11-01', 80), 'a new month warns again');
select public._t_as('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public._t_rejects(format($q$select public.count_conversation(%L, '20000000-0000-0000-0000-00000000000a')$q$, current_setting('test.a')), 'owners cannot touch the conversation meter');
select public._t_rejects(format($q$select public.claim_usage_alert(%L, now(), 0)$q$, current_setting('test.a')), 'owners cannot reset usage warnings');
select public._t_rejects($q$delete from public.usage_conversations$q$, 'owners cannot delete counted conversations');
select public._t_assert((select count(*) from public.usage_conversations) = 1, 'owner A sees only own counted conversations');
update public.conversations set follow_up_disabled = true where id = '20000000-0000-0000-0000-00000000000a';
select public._t_assert((select follow_up_disabled from public.conversations where id = '20000000-0000-0000-0000-00000000000a'), 'team can switch follow-ups off for one chat');
reset role;
select public._t_as('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
select public._t_assert((select count(*) from public.usage_conversations) = 0, 'owner B cannot see A''s counted conversations');
reset role;

-- ===================================================================== R1: marketing opt-in records
insert into public.contacts (id, tenant_id, channel, external_id) values
  ('10000000-0000-0000-0000-0000000001a1', current_setting('test.a')::uuid, 'whatsapp', '60111000001');
insert into public.marketing_consent_events (tenant_id, contact_id, channel, action, method, consent_text, consent_text_version)
  values (current_setting('test.a')::uuid, '10000000-0000-0000-0000-0000000001a1', 'whatsapp', 'granted', 'chat_reply', 'Balas PROMO untuk setuju (test wording)', 'optin-test');
select public._t_assert((select action = 'granted' from public.marketing_consent_current where contact_id = '10000000-0000-0000-0000-0000000001a1'), 'server records an opt-in; current view shows it');
select public._t_rejects(format($q$insert into public.marketing_consent_events (tenant_id, contact_id, channel, action, method, consent_text, consent_text_version)
  values (%L, '10000000-0000-0000-0000-0000000001a1', 'whatsapp', 'granted', 'staff_withdrawal', 'staff says yes on their behalf', 'x')$q$, current_setting('test.a')),
  'a grant can only come from the customer''s own action (not staff)');
select public._t_rejects(format($q$insert into public.marketing_consent_events (tenant_id, contact_id, channel, action, method, consent_text, consent_text_version)
  values (%L, '10000000-0000-0000-0000-0000000001a1', 'whatsapp', 'granted', 'imported', 'bought list', 'x')$q$, current_setting('test.a')),
  'there is no "imported" opt-in method');
select public._t_cross(format($q$insert into public.marketing_consent_events (tenant_id, contact_id, channel, action, method, consent_text, consent_text_version)
  values (%L, '10000000-0000-0000-0000-0000000001a1', 'whatsapp', 'granted', 'chat_reply', 'cross-business consent', 'x')$q$, current_setting('test.b')),
  'business B cannot record consent for business A''s contact');
select public._t_as('00000000-0000-0000-0000-0000000000a1');
set role authenticated;
select public._t_rejects($q$update public.marketing_consent_events set action = 'granted'$q$, 'owner cannot edit consent history');
select public._t_rejects($q$delete from public.marketing_consent_events$q$, 'owner cannot delete consent history');
select public._t_rejects(format($q$insert into public.marketing_consent_events (tenant_id, contact_id, channel, action, method, consent_text, consent_text_version, recorded_by)
  values (%L, '10000000-0000-0000-0000-0000000001a1', 'whatsapp', 'granted', 'chat_reply', 'owner fakes a YES reply', 'x', auth.uid())$q$, current_setting('test.a')),
  'owner cannot record an opt-in from the dashboard');
insert into public.marketing_consent_events (tenant_id, contact_id, channel, action, method, consent_text, consent_text_version, recorded_by)
  values (current_setting('test.a')::uuid, '10000000-0000-0000-0000-0000000001a1', 'whatsapp', 'withdrawn', 'staff_withdrawal', 'Customer asked staff to stop promotions.', 'staff', auth.uid());
select public._t_assert((select action = 'withdrawn' from public.marketing_consent_current where contact_id = '10000000-0000-0000-0000-0000000001a1'), 'staff can record "customer asked to stop"');
reset role;
select public._t_as('00000000-0000-0000-0000-0000000000b1');
set role authenticated;
select public._t_assert((select count(*) = 0 from public.marketing_consent_events), 'business B sees none of A''s consent records');
select public._t_assert((select count(*) = 0 from public.marketing_consent_current), '…not even through the current-consent view');
reset role;
update public.contacts set opted_out_at = now() where id = '10000000-0000-0000-0000-0000000001a1';
select public._t_assert((select method = 'stop_keyword' from public.marketing_consent_current where contact_id = '10000000-0000-0000-0000-0000000001a1'), 'STOP automatically records a withdrawal');
select public._t_assert((select (promotions ->> 'ask_optin')::boolean = false from public.business_brains where tenant_id = current_setting('test.a')::uuid), 'asking for promotions is OFF by default');

\echo 'ALL RLS TESTS PASSED'
