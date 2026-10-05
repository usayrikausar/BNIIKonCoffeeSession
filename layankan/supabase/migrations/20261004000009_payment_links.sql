-- R2 (ROADMAP.md): payment links. A staff member sends a link for an amount
-- they type; the customer pays the BUSINESS through the business's own
-- Billplz or ToyyibPay account (Layankan never holds the money). A link is
-- marked paid only by a verified gateway callback, never from the browser.


create table public.payment_accounts (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  gateway text not null check (gateway in ('billplz', 'toyyibpay')),
  is_active boolean not null default true,
  status text not null default 'pending' check (status in ('pending', 'connected', 'error', 'disconnected')),
  collection_ref text,               -- Billplz collection id / ToyyibPay category code (not secret)
  sandbox boolean not null default false,
  account_holder_name text,          -- shown to the owner to confirm money goes to THEM
  verified_at timestamptz,
  created_at timestamptz not null default now()
);
create unique index payment_accounts_one_active on public.payment_accounts(tenant_id) where is_active;

-- API keys / X-Signature keys: encrypted exactly like channel_credentials
-- (and included in the /admin key rotation when built).
create table public.payment_account_credentials (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  account_id uuid not null references public.payment_accounts(id) on delete cascade,
  name text not null,
  key_id text not null,
  ciphertext text not null,
  is_current boolean not null default true,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);
create unique index payment_account_credentials_one_current
  on public.payment_account_credentials(account_id, name) where is_current and revoked_at is null;
create trigger payment_credentials_same_tenant before insert or update on public.payment_account_credentials
  for each row execute function public.enforce_same_tenant('account_id', 'payment_accounts');

create table public.payment_links (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  account_id uuid not null references public.payment_accounts(id) on delete restrict,
  conversation_id uuid references public.conversations(id) on delete set null,
  contact_id uuid references public.contacts(id) on delete set null,
  created_by uuid references auth.users(id) on delete set null,   -- a staff member, always
  amount_cents integer not null check (amount_cents between 100 and 10000000),  -- RM1 – RM100,000
  currency text not null default 'MYR' check (currency = 'MYR'),
  description text not null check (char_length(description) between 1 and 200),
  gateway_bill_id text,
  url text check (url is null or url ~ '^https://'),
  status text not null default 'open' check (status in ('open', 'paid', 'expired', 'cancelled', 'failed')),
  expires_at timestamptz not null default now() + interval '7 days',
  paid_at timestamptz,
  paid_amount_cents integer,
  message_id uuid references public.messages(id) on delete set null,  -- chat message that carried the link
  created_at timestamptz not null default now(),
  unique (account_id, gateway_bill_id)
);
create index payment_links_conversation_idx on public.payment_links(tenant_id, conversation_id);
create trigger payment_links_same_tenant before insert or update on public.payment_links
  for each row execute function public.enforce_same_tenant('account_id', 'payment_accounts', 'conversation_id', 'conversations', 'contact_id', 'contacts', 'message_id', 'messages');

-- Gateway callbacks, verified and idempotent (same pattern as payment_events).
create table public.payment_link_events (
  id uuid primary key default gen_random_uuid(),
  tenant_id uuid not null references public.tenants(id) on delete cascade,
  link_id uuid references public.payment_links(id) on delete set null,
  gateway text not null,
  event_key text not null unique,
  verified boolean not null,
  paid boolean not null,
  paid_amount_cents integer,
  payload jsonb not null,
  received_at timestamptz not null default now()
);
create trigger payment_link_events_same_tenant before insert on public.payment_link_events
  for each row execute function public.enforce_same_tenant('link_id', 'payment_links');


-- Owner email when a customer pays.
alter table public.notifications drop constraint notifications_kind_check;
alter table public.notifications add constraint notifications_kind_check
  check (kind in ('handoff', 'daily_summary', 'follow_up', 'quota', 'billing', 'payment'));

-- RLS. Accounts and their keys are written by the server only (connecting
-- always goes through the key check); members create links as themselves;
-- link status changes only via verified gateway callbacks (server).
alter table public.payment_accounts enable row level security;
alter table public.payment_account_credentials enable row level security;
alter table public.payment_links enable row level security;
alter table public.payment_link_events enable row level security;
create policy payment_accounts_member_select on public.payment_accounts for select to authenticated using (public.is_tenant_member(tenant_id));
revoke insert, update, delete on public.payment_accounts from authenticated;
revoke all on public.payment_account_credentials from authenticated;
create policy payment_links_member_select on public.payment_links for select to authenticated using (public.is_tenant_member(tenant_id));
create policy payment_links_member_insert on public.payment_links for insert to authenticated
  with check (public.is_tenant_member(tenant_id) and created_by = auth.uid() and status = 'open' and paid_at is null
    and gateway_bill_id is null and url is null and paid_amount_cents is null);
revoke update, delete on public.payment_links from authenticated;
revoke all on public.payment_link_events from authenticated;
revoke all on public.payment_accounts, public.payment_account_credentials, public.payment_links, public.payment_link_events from anon;
