# SBR Budget

Application web/mobile de gestion de budget, connectée à **Nickel** via son
API officielle **Open Banking PSD2/AIS** (standard Berlin Group NextGenPSD2).

> ⚠️ SBR Budget ne demande **jamais** vos identifiants Nickel. La connexion
> passe exclusivement par le parcours officiel d'authentification et de
> consentement hébergé par Nickel lui-même.

---

## 1. Architecture

```
/frontend        → HTML/CSS/JS vanilla, PWA installable, mobile-first
/backend         → Node.js + Express (API REST)
/supabase        → Schéma PostgreSQL (schema.sql)
```

- **Frontend** : aucun framework, PWA (manifest + service worker), design
  premium proche d'une app bancaire.
- **Backend** : Express, sessions serveur (cookie httpOnly), aucun secret
  bancaire exposé côté client.
- **Base de données** : Supabase PostgreSQL avec Row Level Security — chaque
  utilisateur ne voit que ses propres données.
- **Connexion bancaire** : Nickel Open Banking PSD2/AIS (Berlin Group).

---

## 2. Comprendre le mode sandbox intégré

Tant que vous n'avez pas renseigné de vrais identifiants Nickel dans `.env`
(`NICKEL_CLIENT_ID`, `NICKEL_AUTHORIZE_URL`, `NICKEL_TOKEN_URL`), l'application
fonctionne automatiquement en **sandbox simulée** :
- un écran de consentement factice (clairement identifié comme tel) remplace
  l'écran Nickel réel ;
- des comptes et transactions fictifs sont générés côté serveur
  (`backend/nickel.js`, fonctions `generateSandboxAccounts` /
  `generateSandboxTransactions`) ;
- **aucun appel réseau réel** n'est fait vers Nickel dans ce mode.

Cela vous permet de développer et tester toute l'application (transactions,
catégories, abonnements, budgets, statistiques) avant même d'avoir un compte
développeur Nickel.

Dès que les variables Nickel réelles sont renseignées, l'application bascule
automatiquement sur le vrai parcours PSD2/AIS.

---

## 3. Mise en route — Sandbox de développement

### 3.1 Prérequis
- Node.js ≥ 18
- Un projet Supabase (gratuit pour démarrer) : https://supabase.com

### 3.2 Installation

```bash
npm install
cp .env.example .env
```

### 3.3 Configurer Supabase
1. Créez un projet sur https://app.supabase.com.
2. Dans l'éditeur SQL du projet, exécutez le contenu de `supabase/schema.sql`.
3. Récupérez dans **Project Settings → API** :
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY` (⚠️ à garder strictement secrète, backend uniquement)
4. Renseignez ces trois valeurs dans `.env`.

### 3.4 Générer les secrets applicatifs

```bash
# SESSION_SECRET
openssl rand -hex 32

# TOKEN_ENCRYPTION_KEY (chiffrement des tokens bancaires au repos)
openssl rand -hex 32
```
Collez les deux valeurs générées dans `.env`.

### 3.5 Lancer l'application

```bash
npm start
```

Ouvrez http://localhost:3000. Créez un compte, puis cliquez sur
« Connecter mon compte Nickel » : vous verrez l'écran de sandbox simulée
décrit ci-dessus (aucune vraie donnée bancaire n'est utilisée à ce stade).

---

## 4. Passage à l'intégration réelle Nickel (sandbox officielle puis production)

### 4.1 Inscription développeur Nickel
1. Rendez-vous sur le portail officiel : **https://psdapistore.nickel.eu/**
2. Consultez la documentation : **https://psdapistore.nickel.eu/documentation**,
   en particulier les sections :
   - *01 - Manage Consents for Account Information Service*
   - *04 - Access Account Information Services*
   - *07 - Perform a Strong Customer Authentication*
   - *11 - Connect to the sandbox or Berlin Group APIs*
   - *13 - Build your authorize URL*
3. Créez votre compte développeur / TPP (Third Party Provider) et déclarez
   votre application.
4. Déclarez votre URL de callback :
   - Développement : `http://localhost:3000/auth/nickel/callback`
   - Production : `https://votre-domaine.tld/auth/nickel/callback` (HTTPS obligatoire)

### 4.2 Certificats eIDAS / QWAC (production)
Le standard Berlin Group / PSD2 exige, en production, un **certificat qualifié
QWAC** (Qualified Website Authentication Certificate) pour identifier votre
établissement comme TPP agréé (AISP). Nickel précisera dans son espace
développeur :
- si un QWAC est exigé pour son API spécifiquement,
- le format attendu,
- les éventuelles démarches d'agrément ACPR/AISP nécessaires en France pour
  opérer un service d'agrégation bancaire.

Renseignez alors `NICKEL_QWAC_CERT_PATH`, `NICKEL_QWAC_KEY_PATH` et
`NICKEL_TPP_ID` dans `.env`, et configurez votre agent HTTP côté serveur pour
présenter ce certificat (mTLS) lors des appels à l'API Nickel. Cette partie
n'est **pas inventée** dans le code : elle est laissée configurable car elle
dépend d'informations fournies uniquement après inscription développeur.

### 4.3 Renseigner les variables d'environnement

À partir des informations obtenues sur le portail développeur Nickel,
complétez dans `.env` :

```
NICKEL_ENV=sandbox               # puis "production" une fois prêt
NICKEL_CLIENT_ID=...
NICKEL_CLIENT_SECRET=...
NICKEL_REDIRECT_URI=...
NICKEL_API_BASE_URL=...          # base URL Berlin Group Nickel (AIS)
NICKEL_AUTHORIZE_URL=...         # URL d'autorisation (doc §13)
NICKEL_TOKEN_URL=...             # endpoint d'échange de token
NICKEL_AIS_SCOPE=...             # scope AIS exact fourni par Nickel
```

Dès que `NICKEL_CLIENT_ID`, `NICKEL_AUTHORIZE_URL` et `NICKEL_TOKEN_URL` sont
renseignés, `backend/nickel.js` bascule automatiquement du mode sandbox
simulé vers le vrai parcours PSD2/AIS Nickel (voir la constante
`usingRealNickelCredentials`).

### 4.4 Tester la connexion sandbox officielle Nickel
1. Démarrez l'application avec `NICKEL_ENV=sandbox` et les identifiants
   sandbox fournis par Nickel.
2. Cliquez sur « Connecter mon compte Nickel ».
3. Vous êtes redirigé vers le véritable portail d'authentification/consentement
   Nickel (sandbox).
4. Authentifiez-vous avec les identifiants de test fournis par Nickel.
5. Donnez votre consentement AIS.
6. Vous êtes redirigé vers `/auth/nickel/callback`, qui échange le code
   contre les tokens et récupère vos comptes/transactions de test.

### 4.5 Passer en production
1. Changez `NICKEL_ENV=production`.
2. Renseignez les valeurs de production fournies par Nickel (`NICKEL_API_BASE_URL`,
   `NICKEL_AUTHORIZE_URL`, `NICKEL_TOKEN_URL`, client_id/secret de production).
3. Déployez le backend derrière **HTTPS** (obligatoire pour PSD2).
4. Vérifiez que `NICKEL_REDIRECT_URI` correspond exactement à l'URL déclarée
   auprès de Nickel.
5. Configurez le certificat QWAC si Nickel l'exige (voir §4.2).

---

## 5. Sécurité — ce qui est déjà en place

- Aucun secret bancaire (token, certificat) n'est jamais envoyé au frontend.
- Tokens Nickel chiffrés (AES) au repos dans Supabase (`TOKEN_ENCRYPTION_KEY`).
- Sessions serveur en cookie `httpOnly`, `sameSite=lax`, `secure` en production.
- `helmet` pour les en-têtes de sécurité HTTP.
- `express-rate-limit` sur les routes sensibles (authentification, synchronisation).
- CORS restreint aux origines listées dans `CORS_ORIGINS`.
- Row Level Security Supabase : chaque utilisateur n'accède qu'à ses propres
  lignes (`bank_connections`, `transactions`, `budgets`, etc.).
- Contraintes d'unicité sur `(account_id, provider_transaction_id)` pour
  empêcher l'import en double d'une même transaction.
- Aucune donnée bancaire sensible n'est écrite dans les logs serveur.

## 6. RGPD

- Suppression du compte et de toutes les données associées :
  `POST /api/account/delete` (bouton « Supprimer mon compte » dans Paramètres).
- Déconnexion du compte Nickel à tout moment : `POST /api/nickel/disconnect`
  (supprime tokens et informations de consentement stockés).
- Seules les données nécessaires au fonctionnement du service sont conservées.

---

## 7. Structure des fichiers livrés

```
frontend/index.html
frontend/styles.css
frontend/app.js
frontend/manifest.json
frontend/sw.js
frontend/icons/icon-192.png
frontend/icons/icon-512.png

backend/server.js
backend/nickel.js
backend/auth.js
backend/database.js
backend/categorize.js
backend/config.js

supabase/schema.sql

package.json
.env.example
.gitignore
README.md
```

## 8. Limitations connues / à compléter

- Les valeurs exactes `NICKEL_API_BASE_URL`, `NICKEL_AUTHORIZE_URL`,
  `NICKEL_TOKEN_URL` et le scope AIS précis doivent être confirmées dans votre
  espace développeur Nickel : elles peuvent différer entre sandbox et
  production, et ne sont pas publiques avant inscription.
- La synchronisation automatique périodique (cron) n'est pas implémentée —
  seule la synchronisation manuelle (`POST /api/sync`) l'est. L'architecture
  (jetons rafraîchis automatiquement, déduplication) permet d'y brancher un
  planificateur (ex. `node-cron`) sans changement structurel.
- Les icônes PWA fournies sont des placeholders simples ; remplacez-les par
  votre identité visuelle définitive avant publication sur un store.
