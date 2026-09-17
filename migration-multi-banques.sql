-- ============================================================
-- Migration : passage d'une seule banque (Nickel) à plusieurs
-- banques par utilisateur (Nickel + Crédit Mutuel).
-- À exécuter uniquement si la base existait déjà en version mono-banque.
-- ============================================================

alter table public.bank_connections
  add column if not exists provider text not null default 'nickel';

alter table public.bank_accounts
  add column if not exists provider text not null default 'nickel';

-- Une connexion par banque et par utilisateur.
alter table public.bank_connections
  drop constraint if exists bank_connections_user_id_key;

alter table public.bank_connections
  drop constraint if exists bank_connections_user_id_provider_key;

alter table public.bank_connections
  add constraint bank_connections_user_id_provider_key unique (user_id, provider);
