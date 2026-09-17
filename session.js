// ============================================================
// SBR Budget — Sessions sans serveur d'état
//
// Vercel exécute des fonctions serverless : une session stockée en mémoire
// (express-session / MemoryStore) serait perdue d'une requête à l'autre.
// On utilise donc un cookie signé (HMAC-SHA256) contenant uniquement :
//   - l'identifiant et l'email de l'utilisateur ;
//   - l'état temporaire du parcours de consentement bancaire (state + PKCE).
//
// Le cookie est httpOnly, sameSite=lax, secure en production. Il ne contient
// aucun token bancaire : ceux-ci restent chiffrés en base.
// ============================================================

const crypto = require('crypto');
const config = require('./config');

const COOKIE_NAME = 'sbr_session';
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 7; // 7 jours

function sign(payload) {
  return crypto.createHmac('sha256', config.security.sessionSecret).update(payload).digest('base64url');
}

function serialize(data) {
  const payload = Buffer.from(JSON.stringify(data), 'utf8').toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function deserialize(raw) {
  if (!raw || typeof raw !== 'string' || !raw.includes('.')) return null;
  const [payload, signature] = raw.split('.');
  const expected = sign(payload);
  if (
    signature.length !== expected.length ||
    !crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
  ) {
    return null;
  }
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data || !data.exp || data.exp < Date.now()) return null;
    return data;
  } catch (_) {
    return null;
  }
}

/** Middleware : expose req.session (lecture) + res.saveSession / res.clearSession. */
function sessionMiddleware(req, res, next) {
  req.session = deserialize(req.cookies && req.cookies[COOKIE_NAME]) || {};

  res.saveSession = (data) => {
    const payload = { ...data, exp: Date.now() + MAX_AGE_MS };
    res.cookie(COOKIE_NAME, serialize(payload), {
      httpOnly: true,
      secure: config.isProduction,
      sameSite: 'lax',
      maxAge: MAX_AGE_MS,
      path: '/',
    });
    req.session = payload;
  };

  res.clearSession = () => {
    res.clearCookie(COOKIE_NAME, { path: '/' });
    req.session = {};
  };

  next();
}

/** Middleware : exige une session valide. */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'not_authenticated', message: 'Veuillez vous connecter.' });
  }
  req.userId = req.session.userId;
  req.userEmail = req.session.userEmail;
  next();
}

module.exports = { sessionMiddleware, requireAuth, COOKIE_NAME };
