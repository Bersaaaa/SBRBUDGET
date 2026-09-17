// ============================================================
// SBR Budget — Logique frontend (vanilla JS, sans framework)
// Aucun secret bancaire n'est jamais manipulé ici : uniquement des
// appels à notre propre backend (mêmes origine, cookies de session).
// ============================================================

const state = {
  user: null,
  categories: [],
  currentView: 'home',
  banks: [],          // banques proposées (Nickel, Crédit Mutuel)
  connections: [],    // banques déjà connectées par l'utilisateur
  deferredInstall: null, // événement d'installation PWA
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

function euros(n) {
  const value = Number(n || 0);
  return value.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '\u00A0€';
}

function formatDateShort(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short' });
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.add('hidden'), 3200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  let data = {};
  try { data = await res.json(); } catch (_) { /* pas de corps JSON */ }
  if (!res.ok) {
    const err = new Error(data.message || 'Une erreur est survenue.');
    err.code = data.error;
    err.status = res.status;
    throw err;
  }
  return data;
}

// ---------------------------------------------------------------
// Démarrage
// ---------------------------------------------------------------
document.addEventListener('DOMContentLoaded', init);

async function init() {
  bindAuthForms();
  bindNavigation();
  bindHomeActions();
  bindTransactionsView();
  bindBudgetsView();
  bindAccountsView();
  bindSettingsView();
  bindBankModal();
  bindInstallPrompt();
  handleBankRedirectFlags();

  loadBanks();

  try {
    const { user } = await api('/api/auth/me');
    state.user = user;
    await enterApp();
  } catch (_) {
    showAuthScreen();
  }
}

function handleBankRedirectFlags() {
  const params = new URLSearchParams(window.location.search);
  if (params.has('bank_connected')) {
    window.history.replaceState({}, '', window.location.pathname);
    window.sessionStorage.setItem('bank_flag', 'success');
    window.sessionStorage.setItem('bank_flag_provider', params.get('bank_connected') || '');
  } else if (params.has('bank_error')) {
    window.history.replaceState({}, '', window.location.pathname);
    window.sessionStorage.setItem('bank_flag', 'error');
  }
}

async function loadBanks() {
  try {
    const { banks } = await api('/api/banks');
    state.banks = banks;
  } catch (_) {
    state.banks = [];
  }
}

function bankLabel(providerId) {
  const bank = state.banks.find((b) => b.id === providerId);
  return bank ? bank.label : providerId;
}

function showAuthScreen() {
  $('#screen-auth').classList.remove('hidden');
  $('#main').classList.add('hidden');
}

async function enterApp() {
  $('#screen-auth').classList.add('hidden');
  $('#main').classList.remove('hidden');
  $('#settings-email').textContent = state.user.email;

  await loadCategories();
  await refreshAccountsAndBalance();
  await Promise.all([loadRecentTransactions(), loadSubscriptionsHome()]);

  const flag = window.sessionStorage.getItem('bank_flag');
  if (flag) {
    const provider = window.sessionStorage.getItem('bank_flag_provider') || '';
    window.sessionStorage.removeItem('bank_flag');
    window.sessionStorage.removeItem('bank_flag_provider');
    const banner = $('#banner-bank-status');
    banner.classList.remove('hidden', 'success', 'error');
    if (flag === 'success') {
      banner.classList.add('success');
      banner.textContent = `${bankLabel(provider)} connecté. Synchronisation en cours…`;
      triggerSync(true);
    } else {
      banner.classList.add('error');
      banner.textContent = "La connexion bancaire a échoué. Réessayez depuis l'écran Comptes.";
    }
  }
}

// ---------------------------------------------------------------
// Authentification
// ---------------------------------------------------------------
function bindAuthForms() {
  $$('.auth-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      $$('.auth-tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      const isLogin = tab.dataset.tab === 'login';
      $('#form-login').classList.toggle('hidden', !isLogin);
      $('#form-signup').classList.toggle('hidden', isLogin);
    });
  });

  $('#form-login').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const errorEl = $('#login-error');
    errorEl.textContent = '';
    try {
      const { user } = await api('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email: form.get('email'), password: form.get('password') }),
      });
      state.user = user;
      await enterApp();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  $('#form-signup').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const errorEl = $('#signup-error');
    errorEl.textContent = '';
    try {
      const { user } = await api('/api/auth/signup', {
        method: 'POST',
        body: JSON.stringify({
          email: form.get('email'),
          password: form.get('password'),
          fullName: form.get('fullName'),
        }),
      });
      state.user = user;
      await enterApp();
    } catch (err) {
      errorEl.textContent = err.message;
    }
  });

  const logout = async () => {
    await api('/api/auth/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    window.location.reload();
  };
  $('#btn-logout-desktop').addEventListener('click', logout);
  $('#btn-logout-mobile').addEventListener('click', logout);
}

// ---------------------------------------------------------------
// Navigation entre vues
// ---------------------------------------------------------------
function bindNavigation() {
  const navigate = (view) => {
    state.currentView = view;
    $$('.view').forEach((v) => v.classList.remove('active'));
    const target = $(`#view-${view}`);
    if (target) target.classList.add('active');

    $$('.nav-item[data-view]').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    $$('.bottom-nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));

    if (view === 'transactions') loadFullTransactions();
    if (view === 'budgets') loadBudgets();
    if (view === 'stats') loadStats();
    if (view === 'accounts') loadAccountsView();
    if (view === 'subscriptions') loadSubscriptionsFull();
  };

  $$('.nav-item[data-view]').forEach((btn) => btn.addEventListener('click', () => navigate(btn.dataset.view)));
  $$('.bottom-nav-item').forEach((btn) => btn.addEventListener('click', () => navigate(btn.dataset.view)));
  $$('[data-view-link]').forEach((btn) => btn.addEventListener('click', () => navigate(btn.dataset.viewLink)));

  window.navigateTo = navigate;
}

// ---------------------------------------------------------------
// Accueil
// ---------------------------------------------------------------
function bindHomeActions() {
  $('#btn-connect-bank').addEventListener('click', openBankModal);
  $('#btn-sync-now').addEventListener('click', () => triggerSync());
}

// ---------------------------------------------------------------
// Choix de la banque (Nickel / Crédit Mutuel)
// ---------------------------------------------------------------
function bindBankModal() {
  $('#btn-add-bank').addEventListener('click', openBankModal);
  $('#btn-cancel-bank').addEventListener('click', closeBankModal);
  $('#modal-bank').addEventListener('click', (e) => {
    if (e.target.id === 'modal-bank') closeBankModal();
  });
}

async function openBankModal() {
  if (!state.banks.length) await loadBanks();
  const list = $('#bank-choice-list');
  list.innerHTML = '';

  if (!state.banks.length) {
    list.innerHTML = '<li class="empty-state">Aucune banque disponible sur ce serveur.</li>';
  }

  for (const bank of state.banks) {
    const already = state.connections.some((c) => c.provider === bank.id && c.status === 'active');
    const li = document.createElement('li');
    li.className = 'bank-choice' + (already ? ' connected' : '');
    li.innerHTML = `
      <div class="bank-choice-main">
        <span class="bank-choice-name">${escapeHtml(bank.label)}</span>
        <span class="bank-choice-meta">${already ? 'Déjà connectée' : (bank.live ? 'Connexion DSP2 officielle' : 'Mode démonstration')}</span>
      </div>
      <span class="bank-choice-action">${already ? 'Reconnecter' : 'Connecter'}</span>
    `;
    li.addEventListener('click', () => connectBank(bank.id));
    list.appendChild(li);
  }

  $('#modal-bank').classList.remove('hidden');
}

function closeBankModal() {
  $('#modal-bank').classList.add('hidden');
}

async function connectBank(providerId) {
  try {
    const { authorizeUrl } = await api(`/auth/bank/${providerId}/start`);
    window.location.href = authorizeUrl;
  } catch (err) {
    showToast(err.message);
  }
}

async function triggerSync(silent = false, provider = null) {
  const btn = $('#btn-sync-now');
  const originalText = btn.textContent;
  btn.textContent = 'Synchronisation…';
  btn.disabled = true;
  try {
    const result = await api('/api/sync', {
      method: 'POST',
      body: JSON.stringify(provider ? { provider } : {}),
    });
    if (!silent) {
      const failed = result.failed && result.failed.length ? ` — échec : ${result.failed.join(', ')}` : '';
      showToast(`Synchronisé — ${result.transactionsImported} nouvelle(s) transaction(s)${failed}.`);
    }
    await refreshAccountsAndBalance();
    await Promise.all([loadRecentTransactions(), loadSubscriptionsHome()]);
    if (state.currentView === 'transactions') await loadFullTransactions();
  } catch (err) {
    showToast(err.message);
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

async function refreshAccountsAndBalance() {
  try {
    const { accounts, connections } = await api('/api/accounts');
    state.connections = connections || [];
    const total = accounts.reduce((sum, a) => sum + Number(a.balance || 0), 0);
    $('#home-balance').textContent = euros(total);

    const active = state.connections.filter((c) => c.status === 'active');
    $('#home-banks').textContent = active.length
      ? `Banques connectées : ${active.map((c) => c.label).join(', ')}`
      : '';
    $('#settings-banks').textContent = active.length ? active.map((c) => c.label).join(', ') : 'Aucune';

    const connectBtn = $('#btn-connect-bank');
    const syncBtn = $('#btn-sync-now');
    connectBtn.textContent = active.length ? 'Connecter une autre banque' : 'Connecter ma banque';
    syncBtn.classList.toggle('hidden', active.length === 0);

    const stats = await api('/api/stats');
    const currentMonth = stats.months[stats.months.length - 1];
    const monthData = currentMonth ? stats.monthly[currentMonth] : { income: 0, expense: 0 };
    $('#home-income').textContent = euros(monthData.income);
    $('#home-expense').textContent = euros(monthData.expense);
  } catch (err) {
    console.error(err);
  }
}

async function loadRecentTransactions() {
  try {
    const { transactions } = await api('/api/transactions?limit=6');
    renderTxList($('#home-recent-tx'), transactions, { compact: true });
  } catch (err) { /* silencieux à l'accueil */ }
}

async function loadSubscriptionsHome() {
  try {
    const { subscriptions } = await api('/api/subscriptions');
    renderSubList($('#home-subs'), subscriptions.slice(0, 4));
  } catch (err) { /* silencieux */ }
}

// ---------------------------------------------------------------
// Rendu listes de transactions / abonnements
// ---------------------------------------------------------------
function renderTxList(container, transactions, { compact = false } = {}) {
  container.innerHTML = '';
  if (!transactions.length) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = 'Aucune transaction pour le moment.';
    container.appendChild(li);
    return;
  }
  for (const t of transactions) {
    const li = document.createElement('li');
    li.className = 'tx-row';
    const isIncome = Number(t.amount) >= 0;
    li.innerHTML = `
      <div class="tx-main">
        <span class="tx-label">${escapeHtml(t.label)}</span>
        <span class="tx-meta">${formatDateShort(t.date)} · ${escapeHtml(t.category || 'Autre')}</span>
      </div>
      <span class="tx-amount ${isIncome ? 'positive' : 'negative'}">${isIncome ? '+' : '-'}${euros(Math.abs(t.amount))}</span>
    `;
    if (!compact) {
      const select = document.createElement('select');
      select.className = 'tx-category-select';
      for (const cat of state.categories) {
        const opt = document.createElement('option');
        opt.value = cat.name;
        opt.textContent = cat.name;
        if (cat.name === t.category) opt.selected = true;
        select.appendChild(opt);
      }
      select.addEventListener('change', async () => {
        try {
          await api(`/api/transactions/${t.id}/category`, {
            method: 'PATCH',
            body: JSON.stringify({ category: select.value }),
          });
          showToast('Catégorie mise à jour.');
        } catch (err) {
          showToast(err.message);
        }
      });
      li.querySelector('.tx-main').appendChild(select);
    }
    container.appendChild(li);
  }
}

function renderSubList(container, subscriptions) {
  container.innerHTML = '';
  if (!subscriptions.length) {
    const li = document.createElement('li');
    li.className = 'empty-state';
    li.textContent = 'Aucun abonnement détecté pour le moment.';
    container.appendChild(li);
    return;
  }
  for (const s of subscriptions) {
    const li = document.createElement('li');
    li.className = 'sub-row';
    const freqLabel = { monthly: '/mois', weekly: '/semaine', yearly: '/an' }[s.frequency] || '';
    const annualTotal = s.frequency === 'monthly' ? s.amount * 12 : s.frequency === 'weekly' ? s.amount * 52 : s.amount;
    li.innerHTML = `
      <div class="sub-main">
        <span class="sub-name">${escapeHtml(s.name)}</span>
        <span class="sub-freq">Prochain prélèvement estimé : ${s.next_estimated_date ? formatDateShort(s.next_estimated_date) : '—'} · ${euros(annualTotal)}/an</span>
      </div>
      <span class="tx-amount">${euros(s.amount)}${freqLabel}</span>
    `;
    container.appendChild(li);
  }
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

// ---------------------------------------------------------------
// Vue Transactions
// ---------------------------------------------------------------
function bindTransactionsView() {
  const debounce = (fn, delay) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), delay); };
  };
  $('#tx-search').addEventListener('input', debounce(loadFullTransactions, 300));
  $('#tx-filter-type').addEventListener('change', loadFullTransactions);
  $('#tx-filter-category').addEventListener('change', loadFullTransactions);
  $('#tx-filter-period').addEventListener('change', loadFullTransactions);
}

async function loadCategories() {
  try {
    const { categories } = await api('/api/categories');
    state.categories = categories;
    const catSelect = $('#tx-filter-category');
    const budgetSelect = $('#budget-category-select');
    catSelect.innerHTML = '<option value="">Toutes catégories</option>';
    budgetSelect.innerHTML = '';
    for (const c of categories) {
      const opt1 = document.createElement('option');
      opt1.value = c.name; opt1.textContent = c.name;
      catSelect.appendChild(opt1);
      const opt2 = document.createElement('option');
      opt2.value = c.name; opt2.textContent = c.name;
      budgetSelect.appendChild(opt2);
    }
  } catch (err) { /* silencieux */ }
}

async function loadFullTransactions() {
  const search = $('#tx-search').value.trim();
  const type = $('#tx-filter-type').value;
  const category = $('#tx-filter-category').value;
  const period = $('#tx-filter-period').value; // format YYYY-MM

  const params = new URLSearchParams();
  if (search) params.set('search', search);
  if (type) params.set('type', type);
  if (category) params.set('category', category);
  if (period) {
    params.set('from', `${period}-01`);
    const [y, m] = period.split('-').map(Number);
    const to = new Date(y, m, 1).toISOString().slice(0, 10);
    params.set('to', to);
  }

  try {
    const { transactions } = await api(`/api/transactions?${params.toString()}`);
    renderTxList($('#tx-full-list'), transactions);
    $('#tx-empty').classList.toggle('hidden', transactions.length > 0);
  } catch (err) {
    showToast(err.message);
  }
}

async function loadSubscriptionsFull() {
  try {
    const { subscriptions } = await api('/api/subscriptions');
    renderSubList($('#subs-full-list'), subscriptions);
    $('#subs-empty').classList.toggle('hidden', subscriptions.length > 0);
  } catch (err) {
    showToast(err.message);
  }
}

// ---------------------------------------------------------------
// Vue Budgets
// ---------------------------------------------------------------
function bindBudgetsView() {
  $('#btn-new-budget').addEventListener('click', () => $('#modal-budget').classList.remove('hidden'));
  $('#btn-cancel-budget').addEventListener('click', () => $('#modal-budget').classList.add('hidden'));
  $('#form-budget').addEventListener('submit', async (e) => {
    e.preventDefault();
    const form = new FormData(e.target);
    const month = new Date();
    const monthStr = `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}-01`;
    try {
      await api('/api/budgets', {
        method: 'POST',
        body: JSON.stringify({
          category: form.get('category'),
          month: monthStr,
          amount: Number(form.get('amount')),
        }),
      });
      $('#modal-budget').classList.add('hidden');
      e.target.reset();
      await loadBudgets();
      showToast('Budget créé.');
    } catch (err) {
      showToast(err.message);
    }
  });
}

async function loadBudgets() {
  try {
    const { budgets } = await api('/api/budgets');
    const list = $('#budget-list');
    list.innerHTML = '';
    $('#budget-empty').classList.toggle('hidden', budgets.length > 0);
    for (const b of budgets) {
      const pct = b.amount > 0 ? Math.min(100, Math.round((b.spent / b.amount) * 100)) : 0;
      const over = b.spent > b.amount;
      const li = document.createElement('li');
      li.className = 'budget-row';
      li.innerHTML = `
        <div class="budget-top">
          <strong>${escapeHtml(b.category)}</strong>
          <button class="link-btn" data-id="${b.id}">Supprimer</button>
        </div>
        <div class="budget-bar-track"><div class="budget-bar-fill ${over ? 'over' : ''}" style="width:${pct}%"></div></div>
        <div class="budget-bottom">
          <span>Dépensé : ${euros(b.spent)}</span>
          <span>Restant : ${euros(b.remaining)}</span>
        </div>
      `;
      li.querySelector('button').addEventListener('click', async () => {
        try {
          await api(`/api/budgets/${b.id}`, { method: 'DELETE' });
          await loadBudgets();
        } catch (err) { showToast(err.message); }
      });
      list.appendChild(li);
    }
  } catch (err) {
    showToast(err.message);
  }
}

// ---------------------------------------------------------------
// Vue Statistiques
// ---------------------------------------------------------------
async function loadStats() {
  try {
    const { monthly, byCategory, savingsRate, months } = await api('/api/stats');
    $('#stats-savings-rate').textContent = savingsRate === null ? '—' : `${savingsRate}\u00A0%`;
    drawIncomeExpenseChart(months, monthly);
    drawCategoryBars(byCategory);
  } catch (err) {
    showToast(err.message);
  }
}

function drawIncomeExpenseChart(months, monthly) {
  const canvas = $('#chart-income-expense');
  const ctx = canvas.getContext('2d');
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  const recentMonths = months.slice(-6);
  if (!recentMonths.length) return;
  const maxVal = Math.max(1, ...recentMonths.map((m) => Math.max(monthly[m].income, monthly[m].expense)));
  const barGroupWidth = w / recentMonths.length;
  const barWidth = barGroupWidth * 0.28;
  const bottom = h - 30;

  ctx.font = '12px Inter, sans-serif';
  ctx.fillStyle = '#9AA0AB';
  ctx.textAlign = 'center';

  recentMonths.forEach((m, i) => {
    const groupX = i * barGroupWidth + barGroupWidth / 2;
    const income = monthly[m].income;
    const expense = monthly[m].expense;
    const incomeH = (income / maxVal) * (bottom - 20);
    const expenseH = (expense / maxVal) * (bottom - 20);

    ctx.fillStyle = '#3EAA82';
    ctx.fillRect(groupX - barWidth - 4, bottom - incomeH, barWidth, incomeH);
    ctx.fillStyle = '#E2604F';
    ctx.fillRect(groupX + 4, bottom - expenseH, barWidth, expenseH);

    ctx.fillStyle = '#9AA0AB';
    const label = new Date(m + '-01').toLocaleDateString('fr-FR', { month: 'short' });
    ctx.fillText(label, groupX, bottom + 18);
  });
}

function drawCategoryBars(byCategory) {
  const container = $('#chart-by-category');
  container.innerHTML = '';
  const entries = Object.entries(byCategory).sort((a, b) => b[1] - a[1]).slice(0, 8);
  if (!entries.length) {
    container.innerHTML = '<p class="empty-state">Pas encore assez de données.</p>';
    return;
  }
  const max = Math.max(...entries.map(([, v]) => v));
  for (const [category, value] of entries) {
    const row = document.createElement('div');
    row.className = 'bar-row';
    row.innerHTML = `
      <span class="bar-row-label">${escapeHtml(category)}</span>
      <span class="bar-row-track"><span class="bar-row-fill" style="width:${(value / max) * 100}%"></span></span>
      <span class="bar-row-value">${euros(value)}</span>
    `;
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------
// Vue Comptes
// ---------------------------------------------------------------
function bindAccountsView() {
  $('#btn-sync-accounts').addEventListener('click', () => triggerSync());
}

async function loadAccountsView() {
  try {
    const { accounts, connections } = await api('/api/accounts');
    state.connections = connections || [];

    // Banques connectées, avec synchronisation et déconnexion par banque.
    const connectionList = $('#connection-list');
    connectionList.innerHTML = '';
    if (!state.connections.length) {
      connectionList.innerHTML = '<li class="empty-state">Aucune banque connectée. Utilisez « Ajouter une banque » pour connecter Nickel ou le Crédit Mutuel.</li>';
    }
    for (const c of state.connections) {
      const li = document.createElement('li');
      li.className = 'connection-row';
      const synced = c.lastSyncedAt
        ? `Synchronisé le ${new Date(c.lastSyncedAt).toLocaleDateString('fr-FR')}`
        : 'Jamais synchronisé';
      li.innerHTML = `
        <div class="tx-main">
          <span class="tx-label">${escapeHtml(c.label)}</span>
          <span class="tx-meta">${synced}${c.environment === 'demo' ? ' · démo' : ''}</span>
        </div>
        <div class="connection-actions">
          <button class="link-btn" data-sync="${escapeHtml(c.provider)}">Synchroniser</button>
          <button class="link-btn danger" data-disconnect="${escapeHtml(c.provider)}">Déconnecter</button>
        </div>
      `;
      connectionList.appendChild(li);
    }

    $$('[data-sync]', connectionList).forEach((btn) => {
      btn.addEventListener('click', () => triggerSync(false, btn.dataset.sync));
    });
    $$('[data-disconnect]', connectionList).forEach((btn) => {
      btn.addEventListener('click', () => disconnectBank(btn.dataset.disconnect));
    });

    // Comptes rapatriés depuis les banques.
    const list = $('#account-list');
    list.innerHTML = '';
    for (const a of accounts) {
      const li = document.createElement('li');
      li.className = 'account-row';
      li.innerHTML = `
        <div class="tx-main">
          <span class="tx-label">${escapeHtml(a.name)}</span>
          <span class="tx-meta">${escapeHtml(a.iban_masked || '')}</span>
        </div>
        <span class="tx-amount">${euros(a.balance)}</span>
      `;
      list.appendChild(li);
    }

    const lastSync = state.connections
      .map((c) => c.lastSyncedAt)
      .filter(Boolean)
      .sort()
      .pop();
    $('#sync-info').textContent = lastSync
      ? `Dernière synchronisation : ${new Date(lastSync).toLocaleDateString('fr-FR')} à ${new Date(lastSync).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}`
      : 'Aucune synchronisation effectuée pour le moment.';
  } catch (err) {
    showToast(err.message);
  }
}

async function disconnectBank(providerId) {
  if (!confirm(`Déconnecter ${bankLabel(providerId)} de SBR Budget ?`)) return;
  try {
    await api(`/api/banks/${providerId}/disconnect`, { method: 'POST' });
    showToast(`${bankLabel(providerId)} déconnecté.`);
    await loadAccountsView();
    await refreshAccountsAndBalance();
  } catch (err) {
    showToast(err.message);
  }
}

// ---------------------------------------------------------------
// Vue Paramètres / RGPD
// ---------------------------------------------------------------
function bindSettingsView() {
  $('#btn-delete-account').addEventListener('click', async () => {
    if (!confirm('Supprimer définitivement votre compte SBR Budget et toutes vos données ? Cette action est irréversible.')) return;
    try {
      await api('/api/account/delete', { method: 'POST' });
      showToast('Compte supprimé.');
      window.location.reload();
    } catch (err) {
      showToast(err.message);
    }
  });
}

// ---------------------------------------------------------------
// PWA : installation sur l'écran d'accueil + service worker
// ---------------------------------------------------------------
function bindInstallPrompt() {
  const buttons = ['#btn-install-app', '#btn-install-landing'].map((sel) => $(sel)).filter(Boolean);

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredInstall = e;
    buttons.forEach((b) => b.classList.remove('hidden'));
  });

  buttons.forEach((btn) => {
    btn.addEventListener('click', async () => {
      if (!state.deferredInstall) return;
      state.deferredInstall.prompt();
      await state.deferredInstall.userChoice;
      state.deferredInstall = null;
      buttons.forEach((b) => b.classList.add('hidden'));
    });
  });

  window.addEventListener('appinstalled', () => {
    state.deferredInstall = null;
    buttons.forEach((b) => b.classList.add('hidden'));
  });
}

if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  });
}
