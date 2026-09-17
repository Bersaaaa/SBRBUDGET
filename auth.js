// ============================================================
// SBR Budget — Authentification & sessions
//
// Utilise Supabase Auth pour l'inscription/connexion (email + mot de passe)
// et une session serveur (cookie httpOnly signé) pour maintenir l'état côté
// SBR Budget. Chaque utilisateur ne peut accéder qu'à ses propres données
// (voir Row Level Security dans supabase/schema.sql, et filtrage explicite
// par user_id dans database.js).
// ============================================================

const { supabaseAdmin, supabaseAnon } = require('./database');

/**
 * Middleware : exige une session valide. Attache req.userId et req.userEmail.
 */
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.status(401).json({ error: 'not_authenticated', message: 'Veuillez vous connecter.' });
  }
  req.userId = req.session.userId;
  req.userEmail = req.session.userEmail;
  next();
}

/**
 * Inscription : crée l'utilisateur dans Supabase Auth + la ligne de profil.
 */
async function signUp({ email, password, fullName }) {
  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (error) throw error;

  const { error: profileError } = await supabaseAdmin.from('users').insert({
    id: data.user.id,
    email,
    full_name: fullName || null,
  });
  if (profileError) throw profileError;

  return data.user;
}

/**
 * Connexion : vérifie les identifiants via Supabase Auth.
 */
async function signIn({ email, password }) {
  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

module.exports = { requireAuth, signUp, signIn };
