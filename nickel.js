// ============================================================
// SBR Budget — Client Nickel Open Banking (PSD2 / AIS)
//
// Implémente le parcours officiel Berlin Group NextGenPSD2 tel que
// documenté par Nickel : https://psdapistore.nickel.eu/documentation
//   01 - Manage Consents for Account Information Service
//   04 - Access Account Information Services
//   07 - Perform a Strong Customer Authentication
//   13 - Build your authorize URL
//
// IMPORTANT :
// - Ce module ne demande JAMAIS d'identifiants Nickel à l'utilisateur.
// - Aucun secret n'est exposé au frontend : tout se passe côté serveur.
// - Les valeurs exactes des endpoints (NICKEL_AUTHORIZE_URL, NICKEL_TOKEN_URL,
//   scopes, certificats QWAC) doivent être complétées dans .env à partir
//   des identifiants et de la documentation obtenus après inscription
//   développeur / TPP sur https://psdapistore.nickel.eu/. Rien n'est
//   inventé ici : si une valeur n'est pas fournie, le mode sandbox simulé
//   prend le relais pour permettre de développer et tester l'application.
// ============================================================

const crypto = require('crypto');
const fetch = require('node-fetch');
const config = require('./config');

const usingRealNickelCredentials = Boolean(
  config.nickel.clientId && config.nickel.authorizeUrl && config.nickel.tokenUrl
);

/**
 * Génère un état CSRF (state) et le code_verifier PKCE, à conserver en
 * session le temps de l'aller-retour OAuth.
 */
function createAuthorizationRequest() {
  const state = crypto.randomBytes(24).toString('hex');
  const codeVerifier = crypto.randomBytes(32).toString('base64url');
  const codeChallenge = crypto
    .createHash('sha256')
    .update(codeVerifier)
    .digest('base64url');
  return { state, codeVerifier, codeChallenge };
}

/**
 * Construit l'URL d'autorisation officielle Nickel (Berlin Group OIDC/OAuth2).
 * Se base sur NICKEL_AUTHORIZE_URL défini en .env (voir doc §13 "Build your
 * authorize URL"). Si cette variable n'est pas encore renseignée (avant
 * inscription développeur), on redirige en interne vers l'écran de
 * consentement simulé du mode sandbox.
 */
function buildAuthorizeUrl({ state, codeChallenge }) {
  if (!usingRealNickelCredentials) {
    // Mode sandbox simulé : pas d'appel réseau réel vers Nickel.
    const url = new URL(`${config.appBaseUrl}/auth/nickel/sandbox-consent`);
    url.searchParams.set('state', state);
    return url.toString();
  }

  const url = new URL(config.nickel.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.nickel.clientId);
  url.searchParams.set('redirect_uri', config.nickel.redirectUri);
  url.searchParams.set('scope', config.nickel.aisScope);
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', codeChallenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

/**
 * Échange le code d'autorisation contre les tokens Nickel.
 * En sandbox simulé (pas de credentials réels), renvoie des tokens factices
 * clairement identifiés comme tels.
 */
async function exchangeCodeForTokens({ code, codeVerifier }) {
  if (!usingRealNickelCredentials) {
    return {
      accessToken: `sandbox-access-${crypto.randomBytes(8).toString('hex')}`,
      refreshToken: `sandbox-refresh-${crypto.randomBytes(8).toString('hex')}`,
      expiresIn: 3600,
      consentId: `sandbox-consent-${crypto.randomBytes(6).toString('hex')}`,
    };
  }

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.nickel.redirectUri,
    client_id: config.nickel.clientId,
    client_secret: config.nickel.clientSecret,
    code_verifier: codeVerifier,
  });

  const response = await fetch(config.nickel.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    // En production, la mTLS avec le certificat QWAC (NICKEL_QWAC_CERT_PATH /
    // NICKEL_QWAC_KEY_PATH) doit être configurée sur l'agent HTTPS utilisé ici,
    // conformément aux exigences RTS PSD2 / Berlin Group.
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Échange de token Nickel échoué (${response.status}): ${text}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
    consentId: data.consent_id || null,
  };
}

/**
 * Rafraîchit le token d'accès Nickel à partir du refresh_token.
 */
async function refreshAccessToken(refreshToken) {
  if (!usingRealNickelCredentials || String(refreshToken).startsWith('sandbox-')) {
    return {
      accessToken: `sandbox-access-${crypto.randomBytes(8).toString('hex')}`,
      refreshToken,
      expiresIn: 3600,
    };
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: config.nickel.clientId,
    client_secret: config.nickel.clientSecret,
  });

  const response = await fetch(config.nickel.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Rafraîchissement du token Nickel échoué (${response.status}): ${text}`);
  }

  const data = await response.json();
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    expiresIn: data.expires_in,
  };
}

/**
 * Récupère les comptes du PSU (Payment Service User) via l'API AIS Nickel.
 * GET {NICKEL_API_BASE_URL}/accounts
 */
async function fetchAccounts(accessToken, consentId) {
  if (!usingRealNickelCredentials || String(accessToken).startsWith('sandbox-')) {
    return generateSandboxAccounts();
  }

  const response = await fetch(`${config.nickel.apiBaseUrl}/accounts`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Consent-ID': consentId,
      'X-Request-ID': crypto.randomUUID(),
    },
  });
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Récupération des comptes Nickel échouée (${response.status}): ${text}`);
  }
  const data = await response.json();
  return (data.accounts || []).map((a) => ({
    providerAccountId: a.resourceId,
    name: a.name || a.product || 'Compte Nickel',
    ibanMasked: maskIban(a.iban),
    currency: a.currency,
    balance: extractBalance(a),
  }));
}

/**
 * Récupère les transactions d'un compte donné.
 * GET {NICKEL_API_BASE_URL}/accounts/{accountId}/transactions
 */
async function fetchTransactions(accessToken, consentId, providerAccountId) {
  if (!usingRealNickelCredentials || String(accessToken).startsWith('sandbox-')) {
    return generateSandboxTransactions();
  }

  const response = await fetch(
    `${config.nickel.apiBaseUrl}/accounts/${encodeURIComponent(providerAccountId)}/transactions`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Consent-ID': consentId,
        'X-Request-ID': crypto.randomUUID(),
      },
    }
  );
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Récupération des transactions Nickel échouée (${response.status}): ${text}`);
  }
  const data = await response.json();
  const booked = (data.transactions && data.transactions.booked) || [];
  return booked.map((t) => ({
    providerTransactionId: t.transactionId || t.entryReference,
    date: t.bookingDate,
    bookingDateTime: t.bookingDateTime || null,
    label: t.remittanceInformationUnstructured || t.creditorName || t.debtorName || 'Opération',
    amount: parseFloat(t.transactionAmount?.amount || '0'),
    currency: t.transactionAmount?.currency || 'EUR',
    merchant: t.creditorName || t.debtorName || null,
  }));
}

function extractBalance(account) {
  if (Array.isArray(account.balances) && account.balances.length) {
    const preferred =
      account.balances.find((b) => b.balanceType === 'interimAvailable') || account.balances[0];
    return parseFloat(preferred.balanceAmount?.amount || '0');
  }
  return 0;
}

function maskIban(iban) {
  if (!iban) return null;
  return iban.slice(0, 4) + ' •••• •••• ' + iban.slice(-4);
}

// ---------------------------------------------------------------
// Générateurs de données SANDBOX (fictives, clairement isolées) —
// utilisés uniquement quand aucun identifiant Nickel réel n'est configuré,
// pour permettre de développer/tester toute l'application sans compte réel.
// ---------------------------------------------------------------
function generateSandboxAccounts() {
  return [
    {
      providerAccountId: 'sandbox-account-001',
      name: 'Compte Nickel (sandbox)',
      ibanMasked: 'FR76 •••• •••• 4821',
      currency: 'EUR',
      balance: 1842.37,
    },
  ];
}

function generateSandboxTransactions() {
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
    { d: 33, label: 'Netflix', amount: -13.49, merchant: 'Netflix' },
    { d: 35, label: 'Free Mobile', amount: -19.99, merchant: 'Free' },
    { d: 36, label: 'Deezer', amount: -11.99, merchant: 'Deezer' },
    { d: 30, label: 'Salaire', amount: 1830, merchant: 'Employeur' },
  ];

  return rows.map((r, i) => ({
    providerTransactionId: `sandbox-tx-${i}-${iso(daysAgo(r.d))}`,
    date: iso(daysAgo(r.d)),
    bookingDateTime: daysAgo(r.d).toISOString(),
    label: r.label,
    amount: r.amount,
    currency: 'EUR',
    merchant: r.merchant,
  }));
}

module.exports = {
  usingRealNickelCredentials,
  createAuthorizationRequest,
  buildAuthorizeUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  fetchAccounts,
  fetchTransactions,
};
