const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
const HEADERS = { 'Access-Control-Allow-Origin': (process.env.URL || process.env.DEPLOY_URL || 'https://stat-analyse-pro.netlify.app','https://pstat-pro-all.netlify.app').replace(/\/$/, ''), 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' };
const DAYS = 30 * 24 * 60 * 60 * 1000;
function out(statusCode, body) { return { statusCode, headers: HEADERS, body: JSON.stringify(body) }; }
async function uidFrom(event) { const h = event.headers.authorization || event.headers.Authorization || ''; if (!h.startsWith('Bearer ')) return null; return (await admin.auth().verifyIdToken(h.slice(7))).uid; }
function publicMedia(d) { const x = d.data(); return { id: d.id, title: x.title || '', description: x.description || '', type: x.type || 'video', niveau: x.niveau || '', filiere: x.filiere || '', matiere: x.matiere || '', duration: x.duration || '', thumbnailUrl: x.thumbnailUrl || '', priceChimis: Number.isInteger(x.priceChimis) ? x.priceChimis : 5, publishedAt: x.publishedAt || x.createdAt || '' }; }
exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  try {
    if (event.httpMethod === 'GET') {
      const snap = await db.collection('mediaLibrary').where('published', '==', true).limit(200).get();
      const items = snap.docs.map(publicMedia).sort((a,b) => (b.publishedAt || '').localeCompare(a.publishedAt || ''));
      return out(200, { ok: true, items });
    }
    if (event.httpMethod !== 'POST') return out(405, { error: 'Méthode non autorisée' });
    const body = JSON.parse(event.body || '{}'); const action = body.action; const uid = await uidFrom(event);
    if (!uid) return out(401, { error: 'Connexion requise' });
    const mediaId = String(body.mediaId || ''); if (!mediaId) return out(400, { error: 'Résumé manquant' });
    const mediaRef = db.collection('mediaLibrary').doc(mediaId); const mediaSnap = await mediaRef.get();
    if (!mediaSnap.exists || mediaSnap.data().published !== true) return out(404, { error: 'Résumé introuvable ou non publié' });
    const media = mediaSnap.data(); const accessRef = db.collection('mediaAccess').doc(mediaId + '_' + uid); const userRef = db.collection('users').doc(uid);
    if (action === 'unlock') {
      const result = await db.runTransaction(async tx => {
        const [accessSnap, userSnap] = await Promise.all([tx.get(accessRef), tx.get(userRef)]);
        if (!userSnap.exists) throw new Error('Utilisateur introuvable');
        const now = Date.now(); const existing = accessSnap.exists ? accessSnap.data() : null;
        if (existing?.expiresAt && new Date(existing.expiresAt).getTime() > now) return { already: true, expiresAt: existing.expiresAt, credits: userSnap.data().credits ?? 0 };
        const price = Math.max(0, Number.isInteger(media.priceChimis) ? media.priceChimis : 5); const credits = userSnap.data().credits ?? 0;
        if (credits < price) throw new Error('INSUFFICIENT:' + credits);
        const expiresAt = new Date(now + DAYS).toISOString();
        tx.update(userRef, { credits: admin.firestore.FieldValue.increment(-price), updatedAt: new Date().toISOString() });
        tx.set(accessRef, { uid, mediaId, priceChimis: price, unlockedAt: new Date().toISOString(), expiresAt }, { merge: true });
        return { already: false, expiresAt, credits: credits - price, price };
      });
      if (!result.already) await db.collection('mediaTransactions').add({ uid, mediaId, priceChimis: result.price, createdAt: new Date().toISOString(), expiresAt: result.expiresAt });
      return out(200, { ok: true, already: result.already, expiresAt: result.expiresAt, credits: result.credits, msg: result.already ? 'Accès déjà actif.' : 'Résumé débloqué pour 30 jours.' });
    }
    if (action === 'open') {
      const accessSnap = await accessRef.get(); const access = accessSnap.data();
      if (!accessSnap.exists || !access?.expiresAt || new Date(access.expiresAt).getTime() <= Date.now()) return out(403, { error: 'Accès expiré. Débloquez à nouveau ce résumé.' });
      if (!media.publicId) return out(500, { error: 'Fichier média mal configuré' });
      const url = cloudinary.url(media.publicId, { resource_type: media.resourceType || (media.type === 'audio' ? 'video' : 'video'), type: 'authenticated', sign_url: true, secure: true, version: media.version, format: media.format || undefined });
      return out(200, { ok: true, url, expiresAt: access.expiresAt, type: media.type || 'video' });
    }
    return out(400, { error: 'Action inconnue' });
  } catch (e) { if (e.message?.startsWith('INSUFFICIENT:')) return out(402, { error: 'insufficient', credits: Number(e.message.split(':')[1]) }); console.error('mediaAccess error:', e); return out(500, { error: e.message }); }
};
