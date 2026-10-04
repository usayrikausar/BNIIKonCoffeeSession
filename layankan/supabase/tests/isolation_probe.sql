-- Tenant-isolation PROBES (audit). Unlike rls_test.sql this does not stop at
-- the first failure: every probe prints PASS or FAIL so the audit can report
-- all findings at once. Run with supabase/tests/run-isolation-probe.sh.
set client_min_messages = notice;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a@example.com', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'owner-b@example.com', now()),
  ('00000000-0000-0000-0000-0000000000e1', 'victim-staff@example.com', null);  -- signed up, email NOT confirmed

create function public._p_as(uid text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false); end $$;
create function public._p(ok boolean, label text) returns void language plpgsql as $$
begin raise notice '% | %', case when ok then 'PASS' else 'FAIL' end, label; end $$;
-- Runs a statement; PASS if it raises or affects 0 rows.
create function public._p_blocked(stmt text, label text) returns void language plpgsql as $$
declare n integer;
begin
  begin
    execute stmt;
    get diagnostics n = row_count;
    perform public._p(n = 0, label || ' (affected ' || n || ')');
  exception when others then
    perform public._p(true, label || ' (refused: ' || sqlstate || ')');
  end;
end $$;
grant execute on function public._p_as(text), public._p(boolean, text), public._p_blocked(text, text) to authenticated, anon;

-- Two workspaces with data.
select public._p_as('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.create_workspace('Tenant A', 'tenant-a', 'umum') as ta \gset
reset role;
select public._p_as('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select public.create_workspace('Tenant B', 'tenant-b', 'umum') as tb \gset
reset role;
select set_config('p.a', :'ta', false), set_config('p.b', :'tb', false);
insert into public.contacts (id, tenant_id, channel, external_id) values
  ('10000000-0000-0000-0000-0000000000aa', :'ta', 'web', 'a'), ('10000000-0000-0000-0000-0000000000bb', :'tb', 'web', 'b');
insert into public.conversations (id, tenant_id, contact_id, channel) values
  ('20000000-0000-0000-0000-0000000000aa', :'ta', '10000000-0000-0000-0000-0000000000aa', 'web'),
  ('20000000-0000-0000-0000-0000000000bb', :'tb', '10000000-0000-0000-0000-0000000000bb', 'web');
insert into public.messages (tenant_id, conversation_id, direction, sender, body, channel, status) values
  (:'tb', '20000000-0000-0000-0000-0000000000bb', 'inbound', 'customer', 'secret B', 'web', 'received');
insert into public.channel_connections (id, tenant_id, channel, provider) values
  ('30000000-0000-0000-0000-0000000000bb', :'tb', 'whatsapp', 'meta_cloud');
-- Pending invite to tenant B for an email someone can sign up with without confirming it.
insert into public.tenant_invites (tenant_id, email, role) values (:'tb', 'victim-staff@example.com', 'staff');

-- ===================================================== 1. read every tenant table (owner A → B rows)
select public._p_as('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
do $$
declare t text; n bigint;
begin
  foreach t in array array['tenants','tenant_members','tenant_invites','business_brains','brain_revisions','brain_sources',
    'channel_connections','contacts','conversations','messages','message_status_events','ai_assessments','notifications',
    'daily_summary_runs','message_templates','subscriptions','invoices','usage_counters','usage_conversations','marketing_consent_events'] loop
    begin
      if t = 'tenants' then
        execute format('select count(*) from public.tenants where id = %L', current_setting('p.b')) into n;
      else
        execute format('select count(*) from public.%I where tenant_id = %L', t, current_setting('p.b')) into n;
      end if;
      perform public._p(n = 0, 'A cannot read B rows in ' || t || ' (saw ' || n || ')');
    exception when insufficient_privilege then perform public._p(true, 'A cannot read ' || t || ' (no privilege)');
    end;
  end loop;
  foreach t in array array['channel_credentials','rate_limits','payment_events'] loop
    begin
      execute format('select count(*) from public.%I', t) into n;
      perform public._p(n = 0, 'server-only table ' || t || ' invisible to members (saw ' || n || ')');
    exception when insufficient_privilege then perform public._p(true, 'server-only table ' || t || ' not readable');
    end;
  end loop;
end $$;

-- ===================================================== 2. RPCs called with tenant B ids
select public._p((public.analytics_summary(current_setting('p.b')::uuid, now() - interval '1 year', now() + interval '1 day') ->> 'conversations')::int = 0,
  'analytics_summary(B) returns nothing to A');
select public._p((public.take_conversation('20000000-0000-0000-0000-0000000000bb') ->> 'ok') = 'false', 'take_conversation(B chat) refused');
select public._p_blocked(format('select public.switch_active_connection(%L, %L)', current_setting('p.b'), '30000000-0000-0000-0000-0000000000bb'),
  'switch_active_connection on B refused');
select public._p(public.current_usage_period(current_setting('p.b')::uuid) is null,
  'current_usage_period(B) does not reveal B billing anchor to A');
select public._p(public.current_usage_period(current_setting('p.a')::uuid) is not null,
  'current_usage_period(A) works for A''s own members (dashboard meter)');

-- ===================================================== 3. cross-tenant references (rows in A pointing at B)
select public._p_blocked(format($q$insert into public.messages (tenant_id, conversation_id, direction, sender, body, channel, status, sent_by)
  values (%L, '20000000-0000-0000-0000-0000000000bb', 'outbound', 'human', 'injected', 'web', 'sent', '00000000-0000-0000-0000-0000000000a1')$q$, current_setting('p.a')),
  'A cannot attach a message to B''s conversation');
select public._p_blocked(format($q$insert into public.conversations (tenant_id, contact_id, channel)
  values (%L, '10000000-0000-0000-0000-0000000000bb', 'web')$q$, current_setting('p.a')),
  'A cannot create a conversation using B''s contact');
select public._p_blocked($q$update public.conversations set channel_connection_id = '30000000-0000-0000-0000-0000000000bb' where id = '20000000-0000-0000-0000-0000000000aa'$q$,
  'A cannot point its conversation at B''s WhatsApp connection');
reset role;

-- ===================================================== 4. invites need a VERIFIED email
select public._p_as('00000000-0000-0000-0000-0000000000e1'); set role authenticated;
select public.accept_my_invites();
select public._p((select count(*) from public.tenants where id = current_setting('p.b')::uuid) = 0,
  'unconfirmed email cannot accept an invite into B');
reset role;

-- ===================================================== 5. anonymous callers
select set_config('request.jwt.claims', '', false); set role anon;
select public._p_blocked($q$select public.create_workspace('x', 'anon-ws', 'umum')$q$, 'anon cannot create a workspace');
select public._p(not has_function_privilege('anon', 'public.accept_my_invites()', 'execute'), 'anon has no EXECUTE on accept_my_invites');
select public._p(not has_function_privilege('anon', 'public.create_workspace(text,text,text)', 'execute'), 'anon has no EXECUTE on create_workspace');
select public._p(not has_function_privilege('anon', 'public.update_my_notification_prefs(uuid,jsonb)', 'execute'), 'anon has no EXECUTE on update_my_notification_prefs');
select public._p_blocked('select * from public.messages', 'anon cannot read messages');
reset role;
