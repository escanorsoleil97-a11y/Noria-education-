const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const PLANS = { standard: { label: '10 000 FCFA', credits: 100 }, professionnel: { label: '25 000 FCFA', credits: 500 }, premium: { label: '35 000 FCFA Premium', credits: 2000 } };
const HEADERS = { 'Access-Control-Allow-Origin': (process.env.URL || process.env.DEPLOY_URL || 'https://stat-analyse-pro.netlify.app','https://pstat-pro-all.netlify.app').replace(/\/$/, ''), 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Content-Type': 'application/json' };
function out(statusCode, body) { return { statusCode, headers: HEADERS, body: JSON.stringify(body) }; }
async function currentUser(event) { const h = event.headers.authorization || event.headers.Authorization || ''; if (!h.startsWith('Bearer ')) throw new Error('Connexion requise'); return admin.auth().verifyIdToken(h.slice(7)); }
exports.handler = async event => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  try {
    const id = event.queryStringParameters?.campagne || JSON.parse(event.body || '{}').campaignId;
    if (!id) return out(400, { error: 'Campagne manquante' });
    const campaignRef = db.collection('groupCampaigns').doc(id); const campaignSnap = await campaignRef.get();
    if (!campaignSnap.exists) return out(404, { error: 'Campagne introuvable' });
    const c = campaignSnap.data(); const expired = c.expiresAt && new Date(c.expiresAt).getTime() < Date.now(); const taken = (c.usedPlaces || 0) + (c.reservedPlaces || 0);
    if (event.httpMethod === 'GET') return out(200, { ok: true, campaign: { id, name: c.name, targetPlan: c.targetPlan, planLabel: PLANS[c.targetPlan]?.label || c.targetPlan, priceFCFA: c.priceFCFA, maxPlaces: c.maxPlaces, usedPlaces: taken, remainingPlaces: Math.max(0, (c.maxPlaces || 0) - taken), expiresAt: c.expiresAt, expired, status: c.status || 'active' } });
    if (event.httpMethod !== 'POST') return out(405, { error: 'Méthode non autorisée' });
    const decoded = await currentUser(event); const uid = decoded.uid; const userSnap = await db.collection('users').doc(uid).get();
    if (!userSnap.exists) return out(404, { error: 'Compte utilisateur introuvable' });
    if (expired || c.status !== 'active') return out(410, { error: 'Cette campagne est expirée ou fermée' });
    const requestId = id + '_' + uid; const reqRef = db.collection('groupUpgradeRequests').doc(requestId); const existing = await reqRef.get();
    if (existing.exists && ['pending', 'waitlist', 'confirmed'].includes(existing.data().status)) return out(409, { error: existing.data().status === 'confirmed' ? 'Votre upgrade est déjà confirmé' : 'Votre demande est déjà enregistrée', request: existing.data() });
    const dataBase = { id: requestId, campaignId: id, uid, email: decoded.email || userSnap.data().email || '', targetPlan: c.targetPlan, priceFCFA: c.priceFCFA, requestedAt: new Date().toISOString() };
    let placeStatus = 'waitlist';
    await db.runTransaction(async tx => {
      const latest = await tx.get(campaignRef); if (!latest.exists) throw new Error('Campagne introuvable');
      const fresh = latest.data(); const freshTaken = (fresh.usedPlaces || 0) + (fresh.reservedPlaces || 0);
      placeStatus = freshTaken < (fresh.maxPlaces || 0) ? 'pending' : 'waitlist';
      tx.set(reqRef, { ...dataBase, status: placeStatus });
      if (placeStatus === 'pending') tx.update(campaignRef, { reservedPlaces: admin.firestore.FieldValue.increment(1), updatedAt: new Date().toISOString() });
    });
    return out(200, { ok: true, status: placeStatus, msg: placeStatus === 'pending' ? 'Place réservée. Attendez la confirmation de l’administrateur après vérification du paiement.' : 'Quota atteint : vous êtes inscrit en liste d’attente. L’administrateur pourra augmenter le quota ou vous traiter en priorité.' });
  } catch (e) { return out(e.message === 'Connexion requise' ? 401 : 500, { error: e.message }); }
};
