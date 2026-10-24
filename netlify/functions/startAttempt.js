// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — Démarrage d'une tentative de réponse à un questionnaire
// (endpoint public, appelé depuis repondre.html — aucun compte requis).
//
// Rôle : vérifier que le questionnaire existe et est visible, appliquer la
// limite de tentatives (settings.maxAttempts, comptée par IP puisqu'il n'y a
// pas de compte utilisateur côté répondant), calculer la date limite
// (settings.timeLimitSeconds) et émettre un jeton d'attempt à usage unique
// que submitAttempt.js validera à la soumission. Ce jeton empêche un
// répondant de contourner le minuteur ou le compteur en appelant directement
// l'API Firestore (les règles interdisent toute écriture directe dans
// /responses — voir firestore.rules).
// ══════════════════════════════════════════════════════════════════════════════

const crypto = require('crypto');
const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const sec = require('./_security');

const QID_RE = /^[A-Za-z0-9_-]{1,64}$/;

// Rate limit IP en mémoire (même approche que manageDatabase.js / pharmacy.js).
// Plus permissif que pour les endpoints authentifiés car un même répondant
// public peut relancer la page plusieurs fois légitimement.
const _ipCalls = new Map();
function checkIpRateLimit(ip) {
  const now = Date.now();
  const window = 60000; // 1 minute
  const maxReq = 30;
  const recent = (_ipCalls.get(ip) || []).filter(t => now - t < window);
  if (recent.length >= maxReq) return false;
  recent.push(now);
  _ipCalls.set(ip, recent);
  return true;
}

exports.handler = async (event) => {
  let origin = '';
  try {
    origin = sec.assertOrigin(event);
  } catch (e) {
    return { statusCode: e.status || 403, headers: sec.securityHeaders(sec.originOf(event)), body: JSON.stringify({ error: e.message }) };
  }
  if (event.httpMethod === 'OPTIONS') return sec.preflight(event);

  const headers = sec.securityHeaders(origin);
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  const ip = event.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || event.headers?.['client-ip'] || 'unknown';
  if (!checkIpRateLimit(ip)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Trop de requêtes, réessayez dans une minute.' }) };
  }

  // Endpoint public : pas d'authentification Firebase (le répondant n'a pas
  // de compte). App Check reste vérifié quand REQUIRE_APP_CHECK=true — cela
  // filtre les bots/scripts sans bloquer les vrais navigateurs.
  try {
    await sec.verifyAppCheck(event);
  } catch (e) {
    return { statusCode: e.status || 401, headers, body: JSON.stringify({ error: e.message || 'Vérification échouée' }) };
  }

  let body;
  try { body = sec.body(event, 2000); } catch (e) { return { statusCode: e.status || 400, headers, body: JSON.stringify({ error: e.message || 'JSON invalide' }) }; }

  const qid = body.qid;
  if (typeof qid !== 'string' || !QID_RE.test(qid)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'qid invalide' }) };
  }

  try {
    const qSnap = await db.collection('questionnaires').doc(qid).get();
    if (!qSnap.exists) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Questionnaire introuvable ou expiré.' }) };
    }
    const qData = qSnap.data();
    const settings = qData.settings || {};
    if (settings.isVisible === false) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: "Ce questionnaire n'est plus disponible." }) };
    }

    const maxAttempts = Number.isInteger(settings.maxAttempts) ? settings.maxAttempts : 0; // 0 = illimité
    const timeLimitSeconds = Number.isInteger(settings.timeLimitSeconds) ? settings.timeLimitSeconds : 0; // 0 = pas de délai

    // Empreinte anonyme de l'IP (pas d'IP en clair stockée), scoped par
    // questionnaire pour empêcher toute corrélation entre questionnaires.
    const ipHash = crypto.createHash('sha256').update(`${qid}:${ip}`).digest('hex');

    let remainingAttempts = null;
    if (maxAttempts > 0) {
      const counterRef = db.collection('questionnaire_attempt_counters').doc(`${qid}_${ipHash}`);
      remainingAttempts = await db.runTransaction(async (tx) => {
        const snap = await tx.get(counterRef);
        const current = snap.exists ? (Number(snap.data().count) || 0) : 0;
        if (current >= maxAttempts) {
          const e = new Error('Nombre maximum de tentatives atteint pour ce questionnaire.');
          e.status = 403;
          throw e;
        }
        const next = current + 1;
        tx.set(counterRef, { count: next, qid, updatedAt: Date.now() }, { merge: true });
        return maxAttempts - next;
      });
    }

    const deadline = timeLimitSeconds > 0 ? Date.now() + timeLimitSeconds * 1000 : null;
    const attemptId = crypto.randomBytes(24).toString('hex');

    await db.collection('attempts').doc(attemptId).set({
      qid,
      ownerUid: qData.owner_uid || null,
      ipHash,
      createdAt: Date.now(),
      deadline,
      used: false,
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, attemptId, deadline, remainingAttempts }) };
  } catch (e) {
    if (e.status) return { statusCode: e.status, headers, body: JSON.stringify({ error: e.message }) };
    console.error('startAttempt:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Erreur serveur.' }) };
  }
};
