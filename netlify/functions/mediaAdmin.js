const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
cloudinary.config({ cloud_name: process.env.CLOUDINARY_CLOUD_NAME, api_key: process.env.CLOUDINARY_API_KEY, api_secret: process.env.CLOUDINARY_API_SECRET });
const ADMINS = new Set(['SBATLA0GmVbeYWWpWrPoRTTveb32', '0f9FMESHK6gq5Gl77tquCETbFow1']);
const HEADERS = { 'Access-Control-Allow-Origin': (process.env.URL || process.env.DEPLOY_URL || 'https://stat-analyse-pro.netlify.app','https://pstat-pro-all.netlify.app').replace(/\/$/, ''), 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };
function out(statusCode, body) { return { statusCode, headers: HEADERS, body: JSON.stringify(body) }; }
async function verify(event) { const h = event.headers.authorization || event.headers.Authorization || ''; if (!h.startsWith('Bearer ')) throw new Error('Token manquant'); const d = await admin.auth().verifyIdToken(h.slice(7)); if (!ADMINS.has(d.uid)) throw new Error('Accès refusé'); const s = await db.collection('users').doc(d.uid).get(); if (!s.exists || !['admin','adnim'].includes(s.data().role || '')) throw new Error('Rôle admin requis'); return d.uid; }
function safe(s) { return String(s || 'Divers').replace(/[^a-zA-Z0-9À-ÿ _-]/g, '').trim().replace(/\s+/g, '_') || 'Divers'; }
exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return out(405, { error: 'Méthode non autorisée' });
  try {
    const uid = await verify(event); const body = JSON.parse(event.body || '{}'); const action = body.action; const p = body.payload || {};
    if (action === 'sign') {
      if (!process.env.CLOUDINARY_CLOUD_NAME || !process.env.CLOUDINARY_API_KEY || !process.env.CLOUDINARY_API_SECRET) return out(500, { error: 'Cloudinary non configuré dans Netlify' });
      const type = p.type === 'audio' ? 'audio' : 'video'; const folder = `resume-media/${safe(p.niveau)}/${safe(p.filiere)}/${safe(p.matiere)}`; const timestamp = Math.round(Date.now() / 1000); const paramsToSign = { folder, timestamp, type: 'authenticated' }; const signature = cloudinary.utils.api_sign_request(paramsToSign, process.env.CLOUDINARY_API_SECRET);
      return out(200, { ok: true, cloudName: process.env.CLOUDINARY_CLOUD_NAME, apiKey: process.env.CLOUDINARY_API_KEY, timestamp, signature, folder, type: 'authenticated', resourceType: type });
    }
    if (action === 'create') {
      const title = String(p.title || '').trim(); const type = p.type === 'audio' ? 'audio' : 'video'; const priceChimis = Number.parseInt(p.priceChimis, 10); const publicId = String(p.publicId || '').trim();
      if (!title || !publicId || !['audio','video'].includes(type) || !Number.isInteger(priceChimis) || priceChimis < 2 || priceChimis > 10) return out(400, { error: 'Titre, fichier, type et prix entre 2 et 10 chimis requis' });
      const ref = await db.collection('mediaLibrary').add({ title, description: String(p.description || '').trim(), type, niveau: String(p.niveau || '').trim(), filiere: String(p.filiere || '').trim(), matiere: String(p.matiere || '').trim(), duration: String(p.duration || '').trim(), thumbnailUrl: String(p.thumbnailUrl || '').trim(), publicId, resourceType: p.resourceType || (type === 'audio' ? 'video' : 'video'), format: String(p.format || '').toLowerCase(), version: p.version || null, priceChimis, published: p.published !== false, createdAt: new Date().toISOString(), createdBy: uid });
      return out(200, { ok: true, id: ref.id, msg: 'Résumé publié' });
    }
    if (action === 'list') { const snap = await db.collection('mediaLibrary').orderBy('createdAt','desc').limit(200).get(); return out(200, { ok: true, items: snap.docs.map(d => ({ id: d.id, ...d.data() })) }); }
    if (action === 'update') { const id = String(p.id || ''); if (!id) return out(400, { error: 'Identifiant manquant' }); const allowed = {}; ['title','description','niveau','filiere','matiere','duration','thumbnailUrl'].forEach(k => { if (p[k] !== undefined) allowed[k] = String(p[k]); }); if (p.priceChimis !== undefined) { const n = Number.parseInt(p.priceChimis,10); if (!Number.isInteger(n) || n < 2 || n > 10) return out(400,{error:'Prix entre 2 et 10 chimis'}); allowed.priceChimis=n; } if (p.published !== undefined) allowed.published=!!p.published; allowed.updatedAt=new Date().toISOString(); await db.collection('mediaLibrary').doc(id).update(allowed); return out(200,{ok:true,msg:'Résumé mis à jour'}); }
    return out(400, { error: 'Action inconnue' });
  } catch (e) { console.error('mediaAdmin error:', e); return out(e.message.includes('Token') || e.message.includes('Accès') || e.message.includes('Rôle') ? 403 : 500, { error: e.message }); }
};
