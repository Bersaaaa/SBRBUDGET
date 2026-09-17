// ============================================================
// SBR Budget — Configuration (variables d'environnement)
//
// Sur Vercel, ces variables se renseignent dans
// Project Settings → Environment Variables.
// Aucun secret n'est codé en dur ici.
// ============================================================

require('dotenv').config();

// Sur Vercel, l'URL publique est fournie automatiquement.
function baseUrl() {
  if (process.env.APP_BASE_URL) return process.env.APP_BASE_URL.replace(/\/$/, '');
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  return `http://localhost:${process.env.PORT || 3000}`;
}

const config = {
  env: process.env.NODE_ENV || 'development',
  isProduction: (process.env.VERCEL_ENV || process.env.NODE_ENV) === 'production',
  port: parseInt(process.env.PORT || '3000', 10),
  appBaseUrl: baseUrl(),

  // Banques proposées à l'utilisateur, dans l'ordre d'affichage.
  enabledProviders: (process.env.ENABLED_PROVIDERS || 'nickel,creditmutuel')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean),

  providers: {
    // Nickel — standard Berlin Group NextGenPSD2
    // Portail développeur : https://psdapistore.nickel.eu/
    nickel: {
      id: 'nickel',
      label: 'Nickel',
      standard: 'berlin-group',
      env: process.env.NICKEL_ENV || 'sandbox',
      clientId: process.env.NICKEL_CLIENT_ID || '',
      clientSecret: process.env.NICKEL_CLIENT_SECRET || '',
      redirectUri: process.env.NICKEL_REDIRECT_URI || '',
      apiBaseUrl: (process.env.NICKEL_API_BASE_URL || '').replace(/\/$/, ''),
      authorizeUrl: process.env.NICKEL_AUTHORIZE_URL || '',
      tokenUrl: process.env.NICKEL_TOKEN_URL || '',
      scope: process.env.NICKEL_AIS_SCOPE || 'AIS',
      qwacCert: process.env.NICKEL_QWAC_CERT || '',   // contenu PEM (Vercel : pas de fichiers)
      qwacKey: process.env.NICKEL_QWAC_KEY || '',
      tppId: process.env.NICKEL_TPP_ID || '',
    },

    // Crédit Mutuel — standard STET (France)
    // Portail développeur : https://oauth2.creditmutuel.fr/en/devportal/index.html
    // Bases publiées : https://oauth2-apisi.e-i.com/cm/ (prod)
    //                  https://oauth2-apisi.e-i.com/sandbox/cm/ (sandbox)
    creditmutuel: {
      id: 'creditmutuel',
      label: 'Crédit Mutuel',
      standard: 'stet',
      env: process.env.CM_ENV || 'sandbox',
      clientId: process.env.CM_CLIENT_ID || '',
      clientSecret: process.env.CM_CLIENT_SECRET || '',
      redirectUri: process.env.CM_REDIRECT_URI || '',
      apiBaseUrl: (process.env.CM_API_BASE_URL || '').replace(/\/$/, ''),
      authorizeUrl: process.env.CM_AUTHORIZE_URL || '',
      tokenUrl: process.env.CM_TOKEN_URL || '',
      scope: process.env.CM_AIS_SCOPE || 'aisp',
      qwacCert: process.env.CM_QWAC_CERT || '',
      qwacKey: process.env.CM_QWAC_KEY || '',
      tppId: process.env.CM_TPP_ID || '',
    },
  },

  supabase: {
    url: process.env.SUPABASE_URL || '',
    anonKey: process.env.SUPABASE_ANON_KEY || '',
    serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
  },

  security: {
    sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
    tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',
    corsOrigins: (process.env.CORS_ORIGINS || '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

/**
 * Une banque passe en mode réel dès que client_id + authorize_url + token_url
 * sont renseignés. Sinon, mode démonstration local (aucun appel réseau).
 */
config.isLive = function isLive(providerId) {
  const p = config.providers[providerId];
  return Boolean(p && p.clientId && p.authorizeUrl && p.tokenUrl);
};

if (config.isProduction) {
  if (!config.security.tokenEncryptionKey) {
    console.error('[config] TOKEN_ENCRYPTION_KEY manquant : les tokens bancaires ne peuvent pas être chiffrés.');
  }
  if (config.security.sessionSecret === 'dev-only-insecure-secret-change-me') {
    console.error('[config] SESSION_SECRET doit être défini avec une valeur forte en production.');
  }
}

module.exports = config;
