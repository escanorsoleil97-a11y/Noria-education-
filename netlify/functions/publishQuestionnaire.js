// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — Publication d'un questionnaire (server-side)
// Sépare les données publiques (questionnaires/{qid}, lisibles par les
// répondants) du token admin (questionnaire_admin/{qid}, jamais exposé côté
// client — collection bloquée en lecture/écriture directe par les règles
// Firestore, uniquement accessible via l'Admin SDK ici).
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

exports.handler = async (event) => {
const _origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const _allowed = [process.env.SITE_ORIGIN, process.env.URL, process.env.DEPLOY_URL, process.env.DEPLOY_PRIME_URL,
    'https://stat-analyse-pro.netlify.app','https://pstat-pro-all.netlify.app','https://statanalyse-pro.netlify.app','https://noria-education.pages.dev']
    .filter(Boolean).join(',').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  const _originNorm = _origin.replace(/\/$/, '');
  const _allow = (_originNorm && _allowed.includes(_originNorm)) ? _originNorm : (_allowed[0] || 'https://pstat-pro-all.netlify.app');
  // Même origine (pas de header Origin) ou origine autorisée
  if (_originNorm && !_allowed.includes(_originNorm)) {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': _allow }, body: JSON.stringify({ error: 'Origine non autorisée. Ajoutez votre domaine dans SITE_ORIGIN (Netlify env).' }) };
  }


  const headers = {
    'Access-Control-Allow-Origin': _allow,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const idToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!idToken) return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non authentifié.' }) };

  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(idToken);
    uid = decoded.uid;
  } catch (e) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Session invalide ou expirée.' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON invalide' }) }; }
  const { title, variables } = body;
  const maxAttemptsRaw = Number(body.maxAttempts);
  const timeLimitRaw = Number(body.timeLimitSeconds);
  const maxAttempts = Number.isInteger(maxAttemptsRaw) ? Math.min(100, Math.max(0, maxAttemptsRaw)) : 0;
  const timeLimitSeconds = Number.isInteger(timeLimitRaw) ? Math.min(7200, Math.max(0, timeLimitRaw)) : 0;
  const isVisible = body.isVisible !== false;

  if (typeof title !== 'string' || !title.trim() || title.length > 500) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Titre invalide.' }) };
  }
  const variablesStr = typeof variables === 'string' ? variables : JSON.stringify(variables || []);
  if (variablesStr.length > 500000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Variables trop volumineuses.' }) };
  }

  try {
    const qid = db.collection('questionnaires').doc().id;
    const adminToken = require('crypto').randomBytes(15).toString('hex');
    const createdAt = new Date().toISOString();

    await db.collection('questionnaires').doc(qid).set({
      qid, title: title.trim(), variables: variablesStr, created_at: createdAt, owner_uid: uid,
      settings: { maxAttempts, timeLimitSeconds, isVisible },
    });
    await db.collection('questionnaire_admin').doc(qid).set({
      admin_token: adminToken, owner_uid: uid, created_at: createdAt,
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, qid, adminToken }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message || 'Erreur serveur.' }) };
  }
};
