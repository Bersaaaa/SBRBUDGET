// ============================================================
// SBR Budget — Serveur Express
// ============================================================

const path = require('path');
const express = require('express');
const session = require('express-session');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');

const config = require('./config');
const nickel = require('./nickel');
const db = require('./database');
const { requireAuth, signUp, signIn } = require('./auth');
const { categorizeTransaction, detectRecurring } = require('./categorize');

const app = express();
app.set('trust proxy', 1);

// ---------------------------------------------------------------
// Sécurité de base
// ---------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: false, // le frontend statique gère son propre CSP si besoin
}));

app.use(cors({
  origin: config.security.corsOrigins,
  credentials: true,
}));

app.use(express.json());
app.use(cookieParser());

app.use(session({
  secret: config.security.sessionSecret,
  name: 'sbr_budget_sid',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: config.env === 'production',
    sameSite: 'lax',
    maxAge: 1000 * 60 * 60 * 24 * 7, // 7 jours
  },
}));

// Limite le taux de requêtes sur les routes sensibles (auth, sync).
const sensitiveLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 50,
  standardHeaders: true,
  legacyHeaders: false,
});

// Ne jamais logger de données bancaires sensibles.
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------
// Authentification applicative (Supabase Auth)
// ---------------------------------------------------------------
app.post('/api/auth/signup', sensitiveLimiter, async (req, res) => {
  try {
    const { email, password, fullName } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'invalid_input', message: 'Email et mot de passe requis.' });
    }
    const user = await signUp({ email, password, fullName });
    req.session.userId = user.id;
    req.session.userEmail = user.email;
    res.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    res.status(400).json({ error: 'signup_failed', message: err.message });
  }
});

app.post('/api/auth/login', sensitiveLimiter, async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await signIn({ email, password });
    req.session.userId = user.id;
    req.session.userEmail = user.email;
    res.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    res.status(401).json({ error: 'login_failed', message: 'Identifiants invalides.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'not_authenticated' });
  res.json({ user: { id: req.session.userId, email: req.session.userEmail } });
});

// ---------------------------------------------------------------
// Connexion Nickel (Open Banking PSD2/AIS — Berlin Group)
// ---------------------------------------------------------------

// Étape 1 : le frontend appelle GET /auth/nickel pour démarrer le parcours.
app.get('/auth/nickel', requireAuth, sensitiveLimiter, (req, res) => {
  const { state, codeVerifier, codeChallenge } = nickel.createAuthorizationRequest();
  req.session.nickelOAuth = { state, codeVerifier, userId: req.userId };
  const authorizeUrl = nickel.buildAuthorizeUrl({ state, codeChallenge });
  res.json({ authorizeUrl });
});

// Écran de consentement simulé, utilisé uniquement tant qu'aucun identifiant
// Nickel réel n'est configuré (mode sandbox de développement). Ne remplace
// PAS le parcours officiel Nickel : dès que NICKEL_CLIENT_ID / AUTHORIZE_URL /
// TOKEN_URL sont renseignés, /auth/nickel redirige vers le vrai portail Nickel.
app.get('/auth/nickel/sandbox-consent', (req, res) => {
  const { state } = req.query;
  res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>Sandbox Nickel — Consentement</title>
<style>body{font-family:system-ui;background:#0f1115;color:#fff;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.card{background:#171a21;padding:32px;border-radius:16px;max-width:380px;text-align:center}
button{background:#5B8DEF;color:#fff;border:0;padding:14px 24px;border-radius:12px;font-size:16px;font-weight:600;width:100%;margin-top:16px;cursor:pointer}
p{color:#9aa1ac;font-size:14px;line-height:1.5}</style></head>
<body><div class="card">
<h2>🏦 Mode sandbox Nickel</h2>
<p>Aucun identifiant Nickel réel n'est configuré. Ceci simule l'écran de
consentement AIS officiel de Nickel, uniquement pour le développement.
Aucune vraie donnée bancaire n'est utilisée.</p>
<form method="GET" action="/auth/nickel/callback">
  <input type="hidden" name="state" value="${state}" />
  <input type="hidden" name="code" value="sandbox-code-${crypto.randomBytes(6).toString('hex')}" />
  <button type="submit">Simuler le consentement AIS</button>
</form>
</div></body></html>`);
});

// Étape 6-11 : callback après authentification/consentement Nickel.
app.get('/auth/nickel/callback', async (req, res) => {
  try {
    const { code, state } = req.query;
    const pending = req.session.nickelOAuth;
    if (!pending || pending.state !== state) {
      return res.redirect('/?nickel_error=state_invalide');
    }
    const userId = pending.userId;

    const tokens = await nickel.exchangeCodeForTokens({ code, codeVerifier: pending.codeVerifier });
    const expiresAt = new Date(Date.now() + (tokens.expiresIn || 3600) * 1000).toISOString();

    await db.upsertBankConnection(userId, {
      status: 'active',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt,
      consentId: tokens.consentId,
      consentStatus: 'valid',
      environment: nickel.usingRealNickelCredentials ? config.nickel.env : 'sandbox',
    });

    delete req.session.nickelOAuth;
    res.redirect('/?nickel_connected=1');
  } catch (err) {
    console.error('Erreur callback Nickel:', err.message);
    res.redirect('/?nickel_error=1');
  }
});

app.post('/api/nickel/disconnect', requireAuth, async (req, res) => {
  try {
    await db.deleteBankConnection(req.userId);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'disconnect_failed', message: err.message });
  }
});

// ---------------------------------------------------------------
// Synchronisation
// ---------------------------------------------------------------
app.post('/api/sync', requireAuth, sensitiveLimiter, async (req, res) => {
  let syncLog;
  try {
    const connection = await db.getBankConnection(req.userId);
    if (!connection || connection.status !== 'active') {
      return res.status(400).json({ error: 'no_connection', message: 'Aucun compte Nickel connecté.' });
    }

    syncLog = await db.createSyncLog(req.userId, connection.id);

    let accessToken = connection.access_token;
    if (connection.expires_at && new Date(connection.expires_at) < new Date()) {
      const refreshed = await nickel.refreshAccessToken(connection.refresh_token);
      accessToken = refreshed.accessToken;
      await db.upsertBankConnection(req.userId, {
        status: 'active',
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + (refreshed.expiresIn || 3600) * 1000).toISOString(),
        consentId: connection.consent_id,
        consentStatus: connection.consent_status,
        environment: connection.environment,
      });
    }

    const remoteAccounts = await nickel.fetchAccounts(accessToken, connection.consent_id);
    let totalImported = 0;
    const allTransactionsForDetection = [];

    for (const remoteAccount of remoteAccounts) {
      const account = await db.upsertBankAccount(req.userId, connection.id, remoteAccount);
      const remoteTransactions = await nickel.fetchTransactions(accessToken, connection.consent_id, remoteAccount.providerAccountId);

      const categorized = remoteTransactions.map((t) => ({
        ...t,
        category: categorizeTransaction(t),
      }));

      const { inserted } = await db.insertTransactionsDeduped(req.userId, account.id, categorized);
      totalImported += inserted;
      allTransactionsForDetection.push(...categorized);
    }

    const subscriptions = detectRecurring(allTransactionsForDetection);
    for (const sub of subscriptions) {
      await db.upsertSubscription(req.userId, sub);
    }

    await db.upsertBankConnection(req.userId, {
      status: 'active',
      consentId: connection.consent_id,
      consentStatus: connection.consent_status,
      environment: connection.environment,
    });
    await db.supabaseAdmin
      .from('bank_connections')
      .update({ last_synced_at: new Date().toISOString() })
      .eq('user_id', req.userId);

    await db.finishSyncLog(syncLog.id, { status: 'success', transactionsImported: totalImported });

    res.json({ ok: true, transactionsImported: totalImported, subscriptionsDetected: subscriptions.length });
  } catch (err) {
    console.error('Erreur de synchronisation:', err.message);
    if (syncLog) {
      await db.finishSyncLog(syncLog.id, { status: 'error', message: 'Échec de synchronisation.' }).catch(() => {});
    }
    res.status(500).json({ error: 'sync_failed', message: 'La synchronisation a échoué. Réessayez plus tard.' });
  }
});

app.get('/api/accounts', requireAuth, async (req, res) => {
  try {
    const accounts = await db.listBankAccounts(req.userId);
    const connection = await db.getBankConnection(req.userId);
    res.json({
      accounts,
      connection: connection ? {
        status: connection.status,
        environment: connection.environment,
        lastSyncedAt: connection.last_synced_at,
      } : null,
    });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
});

// ---------------------------------------------------------------
// Transactions
// ---------------------------------------------------------------
app.get('/api/transactions', requireAuth, async (req, res) => {
  try {
    const { type, category, from, to, search, limit } = req.query;
    const transactions = await db.listTransactions(req.userId, {
      type, category, from, to, search, limit: limit ? parseInt(limit, 10) : undefined,
    });
    res.json({ transactions });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
});

app.patch('/api/transactions/:id/category', requireAuth, async (req, res) => {
  try {
    const { category } = req.body || {};
    if (!category) return res.status(400).json({ error: 'invalid_input' });
    const updated = await db.updateTransactionCategory(req.userId, req.params.id, category);
    res.json({ transaction: updated });
  } catch (err) {
    res.status(500).json({ error: 'update_failed', message: err.message });
  }
});

// ---------------------------------------------------------------
// Abonnements
// ---------------------------------------------------------------
app.get('/api/subscriptions', requireAuth, async (req, res) => {
  try {
    const subscriptions = await db.listSubscriptions(req.userId);
    res.json({ subscriptions });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
});

app.patch('/api/subscriptions/:id', requireAuth, async (req, res) => {
  try {
    const { name, category } = req.body || {};
    const updates = {};
    if (name) updates.name = name;
    if (category) updates.category = category;
    const updated = await db.updateSubscription(req.userId, req.params.id, updates);
    res.json({ subscription: updated });
  } catch (err) {
    res.status(500).json({ error: 'update_failed', message: err.message });
  }
});

// ---------------------------------------------------------------
// Budgets
// ---------------------------------------------------------------
app.get('/api/budgets', requireAuth, async (req, res) => {
  try {
    const month = req.query.month || new Date().toISOString().slice(0, 7) + '-01';
    const budgets = await db.listBudgets(req.userId, month);

    // Calcule le montant dépensé par catégorie sur ce mois.
    const from = month;
    const toDate = new Date(month);
    toDate.setMonth(toDate.getMonth() + 1);
    const to = toDate.toISOString().slice(0, 10);
    const transactions = await db.listTransactions(req.userId, { from, to, type: 'expense', limit: 5000 });

    const spentByCategory = {};
    for (const t of transactions) {
      spentByCategory[t.category] = (spentByCategory[t.category] || 0) + Math.abs(t.amount);
    }

    const enriched = budgets.map((b) => ({
      ...b,
      spent: spentByCategory[b.category] || 0,
      remaining: b.amount - (spentByCategory[b.category] || 0),
    }));

    res.json({ budgets: enriched });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
});

app.post('/api/budgets', requireAuth, async (req, res) => {
  try {
    const { category, month, amount } = req.body || {};
    if (!category || !month || amount === undefined) {
      return res.status(400).json({ error: 'invalid_input' });
    }
    const budget = await db.upsertBudget(req.userId, category, month, amount);
    res.json({ budget });
  } catch (err) {
    res.status(500).json({ error: 'create_failed', message: err.message });
  }
});

app.delete('/api/budgets/:id', requireAuth, async (req, res) => {
  try {
    await db.deleteBudget(req.userId, req.params.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'delete_failed', message: err.message });
  }
});

// ---------------------------------------------------------------
// Catégories
// ---------------------------------------------------------------
app.get('/api/categories', requireAuth, async (req, res) => {
  try {
    const categories = await db.listCategories(req.userId);
    res.json({ categories });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
});

// ---------------------------------------------------------------
// Statistiques
// ---------------------------------------------------------------
app.get('/api/stats', requireAuth, async (req, res) => {
  try {
    const transactions = await db.listTransactions(req.userId, { limit: 5000 });

    const monthly = {};
    for (const t of transactions) {
      const month = t.date.slice(0, 7);
      if (!monthly[month]) monthly[month] = { income: 0, expense: 0 };
      if (t.amount >= 0) monthly[month].income += t.amount;
      else monthly[month].expense += Math.abs(t.amount);
    }

    const byCategory = {};
    for (const t of transactions.filter((t) => t.amount < 0)) {
      byCategory[t.category] = (byCategory[t.category] || 0) + Math.abs(t.amount);
    }

    const sortedMonths = Object.keys(monthly).sort();
    const currentMonth = sortedMonths[sortedMonths.length - 1];
    const savingsRate = currentMonth && monthly[currentMonth].income > 0
      ? Math.round(((monthly[currentMonth].income - monthly[currentMonth].expense) / monthly[currentMonth].income) * 100)
      : null;

    res.json({ monthly, byCategory, savingsRate, months: sortedMonths });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
});

// ---------------------------------------------------------------
// RGPD
// ---------------------------------------------------------------
app.post('/api/account/delete', requireAuth, async (req, res) => {
  try {
    await db.deleteAllUserData(req.userId);
    await db.supabaseAdmin.auth.admin.deleteUser(req.userId);
    req.session.destroy(() => {});
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'delete_failed', message: err.message });
  }
});

// ---------------------------------------------------------------
// Fichiers statiques (frontend)
// ---------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'frontend')));
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/auth/')) {
    return res.status(404).json({ error: 'not_found' });
  }
  res.sendFile(path.join(__dirname, '..', 'frontend', 'index.html'));
});

app.listen(config.port, () => {
  console.log(`SBR Budget démarré sur http://localhost:${config.port} (env Nickel: ${config.nickel.env}, credentials réels: ${nickel.usingRealNickelCredentials})`);
});
