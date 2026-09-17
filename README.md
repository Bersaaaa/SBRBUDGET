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
- `providers.js` — connexion Nickel (Berlin Group) et Crédit Mutuel (STET), mode DSP2 officiel
- `scraper.js` — connexion directe (identifiant + mot de passe), voir section 7
- `session.js` — session par cookie signé (compatible serverless)
- `auth.js` — inscription / connexion Supabase
- `database.js` — accès Supabase, chiffrement AES des tokens et des identifiants
- `categorize.js` — catégorisation et détection des abonnements

**Site (statique)**
- `index.html`, `app.js`, `styles.css`
- `manifest.webmanifest`, `sw.js`, `offline.html`, `robots.txt`
- `icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png`

**Base de données**
- `schema.sql` — schéma complet avec Row Level Security
- `migration-multi-banques.sql` — migration depuis une base mono-banque (Nickel seul)
- `migration-connexion-directe.sql` — migration pour la connexion directe (section 7)

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

### Connexion directe (sans API officielle — usage personnel)

Par défaut (`DIRECT_LOGIN_PROVIDERS=nickel,creditmutuel`), Nickel et le
Crédit Mutuel utilisent une **connexion directe** : identifiant + mot de
passe, comme dans un navigateur, plutôt que le parcours DSP2 officiel
(inutile pour un usage strictement personnel — pas d'inscription TPP, pas de
certificat QWAC, pas d'agrément ACPR).

**Ce que ça fait concrètement** (`scraper.js`) : un navigateur Chromium sans
interface (Playwright) se connecte à votre espace client avec vos
identifiants, lit les soldes/opérations affichés à l'écran, puis ferme la
session. Les identifiants et les cookies de session sont chiffrés (AES) en
base, jamais en clair, jamais envoyés au navigateur.

**À savoir avant d'activer ce mode :**
- **CERTAIN** : ça sort du cadre prévu par les CGU des banques (accès
  automatisé non explicitement autorisé). Usage personnel, à vos risques.
- **À VÉRIFIER** : les sélecteurs CSS dans `scraper.js` (`SITES.nickel` /
  `SITES.creditmutuel`) sont une base de départ, pas une intégration
  testée sur un vrai compte. Après un premier essai de connexion, si
  ça échoue :
  1. Ouvrez le site de la banque dans Chrome, F12 → onglet *Elements*.
  2. Repérez les attributs `name`/`id` des champs identifiant et mot de
     passe sur le formulaire de connexion réel.
  3. Mettez-les à jour dans `loginSelectors` / `secretSelectors` de
     `scraper.js` (en tête de liste, pour qu'ils soient essayés en premier).
  4. Faites la même chose pour la page « mes comptes » si l'extraction des
     soldes ne remonte rien d'exploitable (`rawAccountTexts` dans les logs
     de synchronisation, table `sync_logs`) — le mapping précis vers des
     transactions catégorisées est à finaliser une fois la structure réelle
     de la page connue.
- Si la banque impose un code reçu par SMS (authentification forte), un
  champ apparaît dans l'app pour le saisir. Si elle exige une validation
  uniquement via l'application mobile de la banque (push notification),
  aucun script ne peut la remplacer : il faudra resynchroniser
  manuellement ce jour-là.
- **Ne fonctionne pas sur Vercel serverless** : la session du navigateur
  doit rester ouverte en mémoire entre l'étape mot de passe et l'étape code
  SMS, ce qu'une fonction serverless (qui se termine après chaque requête)
  ne permet pas. Ce mode doit tourner sur un process Node qui reste allumé
  (votre ordinateur avec `npm start`, une box domestique, un petit VPS ou
  un Raspberry Pi). Le mode DSP2 officiel, lui, reste compatible Vercel.

Pour revenir au mode démonstration ou forcer le mode DSP2 dès que vous avez
de vrais identifiants, ajustez `DIRECT_LOGIN_PROVIDERS` (liste vide pour
tout désactiver) et/ou renseignez les variables `NICKEL_*` / `CM_*`
ci-dessous.

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
npm install              # installe aussi Chromium pour la connexion directe (postinstall)
cp .env.example .env    # renseignez Supabase + les deux secrets
npm start               # http://localhost:3000
```

Pour un usage 100% personnel avec la connexion directe (section 4), lancer en
local (ou sur un petit serveur toujours allumé) est le fonctionnement normal,
pas juste une étape de développement — voir les limites Vercel ci-dessus.

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
