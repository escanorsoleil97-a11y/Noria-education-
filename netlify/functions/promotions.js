// StatAnalyse Pro — promotions.js (sécurisé)
// GET public (affichage tarifs) — origine contrôlée
// POST admin uniquement — Auth + UID + rôle + rate-limit

'use strict';
const admin = require('firebase-admin');
const sec = require('./_security');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const VALID_PROMO_PLANS = ['standard', 'avance', 'professionnel', 'premium', 'institution'];
const DOC_REF = () => db.collection('config').doc('promotions');

const DEFAULT_STATE = {
  active: false,
  plans: { standard: false, avance: false, professionnel: false, premium: false, institution: false },
  promoPrices: { standard: null, avance: null, professionnel: null, premium: null, institution: null },
  promoBonuses: { standard: null, avance: null, professionnel: null, premium: null, institution: null },
};

function out(status, body, origin) {
  return {
    statusCode: status,
    headers: {
      ...sec.securityHeaders(origin),
      'Cache-Control': 'no-store, no-cache, must-revalidate',
    },
    body: JSON.stringify(body),
  };
}

exports.handler = async (event) => {
  let origin = '';
  try {
    origin = sec.assertOrigin(event);
  } catch (x) {
    return out(x.status || 403, { error: 'Origine non autorisée' }, sec.originOf(event));
  }

  if (event.httpMethod === 'OPTIONS') return sec.preflight(event);

  const ip = sec.clientIp(event);
  if (!sec.rateLimit(ip, { limit: 60, windowMs: 60000 })) {
    return out(429, { error: 'Trop de requêtes' }, origin);
  }

  try {
    if (event.httpMethod === 'GET') {
      const snap = await DOC_REF().get();
      const data = snap.exists ? snap.data() : {};
      const state = {
        ...DEFAULT_STATE,
        ...data,
        plans: { ...DEFAULT_STATE.plans, ...(data.plans || {}) },
        promoPrices: { ...DEFAULT_STATE.promoPrices, ...(data.promoPrices || {}) },
        promoBonuses: { ...DEFAULT_STATE.promoBonuses, ...(data.promoBonuses || {}) },
      };
      return out(200, { ok: true, active: !!state.active, plans: state.plans, promoPrices: state.promoPrices, promoBonuses: state.promoBonuses }, origin);
    }

    if (event.httpMethod !== 'POST') {
      return out(405, { error: 'Méthode non autorisée' }, origin);
    }

    // POST : rate-limit plus strict
    if (!sec.rateLimit(ip + ':promo-write', { limit: 20, windowMs: 60000 })) {
      return out(429, { error: 'Trop de modifications' }, origin);
    }

    let decoded;
    try {
      decoded = await sec.verifyAuth(event);
    } catch (e) {
      return out(e.status || 401, { error: 'Authentification requise' }, origin);
    }
    const callerUid = decoded.uid;
    if (!sec.adminUids().has(callerUid)) {
      return out(403, { error: 'Accès refusé' }, origin);
    }
    const callerSnap = await db.collection('users').doc(callerUid).get();
    const callerRole = callerSnap.data()?.role || '';
    if (!callerSnap.exists || (callerRole !== 'admin' && callerRole !== 'adnim')) {
      return out(403, { error: 'Rôle admin requis' }, origin);
    }

    const body = sec.body(event, 50000);
    const nextState = { active: !!body.active, plans: {}, promoPrices: {}, promoBonuses: {} };
    for (const p of VALID_PROMO_PLANS) {
      nextState.plans[p] = !!(body.plans && body.plans[p]);
      const rawPrice = body.promoPrices && body.promoPrices[p];
      const num = rawPrice === '' || rawPrice === null || rawPrice === undefined ? null : Number(rawPrice);
      nextState.promoPrices[p] = Number.isFinite(num) && num >= 0 ? num : null;
      const rawBonus = body.promoBonuses && body.promoBonuses[p];
      nextState.promoBonuses[p] = (typeof rawBonus === 'string' && rawBonus.trim())
        ? rawBonus.trim().slice(0, 200)
        : null;
      if (nextState.plans[p] && nextState.promoPrices[p] === null && !nextState.promoBonuses[p]) {
        return out(400, { error: `Le pack "${p}" est coché sans prix promo ni cadeau.` }, origin);
      }
    }
    await DOC_REF().set(
      { ...nextState, updatedAt: new Date().toISOString(), updatedBy: callerUid },
      { merge: true }
    );
    return out(200, { ok: true, ...nextState }, origin);
  } catch (err) {
    console.error('promotions error:', err.message);
    return out(500, { error: 'Erreur serveur' }, origin);
  }
};
