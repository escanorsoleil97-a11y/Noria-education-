const admin = require('firebase-admin');

// Init Admin SDK une seule fois
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
  });
}

const db = admin.firestore();

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
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  try {
    // 1. Vérifier le token Firebase Auth
    const authHeader = event.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token manquant' }) };
    }
    const idToken = authHeader.split('Bearer ')[1];
    const decoded = await admin.auth().verifyIdToken(idToken);
    const uid = decoded.uid;

    // ── Remboursement après échec IA : uniquement si le proxy a enregistré un échec
    // APRÈS ce débit (aiHealth) et jamais deux fois pour le même débit (aiCharges).
    let _early = {};
    try { _early = JSON.parse(event.body || '{}'); } catch (_) {}
    if (_early.action === 'refund') {
      const tok = String(_early.token || '');
      if (!/^[A-Za-z0-9]{10,40}$/.test(tok)) {
        return { statusCode: 400, headers, body: JSON.stringify({ ok: false, error: 'token invalide' }) };
      }
      const chRef = db.collection('aiCharges').doc(tok);
      const hRef = db.collection('aiHealth').doc(uid);
      const uRef = db.collection('users').doc(uid);
      let refunded = 0;
      await db.runTransaction(async (tx) => {
        const [c, h] = await Promise.all([tx.get(chRef), tx.get(hRef)]);
        if (!c.exists) return;
        const cd = c.data();
        if (cd.uid !== uid || cd.refunded) return;
        if (Date.now() - cd.ts > 15 * 60 * 1000) return;
        const hd = h.exists ? h.data() : {};
        if (!(hd.failAt && hd.failAt >= cd.ts && hd.failAt > (hd.okAt || 0))) return;
        tx.update(uRef, { credits: admin.firestore.FieldValue.increment(cd.cost) });
        tx.update(chRef, { refunded: true, refundedAt: Date.now() });
        refunded = cd.cost;
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: refunded > 0, refunded }) };
    }

    // ── Reprise best-effort des chimis offerts (lien admin) expirés et non
    // consommés : chaque lot expirant est retiré du solde une fois sa date
    // dépassée, s'il reste un solde correspondant (approximation — le solde
    // est fongible, donc on ne peut pas tracer précisément quels chimis
    // dépensés provenaient de quel lot).
    try {
      const now = Date.now();
      const expiredGrantsSnap = await db.collection('chimiGrants')
        .where('uid', '==', uid).where('remaining', '>', 0).get();
      const expired = expiredGrantsSnap.docs.filter(d => new Date(d.data().expiresAt).getTime() < now);
      if (expired.length) {
        const userRef0 = db.collection('users').doc(uid);
        await db.runTransaction(async (tx) => {
          const snap0 = await tx.get(userRef0);
          if (!snap0.exists) return;
          let toReclaim = expired.reduce((s, d) => s + (d.data().remaining || 0), 0);
          const currentCredits = snap0.data().credits ?? 0;
          const reclaimed = Math.min(toReclaim, currentCredits);
          if (reclaimed > 0) tx.update(userRef0, { credits: admin.firestore.FieldValue.increment(-reclaimed) });
          expired.forEach(d => tx.update(d.ref, { remaining: 0 }));
        });
      }
    } catch (reclaimErr) {
      console.warn('chimiGrants reclaim failed (non-blocking):', reclaimErr.message);
    }

    // 2. Coût déterminé SERVER-SIDE selon le type d'action — jamais fourni par le
    // client comme un nombre arbitraire (avant : le client envoyait directement le
    // coût en chimis, falsifiable pour payer moins que le vrai prix de l'action).
    const { actionType, level, resumeType, count, hasFile, fileChars } = JSON.parse(event.body || '{}');
    const LEVEL_COSTS = { court: 1, moyen: 2, detaille: 3, publication: 4 };
    // Simulation QCM & Examen blanc (Espace Étudiant) : coût selon le NOMBRE de
    // questions choisi (10 / 15 / 20). Le client envoie `count`, mais on ne fait
    // confiance qu'aux clés connues de cette table (jamais à un montant arbitraire).
    const QUESTION_COSTS = { 10: 2, 15: 3, 20: 5 };
    // Résumé Cours/Protocole/Mémoire (Espace Étudiant) : coût selon type de document
    // ET taille choisie — jamais fourni tel quel par le client (idem le reste de cette
    // fonction), on ne fait confiance qu'aux clés connues de cette table.
    const RESUME_COSTS = {
      cours:     { court: 2, moyen: 3, grand: 5 },
      protocole: { court: 3, moyen: 5, grand: 8 },
      memoire:   { court: 5, moyen: 8, grand: 12 },
    };
    // Assistant Espace Étudiant (chat éducation) : coût par palier selon la taille du
    // texte extrait du document joint (plus le document est volumineux, plus le prompt
    // envoyé à l'IA est gros et coûte cher en tokens). Le client indique `fileChars`
    // (longueur du texte extrait) mais on ne fait confiance qu'aux paliers ci-dessous —
    // jamais à un coût arbitraire. Sans fichier : tarif fixe question simple.
    const ASSISTANT_FILE_TIERS = [
      { max: 4000,  cost: 4 },  // ~1-2 pages
      { max: 10000, cost: 6 },  // ~3-6 pages
      { max: Infinity, cost: 8 }, // au-delà (jusqu'à la troncature 18000 car. côté client)
    ];
    let cost;
    if (actionType === 'powerpoint') cost = 10;
    else if (actionType === 'discussion') cost = 5;
    else if (actionType === 'assistant') {
      if (hasFile === true) {
        const fc = Math.max(0, Number(fileChars) || 0);
        cost = (ASSISTANT_FILE_TIERS.find(t => fc <= t.max) || ASSISTANT_FILE_TIERS[ASSISTANT_FILE_TIERS.length - 1]).cost;
      } else {
        cost = 2; // question simple, sans document
      }
    }
    else if (actionType === 'simulation' || actionType === 'examen') {
      const n = [10, 15, 20].includes(Number(count)) ? Number(count) : 10;
      cost = QUESTION_COSTS[n];
    }
    else if (actionType === 'resume') {
      const rt  = RESUME_COSTS[resumeType] ? resumeType : 'cours';
      const lvl = ['court','moyen','grand'].includes(level) ? level : 'moyen';
      cost = RESUME_COSTS[rt][lvl];
    }
    else cost = LEVEL_COSTS[level] || 1; // 'interpretation' (ou non précisé) → tarif par niveau, défaut court

    // 3. Transaction atomique : renouveler (si Gratuit) puis vérifier et déduire
    const FREE_MONTHLY_CREDITS = 10;
    const MS_30_DAYS = 30 * 24 * 60 * 60 * 1000;
    const userRef = db.collection('users').doc(uid);
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error('Utilisateur introuvable');
      const data = snap.data();
      let credits = data.credits ?? 0;
      const now = Date.now();

      // ── RATE LIMITING : max 1 appel IA toutes les 3 secondes par compte ──
      const lastCall = data.lastAICallAt ? new Date(data.lastAICallAt).getTime() : 0;
      if (now - lastCall < 3000) throw new Error('RATELIMIT');

      // ── EXPIRY DU PLAN : si plan payant expiré → rétrogradation auto ──────
      if (data.plan && data.plan !== 'gratuit' && data.planExpiry) {
        const expiry = new Date(data.planExpiry).getTime();
        if (expiry < now) {
          tx.update(userRef, { plan: 'gratuit', planExpiry: null });
          throw new Error('PLAN_EXPIRED');
        }
      }

      // ── RENOUVELLEMENT MENSUEL GRATUIT ────────────────────────────────────
      if (data.plan === 'gratuit' || !data.plan) {
        const lastRenew = data.lastFreeCreditAt ? new Date(data.lastFreeCreditAt).getTime() : 0;
        if (now - lastRenew >= MS_30_DAYS) {
          credits = FREE_MONTHLY_CREDITS;
          tx.update(userRef, { credits, lastFreeCreditAt: new Date().toISOString() });
        }
      }

      if (credits < cost) throw new Error(`INSUFFICIENT:${credits}`);

      // ── ALERTE COMPORTEMENTALE : suivi de conso sur 48h (sans blocage) ────
      // Historique glissant léger (48h, 60 entrées max) pour repérer une
      // consommation en rafale, sans jamais empêcher l'action en cours.
      const cutoff48h = now - 48 * 60 * 60 * 1000;
      let usageLog = Array.isArray(data.usageLog) ? data.usageLog : [];
      usageLog = usageLog.filter(e => e && e.ts >= cutoff48h);
      usageLog.push({ ts: now, cost });
      usageLog = usageLog.slice(-60);
      const usage48h = usageLog.reduce((s, e) => s + (e.cost || 0), 0);

      const ANNUAL_STOCK = { standard: 100, professionnel: 500, premium: 2000 };
      const stock = ANNUAL_STOCK[data.plan];
      // Seuil : 40% du stock annuel consommé en 48h = rythme incompatible avec
      // une utilisation individuelle étalée sur l'année → possible partage de compte.
      const shouldAlert = !!stock && usage48h >= stock * 0.4;
      const lastAlertAt = data.lastUsageAlertAt ? new Date(data.lastUsageAlertAt).getTime() : 0;
      const alertCooldownOk = now - lastAlertAt > 24 * 60 * 60 * 1000; // 1 alerte/24h max

      // ── QUÊTES HEBDOMADAIRES : journal glissant 7 jours, séparé de usageLog
      // (qui reste dédié à la détection de fraude 48h ci-dessus) — sert de
      // preuve serveur pour growth.js (listQuests/claimQuest), jamais une
      // simple déclaration du client.
      const cutoff7d = now - 7 * 24 * 60 * 60 * 1000;
      let weekActionLog = Array.isArray(data.weekActionLog) ? data.weekActionLog : [];
      weekActionLog = weekActionLog.filter(e => e && e.ts >= cutoff7d);
      weekActionLog.push({ ts: now });
      weekActionLog = weekActionLog.slice(-200);

      // ── BONUS PARRAINAGE (chimi, distinct du programme Ambassadeur en FCFA) :
      // le PARRAIN reçoit un petit bonus chimi une seule fois, quand LE FILLEUL
      // (l'utilisateur courant) atteint 3 actions IA réelles — jamais à la
      // simple inscription, pour empêcher le farming par comptes fantômes.
      const totalAiActions = (data.totalAiActions || 0) + 1;
      const referralBonusPending = !!data.referredByUid && !data.referralChimiGranted && totalAiActions >= 3;

      tx.update(userRef, {
        credits: admin.firestore.FieldValue.increment(-cost),
        lastAICallAt: new Date().toISOString(),
        usageLog,
        weekActionLog,
        totalAiActions,
        ...(referralBonusPending ? { referralChimiGranted: true } : {}),
        ...(shouldAlert && alertCooldownOk ? { lastUsageAlertAt: new Date().toISOString() } : {})
      });

      return {
        creditsRestants: credits - cost,
        shouldAlert: shouldAlert && alertCooldownOk,
        usage48h, stock,
        email: data.email || '',
        referralBonusPending,
        referrerUid: data.referredByUid || null,
      };
    });

    // Écriture de l'alerte HORS transaction (best-effort, ne doit jamais bloquer l'utilisateur)
    if (result.shouldAlert) {
      try {
        await db.collection('alerts').add({
          uid,
          email: result.email,
          type: 'usage_burst',
          detail: `${result.usage48h}/${result.stock} chimis consommés en 48h`,
          createdAt: new Date().toISOString(),
        });
      } catch (alertErr) {
        console.warn('alert write failed:', alertErr.message);
      }
    }

    // ── Versement du bonus parrainage chimi (best-effort, budgété, HORS
    // transaction principale — un échec ici ne doit jamais faire échouer
    // l'action IA que l'utilisateur vient de payer) ──────────────────────────
    if (result.referralBonusPending && result.referrerUid) {
      try {
        const REFERRAL_CHIMI_BONUS = 5;
        const key = new Date().toISOString().slice(0, 7);
        const budgetRef = db.collection('config').doc('chimiBudget');
        let granted = false;
        await db.runTransaction(async (tx) => {
          const bSnap = await tx.get(budgetRef);
          const bData = bSnap.exists ? bSnap.data() : {};
          const cap = Number.isFinite(bData.capChimis) ? bData.capChimis : 5000;
          const spent = bData.monthKey === key ? (bData.spent || 0) : 0;
          if (spent + REFERRAL_CHIMI_BONUS > cap) return; // budget épuisé, pas de bonus ce mois-ci
          tx.set(budgetRef, { capChimis: cap, monthKey: key, spent: spent + REFERRAL_CHIMI_BONUS }, { merge: true });
          tx.update(db.collection('users').doc(result.referrerUid), {
            credits: admin.firestore.FieldValue.increment(REFERRAL_CHIMI_BONUS),
            referralActiveCount: admin.firestore.FieldValue.increment(1),
          });
          granted = true;
        });
        if (granted) {
          await db.collection('chimi_ledger').add({
            uid: result.referrerUid, amount: REFERRAL_CHIMI_BONUS, source: 'referral_chimi',
            referredUid: uid, ts: new Date().toISOString(), monthKey: key,
          });
        }
      } catch (refErr) {
        console.warn('referral chimi bonus failed (non-blocking):', refErr.message);
      }
    }

    // Jeton de remboursement (best-effort) : permet au client de récupérer les chimis
    // si l'IA échoue après le débit. expireAt = champ TTL Firestore optionnel.
    let refundToken = '';
    try {
      const ch = await db.collection('aiCharges').add({
        uid, cost, ts: Date.now(), refunded: false, expireAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      });
      refundToken = ch.id;
    } catch (chErr) { console.warn('aiCharges write failed:', chErr.message); }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, creditsRestants: result.creditsRestants, refundToken }),
    };

  } catch (e) {
    if (e.message === 'RATELIMIT') {
      return { statusCode: 429, headers, body: JSON.stringify({ error: 'ratelimit', message: 'Trop de requêtes — attendez quelques secondes' }) };
    }
    if (e.message === 'PLAN_EXPIRED') {
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'plan_expired', message: 'Votre abonnement a expiré. Veuillez renouveler.' }) };
    }
    if (e.message?.startsWith('INSUFFICIENT:')) {
      const credits = parseInt(e.message.split(':')[1]);
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'insufficient', credits }) };
    }
    console.error('useAICredit error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
