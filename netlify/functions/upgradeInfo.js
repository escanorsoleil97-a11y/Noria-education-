// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — upgradeInfo.js
// Fonction PUBLIQUE (pas d'auth Firebase requise) — protégée uniquement par le
// token à usage unique généré depuis l'admin. Renvoie le plan actuel de
// l'utilisateur et les paliers d'upgrade disponibles avec le prix différentiel.
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// Miroir exact de PLAN_CONFIG (confirmPayment.js) — ordre = ordre des paliers
const PLAN_CONFIG = {
  standard:      { label: 'Standard',      credits: 100,  prixFCFA: 10000 },
  professionnel: { label: 'Professionnel', credits: 500,  prixFCFA: 25000 },
  premium:       { label: 'Premium',       credits: 2000, prixFCFA: 35000 },
};
const ORDRE = ['gratuit', 'standard', 'professionnel', 'premium'];

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
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };

  try {
    const token = event.queryStringParameters?.token;
    if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Token manquant' }) };

    const linkRef = db.collection('upgradeLinks').doc(token);
    const linkSnap = await linkRef.get();
    if (!linkSnap.exists) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Lien invalide ou inconnu.' }) };
    const link = linkSnap.data();
    if (link.used) return { statusCode: 410, headers, body: JSON.stringify({ error: 'Ce lien a déjà été utilisé.' }) };
    if (new Date(link.expiresAt).getTime() < Date.now()) {
      return { statusCode: 410, headers, body: JSON.stringify({ error: 'Ce lien a expiré (validité 48h). Demandez-en un nouveau.' }) };
    }

    const userSnap = await db.collection('users').doc(link.uid).get();
    if (!userSnap.exists) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Compte utilisateur introuvable.' }) };
    const userData = userSnap.data();
    const currentPlan = userData.plan || 'gratuit';
    const currentIdx = ORDRE.indexOf(currentPlan);
    const currentPrix = PLAN_CONFIG[currentPlan]?.prixFCFA || 0;

    const options = ORDRE
      .filter((p, idx) => p !== 'gratuit' && idx > currentIdx)
      .map(p => ({
        plan: p,
        label: PLAN_CONFIG[p].label,
        credits: PLAN_CONFIG[p].credits,
        prixDiff: PLAN_CONFIG[p].prixFCFA - currentPrix,
      }));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        email: userData.email || '',
        currentPlan,
        options,
      }),
    };
  } catch (e) {
    console.error('upgradeInfo error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
