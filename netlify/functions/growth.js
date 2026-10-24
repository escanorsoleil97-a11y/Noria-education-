// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — growth.js
// Regroupe 3 briques de croissance maîtrisée, budgétées et anti-fraude :
//   1. Infos officielles (onglet "Infos") — source de vérité contre les rumeurs
//   2. Quêtes hebdomadaires (chimis gratuits, plafonnées par un budget mensuel)
//   3. Budget chimis mensuel — admin fixe un plafond, tout dépassement suspend
//      automatiquement les quêtes (jamais une réduction silencieuse des gains)
//
// Le bonus de parrainage "chimi" (distinct du programme Ambassadeur en FCFA
// géré par ambassador.js) est crédité automatiquement dans useAICredit.js
// quand le filleul atteint 3 actions IA réelles — pas ici.
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const ADMIN_UIDS = new Set(['SBATLA0GmVbeYWWpWrPoRTTveb32', '0f9FMESHK6gq5Gl77tquCETbFow1']);

// Catalogue des quêtes hebdomadaires — fixe côté serveur, jamais fourni par le
// client. Chaque quête est vérifiée à partir de données déjà journalisées par
// useAICredit.js (weekActionLog), jamais une simple déclaration du client.
const QUEST_CATALOG = [
  { id: 'connexion',  label: '🔑 Se connecter cette semaine',            chimis: 1, minActions: 0 },
  { id: 'usage3',     label: '⚡ Utiliser l\'IA au moins 3 fois',         chimis: 3, minActions: 3 },
  { id: 'usage8',     label: '🚀 Utiliser l\'IA au moins 8 fois',         chimis: 5, minActions: 8 },
];

const DEFAULT_MONTHLY_BUDGET = 5000; // chimis, ajustable par l'admin

function out(statusCode, body) {
  return { statusCode, headers: H, body: JSON.stringify(body) };
}
const H = {
  'Access-Control-Allow-Origin': (process.env.URL || process.env.DEPLOY_URL || 'https://stat-analyse-pro.netlify.app','https://pstat-pro-all.netlify.app').replace(/\/$/, ''),
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Content-Type': 'application/json',
};

async function requireAuth(event) {
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) throw new Error('AUTH_REQUIRED');
  return admin.auth().verifyIdToken(authHeader.slice(7));
}

function isoWeekKey(d) {
  // Clé ISO "YYYY-Www" — stable pour identifier une semaine calendaire.
  const date = new Date(d.getTime());
  date.setHours(0, 0, 0, 0);
  date.setDate(date.getDate() + 3 - ((date.getDay() + 6) % 7));
  const week1 = new Date(date.getFullYear(), 0, 4);
  const weekNo = 1 + Math.round(((date - week1) / 86400000 - 3 + ((week1.getDay() + 6) % 7)) / 7);
  return date.getFullYear() + '-W' + String(weekNo).padStart(2, '0');
}
function monthKey(d) { return d.toISOString().slice(0, 7); }

// ── Budget mensuel : vérifie ET réserve atomiquement `amount` chimis dans le
// budget "gratuit" du mois en cours. Retourne false (sans lever d'erreur) si
// le plafond est atteint — l'appelant doit alors refuser la distribution
// plutôt que planter, et le message doit dire clairement "quêtes en pause".
async function reserveBudget(amount, source, uid) {
  const key = monthKey(new Date());
  const ref = db.collection('config').doc('chimiBudget');
  const okRef = { ok: false, remaining: 0, cap: DEFAULT_MONTHLY_BUDGET };
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const data = snap.exists ? snap.data() : {};
    const cap = Number.isFinite(data.capChimis) ? data.capChimis : DEFAULT_MONTHLY_BUDGET;
    const spent = data.monthKey === key ? (data.spent || 0) : 0;
    if (spent + amount > cap) {
      okRef.ok = false;
      okRef.remaining = Math.max(0, cap - spent);
      okRef.cap = cap;
      return;
    }
    tx.set(ref, { capChimis: cap, monthKey: key, spent: spent + amount }, { merge: true });
    okRef.ok = true;
    okRef.remaining = cap - (spent + amount);
    okRef.cap = cap;
  });
  if (okRef.ok) {
    try {
      await db.collection('chimi_ledger').add({
        uid, amount, source, ts: new Date().toISOString(), monthKey: key,
      });
    } catch (_) { /* non-bloquant */ }
  }
  return okRef;
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: H, body: '' };
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return out(400, { error: 'JSON invalide' }); }
  const action = body.action;

  try {
    // ── INFOS — lecture publique, pas d'auth requise ────────────────────────
    if (action === 'listInfos') {
      const snap = await db.collection('infoPosts').orderBy('createdAt', 'desc').limit(30).get();
      return out(200, { ok: true, items: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    }

    if (action === 'publishInfo') {
      const decoded = await requireAuth(event);
      if (!ADMIN_UIDS.has(decoded.uid)) return out(403, { error: 'Accès admin requis' });
      const title = String(body.title || '').trim().slice(0, 140);
      const text = String(body.text || '').trim().slice(0, 3000);
      if (!title || !text) return out(400, { error: 'Titre et contenu requis' });
      const ref = await db.collection('infoPosts').add({
        title, text,
        official: true,
        createdAt: new Date().toISOString(),
        createdBy: decoded.uid,
      });
      return out(200, { ok: true, id: ref.id });
    }

    if (action === 'deleteInfo') {
      const decoded = await requireAuth(event);
      if (!ADMIN_UIDS.has(decoded.uid)) return out(403, { error: 'Accès admin requis' });
      const id = String(body.id || '');
      if (!id) return out(400, { error: 'id requis' });
      await db.collection('infoPosts').doc(id).delete();
      return out(200, { ok: true });
    }

    // ── BUDGET MENSUEL — admin seulement ─────────────────────────────────────
    if (action === 'budgetStatus') {
      const decoded = await requireAuth(event);
      if (!ADMIN_UIDS.has(decoded.uid)) return out(403, { error: 'Accès admin requis' });
      const key = monthKey(new Date());
      const snap = await db.collection('config').doc('chimiBudget').get();
      const data = snap.exists ? snap.data() : {};
      const cap = Number.isFinite(data.capChimis) ? data.capChimis : DEFAULT_MONTHLY_BUDGET;
      const spent = data.monthKey === key ? (data.spent || 0) : 0;
      return out(200, { ok: true, monthKey: key, cap, spent, remaining: Math.max(0, cap - spent) });
    }

    if (action === 'setBudget') {
      const decoded = await requireAuth(event);
      if (!ADMIN_UIDS.has(decoded.uid)) return out(403, { error: 'Accès admin requis' });
      const cap = parseInt(body.cap, 10);
      if (!Number.isFinite(cap) || cap < 0) return out(400, { error: 'Plafond invalide' });
      const key = monthKey(new Date());
      const ref = db.collection('config').doc('chimiBudget');
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? snap.data() : {};
        const spent = data.monthKey === key ? (data.spent || 0) : 0;
        tx.set(ref, { capChimis: cap, monthKey: key, spent }, { merge: true });
      });
      return out(200, { ok: true });
    }

    // ── QUÊTES HEBDOMADAIRES ─────────────────────────────────────────────────
    if (action === 'listQuests') {
      const decoded = await requireAuth(event);
      const uid = decoded.uid;
      const week = isoWeekKey(new Date());
      const userSnap = await db.collection('users').doc(uid).get();
      const user = userSnap.exists ? userSnap.data() : {};
      const weekLog = Array.isArray(user.weekActionLog) ? user.weekActionLog : [];
      const now = Date.now();
      const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;
      const actionsThisWeek = weekLog.filter(e => e && e.ts >= cutoff7d).length;
      const claims = (user.questClaims && user.questClaims[week]) || {};
      const items = QUEST_CATALOG.map(q => ({
        ...q,
        progress: Math.min(actionsThisWeek, q.minActions),
        eligible: actionsThisWeek >= q.minActions,
        claimed: !!claims[q.id],
      }));
      return out(200, { ok: true, week, actionsThisWeek, items });
    }

    if (action === 'claimQuest') {
      const decoded = await requireAuth(event);
      const uid = decoded.uid;
      const questId = String(body.questId || '');
      const quest = QUEST_CATALOG.find(q => q.id === questId);
      if (!quest) return out(400, { error: 'Quête inconnue' });
      const week = isoWeekKey(new Date());
      const userRef = db.collection('users').doc(uid);

      const verdict = await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        if (!snap.exists) throw new Error('USER_NOT_FOUND');
        const data = snap.data();
        const weekLog = Array.isArray(data.weekActionLog) ? data.weekActionLog : [];
        const cutoff7d = Date.now() - 7 * 24 * 60 * 60 * 1000;
        const actionsThisWeek = weekLog.filter(e => e && e.ts >= cutoff7d).length;
        if (actionsThisWeek < quest.minActions) throw new Error('NOT_ELIGIBLE');
        const claims = data.questClaims || {};
        const weekClaims = claims[week] || {};
        if (weekClaims[questId]) throw new Error('ALREADY_CLAIMED');
        return { ok: true };
      });
      if (!verdict.ok) return out(400, { error: 'Non éligible' });

      const budget = await reserveBudget(quest.chimis, 'quest_' + questId, uid);
      if (!budget.ok) {
        return out(429, { error: 'budget_exhausted', message: 'Quêtes en pause ce mois-ci — le budget chimis gratuit est épuisé. Réessayez le mois prochain.' });
      }

      await db.runTransaction(async (tx) => {
        const snap = await tx.get(userRef);
        const data = snap.data() || {};
        const claims = data.questClaims || {};
        const weekClaims = claims[week] || {};
        if (weekClaims[questId]) return; // déjà réclamée entre-temps, on n'ajoute pas 2x
        weekClaims[questId] = { claimedAt: new Date().toISOString(), chimis: quest.chimis };
        claims[week] = weekClaims;
        tx.update(userRef, {
          credits: admin.firestore.FieldValue.increment(quest.chimis),
          questClaims: claims,
        });
      });

      return out(200, { ok: true, chimis: quest.chimis });
    }

    // ── CLASSEMENT MENSUEL (palier compétitif) ──────────────────────────────
    // Classe les étudiants par chimis gagnés via quêtes/parrainage ce mois-ci
    // (chimi_ledger), pas par achat — valorise l'engagement, pas le portefeuille.
    // Affiche le matricule (pas l'email) par respect de la vie privée.
    if (action === 'monthlyLeaderboard') {
      const decoded = await requireAuth(event);
      const key = monthKey(new Date());
      const snap = await db.collection('chimi_ledger').where('monthKey', '==', key).get();
      const totals = new Map();
      snap.forEach(doc => {
        const d = doc.data();
        if (!d.uid || !Number.isFinite(d.amount)) return;
        totals.set(d.uid, (totals.get(d.uid) || 0) + d.amount);
      });
      const ranked = [...totals.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
      const uids = ranked.map(([uid]) => uid);
      const matriculeByUid = new Map();
      await Promise.all(uids.map(async (uid) => {
        try {
          const uSnap = await db.collection('users').doc(uid).get();
          matriculeByUid.set(uid, uSnap.exists ? (uSnap.data().matricule || '—') : '—');
        } catch (_) { matriculeByUid.set(uid, '—'); }
      }));
      const items = ranked.map(([uid, chimis], i) => ({
        rank: i + 1,
        matricule: matriculeByUid.get(uid) || '—',
        chimis,
        isMe: uid === decoded.uid,
      }));
      return out(200, { ok: true, monthKey: key, items });
    }

    // ── RÉPARTITION PAR PROFIL (admin) — exploite la segmentation à
    // l'inscription : effectifs et taux de conversion payant par segment,
    // pour adapter les campagnes (secondaire vs L1-L2 vs mémoire/thèse).
    if (action === 'profilStats') {
      const decoded = await requireAuth(event);
      if (!ADMIN_UIDS.has(decoded.uid)) return out(403, { error: 'Accès admin requis' });
      const snap = await db.collection('users').get();
      const stats = {}; // profil -> { total, paid }
      const LABELS = { secondaire: '🎓 Secondaire', l1l2: '📘 L1/L2', memoire: '📝 Mémoire/Thèse', autre: '🔎 Autre', non_renseigne: '❔ Non renseigné' };
      snap.forEach(doc => {
        const d = doc.data();
        const p = d.profil || 'non_renseigne';
        if (!stats[p]) stats[p] = { total: 0, paid: 0 };
        stats[p].total++;
        if (d.plan && d.plan !== 'gratuit') stats[p].paid++;
      });
      const items = Object.keys(LABELS).map(key => ({
        key,
        label: LABELS[key],
        total: stats[key]?.total || 0,
        paid: stats[key]?.paid || 0,
        conversionPct: stats[key]?.total ? Math.round((stats[key].paid / stats[key].total) * 1000) / 10 : 0,
      })).filter(x => x.total > 0);
      return out(200, { ok: true, items, totalUsers: snap.size });
    }

    return out(400, { error: 'action invalide' });
  } catch (e) {
    if (e.message === 'AUTH_REQUIRED') return out(401, { error: 'Non authentifié' });
    if (e.message === 'NOT_ELIGIBLE') return out(400, { error: 'Quête non encore complétée' });
    if (e.message === 'ALREADY_CLAIMED') return out(409, { error: 'Quête déjà réclamée cette semaine' });
    console.error('growth.js error:', e);
    return out(500, { error: e.message });
  }
};
