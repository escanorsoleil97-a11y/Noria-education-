// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — Soumission d'une réponse à un questionnaire
// (endpoint public, appelé depuis repondre.html à la fin du formulaire).
//
// Rôle : valider le jeton d'attempt émis par startAttempt.js (existe, pas
// déjà utilisé, pas expiré), puis écrire la réponse dans /responses avec
// owner_uid (copié depuis le questionnaire, requis par la règle Firestore
// de lecture) et invalider le jeton pour empêcher toute double soumission.
// C'est la SEULE écriture autorisée dans /responses — la règle Firestore
// interdit toute création directe côté client (allow create: if false).
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const sec = require('./_security');

const QID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ATTEMPT_ID_RE = /^[a-f0-9]{48}$/; // crypto.randomBytes(24).toString('hex')
const MAX_DATA_BYTES = 500000;

const _ipCalls = new Map();
function checkIpRateLimit(ip) {
  const now = Date.now();
  const window = 60000;
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

  try {
    await sec.verifyAppCheck(event);
  } catch (e) {
    return { statusCode: e.status || 401, headers, body: JSON.stringify({ error: e.message || 'Vérification échouée' }) };
  }

  let body;
  try { body = sec.body(event, MAX_DATA_BYTES + 2000); } catch (e) { return { statusCode: e.status || 400, headers, body: JSON.stringify({ error: e.message || 'JSON invalide' }) }; }

  const { qid, attemptId, data } = body;
  if (typeof qid !== 'string' || !QID_RE.test(qid)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'qid invalide' }) };
  }
  if (typeof attemptId !== 'string' || !ATTEMPT_ID_RE.test(attemptId)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'attemptId invalide' }) };
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'data invalide' }) };
  }
  const serialized = JSON.stringify(data);
  if (serialized.length > MAX_DATA_BYTES) {
    return { statusCode: 413, headers, body: JSON.stringify({ error: 'Réponse trop volumineuse.' }) };
  }

  try {
    const attemptRef = db.collection('attempts').doc(attemptId);

    // Transaction : lecture + invalidation du jeton en une seule opération
    // atomique pour empêcher deux requêtes simultanées de passer toutes les
    // deux (double-soumission / rejeu du même attemptId).
    const attemptData = await db.runTransaction(async (tx) => {
      const snap = await tx.get(attemptRef);
      if (!snap.exists) {
        const e = new Error('Tentative introuvable ou expirée.');
        e.status = 404;
        throw e;
      }
      const a = snap.data();
      if (a.qid !== qid) {
        const e = new Error('Tentative invalide pour ce questionnaire.');
        e.status = 400;
        throw e;
      }
      if (a.used) {
        const e = new Error('Cette tentative a déjà été soumise.');
        e.status = 409;
        throw e;
      }
      if (a.deadline && Date.now() > a.deadline) {
        const e = new Error('Le temps imparti est écoulé.');
        e.status = 410;
        throw e;
      }
      tx.update(attemptRef, { used: true, usedAt: Date.now() });
      return a;
    });

    const qSnap = await db.collection('questionnaires').doc(qid).get();
    if (!qSnap.exists) {
      return { statusCode: 404, headers, body: JSON.stringify({ error: 'Questionnaire introuvable.' }) };
    }
    const qData = qSnap.data();

    const respRef = db.collection('responses').doc();
    await respRef.set({
      questionnaire_id: qid,
      owner_uid: qData.owner_uid || attemptData.ownerUid || null,
      data: serialized,
      created_at: new Date().toISOString(),
      attemptId,
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    if (e.status) return { statusCode: e.status, headers, body: JSON.stringify({ error: e.message }) };
    console.error('submitAttempt:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Erreur serveur.' }) };
  }
};
