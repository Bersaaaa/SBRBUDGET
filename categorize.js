// ============================================================
// SBR Budget — Catégorisation automatique & détection des abonnements
// ============================================================

const CATEGORY_RULES = [
  { category: 'Logement', keywords: ['loyer', 'agence immobili', 'edf', 'engie', 'eau ', 'syndic'] },
  { category: 'Alimentation', keywords: ['carrefour', 'leclerc', 'auchan', 'lidl', 'monoprix', 'franprix', 'intermarche', 'boulangerie', 'restaurant', 'bistrot'] },
  { category: 'Transport', keywords: ['essence', 'carburant', 'total', 'esso', 'shell', 'sncf', 'ratp', 'uber', 'blablacar', 'parking'] },
  { category: 'Téléphone', keywords: ['free mobile', 'orange', 'sfr', 'bouygues telecom'] },
  { category: 'Abonnements', keywords: ['netflix', 'deezer', 'spotify', 'disney', 'amazon prime', 'canal+', 'apple.com/bill', 'youtube premium'] },
  { category: 'Shopping', keywords: ['amazon', 'fnac', 'zara', 'shein', 'decathlon', 'ikea'] },
  { category: 'Loisirs', keywords: ['cinema', 'cinéma', 'ugc', 'pathe', 'concert', 'fnac spectacles'] },
  { category: 'Banque', keywords: ['frais bancaire', 'cotisation carte', 'agios', 'commission'] },
  { category: 'Impôts', keywords: ['dgfip', 'impots.gouv', 'tresor public', 'urssaf'] },
  { category: 'Santé', keywords: ['pharmacie', 'mutuelle', 'medecin', 'docteur', 'hopital', 'cpam'] },
  { category: 'Salaire', keywords: ['salaire', 'paie', 'employeur', 'virement salaire'] },
];

function normalize(text) {
  return (text || '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/**
 * Devine la catégorie d'une transaction à partir de son libellé/marchand.
 * Retourne "Autre" (dépense) ou "Autre revenu" (revenu) si aucune règle
 * ne correspond.
 */
function categorizeTransaction({ label, merchant, amount }) {
  const haystack = normalize(`${label || ''} ${merchant || ''}`);
  for (const rule of CATEGORY_RULES) {
    if (rule.keywords.some((k) => haystack.includes(normalize(k)))) {
      return rule.category;
    }
  }
  return amount >= 0 ? 'Autre revenu' : 'Autre';
}

/**
 * Détecte les opérations récurrentes (abonnements) à partir d'un historique
 * de transactions d'un même compte : regroupe par (marchand, montant) et
 * ne retient que les groupes apparaissant au moins 2 fois avec un intervalle
 * régulier (~30 jours ± 5, ou ~7 jours ± 2).
 */
function detectRecurring(transactions) {
  const groups = new Map();
  for (const t of transactions) {
    if (t.amount >= 0) continue; // on ne détecte des abonnements que sur des dépenses
    const key = `${normalize(t.merchant || t.label)}|${Math.abs(t.amount).toFixed(2)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(t);
  }

  const subscriptions = [];
  for (const [, group] of groups) {
    if (group.length < 2) continue;
    const sorted = group.slice().sort((a, b) => new Date(a.date) - new Date(b.date));
    const gaps = [];
    for (let i = 1; i < sorted.length; i++) {
      const days = (new Date(sorted[i].date) - new Date(sorted[i - 1].date)) / (1000 * 60 * 60 * 24);
      gaps.push(days);
    }
    const avgGap = gaps.reduce((a, b) => a + b, 0) / gaps.length;

    let frequency = null;
    if (avgGap >= 25 && avgGap <= 35) frequency = 'monthly';
    else if (avgGap >= 5 && avgGap <= 9) frequency = 'weekly';
    else if (avgGap >= 350 && avgGap <= 380) frequency = 'yearly';
    if (!frequency) continue;

    const last = sorted[sorted.length - 1];
    const nextDate = new Date(last.date);
    const addDays = frequency === 'monthly' ? 30 : frequency === 'weekly' ? 7 : 365;
    nextDate.setDate(nextDate.getDate() + addDays);

    subscriptions.push({
      name: last.merchant || last.label,
      merchant: last.merchant || last.label,
      category: categorizeTransaction(last),
      amount: Math.abs(last.amount),
      currency: last.currency || 'EUR',
      frequency,
      nextEstimatedDate: nextDate.toISOString().slice(0, 10),
      firstSeenDate: sorted[0].date,
      lastSeenDate: last.date,
    });
  }
  return subscriptions;
}

module.exports = { categorizeTransaction, detectRecurring };
