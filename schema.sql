-- ============================================================
-- SBR Budget — Schéma PostgreSQL (Supabase)
-- À exécuter dans l'éditeur SQL du projet Supabase.
-- Supporte plusieurs banques par utilisateur (Nickel, Crédit Mutuel).
-- ============================================================

create extension if not exists "pgcrypto";

-- ------------------------------------------------------------
-- Profils utilisateurs (miroir applicatif de auth.users)
-- ------------------------------------------------------------
create table if not exists public.users (
  id uuid primary key references auth.users(id) on delete cascade,
  email text not null,
  full_name text,
  created_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Connexions bancaires (une ligne par banque et par utilisateur)
-- ------------------------------------------------------------
create table if not exists public.bank_connections (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  provider text not null default 'nickel',        -- 'nickel' | 'creditmutuel'
  status text not null default 'active',          -- active | revoked | error
  access_token_encrypted text,
  refresh_token_encrypted text,
  expires_at timestamptz,
  consent_id text,
  consent_status text,
  environment text,                               -- sandbox | production | demo
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, provider)
);

-- ------------------------------------------------------------
-- Comptes bancaires rapatriés
-- ------------------------------------------------------------
create table if not exists public.bank_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  connection_id uuid not null references public.bank_connections(id) on delete cascade,
  provider text not null default 'nickel',
  provider_account_id text not null,
  name text,
  iban_masked text,
  currency text not null default 'EUR',
  balance numeric(14,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (connection_id, provider_account_id)
);

-- ------------------------------------------------------------
-- Transactions (dédoublonnées par compte)
-- ------------------------------------------------------------
create table if not exists public.transactions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  account_id uuid not null references public.bank_accounts(id) on delete cascade,
  provider_transaction_id text not null,
  date date not null,
  booking_datetime timestamptz,
  label text,
  amount numeric(14,2) not null,
  currency text not null default 'EUR',
  type text not null,                             -- income | expense
  category text,
  merchant text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (account_id, provider_transaction_id)
);

create index if not exists transactions_user_date_idx on public.transactions (user_id, date desc);
create index if not exists transactions_user_category_idx on public.transactions (user_id, category);

-- ------------------------------------------------------------
-- Abonnements détectés
-- ------------------------------------------------------------
create table if not exists public.subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  name text,
  merchant text,
  category text,
  amount numeric(14,2) not null,
  currency text not null default 'EUR',
  frequency text,
  next_estimated_date date,
  first_seen_date date,
  last_seen_date date,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ------------------------------------------------------------
-- Budgets mensuels par catégorie
-- ------------------------------------------------------------
create table if not exists public.budgets (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  category text not null,
  month date not null,
  amount numeric(14,2) not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (user_id, category, month)
);

-- ------------------------------------------------------------
-- Catégories (par défaut : user_id NULL)
-- ------------------------------------------------------------
create table if not exists public.categories (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references public.users(id) on delete cascade,
  name text not null,
  color text,
  is_default boolean not null default false,
  created_at timestamptz not null default now()
);

insert into public.categories (name, is_default)
select v.name, true
from (values
  ('Logement'), ('Alimentation'), ('Transport'), ('Téléphone'), ('Abonnements'),
  ('Shopping'), ('Loisirs'), ('Banque'), ('Impôts'), ('Santé'), ('Salaire'),
  ('Autre'), ('Autre revenu')
) as v(name)
where not exists (
  select 1 from public.categories c where c.name = v.name and c.user_id is null
);

-- ------------------------------------------------------------
-- Journaux de synchronisation
-- ------------------------------------------------------------
create table if not exists public.sync_logs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.users(id) on delete cascade,
  connection_id uuid references public.bank_connections(id) on delete cascade,
  status text not null,                           -- running | success | error
  transactions_imported integer not null default 0,
  message text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);

-- ============================================================
-- Row Level Security : chaque utilisateur ne voit que ses données.
-- Le backend utilise la clé service_role (bypass RLS) et filtre
-- systématiquement par user_id.
-- ============================================================
alter table public.users enable row level security;
alter table public.bank_connections enable row level security;
alter table public.bank_accounts enable row level security;
alter table public.transactions enable row level security;
alter table public.subscriptions enable row level security;
alter table public.budgets enable row level security;
alter table public.categories enable row level security;
alter table public.sync_logs enable row level security;

drop policy if exists "users_self" on public.users;
create policy "users_self" on public.users
  for all using (auth.uid() = id) with check (auth.uid() = id);

drop policy if exists "bank_connections_owner" on public.bank_connections;
create policy "bank_connections_owner" on public.bank_connections
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "bank_accounts_owner" on public.bank_accounts;
create policy "bank_accounts_owner" on public.bank_accounts
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "transactions_owner" on public.transactions;
create policy "transactions_owner" on public.transactions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "subscriptions_owner" on public.subscriptions;
create policy "subscriptions_owner" on public.subscriptions
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "budgets_owner" on public.budgets;
create policy "budgets_owner" on public.budgets
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "categories_owner_or_default" on public.categories;
create policy "categories_owner_or_default" on public.categories
  for select using (user_id is null or auth.uid() = user_id);

drop policy if exists "categories_write_owner" on public.categories;
create policy "categories_write_owner" on public.categories
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);

drop policy if exists "sync_logs_owner" on public.sync_logs;
create policy "sync_logs_owner" on public.sync_logs
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
