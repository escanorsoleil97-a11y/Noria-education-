// StatAnalyse Pro — administration serveur des réponses d’un questionnaire.
// Toutes les opérations sensibles passent par l’Admin SDK et un token privé
// conservé dans questionnaire_admin, jamais dans un document public.

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (!raw) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}
const db = admin.firestore();

const allowedOrigins = new Set(
  String(process.env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(v => v.trim())
    .filter(Boolean)
);

function response(statusCode, body, origin) {
  const headers = {
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, no-cache, must-revalidate',
    'X-Content-Type-Options': 'nosniff',
  };
  if (origin && allowedOrigins.has(origin)) headers['Access-Control-Allow-Origin'] = origin;
  return { statusCode, headers, body: body === '' ? '' : JSON.stringify(body) };
}

async function resolveQidFromToken(adminToken) {
  const snap = await db.collection('questionnaire_admin')
    .where('admin_token', '==', adminToken)
    .limit(1)
    .get();
  return snap.empty ? null : snap.docs[0].id;
}

exports.handler = async (event) => {
  const origin = event.headers?.origin || event.headers?.Origin || '';
  if (event.httpMethod === 'OPTIONS') return response(204, '', origin);
  if (event.httpMethod !== 'POST') return response(405, { error: 'Méthode non autorisée' }, origin);

  if (String(event.body || '').length > 1024 * 1024) {
    return response(413, { error: 'Requête trop volumineuse' }, origin);
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return response(400, { error: 'JSON invalide' }, origin); }

  const action = body?.action;
  const adminToken = body?.adminToken;
  const responseId = body?.responseId;
  const data = body?.data;

  if (!['list', 'update', 'delete'].includes(action)) {
    return response(400, { error: 'action invalide (list|update|delete)' }, origin);
  }
  if (typeof adminToken !== 'string' || adminToken.length < 16 || adminToken.length > 256) {
    return response(401, { error: 'Token admin invalide' }, origin);
  }

  try {
    const qid = await resolveQidFromToken(adminToken);
    if (!qid) return response(403, { error: 'Token admin invalide.' }, origin);

    if (action === 'list') {
      const qSnap = await db.collection('questionnaires').doc(qid).get();
      if (!qSnap.exists) return response(404, { error: 'Questionnaire introuvable.' }, origin);
      const qData = qSnap.data();
      const respSnap = await db.collection('responses')
        .where('questionnaire_id', '==', qid)
        .limit(5000)
        .get();
      const responses = respSnap.docs.map(d => ({ _id: d.id, ...d.data() }));
      return response(200, {
        ok: true, qid, title: qData.title, variables: qData.variables, responses,
      }, origin);
    }

    if (typeof responseId !== 'string' || !/^[A-Za-z0-9_-]{1,150}$/.test(responseId)) {
      return response(400, { error: 'responseId invalide' }, origin);
    }
    const respRef = db.collection('responses').doc(responseId);
    const respDoc = await respRef.get();
    if (!respDoc.exists || respDoc.data().questionnaire_id !== qid) {
      return response(404, { error: "Cette réponse n'appartient pas à ce questionnaire." }, origin);
    }

    if (action === 'update') {
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return response(400, { error: 'data invalide' }, origin);
      }
      const serialized = JSON.stringify(data);
      if (serialized.length > 500000) return response(413, { error: 'data trop volumineuse' }, origin);
      await respRef.update({ data: serialized, updatedAt: Date.now() });
      return response(200, { ok: true }, origin);
    }

    await respRef.delete();
    return response(200, { ok: true }, origin);
  } catch (e) {
    console.error('manageResponse:', e);
    return response(500, { error: 'Erreur serveur.' }, origin);
  }
};
