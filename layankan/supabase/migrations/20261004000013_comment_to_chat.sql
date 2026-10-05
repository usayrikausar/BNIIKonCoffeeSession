-- R5 (ROADMAP.md): comment-to-chat. A comment containing one of the owner's
-- keywords, on the business's OWN Facebook / Instagram post, gets ONE private
-- reply (Meta's private-replies feature). When the person writes back, it is
-- a normal AI chat. A Brain setting — no flow builder.

alter table public.business_brains add column comment_to_chat jsonb not null default
  '{"enabled": false, "keywords": [], "opening_message": "", "public_reply": ""}'::jsonb;

create or replace function public.snapshot_brain()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.brain_revisions (tenant_id, version, snapshot, created_by)
  values (new.tenant_id, new.version,
    jsonb_build_object('profile', new.profile, 'products', new.products, 'faqs', new.faqs,
      'policies', new.policies, 'qualifying_questions', new.qualifying_questions,
      'handoff_rules', new.handoff_rules, 'extra_knowledge', new.extra_knowledge,
      'follow_up', new.follow_up, 'booking', new.booking, 'promotions', new.promotions,
      'memory', new.memory, 'comment_to_chat', new.comment_to_chat),
    new.updated_by)
  on conflict (tenant_id, version) do nothing;
  return new;
end;
$$;

-- Every comment we saw and what we did with it (dedupe + audit + per-person cap).
create table public.social_comments (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  connection_id uuid not null references public.channel_connections(id) on delete cascade,
  platform text not null check (platform in ('instagram', 'facebook')),
  post_id text not null,
  comment_id text not null,
  author_external_id text not null,
  author_name text,
  body text not null check (char_length(body) <= 4000),
  received_at timestamptz not null default now(),
  matched_keyword text,
  decision text not null default 'pending' check (decision in (
    'pending', 'replied', 'ignored_no_keyword', 'ignored_own_comment', 'ignored_disabled',
    'skipped_already_replied_to_author', 'skipped_opted_out', 'skipped_expired', 'skipped_plan_limit', 'failed')),
  private_reply_message_id uuid references public.messages(id) on delete set null,
  conversation_id uuid references public.conversations(id) on delete cascade,  -- PDPA: deleting the chat deletes the comment record
  error text,
  unique (connection_id, comment_id)   -- one decision (and at most one private reply) per comment
);
create index social_comments_author_idx on public.social_comments(tenant_id, author_external_id, received_at desc);
create trigger social_comments_same_tenant before insert or update on public.social_comments
  for each row execute function public.enforce_same_tenant('connection_id', 'channel_connections', 'private_reply_message_id', 'messages', 'conversation_id', 'conversations');

-- Written by the webhook (server); members read.
alter table public.social_comments enable row level security;
create policy social_comments_member_select on public.social_comments for select to authenticated using (public.is_tenant_member(tenant_id));
revoke insert, update, delete on public.social_comments from authenticated;
revoke all on public.social_comments from anon;

-- PDPA: deleting a customer also deletes the comments we logged from the same
-- account id (comments that never became a chat, e.g. skipped or ignored).
create or replace function public.delete_contact_comments()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  delete from public.social_comments where tenant_id = old.tenant_id and author_external_id = old.external_id;
  return old;
end;
$$;
create trigger contacts_delete_comments after delete on public.contacts
  for each row when (old.channel in ('messenger', 'instagram'))
  execute function public.delete_contact_comments();
