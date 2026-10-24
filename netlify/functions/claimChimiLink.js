// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — claimChimiLink.js
// Réclame un lien admin donnant N chimis expirants. Accessible à tout étudiant
// connecté (pas de restriction admin) — seul un token valide et non épuisé permet
// de réclamer.
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
    'https://stat-analyse-pro.netlify.app','https://pstat-pro-all.netlify.app','https://statanalyse-pro.netlify.app']
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

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };

  try {
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token manquant' }) };
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    const uid = decoded.uid;

    const { token } = JSON.parse(event.body || '{}');
    if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'token requis' }) };

    const linkRef = db.collection('chimiLinks').doc(token);
    const userRef = db.collection('users').doc(uid);

    const result = await db.runTransaction(async (tx) => {
      const linkSnap = await tx.get(linkRef);
      if (!linkSnap.exists) throw new Error('LINK_NOT_FOUND');
      const link = linkSnap.data();
      const now = Date.now();

      if (new Date(link.expiresAt).getTime() < now) throw new Error('LINK_EXPIRED');
      const claims = Array.isArray(link.claims) ? link.claims : [];
      if (claims.includes(uid)) throw new Error('ALREADY_CLAIMED');
      if (claims.length >= (link.maxClaims || 1)) throw new Error('LINK_EXHAUSTED');
      const dayKey = new Date(now).toISOString().slice(0, 10);
      const claimsByDay = link.claimsByDay && typeof link.claimsByDay === 'object' ? link.claimsByDay : {};
      const todayClaims = Array.isArray(claimsByDay[dayKey]) ? claimsByDay[dayKey] : [];
      if (Number(link.dailyMaxClaims || 0) > 0 && todayClaims.length >= Number(link.dailyMaxClaims)) throw new Error('DAILY_EXHAUSTED');

      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('USER_NOT_FOUND');

      const grantRef = db.collection('chimiGrants').doc();
      const grantExpiresAt = new Date(now + link.dureeChimisJours * 24 * 60 * 60 * 1000).toISOString();

      tx.update(linkRef, { claims: admin.firestore.FieldValue.arrayUnion(uid), [`claimsByDay.${dayKey}`]: admin.firestore.FieldValue.arrayUnion(uid) });
      tx.set(grantRef, {
        uid,
        token,
        amount: link.nbChimis,
        remaining: link.nbChimis,
        grantedAt: new Date().toISOString(),
        expiresAt: grantExpiresAt,
      });
      tx.update(userRef, { credits: admin.firestore.FieldValue.increment(link.nbChimis) });

      return { nbChimis: link.nbChimis, grantExpiresAt };
    });

    return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };

  } catch (e) {
    const map = {
      LINK_NOT_FOUND:  [404, 'Lien introuvable.'],
      LINK_EXPIRED:    [410, 'Ce lien a expiré.'],
      ALREADY_CLAIMED: [409, 'Vous avez déjà utilisé ce lien.'],
      LINK_EXHAUSTED:  [409, 'Ce lien a atteint son nombre maximum d\'utilisations.'],
      DAILY_EXHAUSTED:  [429, 'La limite quotidienne de cette campagne est atteinte.'],
      USER_NOT_FOUND:  [404, 'Compte introuvable.'],
    };
    const [code, message] = map[e.message] || [500, e.message];
    return { statusCode: code, headers, body: JSON.stringify({ error: e.message, message }) };
  }
};
