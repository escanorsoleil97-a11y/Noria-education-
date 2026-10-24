const admin = require('firebase-admin');
const sec = require('./_security');

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}

const db = admin.firestore();
const DOC_REF_PROMO = db.collection('config').doc('promotions');

// Crédits accordés par plan — Grille StatAnalyse Pro
// Standard/Professionnel/Premium : abonnement annuel (365 jours), prix fixe
// Institution : abonnement annuel, prix dégressif par compte (voir INSTITUTION_PRICING)
const PLAN_CONFIG = {
  standard:      { credits: 100,   dureeJours: 365, prixFCFA: 10000 },
  avance:        { credits: 250,   dureeJours: 365, prixFCFA: 18000 },
  professionnel: { credits: 500,   dureeJours: 365, prixFCFA: 25000 },
  premium:       { credits: 2000,   dureeJours: 365, prixFCFA: 50000 },
  institution:   { dureeJours: 365 }, // credits et prix calculés selon nbComptes (2000/compte)
};

// Tarif dégressif Institution : prix par compte selon le palier de volume.
// 5 comptes minimum. Crédits mutualisés : 2000 crédits par compte inclus.
const INSTITUTION_PRICING = [
  { minComptes: 50, prixParCompte: 10000 },
  { minComptes: 20, prixParCompte: 14000 },
  { minComptes: 5,  prixParCompte: 18000 },
];
const INSTITUTION_CREDITS_PAR_COMPTE = 2000;

function getInstitutionPricePerAccount(nbComptes) {
  for (const tier of INSTITUTION_PRICING) {
    if (nbComptes >= tier.minComptes) return tier.prixParCompte;
  }
  return null; // moins de 5 comptes : non éligible
}

// Bonus parrain/filleul par plan
const REFERRAL_BONUS = {
  standard:      { parrain: 1000, filleul: 5  },
  professionnel: { parrain: 2500, filleul: 15 },
  premium:       { parrain: 5000, filleul: 50 },
  institution:   { parrain: 10000,filleul: 100},
};

async function verifyNotchPay(txRef) {
  const apiKey = process.env.NOTCHPAY_PUBLIC_KEY;
  const res = await fetch(`https://api.notchpay.co/payments/${txRef}`, {
    headers: { Authorization: apiKey },
  });
  if (!res.ok) throw new Error('NotchPay API error');
  const data = await res.json();
  // NotchPay: transaction.status === 'complete'
  return {
    paid: data?.transaction?.status === 'complete',
    amount: data?.transaction?.amount ?? null,
  };
}

async function verifyMonetbil(txRef) {
  const serviceKey = process.env.MONETBIL_SERVICE_KEY;
  const res = await fetch(`https://api.monetbil.com/payment/v1/checkPayment`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ serviceKey, paymentRef: txRef }),
  });
  const data = await res.json();
  // Monetbil: status === 1
  return {
    paid: data?.status === 1,
    amount: data?.amount ?? null,
  };
}

async function triggerReferralBonus(uid, plan) {
  const bonus = REFERRAL_BONUS[plan];
  if (!bonus) return;

  const userRef = db.collection('users').doc(uid);
  const userSnap = await userRef.get();
  if (!userSnap.exists) return;

  const data = userSnap.data();
  if (!data.referredBy || data.referralBonusGiven) return; // déjà accordé

  // Créditer le filleul
  await userRef.update({
    credits: admin.firestore.FieldValue.increment(bonus.filleul),
    referralBonusGiven: true,
  });

  // Créditer le parrain
  if (data.referredByUid) {
    await db.collection('users').doc(data.referredByUid).update({
      referralEarnings: admin.firestore.FieldValue.increment(bonus.parrain),
      referralCount:    admin.firestore.FieldValue.increment(1),
      credits:          admin.firestore.FieldValue.increment(Math.floor(bonus.parrain / 1000)),
    });
  }
}

exports.handler = async (event) => {
  const _origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const _allowed = (process.env.SITE_ORIGIN || process.env.URL || 'https://pstat-pro-all.netlify.app,https://stat-analyse-pro.netlify.app','https://pstat-pro-all.netlify.app').split(',').map(s=>s.trim().replace(/\/$/,'')).filter(Boolean);
  if (_origin && !_allowed.includes(_origin) && !(process.env.URL||'').startsWith(_origin) && !(process.env.DEPLOY_URL||'').startsWith(_origin)) {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Origine non autorisée' }) };
  }
  const headers = {
    'Access-Control-Allow-Origin': (_origin && _allowed.includes(_origin)) ? _origin : (_allowed[0] || '*'),
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  try {
    const ip = (event.headers['x-forwarded-for']||event.headers['X-Forwarded-For']||'unknown').split(',')[0].trim();
    if (typeof sec !== 'undefined' && sec.rateLimit && !sec.rateLimit(ip+':pay', { limit: 15, windowMs: 60000 })) {
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'Trop de tentatives de paiement' }) };
    }
  } catch (_rl) {}

  try {
    // 1. Vérifier token Firebase Auth
    const authHeader = event.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token manquant' }) };
    }
    const idToken = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // 2. Lire les paramètres
    const { txRef, plan, provider, nbComptes } = JSON.parse(event.body || '{}');
    if (!txRef || !plan || !provider) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Paramètres manquants' }) };
    }
    if (!PLAN_CONFIG[plan]) {
      return { statusCode: 400, headers, body: JSON.stringify({ error: 'Plan inconnu' }) };
    }

    // Cas Institution : nbComptes requis, prix dégressif calculé serveur-side
    let institutionPrixParCompte = null;
    let institutionCredits = null;
    if (plan === 'institution') {
      const n = parseInt(nbComptes, 10);
      if (!n || n < 5) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'nbComptes invalide (minimum 5 comptes pour Institution)' }) };
      }
      institutionPrixParCompte = getInstitutionPricePerAccount(n);
      if (!institutionPrixParCompte) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'Aucun palier tarifaire ne correspond à ce nombre de comptes' }) };
      }
      institutionCredits = n * INSTITUTION_CREDITS_PAR_COMPTE;
    }

    // 3. Vérifier que cette transaction n'a pas déjà été traitée (anti-replay)
    const txDoc = await db.collection('transactions').doc(txRef).get();
    if (txDoc.exists) {
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, alreadyProcessed: true }) };
    }

    // 4. Vérifier le paiement auprès de l'agrégateur
    let verif;
    if (provider === 'notchpay') verif = await verifyNotchPay(txRef);
    else if (provider === 'monetbil') verif = await verifyMonetbil(txRef);
    else return { statusCode: 400, headers, body: JSON.stringify({ error: 'Provider inconnu' }) };

    if (!verif.paid) {
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'Paiement non confirmé' }) };
    }

    // 4bis. Vérifier strictement que le montant payé correspond au prix du plan
    // demandé (anti-fraude) — pour TOUS les plans, pas seulement Institution.
    // Si l'agrégateur ne renvoie pas de montant vérifiable → on BLOQUE :
    // mieux vaut une activation manuelle qu'une fraude automatisée.
    // Prix attendu = prix catalogue, ou prix promo actif (config/promotions) si applicable
    let prixAttendu = plan === 'institution'
      ? institutionPrixParCompte * parseInt(nbComptes, 10)
      : PLAN_CONFIG[plan].prixFCFA;
    if (plan !== 'institution') {
      try {
        const promoSnap = await DOC_REF_PROMO.get();
        const promo = promoSnap.exists ? promoSnap.data() : null;
        if (promo && promo.active && promo.plans && promo.plans[plan]) {
          const pp = promo.promoPrices ? Number(promo.promoPrices[plan]) : NaN;
          if (Number.isFinite(pp) && pp >= 0) prixAttendu = pp;
        }
      } catch (promoErr) {
        console.warn('confirmPayment: lecture promo impossible, prix catalogue utilisé', promoErr.message);
      }
    }
    if (verif.amount == null) {
      console.error(`confirmPayment: montant non vérifiable pour txRef=${txRef}, plan=${plan} — activation BLOQUÉE, traitement manuel requis.`);
      return {
        statusCode: 402,
        headers,
        body: JSON.stringify({
          error: 'Montant non vérifiable par l\'agrégateur. Votre paiement sera vérifié manuellement sous 24h. Contactez support@statanalyse.pro avec votre reçu.',
          pendingManualReview: true,
        }),
      };
    }
    if (verif.amount < prixAttendu) {
      return { statusCode: 402, headers, body: JSON.stringify({ error: `Montant payé (${verif.amount}) insuffisant pour le plan ${plan} (attendu ${prixAttendu} FCFA)` }) };
    }

    // 5. Mettre à jour le plan utilisateur
    const config = PLAN_CONFIG[plan];
    const creditsToAdd = plan === 'institution' ? institutionCredits : config.credits;
    const expiry = new Date();
    expiry.setDate(expiry.getDate() + config.dureeJours);

    const updateData = {
      plan,
      planExpiry:  expiry.toISOString(),
      credits:     admin.firestore.FieldValue.increment(creditsToAdd),
      updatedAt:   new Date().toISOString(),
    };
    if (plan === 'institution') {
      updateData.institutionNbComptes = parseInt(nbComptes, 10);
    }

    await db.collection('users').doc(uid).update(updateData);

    // 6. Marquer la transaction comme traitée
    await db.collection('transactions').doc(txRef).set({
      uid, plan, provider,
      ...(plan === 'institution' ? { nbComptes: parseInt(nbComptes, 10), montantVerifie: verif.amount } : {}),
      processedAt: new Date().toISOString(),
    });

    // 7. Déclencher le bonus parrain
    await triggerReferralBonus(uid, plan);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, plan, credits: creditsToAdd, expiry: expiry.toISOString() }),
    };

  } catch (e) {
    console.error('confirmPayment error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
