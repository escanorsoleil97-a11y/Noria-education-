// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — cloudinarySign.js
// Génère une signature d'upload Cloudinary pour un upload DIRECT navigateur → Cloudinary
// (le fichier ne passe jamais par nos fonctions Netlify : pas de limite de taille payload)
// Accès : admin uniquement (double verrou UID + rôle Firestore, même pattern que adminAction.js)
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const ADMIN_UIDS = new Set(['SBATLA0GmVbeYWWpWrPoRTTveb32', '0f9FMESHK6gq5Gl77tquCETbFow1']);

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

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
    // ── 1. Vérifier token + rôle admin (double verrou, identique à adminAction.js) ──
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token manquant' }) };
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    if (!ADMIN_UIDS.has(decoded.uid)) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Accès refusé' }) };
    }
    const callerSnap = await db.collection('users').doc(decoded.uid).get();
    const callerRole = callerSnap.data()?.role || '';
    if (!callerSnap.exists || (callerRole !== 'admin' && callerRole !== 'adnim')) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Rôle admin requis' }) };
    }

    if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) {
      return { statusCode: 500, headers, body: JSON.stringify({ error: 'Cloudinary non configuré (variables d\'environnement manquantes)' }) };
    }

    // ── 2. Paramètres de l'upload (dossier rangé niveau/matière) ──
    const { niveau, matiere } = JSON.parse(event.body || '{}');
    const safe = s => String(s || 'Divers').replace(/[^a-zA-Z0-9 _-]/g, '').trim().replace(/\s+/g, '_') || 'Divers';
    const folder = `banque-epreuves/${safe(niveau)}/${safe(matiere)}`;
    const timestamp = Math.round(Date.now() / 1000);

    // Paramètres à signer : tout ce qui sera envoyé à Cloudinary sauf api_key/file/cloud_name/resource_type
    const paramsToSign = { folder, timestamp, type: 'authenticated' };
    const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        ok: true,
        cloudName: process.env.CLOUDINARY_CLOUD_NAME,
        apiKey: process.env.CLOUDINARY_API_KEY,
        timestamp,
        signature,
        folder,
        type: 'authenticated',
      }),
    };
  } catch (e) {
    console.error('cloudinarySign error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
