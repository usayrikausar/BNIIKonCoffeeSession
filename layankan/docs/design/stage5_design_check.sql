-- Design check for docs/design/stage5_data_model.sql (DRAFT, not applied anywhere real).
-- Applied on a throwaway Postgres AFTER the real migrations + the draft.
-- Proves the draft's safety rules hold. Run: npm run test:design
\set ON_ERROR_STOP 1
set client_min_messages = notice;

insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a@example.com', now()),
  ('00000000-0000-0000-0000-0000000000a2', 'staff-a@example.com', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'owner-b@example.com', now());

create function public._d_as(uid text) returns void language plpgsql as $$
begin perform set_config('request.jwt.claims', json_build_object('sub', uid, 'role', 'authenticated')::text, false); end $$;
create function public._d_ok(cond boolean, msg text) returns void language plpgsql as $$
begin if cond is distinct from true then raise exception 'DESIGN CHECK FAILED: %', msg; end if; raise notice 'ok - %', msg; end $$;
-- Must be refused (permission, RLS, check/trigger) or affect 0 rows.
create function public._d_refused(stmt text, msg text) returns void language plpgsql as $$
declare n integer;
begin
  begin
    execute stmt;
    get diagnostics n = row_count;
    if n > 0 then raise exception 'DESIGN CHECK FAILED: % (affected % rows)', msg, n; end if;
  exception when insufficient_privilege or check_violation or not_null_violation or unique_violation then null;
  end;
  raise notice 'ok - %', msg;
end $$;
grant execute on function public._d_as(text), public._d_ok(boolean, text), public._d_refused(text, text) to authenticated;

select public._d_as('00000000-0000-0000-0000-0000000000a1'); set role authenticated;
select public.create_workspace('Klinik A', 'klinik-a', 'klinik') as ta \gset
reset role;
select public._d_as('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select public.create_workspace('Kedai B', 'kedai-b', 'runcit') as tb \gset
reset role;
select set_config('d.a', :'ta', false), set_config('d.b', :'tb', false);
insert into public.tenant_members (tenant_id, user_id, role) values (:'ta', '00000000-0000-0000-0000-0000000000a2', 'staff');

insert into public.channel_connections (id, tenant_id, channel, provider, is_active, status, phone_number_id) values
  ('30000000-0000-0000-0000-0000000000aa', :'ta', 'whatsapp', 'meta_cloud', true, 'connected', 'PN-A'),
  ('30000000-0000-0000-0000-0000000000bb', :'tb', 'whatsapp', 'meta_cloud', true, 'connected', 'PN-B');
insert into public.contacts (id, tenant_id, channel, external_id) values
  ('10000000-0000-0000-0000-0000000000a1', :'ta', 'whatsapp', '60111'),
  ('10000000-0000-0000-0000-0000000000a2', :'ta', 'whatsapp', '60112'),
  ('10000000-0000-0000-0000-0000000000b1', :'tb', 'whatsapp', '60199');
insert into public.conversations (id, tenant_id, contact_id, channel) values
  ('20000000-0000-0000-0000-0000000000a1', :'ta', '10000000-0000-0000-0000-0000000000a1', 'whatsapp'),
  ('20000000-0000-0000-0000-0000000000b1', :'tb', '10000000-0000-0000-0000-0000000000b1', 'whatsapp');
insert into public.messages (id, tenant_id, conversation_id, direction, sender, body, channel, status) values
  ('40000000-0000-0000-0000-0000000000a1', :'ta', '20000000-0000-0000-0000-0000000000a1', 'inbound', 'customer', 'YA, saya setuju', 'whatsapp', 'received');

-- ═══════════════════════════════════════ R1/R6 opt-in + broadcasts
insert into public.marketing_consent_events (tenant_id, contact_id, channel, action, method, consent_text, consent_text_version, evidence_message_id)
values (:'ta', '10000000-0000-0000-0000-0000000000a1', 'whatsapp', 'granted', 'chat_reply', 'Boleh kami hantar promosi sekali-sekala? Balas YA. (Balas STOP bila-bila masa)', 'v1', '40000000-0000-0000-0000-0000000000a1')
returning id as grant_a1 \gset
insert into public.broadcasts (id, tenant_id, connection_id, name, template_name) values
  ('50000000-0000-0000-0000-0000000000a1', :'ta', '30000000-0000-0000-0000-0000000000aa', 'Promo Raya', 'promo_raya');

select public._d_ok((select count(*) = 1 from public.marketing_consent_current where contact_id = '10000000-0000-0000-0000-0000000000a1' and action = 'granted'), 'current-consent view shows the grant');
insert into public.broadcast_recipients (broadcast_id, contact_id, tenant_id, consent_event_id)
  values ('50000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000a1', :'ta', :grant_a1);
select public._d_ok(true, 'opted-in contact can be added to a broadcast');
select public._d_refused(format($q$insert into public.broadcast_recipients (broadcast_id, contact_id, tenant_id, consent_event_id)
  values ('50000000-0000-0000-0000-0000000000a1', '10000000-0000-0000-0000-0000000000a2', %L, %s)$q$, current_setting('d.a'), :grant_a1),
  'contact WITHOUT opt-in cannot be added (even citing someone else''s consent)');
select public._d_refused(format($q$insert into public.marketing_consent_events (tenant_id, contact_id, channel, action, method, consent_text, consent_text_version)
  values (%L, '10000000-0000-0000-0000-0000000000a2', 'whatsapp', 'granted', 'staff_withdrawal', 'staff says customer agreed on the phone', 'v1')$q$, current_setting('d.a')),
  'staff cannot record a GRANT on a customer''s behalf');
-- STOP: Phase 2 sets opted_out_at → the draft trigger records the withdrawal → no more broadcasts
update public.contacts set opted_out_at = now() where id = '10000000-0000-0000-0000-0000000000a1';
select public._d_ok((select action = 'withdrawn' and method = 'stop_keyword' from public.marketing_consent_current where contact_id = '10000000-0000-0000-0000-0000000000a1'), 'STOP automatically writes a withdrawal into the consent history');
insert into public.broadcasts (id, tenant_id, connection_id, name, template_name) values
  ('50000000-0000-0000-0000-0000000000a2', :'ta', '30000000-0000-0000-0000-0000000000aa', 'Promo 2', 'promo_2');
select public._d_refused(format($q$insert into public.broadcast_recipients (broadcast_id, contact_id, tenant_id, consent_event_id)
  values ('50000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-0000000000a1', %L, %s)$q$, current_setting('d.a'), :grant_a1),
  'after STOP the old grant can no longer be used');
select public._d_refused(format($q$insert into public.broadcasts (tenant_id, connection_id, name, template_name) values (%L, '30000000-0000-0000-0000-0000000000bb', 'x', 'x')$q$, current_setting('d.a')),
  'a broadcast cannot use another business''s WhatsApp number');

select public._d_as('00000000-0000-0000-0000-0000000000a2'); set role authenticated;
select public._d_refused($q$update public.marketing_consent_events set action = 'granted'$q$, 'staff cannot edit consent history');
select public._d_refused($q$delete from public.marketing_consent_events$q$, 'staff cannot delete consent history');
select public._d_refused($q$insert into public.broadcast_recipients (broadcast_id, contact_id, tenant_id, consent_event_id) select '50000000-0000-0000-0000-0000000000a2', '10000000-0000-0000-0000-0000000000a2', tenant_id, 1 from public.contacts limit 1$q$,
  'members cannot add broadcast recipients directly (server only)');
select public._d_refused(format($q$insert into public.broadcasts (tenant_id, connection_id, name, template_name) values (%L, '30000000-0000-0000-0000-0000000000aa', 'x', 'x')$q$, current_setting('d.a')),
  'only owners create broadcasts');
insert into public.marketing_consent_events (tenant_id, contact_id, channel, action, method, consent_text, consent_text_version, recorded_by)
  values (current_setting('d.a')::uuid, '10000000-0000-0000-0000-0000000000a2', 'whatsapp', 'withdrawn', 'staff_withdrawal', 'Customer asked by phone to stop promotions', 'v1', auth.uid());
select public._d_ok(true, 'staff can record a withdrawal');
reset role;

-- ═══════════════════════════════════════ R2 payment links
insert into public.payment_accounts (id, tenant_id, gateway, status, collection_ref) values
  ('60000000-0000-0000-0000-0000000000a1', :'ta', 'billplz', 'connected', 'col_a'),
  ('60000000-0000-0000-0000-0000000000b1', :'tb', 'toyyibpay', 'connected', 'cat_b');
select public._d_as('00000000-0000-0000-0000-0000000000a2'); set role authenticated;
insert into public.payment_links (tenant_id, account_id, conversation_id, created_by, amount_cents, description)
  values (current_setting('d.a')::uuid, '60000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000a1', auth.uid(), 8000, 'Cuci gigi');
select public._d_ok(true, 'staff can create a payment link in their own chat');
select public._d_refused(format($q$insert into public.payment_links (tenant_id, account_id, created_by, amount_cents, description, status, paid_at) values (%L, '60000000-0000-0000-0000-0000000000a1', auth.uid(), 8000, 'x', 'paid', now())$q$, current_setting('d.a')),
  'nobody can create a link that is already "paid"');
select public._d_refused($q$update public.payment_links set status = 'paid', paid_at = now()$q$, 'members cannot mark a link paid (only verified gateway callbacks)');
select public._d_refused(format($q$insert into public.payment_links (tenant_id, account_id, created_by, amount_cents, description) values (%L, '60000000-0000-0000-0000-0000000000b1', auth.uid(), 8000, 'x')$q$, current_setting('d.a')),
  'a link cannot use another business''s payment account (money must go to the right business)');
select public._d_refused(format($q$insert into public.payment_links (tenant_id, account_id, conversation_id, created_by, amount_cents, description) values (%L, '60000000-0000-0000-0000-0000000000a1', '20000000-0000-0000-0000-0000000000b1', auth.uid(), 8000, 'x')$q$, current_setting('d.a')),
  'a link cannot be attached to another business''s chat');
select public._d_refused(format($q$insert into public.payment_links (tenant_id, account_id, created_by, amount_cents, description) values (%L, '60000000-0000-0000-0000-0000000000a1', auth.uid(), 0, 'x')$q$, current_setting('d.a')),
  'amount must be at least RM1');
select public._d_refused($q$select * from public.payment_account_credentials$q$, 'payment API keys are invisible to members');
reset role;

-- ═══════════════════════════════════════ R3 customer memory
insert into public.customers (id, tenant_id, display_name) values ('70000000-0000-0000-0000-0000000000a1', :'ta', 'Ali');
update public.contacts set customer_id = '70000000-0000-0000-0000-0000000000a1' where id = '10000000-0000-0000-0000-0000000000a2';
insert into public.customer_memories (tenant_id, customer_id, kind, content, source) values (:'ta', '70000000-0000-0000-0000-0000000000a1', 'preference', 'Suka slot pagi Sabtu', 'ai');
select public._d_refused(format($q$update public.contacts set customer_id = '70000000-0000-0000-0000-0000000000a1' where id = '10000000-0000-0000-0000-0000000000b1'$q$),
  'a contact of business B cannot be linked to a customer of business A');
select public._d_refused(format($q$insert into public.customer_memories (tenant_id, customer_id, kind, content, source) values (%L, '70000000-0000-0000-0000-0000000000a1', 'note', 'x', 'ai')$q$, current_setting('d.b')),
  'business B cannot attach a memory to business A''s customer');
select public._d_refused(format($q$insert into public.customer_memories (tenant_id, customer_id, kind, content, source) values (%L, '70000000-0000-0000-0000-0000000000a1', 'note', repeat('x', 301), 'staff')$q$, current_setting('d.a')),
  'memories are short (max 300 characters)');
select public._d_as('00000000-0000-0000-0000-0000000000b1'); set role authenticated;
select public._d_ok((select count(*) = 0 from public.customer_memories), 'business B sees none of A''s customer memories');
select public._d_ok((select count(*) = 0 from public.payment_links), 'business B sees none of A''s payment links');
select public._d_ok((select count(*) = 0 from public.marketing_consent_events), 'business B sees none of A''s consent records');
reset role;
delete from public.contacts where id = '10000000-0000-0000-0000-0000000000a2';  -- PDPA delete
select public._d_ok((select count(*) = 0 from public.customers where id = '70000000-0000-0000-0000-0000000000a1'), 'deleting the last contact deletes the customer');
select public._d_ok((select count(*) = 0 from public.customer_memories where customer_id = '70000000-0000-0000-0000-0000000000a1'), '…and all their memories (PDPA)');

-- ═══════════════════════════════════════ R4/R5 Instagram, Messenger, comments
insert into public.channel_connections (id, tenant_id, channel, provider, is_active, status, page_id, ig_account_id) values
  ('30000000-0000-0000-0000-0000000001aa', :'ta', 'instagram', 'meta_instagram', true, 'connected', 'PAGE-A', 'IG-A');
select public._d_ok(true, 'an Instagram connection fits the existing connection model');
select public._d_refused(format($q$insert into public.channel_connections (tenant_id, channel, provider, is_active, status, ig_account_id) values (%L, 'instagram', 'meta_instagram', true, 'connected', 'IG-A')$q$, current_setting('d.b')),
  'the same Instagram account cannot be live in two businesses');
select public._d_refused(format($q$insert into public.channel_connections (tenant_id, channel, provider, official_api) values (%L, 'instagram', 'meta_instagram', false)$q$, current_setting('d.a')),
  'unofficial connections are still refused');
insert into public.social_comments (tenant_id, connection_id, platform, post_id, comment_id, author_external_id, body, matched_keyword)
  values (:'ta', '30000000-0000-0000-0000-0000000001aa', 'instagram', 'POST1', 'C1', 'IGSID-1', 'harga?', 'harga');
select public._d_refused(format($q$insert into public.social_comments (tenant_id, connection_id, platform, post_id, comment_id, author_external_id, body) values (%L, '30000000-0000-0000-0000-0000000001aa', 'instagram', 'POST1', 'C1', 'IGSID-1', 'harga?')$q$, current_setting('d.a')),
  'the same comment is recorded once (so it gets at most one private reply)');
select public._d_ok((select (comment_to_chat ->> 'enabled')::boolean = false from public.business_brains where tenant_id = current_setting('d.a')::uuid), 'comment-to-chat is OFF by default (a Brain setting, no flow builder)');

\echo 'ALL STAGE 5 DESIGN CHECKS PASSED'
