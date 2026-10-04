-- Two businesses with distinctive "secret" markers so leaks are easy to detect.
insert into auth.users (id, email, email_confirmed_at) values
  ('00000000-0000-0000-0000-0000000000a1', 'owner-a@klinik.test', now()),
  ('00000000-0000-0000-0000-0000000000b1', 'owner-b@kedai.test', now());
insert into public.tenants (id, slug, name, status) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'klinik-a', 'Klinik A', 'live'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'kedai-b', 'Kedai B RAHSIAB', 'live');
insert into public.tenant_members (tenant_id, user_id, role, email) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '00000000-0000-0000-0000-0000000000a1', 'owner', 'owner-a@klinik.test'),
  ('bbbbbbbb-0000-4000-8000-000000000001', '00000000-0000-0000-0000-0000000000b1', 'owner', 'owner-b@kedai.test');
insert into public.business_brains (tenant_id, profile, extra_knowledge) values
  ('aaaaaaaa-0000-4000-8000-000000000001', '{"name":"Klinik A"}', ''),
  ('bbbbbbbb-0000-4000-8000-000000000001', '{"name":"Kedai B RAHSIAB"}', 'Kod diskaun dalaman RAHSIAB-DISKAUN');
insert into public.contacts (id, tenant_id, channel, external_id, name) values
  ('cccccccc-0000-4000-8000-0000000000aa', 'aaaaaaaa-0000-4000-8000-000000000001', 'web', 'web_a', 'Pelanggan A'),
  ('cccccccc-0000-4000-8000-0000000000bb', 'bbbbbbbb-0000-4000-8000-000000000001', 'web', 'web_b', 'RAHSIAB Nama');
insert into public.conversations (id, tenant_id, contact_id, channel, lead_score, lead_details, status) values
  ('dddddddd-0000-4000-8000-0000000000aa', 'aaaaaaaa-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-0000000000aa', 'web', 'SUAM', '{"name":"Pelanggan A"}', 'needs_human'),
  ('dddddddd-0000-4000-8000-0000000000bb', 'bbbbbbbb-0000-4000-8000-000000000001', 'cccccccc-0000-4000-8000-0000000000bb', 'web', 'PANAS', '{"name":"RAHSIAB Nama","phone":"RAHSIAB-0123"}', 'needs_human');
insert into public.messages (tenant_id, conversation_id, direction, sender, body, channel, status) values
  ('aaaaaaaa-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-0000000000aa', 'inbound', 'customer', 'hello A', 'web', 'received'),
  ('bbbbbbbb-0000-4000-8000-000000000001', 'dddddddd-0000-4000-8000-0000000000bb', 'inbound', 'customer', 'RAHSIAB mesej sulit', 'web', 'received');
insert into public.channel_connections (id, tenant_id, channel, provider, status) values
  ('eeeeeeee-0000-4000-8000-0000000000bb', 'bbbbbbbb-0000-4000-8000-000000000001', 'whatsapp', 'murpati', 'connected');
insert into public.message_templates (tenant_id, name, body_text) values
  ('bbbbbbbb-0000-4000-8000-000000000001', 'rahsiab_template', 'RAHSIAB template');
