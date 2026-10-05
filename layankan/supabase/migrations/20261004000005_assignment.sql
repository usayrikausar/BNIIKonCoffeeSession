-- Chat assignment: shared inbox where every chat shows who is handling it.
-- "First to take it": whoever presses Take over first owns the chat; others
-- must explicitly take it from them. Additive only.

alter table public.conversations
  add column assigned_to uuid references auth.users(id) on delete set null,
  add column assigned_at timestamptz;
create index conversations_assigned_idx on public.conversations(tenant_id, assigned_to) where assigned_to is not null;

-- Name shown to colleagues ("dilayan oleh Aisyah"). Falls back to the email in the app.
alter table public.tenant_members add column display_name text check (char_length(display_name) <= 60);

-- A chat can only be assigned to someone who belongs to the same workspace.
create or replace function public.check_assignee()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if new.assigned_to is not null and new.assigned_to is distinct from old.assigned_to then
    if not exists (select 1 from public.tenant_members m where m.tenant_id = new.tenant_id and m.user_id = new.assigned_to) then
      raise exception 'assignee is not a member of this workspace' using errcode = 'check_violation';
    end if;
    new.assigned_at := now();
  end if;
  if new.assigned_to is null then
    new.assigned_at := null;
  end if;
  return new;
end;
$$;
create trigger conversations_check_assignee before insert or update of assigned_to on public.conversations
  for each row execute function public.check_assignee();

-- Removing someone from the team releases their chats back to the shared queue.
create or replace function public.release_member_chats()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.conversations set assigned_to = null
    where tenant_id = old.tenant_id and assigned_to = old.user_id;
  return old;
end;
$$;
create trigger tenant_members_release_chats after delete on public.tenant_members
  for each row execute function public.release_member_chats();

-- Staff set their own display name (cannot touch role).
create or replace function public.update_my_display_name(p_tenant uuid, p_name text)
returns void language sql security definer set search_path = public as $$
  update public.tenant_members set display_name = nullif(trim(left(p_name, 60)), '')
  where tenant_id = p_tenant and user_id = auth.uid();
$$;
revoke all on function public.update_my_display_name(uuid, text) from public, anon;
grant execute on function public.update_my_display_name(uuid, text) to authenticated;

-- Atomic "take this chat". Runs as the caller (RLS applies: members only).
-- Without p_force it only succeeds if the chat is free, already yours, or not
-- being handled by a person; otherwise it returns who holds it.
create or replace function public.take_conversation(p_conversation uuid, p_force boolean default false)
returns jsonb language plpgsql security invoker set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_holder uuid;
begin
  if v_me is null then raise exception 'not authenticated'; end if;
  update public.conversations
     set status = 'human', assigned_to = v_me
   where id = p_conversation
     and (p_force or assigned_to is null or assigned_to = v_me or status in ('ai', 'closed'))
  returning assigned_to into v_holder;
  if found then
    return jsonb_build_object('ok', true, 'assigned_to', v_holder);
  end if;
  select assigned_to into v_holder from public.conversations where id = p_conversation;
  return jsonb_build_object('ok', false, 'assigned_to', v_holder);
end;
$$;
revoke all on function public.take_conversation(uuid, boolean) from public, anon;
grant execute on function public.take_conversation(uuid, boolean) to authenticated;
