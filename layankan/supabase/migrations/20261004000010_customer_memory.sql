-- R3 (ROADMAP.md): customer memory. Short, typed facts about a customer that
-- the AI uses as DATA (never instructions). Off by default (Brain switch).
-- 12-month expiry; deleting a customer's last contact deletes everything (PDPA).

alter table public.business_brains
  add column memory jsonb not null default '{"enabled": false}'::jsonb;

create or replace function public.snapshot_brain()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.brain_revisions (tenant_id, version, snapshot, created_by)
  values (new.tenant_id, new.version,
    jsonb_build_object('profile', new.profile, 'products', new.products, 'faqs', new.faqs,
      'policies', new.policies, 'qualifying_questions', new.qualifying_questions,
      'handoff_rules', new.handoff_rules, 'extra_knowledge', new.extra_knowledge,
      'follow_up', new.follow_up, 'booking', new.booking, 'promotions', new.promotions, 'memory', new.memory),
    new.updated_by)
  on conflict (tenant_id, version) do nothing;
  return new;
end;
$$;


create table public.customers (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  display_name text,
  created_at timestamptz not null default now()
);
alter table public.contacts add column customer_id uuid references public.customers(id) on delete set null;
create trigger contacts_customer_same_tenant before insert or update of customer_id on public.contacts
  for each row execute function public.enforce_same_tenant('customer_id', 'customers');

create table public.customer_memories (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  customer_id uuid not null references public.customers(id) on delete cascade,
  kind text not null check (kind in ('preference', 'fact', 'purchase', 'note')),
  content text not null check (char_length(content) between 1 and 300),
  -- 'ai' = proposed by the AI from what the customer said (preference/fact only);
  -- 'staff' = added by a team member; 'payment' = a VERIFIED paid payment link (R2).
  source text not null check (source in ('ai', 'staff', 'payment')),
  constraint memory_purchase_only_from_payment check (kind <> 'purchase' or source = 'payment'),
  constraint memory_ai_kinds check (source <> 'ai' or kind in ('preference', 'fact')),
  source_message_id uuid references public.messages(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '12 months',  -- retention (PDPA)
  deleted_at timestamptz
);
create index customer_memories_customer_idx on public.customer_memories(tenant_id, customer_id) where deleted_at is null;
create trigger customer_memories_same_tenant before insert or update on public.customer_memories
  for each row execute function public.enforce_same_tenant('customer_id', 'customers', 'source_message_id', 'messages');

-- PDPA: deleting a customer's last contact deletes the customer and its memories.
create or replace function public.delete_orphan_customer()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if old.customer_id is not null and not exists (select 1 from public.contacts where customer_id = old.customer_id) then
    delete from public.customers where id = old.customer_id;
  end if;
  return old;
end;
$$;
create trigger contacts_delete_orphan_customer after delete on public.contacts
  for each row execute function public.delete_orphan_customer();
revoke all on function public.delete_orphan_customer() from public, anon, authenticated;

-- RLS. Customers and AI/payment memories are created by the server. Staff can
-- read, add their own notes, and remove a memory (soft delete). They can't
-- rewrite a memory's text: to correct one, remove it and add a note.
alter table public.customers enable row level security;
alter table public.customer_memories enable row level security;
create policy customers_member_select on public.customers for select to authenticated using (public.is_tenant_member(tenant_id));
revoke insert, update, delete on public.customers from authenticated;
create policy customer_memories_member_select on public.customer_memories for select to authenticated using (public.is_tenant_member(tenant_id));
create policy customer_memories_member_insert on public.customer_memories for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and source = 'staff' and kind = 'note' and created_by = auth.uid() and deleted_at is null);
create policy customer_memories_member_update on public.customer_memories for update to authenticated
  using (public.is_tenant_member(tenant_id)) with check (public.is_tenant_member(tenant_id));
revoke update, delete on public.customer_memories from authenticated;
grant update (deleted_at) on public.customer_memories to authenticated;
revoke all on public.customers, public.customer_memories from anon;
