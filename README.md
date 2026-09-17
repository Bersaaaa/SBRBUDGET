# SBR Budget — site web PWA (déploiement Vercel)

Tous les fichiers sont dans un seul dossier, prêt à être poussé sur un dépôt Git
et importé dans Vercel. Le site est installable (PWA) et se connecte aux comptes
bancaires via les API Open Banking DSP2 officielles :

| Banque | Standard | Portail développeur |
|---|---|---|
| **Nickel** | Berlin Group NextGenPSD2 | https://psdapistore.nickel.eu/ |
| **Crédit Mutuel** | STET (France) | https://oauth2.creditmutuel.fr/en/devportal/index.html |

L'utilisateur choisit sa banque au moment de connecter un compte et peut
connecter les deux : soldes, transactions, abonnements et budgets sont
consolidés.

> SBR Budget ne demande jamais les identifiants bancaires. L'authentification et
> le consentement se font sur le site de la banque.

---

## 1. Contenu du dossier

**Serveur (fonction Vercel)**
- `server.js` — API REST, parcours de consentement bancaire, export de l'app Express
- `config.js` — variables d'environnement, configuration par banque
- `providers.js` — connexion Nickel (Berlin Group) et Crédit Mutuel (STET)
- `session.js` — session par cookie signé (compatible serverless)
- `auth.js` — inscription / connexion Supabase
- `database.js` — accès Supabase, chiffrement AES des tokens
- `categorize.js` — catégorisation et détection des abonnements

**Site (statique)**
- `index.html`, `app.js`, `styles.css`
- `manifest.webmanifest`, `sw.js`, `offline.html`, `robots.txt`
- `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`

**Base de données**
- `schema.sql` — schéma complet avec Row Level Security
- `migration-multi-banques.sql` — migration depuis une base mono-banque (Nickel seul)

**Déploiement**
- `vercel.json` — `server.js` en fonction Node, le reste en statique
- `.env.example` — liste complète des variables

---

## 2. Déploiement sur Vercel

1. Poussez le dossier sur GitHub / GitLab, puis **Add New → Project** sur Vercel.
   Framework preset : **Other**. Aucune commande de build n'est nécessaire.
2. Dans **Settings → Environment Variables**, renseignez au minimum :

```
SUPABASE_URL
SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY
SESSION_SECRET          # openssl rand -hex 32
TOKEN_ENCRYPTION_KEY    # openssl rand -hex 32
```

3. Déployez. Vérifiez `https://votre-domaine.vercel.app/api/health` : il indique
   l'URL détectée, l'état de chaque banque (démo ou réel) et si Supabase est
   configuré.

`APP_BASE_URL` est facultatif : l'URL Vercel est détectée automatiquement.
Renseignez-le une fois votre domaine définitif branché, car c'est cette URL qui
sert à construire les redirections bancaires.

### Points d'attention Vercel

- Les sessions sont portées par un **cookie signé** et non par `express-session` :
  sur du serverless, une session en mémoire serait perdue entre deux requêtes.
- Les certificats QWAC se passent par variables (`*_QWAC_CERT`, `*_QWAC_KEY`,
  contenu PEM collé), pas par chemins de fichiers.
- Après chaque mise à jour du front, incrémentez `CACHE_VERSION` dans `sw.js`
  pour que les navigateurs récupèrent la nouvelle version.

---

## 3. Base de données Supabase

1. Créez un projet sur https://app.supabase.com.
2. Éditeur SQL → exécutez `schema.sql`.
   Si votre base existe déjà en version Nickel seule, exécutez plutôt
   `migration-multi-banques.sql`.
3. Récupérez `SUPABASE_URL`, `SUPABASE_ANON_KEY` et `SUPABASE_SERVICE_ROLE_KEY`
   dans Project Settings → API. La clé service_role reste strictement côté
   serveur (variable Vercel, jamais dans le front).

---

## 4. Connexion bancaire

### Mode démonstration (par défaut)

Tant qu'une banque n'a pas ses identifiants, elle apparaît dans le choix avec la
mention « Mode démonstration » : un écran de consentement local, clairement
identifié, remplace celui de la banque, et des comptes / transactions fictifs
sont générés. Aucun appel réseau vers la banque n'est effectué. Cela permet de
tester tout le site avant d'avoir un accès développeur.

Le basculement est automatique et banque par banque : dès que `CLIENT_ID`,
`AUTHORIZE_URL` et `TOKEN_URL` sont renseignés, le parcours officiel prend le
relais.

### Nickel

1. Inscription TPP sur https://psdapistore.nickel.eu/ et déclaration de
   l'application.
2. URL de redirection à déclarer :
   `https://votre-domaine.vercel.app/auth/bank/nickel/callback`
3. Variables à renseigner : `NICKEL_CLIENT_ID`, `NICKEL_CLIENT_SECRET`,
   `NICKEL_API_BASE_URL`, `NICKEL_AUTHORIZE_URL`, `NICKEL_TOKEN_URL`,
   `NICKEL_AIS_SCOPE`, `NICKEL_REDIRECT_URI`.

### Crédit Mutuel

1. Inscription AISP sur https://oauth2.creditmutuel.fr/en/devportal/index.html
   et création de l'application.
2. URL de redirection à déclarer :
   `https://votre-domaine.vercel.app/auth/bank/creditmutuel/callback`
3. Variables à renseigner : `CM_CLIENT_ID`, `CM_CLIENT_SECRET`,
   `CM_API_BASE_URL`, `CM_AUTHORIZE_URL`, `CM_TOKEN_URL`, `CM_AIS_SCOPE`,
   `CM_REDIRECT_URI`.

Bases API publiées par le Crédit Mutuel : `https://oauth2-apisi.e-i.com/cm/`
(production) et `https://oauth2-apisi.e-i.com/sandbox/cm/` (sandbox). Les chemins
exacts sous ces bases, les scopes et les modalités de signature HTTP sont à
relever dans l'espace développeur : rien n'est deviné dans le code, tout passe
par les variables `CM_*`.

Le Crédit Mutuel suit STET et non Berlin Group. Les différences (soldes sur un
endpoint `/balances` dédié, sens de l'opération via `creditDebitIndicator`,
libellé dans `remittanceInformation`) sont traitées dans `providers.js`.

### Certificats QWAC

En production, la DSP2 impose un certificat qualifié QWAC et du mTLS sur les
appels, ainsi qu'un agrément AISP auprès de l'ACPR pour opérer un service
d'agrégation en France. Collez le PEM dans `NICKEL_QWAC_CERT` / `NICKEL_QWAC_KEY`
et `CM_QWAC_CERT` / `CM_QWAC_KEY` : l'agent HTTPS correspondant est construit
automatiquement.

---

## 5. Lancer en local

```bash
npm install
cp .env.example .env    # renseignez Supabase + les deux secrets
npm start               # http://localhost:3000
```

En local, `server.js` sert aussi les fichiers du site (liste blanche : les
fichiers serveur ne sont jamais exposés). Sur Vercel, le statique est servi par
la plateforme selon `vercel.json`.

Redirections à déclarer pour le développement :
`http://localhost:3000/auth/bank/nickel/callback` et
`http://localhost:3000/auth/bank/creditmutuel/callback`.

---

## 6. Sécurité et RGPD

- Aucun secret bancaire côté navigateur ; tokens chiffrés (AES) en base.
- Cookie de session `httpOnly`, `sameSite=lax`, `secure` en production, signé
  HMAC-SHA256 ; il ne contient aucun token bancaire.
- CSP explicite via helmet, CORS restreint, Row Level Security Supabase.
- Le service worker ne met jamais en cache `/api/` ni `/auth/`.
- Déconnexion d'une banque : `POST /api/banks/:provider/disconnect`.
- Suppression du compte et de toutes les données : `POST /api/account/delete`.

## 7. Limitations connues

- Les URLs d'autorisation/token et scopes exacts des deux banques ne sont
  publics qu'après inscription développeur : ils restent à renseigner.
- Synchronisation manuelle uniquement (`POST /api/sync`). Un cron Vercel peut
  être ajouté sans changement structurel.
- Les icônes PWA sont génériques : remplacez-les par votre identité visuelle.
