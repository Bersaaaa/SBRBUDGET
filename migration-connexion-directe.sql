-- ============================================================
-- SBR Budget — Migration : connexion bancaire directe
-- (identifiant + mot de passe, sans API officielle DSP2)
--
-- À exécuter une fois dans l'éditeur SQL Supabase, en plus de schema.sql
-- (ou migration-multi-banques.sql si déjà appliquée).
-- ============================================================

alter table bank_connections
  add column if not exists connection_type text not null default 'oauth'
    check (connection_type in ('oauth', 'direct', 'demo')),
  add column if not exists login_encrypted text,
  add column if not exists secret_encrypted text,
  add column if not exists session_state_encrypted text;

comment on column bank_connections.connection_type is
  'oauth = DSP2 officiel, direct = identifiant/mot de passe (scraper.js), demo = données fictives';
comment on column bank_connections.login_encrypted is
  'Identifiant de connexion directe, chiffré AES (jamais en clair)';
comment on column bank_connections.secret_encrypted is
  'Mot de passe / code d''accès de connexion directe, chiffré AES (jamais en clair)';
comment on column bank_connections.session_state_encrypted is
  'Cookies de session navigateur (Playwright storageState), chiffrés AES, pour éviter de se reconnecter à chaque synchronisation';
