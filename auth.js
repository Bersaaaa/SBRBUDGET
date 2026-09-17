// ============================================================
// SBR Budget — Inscription / connexion (Supabase Auth)
//
// La session applicative est portée par un cookie signé (voir session.js),
// compatible avec l'exécution serverless de Vercel.
// ============================================================

const { supabaseAdmin, supabaseAnon } = require('./database');

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

async function signIn({ email, password }) {
  const { data, error } = await supabaseAnon.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data.user;
}

module.exports = { signUp, signIn };
