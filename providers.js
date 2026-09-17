// ============================================================
// SBR Budget — Connexion bancaire Open Banking DSP2
//
//   nickel        → standard Berlin Group NextGenPSD2
//                   https://psdapistore.nickel.eu/
//   creditmutuel  → standard STET (France)
//                   https://oauth2.creditmutuel.fr/en/devportal/index.html
//
// Le parcours OAuth2 + PKCE est commun ; seuls les chemins d'API et le
// format des réponses diffèrent, d'où un adaptateur par banque.
//
// SBR Budget ne demande jamais les identifiants bancaires de l'utilisateur :
// authentification et consentement se font sur le site de la banque.
// Tant que CLIENT_ID / AUTHORIZE_URL / TOKEN_URL ne sont pas renseignés pour
// une banque, celle-ci fonctionne en démonstration locale (aucun appel réseau).
// ============================================================

const crypto = require('crypto');
const https = require('https');
const fetch = require('node-fetch');
const config = require('./config');

// ---------------------------------------------------------------
// Adaptateurs
// ---------------------------------------------------------------
const ADAPTERS = {
  // ----- Nickel : Berlin Group NextGenPSD2 -----
  nickel: {
    id: 'nickel',
    label: 'Nickel',
    standard: 'berlin-group',

    headers(accessToken, consentId) {
      const h = {
        Authorization: `Bearer ${accessToken}`,
        'X-Request-ID': crypto.randomUUID(),
        Accept: 'application/json',
      };
      if (consentId) h['Consent-ID'] = consentId;
      return h;
    },

    accountsPath: () => '/accounts?withBalance=true',
    transactionsPath: (id) => `/accounts/${encodeURIComponent(id)}/transactions?bookingStatus=booked`,

    mapAccounts(data) {
      return (data.accounts || []).map((a) => ({
        providerAccountId: a.resourceId,
        name: a.name || a.product || 'Compte Nickel',
        ibanMasked: maskIban(a.iban),
        currency: a.currency || 'EUR',
        balance: berlinBalance(a),
      }));
    },

    mapTransactions(data) {
      const booked = (data.transactions && data.transactions.booked) || [];
      return booked.map((t) => ({
        providerTransactionId: t.transactionId || t.entryReference,
        date: t.bookingDate,
        bookingDateTime: t.bookingDateTime || null,
        label: t.remittanceInformationUnstructured || t.creditorName || t.debtorName || 'Opération',
        amount: parseFloat((t.transactionAmount && t.transactionAmount.amount) || '0'),
        currency: (t.transactionAmount && t.transactionAmount.currency) || 'EUR',
        merchant: t.creditorName || t.debtorName || null,
      }));
    },
  },

  // ----- Crédit Mutuel : STET (France) -----
  // Différences avec Berlin Group : soldes sur un endpoint /balances dédié,
  // sens de l'opération porté par creditDebitIndicator (DBIT/CRDT),
  // libellé dans remittanceInformation (tableau de chaînes).
  creditmutuel: {
    id: 'creditmutuel',
    label: 'Crédit Mutuel',
    standard: 'stet',

    headers(accessToken) {
      return {
        Authorization: `Bearer ${accessToken}`,
        'X-Request-ID': crypto.randomUUID(),
        Accept: 'application/json',
      };
    },

    accountsPath: () => '/accounts',
    transactionsPath: (id) => `/accounts/${encodeURIComponent(id)}/transactions`,
    balancesPath: (id) => `/accounts/${encodeURIComponent(id)}/balances`,

    mapAccounts(data) {
      const list = data.accounts || (data._embedded && data._embedded.accounts) || [];
      return list.map((a) => ({
        providerAccountId: a.resourceId || a.id,
        name: a.name || a.product || 'Compte Crédit Mutuel',
        ibanMasked: maskIban((a.accountId && a.accountId.iban) || a.iban),
        currency: (a.accountId && a.accountId.currency) || a.currency || 'EUR',
        balance: 0, // complété via balancesPath
      }));
    },

    mapBalance(data) {
      const list = data.balances || [];
      if (!list.length) return 0;
      const preferred = list.find((b) => ['XPCD', 'CLBD', 'interimAvailable'].includes(b.balanceType)) || list[0];
      return parseFloat((preferred.balanceAmount && preferred.balanceAmount.amount) || '0');
    },

    mapTransactions(data) {
      const list = data.transactions || (data._embedded && data._embedded.transactions) || [];
      return list.map((t) => ({
        providerTransactionId: t.resourceId || t.entryReference || t.transactionId,
        date: t.bookingDate || t.expectedBookingDate || t.transactionDate,
        bookingDateTime: t.bookingDate ? new Date(t.bookingDate).toISOString() : null,
        label: stetLabel(t),
        amount: stetAmount(t),
        currency: (t.transactionAmount && t.transactionAmount.currency) || 'EUR',
        merchant: t.creditorName || t.debtorName || null,
      }));
    },
  },
};

function berlinBalance(account) {
  if (Array.isArray(account.balances) && account.balances.length) {
    const preferred = account.balances.find((b) => b.balanceType === 'interimAvailable') || account.balances[0];
    return parseFloat((preferred.balanceAmount && preferred.balanceAmount.amount) || '0');
  }
  return 0;
}

function stetLabel(t) {
  if (Array.isArray(t.remittanceInformation) && t.remittanceInformation.length) {
    return t.remittanceInformation.join(' ').trim();
  }
  if (typeof t.remittanceInformation === 'string') return t.remittanceInformation;
  return t.creditorName || t.debtorName || 'Opération';
}

function stetAmount(t) {
  const raw = parseFloat((t.transactionAmount && t.transactionAmount.amount) || '0');
  const indicator = t.creditDebitIndicator || (t.transactionAmount && t.transactionAmount.creditDebitIndicator);
  if (indicator === 'DBIT') return -Math.abs(raw);
  if (indicator === 'CRDT') return Math.abs(raw);
  return raw;
}

function maskIban(iban) {
  if (!iban) return null;
  return iban.slice(0, 4) + ' •••• •••• ' + iban.slice(-4);
}

// ---------------------------------------------------------------
// Utilitaires de registre
// ---------------------------------------------------------------
function listProviders() {
  return config.enabledProviders
    .filter((id) => ADAPTERS[id])
    .map((id) => ({
      id,
      label: ADAPTERS[id].label,
      standard: ADAPTERS[id].standard,
      live: config.isLive(id),
    }));
}

function isSupported(id) {
  return Boolean(ADAPTERS[id]) && config.enabledProviders.includes(id);
}

function labelOf(id) {
  return ADAPTERS[id] ? ADAPTERS[id].label : id;
}

function settingsOf(id) {
  const s = config.providers[id];
  if (!s) throw new Error(`Configuration manquante pour : ${id}`);
  return s;
}

function redirectUri(id) {
  return settingsOf(id).redirectUri || `${config.appBaseUrl}/auth/bank/${id}/callback`;
}

/** Agent mTLS (certificat QWAC), exigé en production par la DSP2. */
const agents = {};
function httpsAgent(id) {
  const s = settingsOf(id);
  if (!s.qwacCert || !s.qwacKey) return undefined;
  if (!agents[id]) {
    agents[id] = new https.Agent({ cert: s.qwacCert, key: s.qwacKey, keepAlive: true });
  }
  return agents[id];
}

// ---------------------------------------------------------------
// Démonstration locale (aucune donnée bancaire réelle)
// ---------------------------------------------------------------
function demoTokens() {
  return {
    accessToken: `demo-access-${crypto.randomBytes(8).toString('hex')}`,
    refreshToken: `demo-refresh-${crypto.randomBytes(8).toString('hex')}`,
    expiresIn: 3600,
    consentId: `demo-consent-${crypto.randomBytes(6).toString('hex')}`,
  };
}

function isDemoToken(token) {
  return String(token || '').startsWith('demo-');
}

function demoAccounts(providerId) {
  const preset = {
    nickel: { id: 'demo-nickel-001', name: 'Compte Nickel (démo)', iban: 'FR76 •••• •••• 4821', balance: 1842.37 },
    creditmutuel: { id: 'demo-cm-001', name: 'Compte courant Crédit Mutuel (démo)', iban: 'FR76 •••• •••• 1093', balance: 3215.88 },
  }[providerId] || { id: 'demo-001', name: 'Compte (démo)', iban: 'FR76 •••• •••• 0000', balance: 1000 };

  return [{
    providerAccountId: preset.id,
    name: preset.name,
    ibanMasked: preset.iban,
    currency: 'EUR',
    balance: preset.balance,
  }];
}

function demoTransactions(providerId) {
  const today = new Date();
  const iso = (d) => d.toISOString().slice(0, 10);
  const daysAgo = (n) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return d;
  };

  const rows = [
    { d: 0, label: 'Salaire', amount: 1830, merchant: 'Employeur' },
    { d: 1, label: 'Carburant', amount: -50, merchant: 'Station Total' },
    { d: 2, label: 'Netflix', amount: -13.49, merchant: 'Netflix' },
    { d: 3, label: 'Carrefour', amount: -64.2, merchant: 'Carrefour' },
    { d: 5, label: 'Free Mobile', amount: -19.99, merchant: 'Free' },
    { d: 6, label: 'Deezer', amount: -11.99, merchant: 'Deezer' },
    { d: 8, label: 'Loyer', amount: -750, merchant: 'Agence Immobilière' },
    { d: 10, label: 'Pharmacie', amount: -22.5, merchant: 'Pharmacie du Centre' },
    { d: 12, label: 'Restaurant', amount: -38.9, merchant: 'Le Bistrot' },
    { d: 15, label: 'Essence', amount: -55, merchant: 'Station Esso' },
    { d: 20, label: 'Assurance auto', amount: -45.3, merchant: 'MAIF' },
    { d: 30, label: 'Salaire', amount: 1830, merchant: 'Employeur' },
    { d: 33, label: 'Netflix', amount: -13.49, merchant: 'Netflix' },
    { d: 35, label: 'Free Mobile', amount: -19.99, merchant: 'Free' },
    { d: 36, label: 'Deezer', amount: -11.99, merchant: 'Deezer' },
  ];

  return rows.map((r, i) => ({
    providerTransactionId: `demo-${providerId}-tx-${i}-${iso(daysAgo(r.d))}`,
    date: iso(daysAgo(r.d)),
    bookingDateTime: daysAgo(r.d).toISOString(),
    label: r.label,
    amount: r.amount,
    currency: 'EUR',
    merchant: r.merchant,
  }));
}

// ---------------------------------------------------------------
// OAuth2 + PKCE
// ---------------------------------------------------------------
function createAuthorizationRequest() {
  const state = crypto.randomBytes(24).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto.createHash('sha256').update(codeVerifier).digest('base64url');
  return { state, codeVerifier, codeChallenge };
}

function buildAuthorizeUrl(providerId, { state, codeChallenge }) {
  if (!config.isLive(providerId)) {
    const url = new URL(`${config.appBaseUrl}/auth/bank/${providerId}/demo-consent`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  const s = settingsOf(providerId);
  const url = new URL(s.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', s.clientId);
  url.searchParams.set('redirect_uri', redirectUri(providerId));
  url.searchParams.set('scope', s.scope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

async function exchangeCodeForTokens(providerId, { code, codeVerifier }) {
  if (!config.isLive(providerId)) return demoTokens();

  const s = settingsOf(providerId);
  const response = await fetch(s.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri(providerId),
      client_id: s.clientId,
      client_secret: s.clientSecret,
      code_verifier: codeVerifier,
    }),
    agent: httpsAgent(providerId),
  });

  if (!response.ok) throw new Error(`Échange de token ${labelOf(providerId)} échoué (${response.status}).`);

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    consentId: data.consent_id || null,
  };
}

async function refreshAccessToken(providerId, refreshToken) {
  if (!config.isLive(providerId) || isDemoToken(refreshToken)) {
    return { accessToken: demoTokens().accessToken, refreshToken, expiresIn: 3600 };
  }

  const s = settingsOf(providerId);
  const response = await fetch(s.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: s.clientId,
      client_secret: s.clientSecret,
    }),
    agent: httpsAgent(providerId),
  });

  if (!response.ok) throw new Error(`Rafraîchissement du token ${labelOf(providerId)} échoué (${response.status}).`);

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in,
  };
}

// ---------------------------------------------------------------
// Appels AIS
// ---------------------------------------------------------------
async function apiGet(providerId, path, accessToken, consentId) {
  const s = settingsOf(providerId);
  const adapter = ADAPTERS[providerId];
  const response = await fetch(`${s.apiBaseUrl}${path}`, {
    headers: adapter.headers(accessToken, consentId),
    agent: httpsAgent(providerId),
  });
  if (!response.ok) throw new Error(`Appel ${labelOf(providerId)} ${path} échoué (${response.status}).`);
  return response.json();
}

async function fetchAccounts(providerId, accessToken, consentId) {
  if (!config.isLive(providerId) || isDemoToken(accessToken)) return demoAccounts(providerId);

  const adapter = ADAPTERS[providerId];
  const accounts = adapter.mapAccounts(await apiGet(providerId, adapter.accountsPath(), accessToken, consentId));

  if (adapter.balancesPath) {
    for (const account of accounts) {
      try {
        const balances = await apiGet(providerId, adapter.balancesPath(account.providerAccountId), accessToken, consentId);
        account.balance = adapter.mapBalance(balances);
      } catch (_) {
        // Un solde indisponible ne doit pas faire échouer toute la synchro.
      }
    }
  }
  return accounts;
}

async function fetchTransactions(providerId, accessToken, consentId, providerAccountId) {
  if (!config.isLive(providerId) || isDemoToken(accessToken)) return demoTransactions(providerId);
  const adapter = ADAPTERS[providerId];
  return adapter.mapTransactions(
    await apiGet(providerId, adapter.transactionsPath(providerAccountId), accessToken, consentId)
  );
}

module.exports = {
  listProviders,
  isSupported,
  labelOf,
  redirectUri,
  createAuthorizationRequest,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  fetchAccounts,
  fetchTransactions,
};
