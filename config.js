// ============================================================
// SBR Budget — Configuration centralisée
// Charge et valide les variables d'environnement.
// Aucun secret n'est codé en dur ici : tout vient de process.env.
// ============================================================

require('dotenv').config();

function required(name, { allowEmptyInDev = false } = {}) {
  const value = process.env[name];
  if (!value && !(allowEmptyInDev && process.env.NODE_ENV !== 'production')) {
    // On ne fait pas planter le serveur en sandbox/dev pour permettre de
    // démarrer l'app avant d'avoir tous les identifiants Nickel/Supabase,
    // mais on avertit clairement.
    console.warn(`[config] ATTENTION : la variable d'environnement "${name}" n'est pas définie.`);
  }
  return value || '';
}

const config = {
  env: process.env.NODE_ENV || 'development',
  port: parseInt(process.env.PORT || '3000', 10),
  appBaseUrl: process.env.APP_BASE_URL || 'http://localhost:3000',

  nickel: {
    env: process.env.NICKEL_ENV || 'sandbox', // sandbox | production
    clientId: required('NICKEL_CLIENT_ID', { allowEmptyInDev: true }),
    clientSecret: required('NICKEL_CLIENT_SECRET', { allowEmptyInDev: true }),
    redirectUri: required('NICKEL_REDIRECT_URI', { allowEmptyInDev: true }),
    apiBaseUrl: process.env.NICKEL_API_BASE_URL || 'https://psd.nickel.eu/berlingroup/v1',
    authorizeUrl: process.env.NICKEL_AUTHORIZE_URL || '',
    tokenUrl: process.env.NICKEL_TOKEN_URL || '',
    aisScope: process.env.NICKEL_AIS_SCOPE || 'AIS',
    qwacCertPath: process.env.NICKEL_QWAC_CERT_PATH || '',
    qwacKeyPath: process.env.NICKEL_QWAC_KEY_PATH || '',
    tppId: process.env.NICKEL_TPP_ID || '',
  },

  supabase: {
    url: required('SUPABASE_URL', { allowEmptyInDev: true }),
    anonKey: required('SUPABASE_ANON_KEY', { allowEmptyInDev: true }),
    serviceRoleKey: required('SUPABASE_SERVICE_ROLE_KEY', { allowEmptyInDev: true }),
  },

  security: {
    sessionSecret: process.env.SESSION_SECRET || 'dev-only-insecure-secret-change-me',
    tokenEncryptionKey: process.env.TOKEN_ENCRYPTION_KEY || '',
    corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  },
};

if (config.env === 'production') {
  if (!config.security.tokenEncryptionKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY est obligatoire en production (chiffrement des tokens bancaires).');
  }
  if (config.security.sessionSecret === 'dev-only-insecure-secret-change-me') {
    throw new Error('SESSION_SECRET doit être défini avec une valeur forte en production.');
  }
}

module.exports = config;
