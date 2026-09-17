// ============================================================
// SBR Budget — Connexion bancaire DIRECTE (sans API officielle DSP2)
//
// À la place du parcours Open Banking (TPP, certificats QWAC, agrément
// ACPR — inutile pour un usage strictement personnel sur ton propre
// compte), ce module se connecte comme tu le ferais toi-même dans un
// navigateur : identifiant + mot de passe / code d'accès, puis lecture
// des soldes et opérations affichés sur l'espace client de la banque.
//
// ⚠️ IMPORTANT — À LIRE AVANT UTILISATION
// - ESTIMATION / À VÉRIFIER : les URLs et sélecteurs ci-dessous sont une
//   base de départ, pas une intégration testée en conditions réelles
//   (cet environnement de développement n'a pas d'accès réseau sortant
//   pour se connecter à ton compte et vérifier). Il est très probable
//   qu'il faille ajuster LOGIN_SELECTORS / SECRET_SELECTORS ci-dessous
//   après un premier essai (voir README, section "Connexion directe").
// - Ce mode sort du cadre prévu par les CGU des banques (accès
//   automatisé non explicitement autorisé). Pour un usage personnel sur
//   ton propre compte, le risque est limité, mais ce n'est pas un
//   usage "officiel".
// - Nickel et le Crédit Mutuel peuvent demander une authentification
//   forte (SMS, notification appli) à la connexion. Ce module gère un
//   palier "code reçu par SMS" (voir requestOtp/submitOtp) mais ne peut
//   pas contourner une validation qui se ferait uniquement dans
//   l'application mobile de la banque — dans ce cas, la synchronisation
//   automatique restera bloquée et il faudra repasser en saisie
//   manuelle pour cette session-là.
// - Nécessite un navigateur Chromium (Playwright). Doit tourner en
//   process Node persistant (local, VPS, Raspberry Pi…) : PAS compatible
//   avec Vercel serverless, car la session navigateur doit rester
//   ouverte entre l'étape mot de passe et l'étape code SMS. Voir README.
// ============================================================

const crypto = require('crypto');
const config = require('./config');

let chromium = null;
function getChromium() {
  if (!chromium) {
    // Chargement paresseux : évite de faire échouer tout le serveur si
    // Playwright n'est pas installé sur un déploiement qui n'utilise pas
    // la connexion directe.
    chromium = require('playwright').chromium;
  }
  return chromium;
}

// ---------------------------------------------------------------
// Sélecteurs par banque — ESTIMATION / À VÉRIFIER (voir README).
// Chaque entrée est une LISTE de sélecteurs essayés dans l'ordre : le
// premier qui correspond à un élément visible est utilisé. Ça donne une
// chance raisonnable que ça marche du premier coup, et une liste claire
// à corriger sinon.
// ---------------------------------------------------------------
const SITES = {
  nickel: {
    label: 'Nickel',
    // ESTIMATION / À VÉRIFIER
    loginUrl: 'https://mon.compte-nickel.fr/',
    // Identifiant client à 10 chiffres (dos de la carte)
    loginSelectors: [
      'input[name="identifiant"]',
      'input[name="login"]',
      'input#identifiant',
      'input[type="text"]',
    ],
    // Code d'accès à 6 chiffres
    secretSelectors: [
      'input[name="password"]',
      'input[name="codeAcces"]',
      'input[type="password"]',
    ],
    submitSelectors: [
      'button[type="submit"]',
      'button:has-text("Connexion")',
      'button:has-text("Me connecter")',
    ],
    // Détection d'un écran de code SMS après soumission du formulaire
    otpSelectors: [
      'input[name="otp"]',
      'input[name="code"]',
      'input[autocomplete="one-time-code"]',
    ],
    // Une fois connecté : sélecteurs pour retrouver soldes / opérations.
    // À adapter une fois la page réelle inspectée (voir README).
    accountsUrl: 'https://mon.compte-nickel.fr/comptes',
    transactionsUrl: 'https://mon.compte-nickel.fr/operations',
  },
  creditmutuel: {
    label: 'Crédit Mutuel',
    // ESTIMATION / À VÉRIFIER
    loginUrl: 'https://www.creditmutuel.fr/fr/banques/particuliers.html',
    loginSelectors: [
      'input[name="_cm_user"]',
      'input#idsaisie',
      'input[type="text"]',
    ],
    secretSelectors: [
      'input[name="_cm_pwd"]',
      'input#password',
      'input[type="password"]',
    ],
    submitSelectors: [
      'input[type="submit"]',
      'button[type="submit"]',
      'button:has-text("Connexion")',
    ],
    otpSelectors: [
      'input[name="otp"]',
      'input[name="code"]',
      'input[autocomplete="one-time-code"]',
    ],
    accountsUrl: 'https://www.creditmutuel.fr/fr/banque/mes-comptes.html',
    transactionsUrl: null, // récupéré depuis la page comptes (voir scrapeAccounts)
  },
};

function assertSupported(provider) {
  if (!SITES[provider]) {
    throw new Error(`Connexion directe non définie pour "${provider}".`);
  }
  return SITES[provider];
}

// ---------------------------------------------------------------
// Sessions navigateur en attente d'un code OTP.
// En mémoire process (voir avertissement en tête de fichier : ce mode
// doit tourner sur un process Node persistant, pas en serverless).
// ---------------------------------------------------------------
const pendingOtpSessions = new Map(); // attemptId -> { browser, context, page, provider, userId, expiresAt }

function cleanupExpiredAttempts() {
  const now = Date.now();
  for (const [id, s] of pendingOtpSessions.entries()) {
    if (s.expiresAt < now) {
      s.browser.close().catch(() => {});
      pendingOtpSessions.delete(id);
    }
  }
}
setInterval(cleanupExpiredAttempts, 60_000).unref?.();

async function firstVisible(page, selectors) {
  for (const sel of selectors) {
    const loc = page.locator(sel).first();
    try {
      if (await loc.isVisible({ timeout: 1500 })) return loc;
    } catch (_) {
      // ignore, essaie le sélecteur suivant
    }
  }
  return null;
}

/**
 * Tente une connexion directe (identifiant + secret) sur le site de la
 * banque. Retourne soit une connexion établie (avec état de session à
 * conserver), soit un statut "otp_required" avec un attemptId à
 * renvoyer via submitOtp().
 */
async function attemptLogin(provider, { login, secret }) {
  // Remarque sécurité : login/secret ne transitent jamais par le cookie de
  // session client — ils restent en mémoire serveur (ici, ou dans
  // pendingOtpSessions le temps du palier OTP) et ne sont écrits en base
  // (chiffrés) qu'une fois la connexion confirmée.
  const site = assertSupported(provider);
  const { chromium: launchChromium } = { chromium: getChromium() };
  const browser = await launchChromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    await page.goto(site.loginUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    const loginField = await firstVisible(page, site.loginSelectors);
    const secretField = await firstVisible(page, site.secretSelectors);
    if (!loginField || !secretField) {
      throw new Error(
        `Formulaire de connexion ${site.label} introuvable avec les sélecteurs actuels. ` +
        `Il faut ajuster loginSelectors/secretSelectors dans scraper.js (voir README).`
      );
    }
    await loginField.fill(String(login));
    await secretField.fill(String(secret));

    const submitBtn = await firstVisible(page, site.submitSelectors);
    if (submitBtn) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
        submitBtn.click(),
      ]);
    } else {
      await secretField.press('Enter');
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }

    const otpField = await firstVisible(page, site.otpSelectors);
    if (otpField) {
      const attemptId = crypto.randomBytes(16).toString('hex');
      pendingOtpSessions.set(attemptId, {
        browser,
        context,
        page,
        provider,
        login,
        secret,
        expiresAt: Date.now() + 5 * 60_000, // 5 min pour saisir le code reçu par SMS
      });
      return { status: 'otp_required', attemptId };
    }

    const sessionState = await context.storageState();
    await browser.close();
    return { status: 'connected', sessionState };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Termine une connexion en attente de code SMS.
 */
async function submitOtp(attemptId, code) {
  const pending = pendingOtpSessions.get(attemptId);
  if (!pending) {
    throw new Error('Session de connexion expirée ou introuvable, recommence la connexion.');
  }
  pendingOtpSessions.delete(attemptId);
  const { browser, context, page, provider, login, secret } = pending;
  const site = assertSupported(provider);
  try {
    const otpField = await firstVisible(page, site.otpSelectors);
    if (!otpField) throw new Error('Champ code SMS introuvable (session probablement expirée).');
    await otpField.fill(String(code));
    const submitBtn = await firstVisible(page, site.submitSelectors);
    if (submitBtn) {
      await Promise.all([
        page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
        submitBtn.click(),
      ]);
    } else {
      await otpField.press('Enter');
      await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    }
    const sessionState = await context.storageState();
    await browser.close();
    return { status: 'connected', sessionState, login, secret };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

/**
 * Réutilise un état de session sauvegardé (cookies) pour aller lire
 * soldes et opérations, sans redemander identifiant/mot de passe à
 * chaque synchronisation. Si la session a expiré, renvoie
 * { status: 'reauth_required' } : il faudra reconnecter via attemptLogin.
 */
async function scrapeAccounts(provider, sessionState) {
  const site = assertSupported(provider);
  const chromiumEngine = getChromium();
  const browser = await chromiumEngine.launch({ headless: true });
  const context = await browser.newContext({ storageState: sessionState });
  const page = await context.newPage();

  try {
    await page.goto(site.accountsUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // Si la banque nous renvoie vers l'écran de connexion, la session a expiré.
    const backOnLogin = await firstVisible(page, site.loginSelectors);
    if (backOnLogin) {
      await browser.close();
      return { status: 'reauth_required' };
    }

    // ESTIMATION / À VÉRIFIER : extraction générique à partir du texte de
    // la page. À remplacer par de vrais sélecteurs une fois la page
    // "mes comptes" inspectée (voir README, section "Ajuster les
    // sélecteurs"). Ici on tente de repérer des montants type "1 234,56 €"
    // associés à un libellé, ce qui donne un point de départ exploitable
    // même sans sélecteurs précis.
    const accounts = await page.evaluate(() => {
      const amountRegex = /-?\d[\d\s]*,\d{2}\s?€/;
      const rows = [];
      document.querySelectorAll('body *').forEach((el) => {
        if (el.children.length > 0) return; // ne garde que les feuilles
        const text = (el.textContent || '').trim();
        if (amountRegex.test(text) && text.length < 40) {
          rows.push(text);
        }
      });
      return rows.slice(0, 20);
    });

    const newSessionState = await context.storageState();
    await browser.close();
    return {
      status: 'ok',
      rawAccountTexts: accounts, // à catégoriser côté serveur (voir server.js)
      sessionState: newSessionState,
    };
  } catch (err) {
    await browser.close().catch(() => {});
    throw err;
  }
}

module.exports = {
  isDirectModeAvailable(provider) {
    return Boolean(SITES[provider]);
  },
  attemptLogin,
  submitOtp,
  scrapeAccounts,
};
