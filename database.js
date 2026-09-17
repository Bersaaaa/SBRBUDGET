// ============================================================
// SBR Budget — Accès base de données (Supabase) + chiffrement
// des tokens bancaires au repos.
// ============================================================

const { createClient } = require('@supabase/supabase-js');
const CryptoJS = require('crypto-js');
const config = require('./config');

// Client "service role" : utilisé uniquement côté serveur, jamais exposé
// au frontend. Bypass RLS volontairement pour les opérations système
// (sync, écriture de tokens), toujours filtré manuellement par user_id.
// En développement, si Supabase n'est pas encore configuré, on utilise une URL
// locale factice : le site démarre et la page publique s'affiche, seules les
// routes touchant réellement à la base renverront une erreur.
const SUPABASE_URL = config.supabase.url || 'http://localhost:54321';
const SUPABASE_ANON = config.supabase.anonKey || 'anon-key-non-configuree';
const SUPABASE_SERVICE = config.supabase.serviceRoleKey || 'service-key-non-configuree';

const supabaseAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Client "anon" : utilisé pour vérifier les sessions utilisateur (Supabase Auth).
const supabaseAnon = createClient(SUPABASE_URL, SUPABASE_ANON);

// ---------------------------------------------------------------
// Chiffrement des tokens bancaires (AES) — jamais stockés en clair.
// ---------------------------------------------------------------
function encryptSecret(plainText) {
  if (!plainText) return null;
  if (!config.security.tokenEncryptionKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY manquant : impossible de chiffrer les tokens bancaires.');
  }
  return CryptoJS.AES.encrypt(plainText, config.security.tokenEncryptionKey).toString();
}

function decryptSecret(cipherText) {
  if (!cipherText) return null;
  if (!config.security.tokenEncryptionKey) {
    throw new Error('TOKEN_ENCRYPTION_KEY manquant : impossible de déchiffrer les tokens bancaires.');
  }
  const bytes = CryptoJS.AES.decrypt(cipherText, config.security.tokenEncryptionKey);
  return bytes.toString(CryptoJS.enc.Utf8);
}

// ---------------------------------------------------------------
// Connexions bancaires
// ---------------------------------------------------------------
async function upsertBankConnection(userId, {
  provider = 'nickel',
  status,
  accessToken,
  refreshToken,
  expiresAt,
  consentId,
  consentStatus,
  environment,
}) {
  const payload = {
    user_id: userId,
    provider,
    status,
    consent_id: consentId,
    consent_status: consentStatus,
    environment,
    updated_at: new Date().toISOString(),
  };
  if (accessToken !== undefined) payload.access_token_encrypted = encryptSecret(accessToken);
  if (refreshToken !== undefined) payload.refresh_token_encrypted = encryptSecret(refreshToken);
  if (expiresAt !== undefined) payload.expires_at = expiresAt;

  const { data, error } = await supabaseAdmin
    .from('bank_connections')
    .upsert(payload, { onConflict: 'user_id,provider' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function getBankConnection(userId, provider = 'nickel') {
  const { data, error } = await supabaseAdmin
    .from('bank_connections')
    .select('*')
    .eq('user_id', userId)
    .eq('provider', provider)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    ...data,
    access_token: data.access_token_encrypted ? decryptSecret(data.access_token_encrypted) : null,
    refresh_token: data.refresh_token_encrypted ? decryptSecret(data.refresh_token_encrypted) : null,
  };
}

async function listBankConnections(userId) {
  const { data, error } = await supabaseAdmin
    .from('bank_connections')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return (data || []).map((row) => ({
    ...row,
    access_token: row.access_token_encrypted ? decryptSecret(row.access_token_encrypted) : null,
    refresh_token: row.refresh_token_encrypted ? decryptSecret(row.refresh_token_encrypted) : null,
  }));
}

async function markConnectionSynced(userId, provider) {
  const { error } = await supabaseAdmin
    .from('bank_connections')
    .update({ last_synced_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) throw error;
}

async function deleteBankConnection(userId, provider = 'nickel') {
  const { error } = await supabaseAdmin
    .from('bank_connections')
    .delete()
    .eq('user_id', userId)
    .eq('provider', provider);
  if (error) throw error;
}

// ---------------------------------------------------------------
// Comptes bancaires
// ---------------------------------------------------------------
async function upsertBankAccount(userId, connectionId, account, provider = 'nickel') {
  const { data, error } = await supabaseAdmin
    .from('bank_accounts')
    .upsert({
      user_id: userId,
      connection_id: connectionId,
      provider,
      provider_account_id: account.providerAccountId,
      name: account.name,
      iban_masked: account.ibanMasked,
      currency: account.currency || 'EUR',
      balance: account.balance || 0,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'connection_id,provider_account_id' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function listBankAccounts(userId) {
  const { data, error } = await supabaseAdmin
    .from('bank_accounts')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------
async function insertTransactionsDeduped(userId, accountId, transactions) {
  if (!transactions.length) return { inserted: 0 };
  const rows = transactions.map((t) => ({
    user_id: userId,
    account_id: accountId,
    provider_transaction_id: t.providerTransactionId,
    date: t.date,
    booking_datetime: t.bookingDateTime || null,
    label: t.label,
    amount: t.amount,
    currency: t.currency || 'EUR',
    type: t.amount >= 0 ? 'income' : 'expense',
    category: t.category || null,
    merchant: t.merchant || null,
  }));

  // onConflict sur (account_id, provider_transaction_id) évite les doublons.
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .upsert(rows, { onConflict: 'account_id,provider_transaction_id', ignoreDuplicates: true })
    .select();
  if (error) throw error;
  return { inserted: data ? data.length : 0 };
}

async function listTransactions(userId, filters = {}) {
  let query = supabaseAdmin.from('transactions').select('*').eq('user_id', userId);
  if (filters.type) query = query.eq('type', filters.type);
  if (filters.category) query = query.eq('category', filters.category);
  if (filters.from) query = query.gte('date', filters.from);
  if (filters.to) query = query.lte('date', filters.to);
  if (filters.search) query = query.ilike('label', `%${filters.search}%`);
  query = query.order('date', { ascending: false }).limit(filters.limit || 500);
  const { data, error } = await query;
  if (error) throw error;
  return data;
}

async function updateTransactionCategory(userId, transactionId, category) {
  const { data, error } = await supabaseAdmin
    .from('transactions')
    .update({ category, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', transactionId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------
// Abonnements (récurrences détectées)
// ---------------------------------------------------------------
async function upsertSubscription(userId, sub) {
  const { data: existing } = await supabaseAdmin
    .from('subscriptions')
    .select('id')
    .eq('user_id', userId)
    .eq('merchant', sub.merchant)
    .eq('amount', sub.amount)
    .maybeSingle();

  const payload = {
    user_id: userId,
    name: sub.name,
    merchant: sub.merchant,
    category: sub.category,
    amount: sub.amount,
    currency: sub.currency || 'EUR',
    frequency: sub.frequency,
    next_estimated_date: sub.nextEstimatedDate,
    first_seen_date: sub.firstSeenDate,
    last_seen_date: sub.lastSeenDate,
    active: true,
    updated_at: new Date().toISOString(),
  };

  if (existing) {
    const { data, error } = await supabaseAdmin
      .from('subscriptions')
      .update(payload)
      .eq('id', existing.id)
      .select()
      .single();
    if (error) throw error;
    return data;
  }
  const { data, error } = await supabaseAdmin
    .from('subscriptions')
    .insert(payload)
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function listSubscriptions(userId) {
  const { data, error } = await supabaseAdmin
    .from('subscriptions')
    .select('*')
    .eq('user_id', userId)
    .eq('active', true)
    .order('amount', { ascending: false });
  if (error) throw error;
  return data;
}

async function updateSubscription(userId, subscriptionId, updates) {
  const { data, error } = await supabaseAdmin
    .from('subscriptions')
    .update({ ...updates, updated_at: new Date().toISOString() })
    .eq('user_id', userId)
    .eq('id', subscriptionId)
    .select()
    .single();
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------
async function upsertBudget(userId, category, month, amount) {
  const { data, error } = await supabaseAdmin
    .from('budgets')
    .upsert({ user_id: userId, category, month, amount, updated_at: new Date().toISOString() },
      { onConflict: 'user_id,category,month' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function listBudgets(userId, month) {
  const { data, error } = await supabaseAdmin
    .from('budgets')
    .select('*')
    .eq('user_id', userId)
    .eq('month', month);
  if (error) throw error;
  return data;
}

async function deleteBudget(userId, budgetId) {
  const { error } = await supabaseAdmin
    .from('budgets')
    .delete()
    .eq('user_id', userId)
    .eq('id', budgetId);
  if (error) throw error;
}

// ---------------------------------------------------------------
// Catégories
// ---------------------------------------------------------------
async function listCategories(userId) {
  const { data, error } = await supabaseAdmin
    .from('categories')
    .select('*')
    .or(`user_id.is.null,user_id.eq.${userId}`)
    .order('is_default', { ascending: false });
  if (error) throw error;
  return data;
}

// ---------------------------------------------------------------
// Logs de synchronisation
// ---------------------------------------------------------------
async function createSyncLog(userId, connectionId) {
  const { data, error } = await supabaseAdmin
    .from('sync_logs')
    .insert({ user_id: userId, connection_id: connectionId, status: 'running' })
    .select()
    .single();
  if (error) throw error;
  return data;
}

async function finishSyncLog(logId, { status, transactionsImported, message }) {
  const { error } = await supabaseAdmin
    .from('sync_logs')
    .update({
      status,
      transactions_imported: transactionsImported || 0,
      message: message || null,
      finished_at: new Date().toISOString(),
    })
    .eq('id', logId);
  if (error) throw error;
}

// ---------------------------------------------------------------
// RGPD : suppression complète des données d'un utilisateur
// ---------------------------------------------------------------
async function deleteAllUserData(userId) {
  await supabaseAdmin.from('sync_logs').delete().eq('user_id', userId);
  await supabaseAdmin.from('subscriptions').delete().eq('user_id', userId);
  await supabaseAdmin.from('transactions').delete().eq('user_id', userId);
  await supabaseAdmin.from('budgets').delete().eq('user_id', userId);
  await supabaseAdmin.from('bank_accounts').delete().eq('user_id', userId);
  await supabaseAdmin.from('bank_connections').delete().eq('user_id', userId);
  await supabaseAdmin.from('categories').delete().eq('user_id', userId);
}

module.exports = {
  supabaseAdmin,
  supabaseAnon,
  encryptSecret,
  decryptSecret,
  upsertBankConnection,
  getBankConnection,
  listBankConnections,
  markConnectionSynced,
  deleteBankConnection,
  upsertBankAccount,
  listBankAccounts,
  insertTransactionsDeduped,
  listTransactions,
  updateTransactionCategory,
  upsertSubscription,
  listSubscriptions,
  updateSubscription,
  upsertBudget,
  listBudgets,
  deleteBudget,
  listCategories,
  createSyncLog,
  finishSyncLog,
  deleteAllUserData,
};
