// ============================================================
// SBR Budget — API (Express)
//
// Sur Vercel, ce fichier est déployé en fonction serverless : l'app est
// exportée (module.exports = app) et ne fait listen() qu'en local.
// Les fichiers du site (index.html, app.js, styles.css, sw.js, icônes…)
// sont servis en statique par Vercel, voir vercel.json.
// ============================================================

const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const cors = require('cors');
const helmet = require('helmet');
const crypto = require('crypto');

const config = require('./config');
const banks = require('./providers');
const db = require('./database');
const { sessionMiddleware, requireAuth } = require('./session');
const { signUp, signIn } = require('./auth');
const { categorizeTransaction, detectRecurring } = require('./categorize');

const app = express();
app.set('trust proxy', 1);

app.use(helmet({
  contentSecurityPolicy: {
    useDefaults: true,
    directives: {
      'default-src': ["'self'"],
      'script-src': ["'self'"],
      'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      'font-src': ["'self'", 'https://fonts.gstatic.com'],
      'img-src': ["'self'", 'data:'],
      'connect-src': ["'self'"],
      'frame-ancestors': ["'none'"],
      'form-action': ["'self'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

if (config.security.corsOrigins.length) {
  app.use(cors({ origin: config.security.corsOrigins, credentials: true }));
}

app.use(express.json());
app.use(cookieParser());
app.use(sessionMiddleware);

app.use((req, _res, next) => {
  // Jamais de données bancaires dans les logs.
  console.log(`${req.method} ${req.path}`);
  next();
});

// ---------------------------------------------------------------
// Compte SBR Budget
// ---------------------------------------------------------------
app.post('/api/auth/signup', async (req, res) => {
  try {
    const { email, password, fullName } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'invalid_input', message: 'Email et mot de passe requis.' });
    }
    const user = await signUp({ email, password, fullName });
    res.saveSession({ userId: user.id, userEmail: user.email });
    res.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    res.status(400).json({ error: 'signup_failed', message: err.message });
  }
});

app.post('/api/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body || {};
    const user = await signIn({ email, password });
    res.saveSession({ userId: user.id, userEmail: user.email });
    res.json({ user: { id: user.id, email: user.email } });
  } catch (err) {
    res.status(401).json({ error: 'login_failed', message: 'Identifiants invalides.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  res.clearSession();
  res.json({ ok: true });
});

app.get('/api/auth/me', (req, res) => {
  if (!req.session.userId) return res.status(401).json({ error: 'not_authenticated' });
  res.json({ user: { id: req.session.userId, email: req.session.userEmail } });
});

// ---------------------------------------------------------------
// Connexion bancaire : Nickel ou Crédit Mutuel
// ---------------------------------------------------------------
app.get('/api/banks', (_req, res) => {
  res.json({ banks: banks.listProviders() });
});

// Étape 1 — l'utilisateur choisit sa banque, on prépare state + PKCE.
app.get('/auth/bank/:provider/start', requireAuth, (req, res) => {
  const provider = String(req.params.provider || '').toLowerCase();
  if (!banks.isSupported(provider)) {
    return res.status(400).json({ error: 'unsupported_bank', message: 'Banque non supportée.' });
  }
  const { state, codeVerifier, codeChallenge } = banks.createAuthorizationRequest();
  res.saveSession({
    userId: req.userId,
    userEmail: req.userEmail,
    oauth: { provider, state, codeVerifier },
  });
  res.json({ authorizeUrl: banks.buildAuthorizeUrl(provider, { state, codeChallenge }) });
});

// Écran de consentement de démonstration — actif uniquement tant qu'aucun
// identifiant réel n'est configuré pour la banque. Dès que les variables
// CLIENT_ID / AUTHORIZE_URL / TOKEN_URL sont renseignées, l'utilisateur est
// redirigé vers le portail officiel de sa banque.
app.get('/auth/bank/:provider/demo-consent', (req, res) => {
  const provider = String(req.params.provider || '').toLowerCase();
  if (!banks.isSupported(provider) || config.isLive(provider)) return res.redirect('/');
  const state = String(req.query.state || '').replace(/[^a-f0-9]/gi, '');
  const label = banks.labelOf(provider);
  res.send(`<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><title>Démo ${label} — Consentement</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>body{font-family:system-ui;background:#0E1013;color:#F3F1EC;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:24px}
.card{background:#171A1F;padding:32px;border-radius:20px;max-width:380px;text-align:center;border:1px solid #2A2F38}
button{background:#D4A94F;color:#1A1305;border:0;padding:14px 24px;border-radius:14px;font-size:15px;font-weight:600;width:100%;margin-top:16px;cursor:pointer}
p{color:#9AA0AB;font-size:14px;line-height:1.5}</style></head>
<body><div class="card">
<h2>Mode démonstration — ${label}</h2>
<p>Aucun identifiant ${label} réel n'est configuré sur ce déploiement. Cet écran
simule le consentement DSP2 officiel de la banque. Aucune donnée bancaire
réelle n'est utilisée.</p>
<form method="GET" action="/auth/bank/${provider}/callback">
  <input type="hidden" name="state" value="${state}" />
  <input type="hidden" name="code" value="demo-code-${crypto.randomBytes(6).toString('hex')}" />
  <button type="submit">Simuler le consentement</button>
</form>
</div></body></html>`);
});

// Étape 2 — retour de la banque après authentification forte + consentement.
app.get('/auth/bank/:provider/callback', async (req, res) => {
  const provider = String(req.params.provider || '').toLowerCase();
  try {
    const { code, state } = req.query;
    const pending = req.session.oauth;
    if (!pending || pending.provider !== provider || pending.state !== state) {
      return res.redirect('/?bank_error=state_invalide');
    }

    const tokens = await banks.exchangeCodeForTokens(provider, { code, codeVerifier: pending.codeVerifier });

    await db.upsertBankConnection(req.session.userId, {
      provider,
      status: 'active',
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: new Date(Date.now() + (tokens.expiresIn || 3600) * 1000).toISOString(),
      consentId: tokens.consentId,
      consentStatus: 'valid',
      environment: config.isLive(provider) ? config.providers[provider].env : 'demo',
    });

    // On repart d'une session sans état OAuth résiduel.
    res.saveSession({ userId: req.session.userId, userEmail: req.session.userEmail });
    res.redirect(`/?bank_connected=${provider}`);
  } catch (err) {
    console.error('Erreur callback banque:', err.message);
    res.redirect('/?bank_error=1');
  }
});

// Compatibilité avec les anciennes URLs Nickel.
app.get('/auth/nickel', requireAuth, (_req, res) => res.redirect('/auth/bank/nickel/start'));
app.get('/auth/nickel/callback', (req, res) => {
  const qs = new URLSearchParams(req.query).toString();
  res.redirect(`/auth/bank/nickel/callback${qs ? `?${qs}` : ''}`);
});

app.post('/api/banks/:provider/disconnect', requireAuth, async (req, res) => {
  try {
    const provider = String(req.params.provider || '').toLowerCase();
    if (!banks.isSupported(provider)) return res.status(400).json({ error: 'unsupported_bank' });
    await db.deleteBankConnection(req.userId, provider);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'disconnect_failed', message: err.message });
  }
});

// ---------------------------------------------------------------
// Synchronisation
// ---------------------------------------------------------------
async function syncConnection(userId, connection) {
  const provider = connection.provider;
  const syncLog = await db.createSyncLog(userId, connection.id);

  try {
    let accessToken = connection.access_token;
    if (connection.expires_at && new Date(connection.expires_at) < new Date()) {
      const refreshed = await banks.refreshAccessToken(provider, connection.refresh_token);
      accessToken = refreshed.accessToken;
      await db.upsertBankConnection(userId, {
        provider,
        status: 'active',
        accessToken: refreshed.accessToken,
        refreshToken: refreshed.refreshToken,
        expiresAt: new Date(Date.now() + (refreshed.expiresIn || 3600) * 1000).toISOString(),
        consentId: connection.consent_id,
        consentStatus: connection.consent_status,
        environment: connection.environment,
      });
    }

    const remoteAccounts = await banks.fetchAccounts(provider, accessToken, connection.consent_id);
    let imported = 0;
    const forDetection = [];

    for (const remoteAccount of remoteAccounts) {
      const account = await db.upsertBankAccount(userId, connection.id, remoteAccount, provider);
      const remoteTransactions = await banks.fetchTransactions(
        provider, accessToken, connection.consent_id, remoteAccount.providerAccountId
      );
      const categorized = remoteTransactions.map((t) => ({ ...t, category: categorizeTransaction(t) }));
      const { inserted } = await db.insertTransactionsDeduped(userId, account.id, categorized);
      imported += inserted;
      forDetection.push(...categorized);
    }

    await db.markConnectionSynced(userId, provider);
    await db.finishSyncLog(syncLog.id, { status: 'success', transactionsImported: imported });
    return { imported, transactions: forDetection };
  } catch (err) {
    await db.finishSyncLog(syncLog.id, { status: 'error', message: 'Échec de synchronisation.' }).catch(() => {});
    throw err;
  }
}

app.post('/api/sync', requireAuth, async (req, res) => {
  try {
    const requested = req.body && req.body.provider ? String(req.body.provider).toLowerCase() : null;
    const connections = (await db.listBankConnections(req.userId))
      .filter((c) => c.status === 'active' && (!requested || c.provider === requested));

    if (!connections.length) {
      return res.status(400).json({ error: 'no_connection', message: 'Aucune banque connectée.' });
    }

    let totalImported = 0;
    const allTransactions = [];
    const errors = [];

    for (const connection of connections) {
      try {
        const result = await syncConnection(req.userId, connection);
        totalImported += result.imported;
        allTransactions.push(...result.transactions);
      } catch (err) {
        console.error(`Sync ${connection.provider} :`, err.message);
        errors.push(banks.labelOf(connection.provider));
      }
    }

    const subscriptions = detectRecurring(allTransactions);
    for (const sub of subscriptions) {
      await db.upsertSubscription(req.userId, sub);
    }

    if (errors.length && !totalImported) {
      return res.status(502).json({
        error: 'sync_failed',
        message: `La synchronisation a échoué (${errors.join(', ')}). Réessayez plus tard.`,
      });
    }

    res.json({
      ok: true,
      transactionsImported: totalImported,
      subscriptionsDetected: subscriptions.length,
      failed: errors,
    });
  } catch (err) {
    console.error('Erreur de synchronisation:', err.message);
    res.status(500).json({ error: 'sync_failed', message: 'La synchronisation a échoué. Réessayez plus tard.' });
  }
});

app.get('/api/accounts', requireAuth, async (req, res) => {
  try {
    const accounts = await db.listBankAccounts(req.userId);
    const connections = await db.listBankConnections(req.userId);
    res.json({
      accounts,
      connections: connections.map((c) => ({
        provider: c.provider,
        label: banks.labelOf(c.provider),
        status: c.status,
        environment: c.environment,
        lastSyncedAt: c.last_synced_at,
      })),
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
    res.json({ transaction: await db.updateTransactionCategory(req.userId, req.params.id, category) });
  } catch (err) {
    res.status(500).json({ error: 'update_failed', message: err.message });
  }
});

// ---------------------------------------------------------------
// Abonnements
// ---------------------------------------------------------------
app.get('/api/subscriptions', requireAuth, async (req, res) => {
  try {
    res.json({ subscriptions: await db.listSubscriptions(req.userId) });
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
    res.json({ subscription: await db.updateSubscription(req.userId, req.params.id, updates) });
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

    const toDate = new Date(month);
    toDate.setMonth(toDate.getMonth() + 1);
    const transactions = await db.listTransactions(req.userId, {
      from: month, to: toDate.toISOString().slice(0, 10), type: 'expense', limit: 5000,
    });

    const spentByCategory = {};
    for (const t of transactions) {
      spentByCategory[t.category] = (spentByCategory[t.category] || 0) + Math.abs(t.amount);
    }

    res.json({
      budgets: budgets.map((b) => ({
        ...b,
        spent: spentByCategory[b.category] || 0,
        remaining: b.amount - (spentByCategory[b.category] || 0),
      })),
    });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
});

app.post('/api/budgets', requireAuth, async (req, res) => {
  try {
    const { category, month, amount } = req.body || {};
    if (!category || !month || amount === undefined) return res.status(400).json({ error: 'invalid_input' });
    res.json({ budget: await db.upsertBudget(req.userId, category, month, amount) });
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
// Catégories & statistiques
// ---------------------------------------------------------------
app.get('/api/categories', requireAuth, async (req, res) => {
  try {
    res.json({ categories: await db.listCategories(req.userId) });
  } catch (err) {
    res.status(500).json({ error: 'fetch_failed', message: err.message });
  }
});

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

    const months = Object.keys(monthly).sort();
    const currentMonth = months[months.length - 1];
    const savingsRate = currentMonth && monthly[currentMonth].income > 0
      ? Math.round(((monthly[currentMonth].income - monthly[currentMonth].expense) / monthly[currentMonth].income) * 100)
      : null;

    res.json({ monthly, byCategory, savingsRate, months });
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
    res.clearSession();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'delete_failed', message: err.message });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    baseUrl: config.appBaseUrl,
    banks: banks.listProviders(),
    supabaseConfigured: Boolean(config.supabase.url && config.supabase.serviceRoleKey),
  });
});

app.use('/api', (_req, res) => res.status(404).json({ error: 'not_found' }));
app.use('/auth', (_req, res) => res.status(404).json({ error: 'not_found' }));

// ---------------------------------------------------------------
// Exécution locale : sert aussi les fichiers du site.
// Sur Vercel, le statique est géré par la plateforme (vercel.json).
// ---------------------------------------------------------------
if (!process.env.VERCEL) {
  // Liste blanche : les fichiers du serveur (config.js, providers.js…) ne
  // doivent jamais être servis au navigateur.
  const STATIC_FILES = [
    'index.html', 'app.js', 'styles.css', 'sw.js', 'offline.html',
    'manifest.webmanifest', 'robots.txt',
    'icon-192.png', 'icon-512.png', 'icon-maskable-512.png', 'apple-touch-icon.png',
  ];

  app.get('*', (req, res) => {
    const file = req.path.replace(/^\//, '');
    if (STATIC_FILES.includes(file)) {
      if (file === 'sw.js' || file === 'index.html') res.setHeader('Cache-Control', 'no-cache');
      return res.sendFile(path.join(__dirname, file));
    }
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(path.join(__dirname, 'index.html'));
  });

  app.listen(config.port, () => {
    const etat = banks.listProviders().map((p) => `${p.label} : ${p.live ? 'réel' : 'démo'}`).join(' | ');
    console.log(`SBR Budget — ${config.appBaseUrl} (${etat})`);
  });
}

module.exports = app;
