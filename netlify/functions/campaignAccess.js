const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const HEADERS = { 'Access-Control-Allow-Origin': (process.env.URL || process.env.DEPLOY_URL || 'https://stat-analyse-pro.netlify.app','https://pstat-pro-all.netlify.app').replace(/\/$/, ''), 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Content-Type': 'application/json' };

function out(statusCode, body) { return { statusCode, headers: HEADERS, body: JSON.stringify(body) }; }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'GET') return out(405, { error: 'Méthode non autorisée' });
  try {
    const id = String(event.queryStringParameters?.campagne || '').trim();
    const profile = String(event.queryStringParameters?.profil || '').trim();
    if (!id || !['stats', 'student'].includes(profile)) return out(400, { error: 'Lien de campagne invalide' });
    const snap = await db.collection('groupCampaigns').doc(id).get();
    if (!snap.exists) return out(404, { error: 'Campagne introuvable' });
    const c = snap.data();
    const expired = c.expiresAt && new Date(c.expiresAt).getTime() < Date.now();
    if (c.status && c.status !== 'active') return out(410, { error: 'Cette campagne est fermée' });
    if (expired) return out(410, { error: 'Cette campagne est expirée' });
    return out(200, { ok: true, campaignId: id, profile, permanent: !c.expiresAt, name: c.name || '' });
  } catch (e) {
    console.error('campaignAccess error:', e);
    return out(500, { error: 'Impossible de vérifier ce lien' });
  }
};
