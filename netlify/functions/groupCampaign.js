const admin = require('firebase-admin');
const crypto = require('crypto');
if (!admin.apps.length) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
const db = admin.firestore();
const ADMIN_UIDS = new Set(['SBATLA0GmVbeYWWpWrPoRTTveb32', '0f9FMESHK6gq5Gl77tquCETbFow1']);
const PLANS = {
  standard: { label: '10 000 FCFA', credits: 100, prixFCFA: 10000 },
  professionnel: { label: '25 000 FCFA', credits: 500, prixFCFA: 25000 },
  premium: { label: '35 000 FCFA Premium', credits: 2000, prixFCFA: 35000 },
};
const HEADERS = { 'Access-Control-Allow-Origin': (process.env.URL || process.env.DEPLOY_URL || 'https://stat-analyse-pro.netlify.app','https://pstat-pro-all.netlify.app').replace(/\/$/, ''), 'Access-Control-Allow-Headers': 'Content-Type, Authorization', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Content-Type': 'application/json' };

async function verifyAdmin(event) {
  const header = event.headers.authorization || event.headers.Authorization || '';
  if (!header.startsWith('Bearer ')) throw new Error('Token manquant');
  const decoded = await admin.auth().verifyIdToken(header.slice(7));
  if (!ADMIN_UIDS.has(decoded.uid)) throw new Error('Accès refusé');
  const snap = await db.collection('users').doc(decoded.uid).get();
  if (!snap.exists || !['admin', 'adnim'].includes(snap.data().role || '')) throw new Error('Rôle admin requis');
  return decoded.uid;
}
function response(statusCode, body) { return { statusCode, headers: HEADERS, body: JSON.stringify(body) }; }
function isoDate(value) { const d = new Date(value); return Number.isNaN(d.getTime()) ? null : d.toISOString(); }

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers: HEADERS, body: '' };
  if (event.httpMethod !== 'POST') return response(405, { error: 'Méthode non autorisée' });
  try {
    const body = JSON.parse(event.body || '{}');
    const action = body.action;
    if (action === 'publicInfo') {
      const id = String(body.campaignId || '').trim();
      if (!id) return response(400, { error: 'Campagne manquante' });
      const snap = await db.collection('groupCampaigns').doc(id).get();
      if (!snap.exists) return response(404, { error: 'Campagne introuvable' });
      const c = snap.data();
      const expired = c.expiresAt && new Date(c.expiresAt).getTime() < Date.now();
      const used = (c.usedPlaces || 0) + (c.reservedPlaces || 0);
      return response(200, { ok: true, campaign: { id, name: c.name, targetPlan: c.targetPlan, planLabel: PLANS[c.targetPlan]?.label || c.targetPlan, priceFCFA: c.priceFCFA, maxPlaces: c.maxPlaces, usedPlaces: used, remainingPlaces: Math.max(0, c.maxPlaces - used), expiresAt: c.expiresAt, expired, status: c.status || 'active' } });
    }

    const adminUid = await verifyAdmin(event);
    if (action === 'create') {
      const p = body.payload || {};
      const targetPlan = String(p.targetPlan || '').toLowerCase();
      const name = String(p.name || '').trim();
      const maxPlaces = Number.parseInt(p.maxPlaces, 10);
      const priceFCFA = Number.parseInt(p.priceFCFA, 10);
      const profile = String(p.profile || 'student').toLowerCase();
      const permanent = p.permanent === true || p.permanent === 'true';
      const expiresAt = permanent ? null : isoDate(p.expiresAt);
      if (!name || !PLANS[targetPlan] || !['stats', 'student'].includes(profile) || !Number.isInteger(maxPlaces) || maxPlaces < 1 || !Number.isInteger(priceFCFA) || priceFCFA < 0 || (!permanent && (!expiresAt || new Date(expiresAt).getTime() <= Date.now()))) return response(400, { error: 'Nom, profil, palier, prix, places et date d’expiration valides requis' });
      const id = crypto.randomBytes(10).toString('hex');
      await db.collection('groupCampaigns').doc(id).set({ id, name, targetPlan, profile, permanent, priceFCFA, maxPlaces, usedPlaces: 0, status: 'active', createdAt: new Date().toISOString(), createdBy: adminUid, reservedPlaces: 0, expiresAt });
      return response(200, { ok: true, id, profile, permanent, url: '/upgrade-groupe.html?campagne=' + id });
    }
    if (action === 'list') {
      const snap = await db.collection('groupCampaigns').orderBy('createdAt', 'desc').limit(100).get();
      const campaigns = snap.docs.map(d => ({ id: d.id, ...d.data(), remainingPlaces: Math.max(0, (d.data().maxPlaces || 0) - (d.data().usedPlaces || 0) - (d.data().reservedPlaces || 0)) }));
      return response(200, { ok: true, campaigns });
    }
    if (action === 'setQuota') {
      const id = String(body.campaignId || ''); const maxPlaces = Number.parseInt(body.payload?.maxPlaces, 10);
      if (!id || !Number.isInteger(maxPlaces) || maxPlaces < 1) return response(400, { error: 'Quota invalide' });
      const ref = db.collection('groupCampaigns').doc(id); const snap = await ref.get();
      if (!snap.exists || maxPlaces < (snap.data().usedPlaces || 0) + (snap.data().reservedPlaces || 0)) return response(400, { error: 'Le quota ne peut pas être inférieur aux places confirmées ou réservées' });
      await ref.update({ maxPlaces, updatedAt: new Date().toISOString(), updatedBy: adminUid }); return response(200, { ok: true, msg: 'Quota mis à jour' });
    }
    if (action === 'listRequests') {
      const snap = await db.collection('groupUpgradeRequests').orderBy('requestedAt', 'desc').limit(300).get();
      return response(200, { ok: true, requests: snap.docs.map(d => ({ id: d.id, ...d.data() })) });
    }
    if (action === 'confirm') {
      const requestId = String(body.requestId || ''); if (!requestId) return response(400, { error: 'Demande manquante' });
      const reqRef = db.collection('groupUpgradeRequests').doc(requestId); const reqSnap = await reqRef.get();
      if (!reqSnap.exists) return response(404, { error: 'Demande introuvable' });
      const req = reqSnap.data(); if (!['pending', 'waitlist'].includes(req.status)) return response(400, { error: 'Cette demande a déjà été traitée' });
      const campaignRef = db.collection('groupCampaigns').doc(req.campaignId); const userRef = db.collection('users').doc(req.uid);
      const result = await db.runTransaction(async tx => {
        const [campaignSnap, userSnap] = await Promise.all([tx.get(campaignRef), tx.get(userRef)]);
        if (!campaignSnap.exists || !userSnap.exists) throw new Error('Campagne ou utilisateur introuvable');
        const c = campaignSnap.data(); const u = userSnap.data();
        const taken = (c.usedPlaces || 0) + (c.reservedPlaces || 0);
        if (req.status === 'waitlist' && (c.usedPlaces || 0) >= (c.maxPlaces || 0)) throw new Error('Quota atteint : augmentez le quota avant de confirmer cette demande');
        if (req.status === 'pending' && taken > (c.maxPlaces || 0)) throw new Error('Quota atteint : vérifiez le quota avant de confirmer cette demande');
        const plan = PLANS[req.targetPlan]; if (!plan) throw new Error('Palier invalide');
        tx.update(userRef, { plan: req.targetPlan, credits: plan.credits, updatedAt: new Date().toISOString(), updatedBy: 'admin_group_upgrade' });
        tx.update(campaignRef, { usedPlaces: admin.firestore.FieldValue.increment(1), ...(req.status === 'pending' ? { reservedPlaces: admin.firestore.FieldValue.increment(-1) } : {}), updatedAt: new Date().toISOString() });
        tx.update(reqRef, { status: 'confirmed', confirmedAt: new Date().toISOString(), confirmedBy: adminUid });
        return { email: u.email || req.email || '', oldPlan: u.plan || 'gratuit' };
      });
      await db.collection('upgrades').add({ uid: req.uid, email: result.email, ancienPlan: result.oldPlan, nouveauPlan: req.targetPlan, montant: req.priceFCFA, campaignId: req.campaignId, requestId, appliedAt: new Date().toISOString() });

      // Commission ambassadeur (étape 11) : une ligne par membre payant du
      // groupe, base = montant net remisé (req.priceFCFA), même règles que le
      // paiement individuel (F4 pas de code = pas de commission, anti-auto-
      // parrainage, code actif requis, 15%, passage Éclaireur → Ambassadeur).
      let commissionInfo = null;
      try {
        const studentSnap = await db.collection('users').doc(req.uid).get();
        const refCode = studentSnap.exists ? studentSnap.data().ambassadorRef : null;
        if (refCode) {
          const ambQuery = await db.collection('ambassadors').where('code', '==', refCode).limit(1).get();
          if (!ambQuery.empty) {
            const ambDoc = ambQuery.docs[0];
            const ambassadorUid = ambDoc.id;
            const ambData = ambDoc.data();
            const ambassadorUserSnap = await db.collection('users').doc(ambassadorUid).get();
            const ambassadorUser = ambassadorUserSnap.exists ? (ambassadorUserSnap.data() || {}) : {};
            const targetUser = studentSnap.exists ? (studentSnap.data() || {}) : {};
            const normEmail = v => String(v || '').trim().toLowerCase();
            const normPhone = v => String(v || '').replace(/[^0-9]/g, '');
            const sameIdentity = ambassadorUid === req.uid
              || (normEmail(ambassadorUser.email) && normEmail(ambassadorUser.email) === normEmail(targetUser.email))
              || (normPhone(ambassadorUser.phone || ambassadorUser.telephone || ambassadorUser.tel) && normPhone(ambassadorUser.phone || ambassadorUser.telephone || ambassadorUser.tel) === normPhone(targetUser.phone || targetUser.telephone || targetUser.tel));
            if (!sameIdentity && ambData.status === 'active') {
              const rate = 0.15;
              const commissionAmount = Math.round(req.priceFCFA * rate);
              const commissionRef = await db.collection('ambassador_commissions').add({
                ambassador_id: ambassadorUid,
                referred_user_id: req.uid,
                plan: req.targetPlan, gross_amount: req.priceFCFA, net_amount: req.priceFCFA, rate,
                commission_amount: commissionAmount,
                status: 'due',
                source: 'groupe', campaignId: req.campaignId,
                created_at: new Date().toISOString(),
              });
              await db.collection('ambassador_events').add({
                code: refCode, type: 'paid', referred_user_id: req.uid,
                plan: req.targetPlan, amount: req.priceFCFA, net_amount: req.priceFCFA, source: 'groupe', created_at: new Date().toISOString(),
              });
              if (ambData.level === 'eclaireur') {
                await db.collection('ambassadors').doc(ambassadorUid).set({ level: 'ambassadeur' }, { merge: true });
              }
              commissionInfo = { id: commissionRef.id, amount: commissionAmount, ambassadorUid };
            }
          }
        }
      } catch (ambErr) {
        console.error('groupCampaign ambassador commission error:', ambErr);
        // Ne bloque jamais la confirmation de l'upgrade pour une erreur de commission.
      }

      return response(200, { ok: true, msg: 'Demande confirmée et upgrade appliqué', commission: commissionInfo });
    }
    if (action === 'reject') {
      const requestId = String(body.requestId || ''); if (!requestId) return response(400, { error: 'Demande manquante' });
      const ref = db.collection('groupUpgradeRequests').doc(requestId); const snap = await ref.get(); if (!snap.exists) return response(404, { error: 'Demande introuvable' });
      if (!['pending', 'waitlist'].includes(snap.data().status)) return response(400, { error: 'Cette demande a déjà été traitée' });
      const req = snap.data();
      if (req.status === 'pending') {
        const campaignRef = db.collection('groupCampaigns').doc(req.campaignId);
        await db.runTransaction(async tx => { const c = await tx.get(campaignRef); if (c.exists) tx.update(campaignRef, { reservedPlaces: admin.firestore.FieldValue.increment(-1), updatedAt: new Date().toISOString() }); tx.update(ref, { status: 'rejected', rejectedAt: new Date().toISOString(), rejectedBy: adminUid }); });
      } else await ref.update({ status: 'rejected', rejectedAt: new Date().toISOString(), rejectedBy: adminUid });
      return response(200, { ok: true, msg: 'Demande refusée' });
    }
    return response(400, { error: 'Action inconnue' });
  } catch (e) { console.error('groupCampaign error:', e); return response(e.message.includes('Token') || e.message.includes('Accès') || e.message.includes('Rôle') ? 403 : 500, { error: e.message }); }
};
