-- Stage 2 security fixes (see AUDIT_REPORT.md: C1, C2, M1, M2).

-- ---------------------------------------------------------------------------
-- C1. A row may only point at rows of the SAME tenant.
-- RLS checks the row's own tenant_id, but not the tenant of the rows it
-- references, so a member of A could insert a message into B's conversation.
-- This trigger checks every listed reference. Arguments come in pairs:
-- (column, referenced table). The referenced table must have id + tenant_id.
-- ---------------------------------------------------------------------------
create or replace function public.enforce_same_tenant()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  i integer := 0;
  v_ref uuid;
  v_tenant uuid;
begin
  while i < tg_nargs loop
    v_ref := (to_jsonb(new) ->> tg_argv[i])::uuid;
    if v_ref is not null then
      execute format('select tenant_id from public.%I where id = $1', tg_argv[i + 1]) into v_tenant using v_ref;
      -- a missing row is left to the foreign key; a row of another tenant is refused
      if v_tenant is not null and v_tenant is distinct from new.tenant_id then
        raise exception '% must belong to the same workspace', tg_argv[i]
          using errcode = 'check_violation';
      end if;
    end if;
    i := i + 2;
  end loop;
  return new;
end;
$$;
revoke all on function public.enforce_same_tenant() from public, anon, authenticated;

create trigger messages_same_tenant before insert or update of tenant_id, conversation_id on public.messages
  for each row execute function public.enforce_same_tenant('conversation_id', 'conversations');
create trigger conversations_same_tenant before insert or update of tenant_id, contact_id, channel_connection_id on public.conversations
  for each row execute function public.enforce_same_tenant('contact_id', 'contacts', 'channel_connection_id', 'channel_connections');
create trigger templates_same_tenant before insert or update of tenant_id, connection_id on public.message_templates
  for each row execute function public.enforce_same_tenant('connection_id', 'channel_connections');
create trigger credentials_same_tenant before insert or update of tenant_id, connection_id on public.channel_credentials
  for each row execute function public.enforce_same_tenant('connection_id', 'channel_connections');
create trigger status_events_same_tenant before insert or update of tenant_id, message_id on public.message_status_events
  for each row execute function public.enforce_same_tenant('message_id', 'messages');
create trigger assessments_same_tenant before insert or update of tenant_id, conversation_id, inbound_message_id, reply_message_id on public.ai_assessments
  for each row execute function public.enforce_same_tenant('conversation_id', 'conversations', 'inbound_message_id', 'messages', 'reply_message_id', 'messages');
create trigger notifications_same_tenant before insert or update of tenant_id, conversation_id on public.notifications
  for each row execute function public.enforce_same_tenant('conversation_id', 'conversations');

-- Belt and braces: the response-time trigger only ever touches its own tenant.
create or replace function public.track_response_times()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  v_first_in timestamptz;
begin
  if new.direction <> 'outbound' then return new; end if;
  select min(created_at) into v_first_in from public.messages
    where conversation_id = new.conversation_id and tenant_id = new.tenant_id and direction = 'inbound';
  if v_first_in is not null then
    update public.conversations
      set first_response_seconds = greatest(0, extract(epoch from new.created_at - v_first_in))::int
      where id = new.conversation_id and tenant_id = new.tenant_id and first_response_seconds is null;
  end if;
  if new.sender = 'human' then
    update public.conversations
      set human_response_seconds = greatest(0, extract(epoch from new.created_at - handoff_at))::int
      where id = new.conversation_id and tenant_id = new.tenant_id and handoff_at is not null and human_response_seconds is null;
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------
-- C2. Invites are accepted only for a CONFIRMED email address. Otherwise
-- anyone could sign up with a staff member's address and join the workspace.
-- ---------------------------------------------------------------------------
create or replace function public.accept_my_invites()
returns integer language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_email text;
  v_count integer := 0;
begin
  if v_uid is null then return 0; end if;
  select lower(email) into v_email from auth.users
    where id = v_uid and email_confirmed_at is not null;
  if v_email is null then return 0; end if;
  with acc as (
    insert into public.tenant_members (tenant_id, user_id, role, email)
    select i.tenant_id, v_uid, i.role, v_email
    from public.tenant_invites i
    where lower(i.email) = v_email and i.accepted_at is null
    on conflict do nothing
    returning tenant_id
  )
  select count(*) into v_count from acc;
  update public.tenant_invites set accepted_at = now()
    where lower(email) = v_email and accepted_at is null;
  return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- M1. Supabase grants EXECUTE on new functions to anon by default, and
-- "revoke ... from public" does not remove that. Nothing in Layankan calls a
-- database function without signing in, so anon gets none of them.
-- ---------------------------------------------------------------------------
revoke execute on all functions in schema public from anon;
alter default privileges in schema public revoke execute on functions from anon;
-- Grants for signed-in users, restated so they are explicit.
grant execute on function public.is_tenant_member(uuid), public.is_tenant_owner(uuid) to authenticated, service_role;
grant execute on function public.create_workspace(text, text, text) to authenticated;
grant execute on function public.accept_my_invites() to authenticated;
grant execute on function public.update_my_notification_prefs(uuid, jsonb) to authenticated;

-- ---------------------------------------------------------------------------
-- M2. current_usage_period is only used by the server (service role); members
-- could otherwise read any tenant's billing anchor by guessing its id.
-- ---------------------------------------------------------------------------
revoke execute on function public.current_usage_period(uuid) from authenticated;
grant execute on function public.current_usage_period(uuid) to service_role;
