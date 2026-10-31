// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — adminAction.js
// Actions d'administration sécurisées (côté serveur uniquement)
// UID admin autorisé hardcodé + vérification role Firestore (double verrou)
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const crypto = require('crypto');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ── Grille de prix (miroir exact de PLAN_CONFIG dans confirmPayment.js) ──────
const UPGRADE_PLAN_CONFIG = {
  standard:      { credits: 100,  prixFCFA: 10000 },
  avance:        { credits: 250,  prixFCFA: 18000 },
  professionnel: { credits: 500,  prixFCFA: 25000 },
  premium:       { credits: 2000, prixFCFA: 35000 },
};

// ── UID admin autorisé (double sécurité avec role Firestore) ─────────────────
// UIDs admins autorisés
const ADMIN_UIDS = new Set(((process.env.ADMIN_UIDS||'SBATLA0GmVbeYWWpWrPoRTTveb32,0f9FMESHK6gq5Gl77tquCETbFow1')).split(',').map(s=>s.trim()).filter(Boolean));

// ── Plans valides ────────────────────────────────────────────────────────────
const VALID_PLANS = ['gratuit', 'standard', 'avance', 'professionnel', 'premium', 'institution', 'ecole', 'hopital_district', 'centre_sante', 'pharmacie'];

// ── Crédits par défaut par plan ──────────────────────────────────────────────
const PLAN_CREDITS = {
  gratuit:       10,
  standard:      200,
  avance:        250,
  professionnel: 500,
  premium:       2000,
  institution:   2000,
  centre_sante:  500,
  ecole:          500,
  hopital_district: 2000,
  pharmacie:      500,
};

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST')    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };

  try {
    // ── 1. Vérifier token Firebase ───────────────────────────────────────────
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token manquant' }) };
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    const callerUid = decoded.uid;

    // ── 2. Vérifier que c'est l'admin (double verrou : UID + role Firestore) ─
    if (!ADMIN_UIDS.has(callerUid)) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Accès refusé' }) };
    }
    const callerSnap = await db.collection('users').doc(callerUid).get();
    const callerRole = callerSnap.data()?.role || '';
    if (!callerSnap.exists || (callerRole !== 'admin' && callerRole !== 'adnim')) {
      return { statusCode: 403, headers, body: JSON.stringify({ error: 'Rôle admin requis' }) };
    }

    // ── 3. Parser l'action ───────────────────────────────────────────────────
    const { action, targetUid, payload } = JSON.parse(event.body || '{}');
    if (!action) return { statusCode: 400, headers, body: JSON.stringify({ error: 'action requise' }) };

    // ── 4. Exécuter l'action ─────────────────────────────────────────────────
    switch (action) {

      // Lister tous les utilisateurs (50 max par appel)
      case 'listUsers': {
        const snap = await db.collection('users').limit(200).get();
        const users = snap.docs.map(d => ({
          uid:        d.id,
          email:      d.data().email || '',
          plan:       d.data().plan || 'gratuit',
          credits:    d.data().credits ?? 0,
          createdAt:  d.data().createdAt || '',
          planExpiry: d.data().planExpiry || '',
          suspended:  d.data().suspended || false,
          kickCount:  d.data().kickCount || 0,
          role:       d.data().role || '',
          referralCount: d.data().referralCount || 0,
          profil: d.data().profil || '',
          accessProfile: d.data().accessProfile || '',
          accessCampaignId: d.data().accessCampaignId || '',
          institutionNom: d.data().institutionNom || '',
          institutionNbComptes: d.data().institutionNbComptes ?? '',
          institutionPrixTotal: d.data().institutionPrixTotal ?? '',
          institutionCreditsAn: d.data().institutionCreditsAn ?? '',
          spaces: d.data().spaces || {},
        }));
        // Tri : plus récents en premier
        users.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, users }) };
      }

      // Modifier les informations de profil affichées dans l’application.
      // L’e-mail d’authentification, l’UID et le rôle restent non modifiables ici.
      case 'updateUserInfo': {
        if (!targetUid || !payload || typeof payload !== 'object') {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et informations requises' }) };
        }
        if (ADMIN_UIDS.has(targetUid)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Les informations du compte admin sont protégées' }) };
        }
        const allowed = ['displayName', 'phone', 'matricule', 'accessProfile', 'accessCampaignId', 'planExpiry'];
        const updates = {};
        for (const key of allowed) {
          if (Object.prototype.hasOwnProperty.call(payload, key)) {
            const value = payload[key] == null ? '' : String(payload[key]).trim();
            if (value.length > 200) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Champ trop long : ' + key }) };
            updates[key] = value;
          }
        }
        if (Object.prototype.hasOwnProperty.call(updates, 'planExpiry') && updates.planExpiry) {
          const d = new Date(updates.planExpiry);
          if (Number.isNaN(d.getTime())) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Date d’expiration invalide' }) };
          updates.planExpiry = d.toISOString();
        }
        if (!Object.keys(updates).length) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Aucune information modifiable fournie' }) };
        updates.updatedAt = new Date().toISOString();
        updates.updatedBy = 'admin';
        await db.collection('users').doc(targetUid).update(updates);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: 'Informations utilisateur mises à jour', updates }) };
      }

      // Changer le plan d'un utilisateur
      case 'setPlan': {
        if (!targetUid || !payload?.plan) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et plan requis' }) };
        }
        if (!VALID_PLANS.includes(payload.plan)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Plan invalide' }) };
        }
        const expiry = new Date();
        expiry.setFullYear(expiry.getFullYear() + 1);
        const updates = {
          plan:       payload.plan,
          planExpiry: payload.plan === 'gratuit' ? null : expiry.toISOString(),
          updatedAt:  new Date().toISOString(),
          updatedBy:  'admin',
        };
        // Lorsqu'un admin transforme un compte en établissement, appliquer
        // aussi le stock initial du profil afin que le changement de plan soit
        // cohérent immédiatement (et non uniquement visuel).
        if (Object.prototype.hasOwnProperty.call(PLAN_CREDITS, payload.plan)) {
          updates.credits = PLAN_CREDITS[payload.plan];
        }
        await db.collection('users').doc(targetUid).update(updates);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: `Plan mis à jour : ${payload.plan}` }) };
      }

      // Activer / bloquer les modes complémentaires d'un compte
      case 'setSpaces': {
        const KEYS = ['business', 'sante', 'institution'];
        if (!targetUid || !payload || typeof payload.spaces !== 'object' || payload.spaces === null) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et spaces requis' }) };
        }
        const spaces = {};
        for (const k of KEYS) spaces[k] = payload.spaces[k] === true;
        await db.collection('users').doc(targetUid).update({
          spaces,
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin',
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, spaces, msg: 'Modes mis à jour' }) };
      }

      // Ajouter des crédits
      case 'addCredits': {
        if (!targetUid || typeof payload?.amount !== 'number') {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et amount requis' }) };
        }
        if (payload.amount < 0 || payload.amount > 10000) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Montant invalide (0–10 000)' }) };
        }
        await db.collection('users').doc(targetUid).update({
          credits:   admin.firestore.FieldValue.increment(payload.amount),
          updatedAt: new Date().toISOString(),
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: `+${payload.amount} crédits ajoutés` }) };
      }

      // Suspendre / réactiver un compte
      case 'setSuspend': {
        if (!targetUid || typeof payload?.suspended !== 'boolean') {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et suspended requis' }) };
        }
        if (ADMIN_UIDS.has(targetUid)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Impossible de suspendre le compte admin' }) };
        }
        await db.collection('users').doc(targetUid).update({
          suspended:  payload.suspended,
          kickCount:  0,
          updatedAt:  new Date().toISOString(),
          updatedBy:  'admin',
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: payload.suspended ? 'Compte suspendu' : 'Compte réactivé' }) };
      }

      // Réinitialiser le compteur de kicks
      case 'resetKicks': {
        if (!targetUid) return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid requis' }) };
        await db.collection('users').doc(targetUid).update({ kickCount: 0, suspended: false, updatedAt: new Date().toISOString() });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: 'Compteur réinitialisé' }) };
      }

      // Supprimer un utilisateur (Firestore doc uniquement — pas Firebase Auth)
      case 'deleteUser': {
        if (!targetUid) return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid requis' }) };
        if (ADMIN_UIDS.has(targetUid)) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Impossible de supprimer le compte admin' }) };
        }
        await db.collection('users').doc(targetUid).delete();
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: 'Utilisateur supprimé' }) };
      }

      // Stats globales
      case 'getStats': {
        const snap = await db.collection('users').get();
        const stats = { total: 0, byPlan: {}, suspended: 0, creditsTotal: 0, newThisMonth: 0 };
        const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
        snap.docs.forEach(d => {
          const data = d.data();
          stats.total++;
          const plan = data.plan || 'gratuit';
          stats.byPlan[plan] = (stats.byPlan[plan] || 0) + 1;
          if (data.suspended) stats.suspended++;
          stats.creditsTotal += data.credits ?? 0;
          if (data.createdAt && new Date(data.createdAt) >= monthStart) stats.newThisMonth++;
        });
        // Revenus estimés (prix en FCFA)
        const PRIX = { standard: 10000, professionnel: 25000, premium: 35000 };
        stats.revenusEstimes = Object.entries(PRIX).reduce((sum, [plan, prix]) => {
          return sum + (stats.byPlan[plan] || 0) * prix;
        }, 0);

        // ── PAIEMENTS (à activer quand l'API sera disponible) ────────────────
        // Décommenter quand NOTCHPAY_PUBLIC_KEY ou MONETBIL_SERVICE_KEY
        // sera configuré sur Netlify :
        //
        // const txSnap = await db.collection('transactions').orderBy('processedAt','desc').limit(50).get();
        // stats.transactions = txSnap.docs.map(d => ({ id: d.id, ...d.data() }));
        //
        // Pour l'instant on retourne un tableau vide avec un message clair :
        stats.transactions = [];
        stats.paymentNote = 'Paiements disponibles après configuration API (NotchPay ou Monetbil)';

        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, stats }) };
      }

      // ── Créer un membre Institution ──────────────────────────────────────
      // Reçoit : targetUid, payload.nbIndividus, payload.institutionName
      // Calcule : prix, crédits → met à jour le compte + journalise
      case 'createInstitutionMember': {
        if (!targetUid || !payload?.nbIndividus) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et nbIndividus requis' }) };
        }
        const nb = parseInt(payload.nbIndividus, 10);
        if (!nb || nb < 5) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Minimum 5 individus pour le plan Institution' }) };
        }
        // Calcul prix dégressif (identique à confirmPayment.js)
        const INST_PRICING = [
          { minComptes: 50, prixParCompte: 10000 },
          { minComptes: 20, prixParCompte: 14000 },
          { minComptes: 5,  prixParCompte: 18000 },
        ];
        const tier = INST_PRICING.find(t => nb >= t.minComptes);
        if (!tier) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Aucun palier tarifaire trouvé' }) };
        }
        const prixParCompte = tier.prixParCompte;
        const prixTotal = prixParCompte * nb;
        const creditsTotal = nb * 2000;
        const expiry = new Date();
        expiry.setFullYear(expiry.getFullYear() + 1);

        await db.collection('users').doc(targetUid).update({
          plan:                    'institution',
          planExpiry:              expiry.toISOString(),
          credits:                 admin.firestore.FieldValue.increment(creditsTotal),
          institutionNbComptes:    nb,
          institutionNom:          payload.institutionName || '',
          institutionPrixTotal:    prixTotal,
          institutionPrixParCompte: prixParCompte,
          updatedAt:               new Date().toISOString(),
          updatedBy:               'admin',
        });

        // Journaliser dans la collection institutions
        await db.collection('institutions').doc(targetUid).set({
          uid:             targetUid,
          nom:             payload.institutionName || '',
          nbComptes:       nb,
          creditsAlloues:  creditsTotal,
          prixTotal:       prixTotal,
          prixParCompte:   prixParCompte,
          activatedAt:     new Date().toISOString(),
          activatedBy:     callerUid,
          planExpiry:      expiry.toISOString(),
        }, { merge: true });

        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            ok: true,
            msg: `Institution activée : ${nb} comptes, ${creditsTotal} crédits, ${prixTotal.toLocaleString('fr-FR')} FCFA`,
            details: { nb, creditsTotal, prixTotal, prixParCompte },
          }),
        };
      }

      // ── Lister les institutions ──────────────────────────────────────────
      case 'listInstitutions': {
        const snap = await db.collection('institutions').get();
        const institutions = [];
        for (const d of snap.docs) {
          const data = d.data();
          // Récupérer l'email depuis users
          let email = '';
          try {
            const uSnap = await db.collection('users').doc(d.id).get();
            email = uSnap.data()?.email || '';
          } catch(_) {}
          institutions.push({ uid: d.id, email, ...data });
        }
        institutions.sort((a, b) => (b.activatedAt > a.activatedAt ? 1 : -1));
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, institutions }) };
      }

      // ── Lister les alertes anti-partage (usage_burst / device_multi) ──────
      case 'listAlerts': {
        const snap = await db.collection('alerts').limit(200).get();
        const alerts = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        alerts.sort((a, b) => (b.createdAt || '') > (a.createdAt || '') ? 1 : -1);
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, alerts }) };
      }

      // ── Marquer une alerte comme traitée (suppression du doc) ─────────────
      case 'resolveAlert': {
        if (!payload?.alertId) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'alertId requis' }) };
        }
        await db.collection('alerts').doc(payload.alertId).delete();
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: 'Alerte traitée' }) };
      }

      // ── Générer un lien donnant N chimis expirants (usage unique par défaut) ─
      case 'generateChimiLink': {
        const nbChimis = parseInt(payload?.nbChimis, 10);
        const dureeChimisJours = parseInt(payload?.dureeChimisJours, 10);
        const dureeLienHeures = parseInt(payload?.dureeLienHeures, 10) || 48;
        const maxClaims = Math.min(100000, Math.max(1, parseInt(payload?.maxClaims, 10) || 1));
        const dailyMaxClaims = Math.min(maxClaims, Math.max(0, parseInt(payload?.dailyMaxClaims, 10) || 0));
        if (!nbChimis || nbChimis <= 0) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'nbChimis requis (> 0)' }) };
        }
        if (!dureeChimisJours || dureeChimisJours < 1 || dureeChimisJours > 7) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'dureeChimisJours requis (1 à 7)' }) };
        }
        const token = crypto.randomBytes(16).toString('hex');
        const expiresAt = new Date(Date.now() + dureeLienHeures * 60 * 60 * 1000).toISOString();
        await db.collection('chimiLinks').doc(token).set({
          nbChimis,
          dureeChimisJours,
          maxClaims,
          dailyMaxClaims,
          claims: [],
          claimsByDay: {},
          createdAt: new Date().toISOString(),
          expiresAt,
          createdBy: callerUid,
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, token, expiresAt, maxClaims, dailyMaxClaims }) };
      }

      // ── Générer un lien d'upgrade à usage unique (48h) pour un utilisateur ──
      case 'generateUpgradeLink': {
        if (!targetUid) return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid requis' }) };
        const token = crypto.randomBytes(24).toString('hex');
        const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000).toISOString();
        await db.collection('upgradeLinks').doc(token).set({
          uid: targetUid,
          createdAt: new Date().toISOString(),
          expiresAt,
          used: false,
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, token, expiresAt }) };
      }

      // ── Appliquer un upgrade de palier (après paiement confirmé manuellement) ─
      // Règle : date d'expiration INCHANGÉE, stock du nouveau palier accordé
      // en PLEIN (pas d'incrément), prix plein différentiel (pas de prorata).
      case 'applyUpgrade': {
        if (!targetUid || !payload?.targetPlan) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'targetUid et targetPlan requis' }) };
        }
        if (!UPGRADE_PLAN_CONFIG[payload.targetPlan]) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Palier cible invalide' }) };
        }
        const userRef = db.collection('users').doc(targetUid);
        const userSnap = await userRef.get();
        if (!userSnap.exists) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Utilisateur introuvable' }) };
        const userData = userSnap.data();
        const ancienPlan = userData.plan || 'gratuit';
        const nouveauConfig = UPGRADE_PLAN_CONFIG[payload.targetPlan];
        const ancienPrix = UPGRADE_PLAN_CONFIG[ancienPlan]?.prixFCFA || 0;
        const montant = Math.max(0, nouveauConfig.prixFCFA - ancienPrix);

        await userRef.update({
          plan: payload.targetPlan,
          credits: nouveauConfig.credits, // stock plein, pas d'incrément — planExpiry non touché
          updatedAt: new Date().toISOString(),
          updatedBy: 'admin_upgrade',
        });

        await db.collection('upgrades').add({
          uid: targetUid,
          email: userData.email || '',
          ancienPlan,
          nouveauPlan: payload.targetPlan,
          montant,
          appliedAt: new Date().toISOString(),
        });

        if (payload.token) {
          try { await db.collection('upgradeLinks').doc(payload.token).update({ used: true, usedAt: new Date().toISOString() }); } catch (_) {}
        }

        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, msg: `Upgrade appliqué : ${ancienPlan} → ${payload.targetPlan} (${montant} FCFA, expiration inchangée)` }) };
      }

      // ═══════════════ MODULE AMBASSADEURS ═══════════════

      // Lister les demandes/ambassadeurs (pending + actifs + suspendus)
      case 'ambassadorList': {
        const snap = await db.collection('ambassadors').orderBy('createdAt', 'desc').limit(300).get();
        const list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ambassadors: list }) };
      }

      // Valider une demande pending → génère le code, passe en active/eclaireur
      case 'ambassadorApprove': {
        const ambRef = db.collection('ambassadors').doc(targetUid);
        const ambSnap = await ambRef.get();
        if (!ambSnap.exists) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Demande introuvable' }) };
        const ambData = ambSnap.data();
        if (ambData.status === 'active') {
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true, code: ambData.code, msg: 'Déjà actif.' }) };
        }
        const userSnap = await db.collection('users').doc(targetUid).get();
        const userData = userSnap.data() || {}; const rawPrenom = userData.prenom || userData.firstName || userData.displayName || (userData.email || 'AMB').split('@')[0]; const prenom = String(rawPrenom).replace(/[^a-zA-ZÀ-ÿ]/g, '').toUpperCase().substring(0, 6) || 'AMB';
        const suffix = Math.floor(10 + Math.random() * 90);
        const code = `AMB-${prenom}${suffix}`;
        await ambRef.set({
          code, status: 'active', level: 'eclaireur',
          activatedAt: new Date().toISOString(),
        }, { merge: true });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, code }) };
      }

      // Suspendre / réactiver un ambassadeur (motif obligatoire à la suspension)
      case 'ambassadorSuspend': {
        const newStatus = payload?.status === 'active' ? 'active' : 'suspended';
        if (newStatus === 'suspended' && !payload?.reason) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'Motif de suspension requis' }) };
        }
        const update = { status: newStatus };
        if (newStatus === 'suspended') {
          update.suspended_at = new Date().toISOString();
          update.suspend_reason = payload.reason;
        }
        await db.collection('ambassadors').doc(targetUid).set(update, { merge: true });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }

      // Confirmer un paiement reçu manuellement (Mobile Money hors ligne) :
      // remplace le webhook auto absent — c'est le geste manuel de l'admin qui
      // déclenche l'event "paid" + crée la ligne de commission due.
      // targetUid = uid de l'ÉTUDIANT qui vient de payer.
      case 'ambassadorConfirmPayment': {
        const { plan, amountPaid } = payload || {};
        if (!plan || !amountPaid) {
          return { statusCode: 400, headers, body: JSON.stringify({ error: 'plan et amountPaid requis' }) };
        }
        const studentSnap = await db.collection('users').doc(targetUid).get();
        if (!studentSnap.exists) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Étudiant introuvable' }) };
        const studentData = studentSnap.data();
        const refCode = studentData.ambassadorRef;

        if (!refCode) {
          // Règle d'or F4 : pas de code au moment du paiement = pas de commission.
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true, commission: null, msg: 'Aucun code ambassadeur associé — pas de commission.' }) };
        }

        // Anti-auto-parrainage : le code appartient-il à l'étudiant lui-même ?
        const ambQuery = await db.collection('ambassadors').where('code', '==', refCode).limit(1).get();
        if (ambQuery.empty) {
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true, commission: null, msg: 'Code ambassadeur introuvable.' }) };
        }
        const ambDoc = ambQuery.docs[0];
        const ambassadorUid = ambDoc.id;
        const ambData = ambDoc.data();

        const ambassadorUserSnap = await db.collection('users').doc(ambassadorUid).get(); const ambassadorUser = ambassadorUserSnap.exists ? (ambassadorUserSnap.data() || {}) : {}; const normEmail = v => String(v || '').trim().toLowerCase(); const normPhone = v => String(v || '').replace(/[^0-9]/g, ''); const sameIdentity = ambassadorUid === targetUid || (normEmail(ambassadorUser.email) && normEmail(ambassadorUser.email) === normEmail(studentData.email)) || (normPhone(ambassadorUser.phone || ambassadorUser.telephone || ambassadorUser.tel) && normPhone(ambassadorUser.phone || ambassadorUser.telephone || ambassadorUser.tel) === normPhone(studentData.phone || studentData.telephone || studentData.tel));
        if (sameIdentity) {
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true, commission: null, msg: '⚠️ Auto-parrainage détecté — commission bloquée.' }) };
        }
        if (ambData.status !== 'active') {
          return { statusCode: 200, headers, body: JSON.stringify({ ok: true, commission: null, msg: 'Code ambassadeur suspendu — pas de commission.' }) };
        }

        const rate = (() => {
          const activatedAt = ambData.activatedAt ? new Date(ambData.activatedAt) : null;
          if (activatedAt && (Date.now() - activatedAt.getTime()) <= 30 * 24 * 3600 * 1000) return 0.20;
          return 0.15;
        })();
        const commissionAmount = Math.round(amountPaid * rate);

        // Flag anti-abus : plusieurs filleuls payants différents le même jour
        // pour ce même ambassadeur → signalé pour vérification manuelle,
        // sans bloquer la commission (évite les faux positifs).
        const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
        const todaySnap = await db.collection('ambassador_commissions')
          .where('ambassador_id', '==', ambassadorUid)
          .where('created_at', '>=', todayStart.toISOString())
          .get();
        const distinctReferredToday = new Set(todaySnap.docs.map(d => d.data().referred_user_id));
        const flagged = distinctReferredToday.size >= 3;

        const commissionRef = await db.collection('ambassador_commissions').add({
          ambassador_id: ambassadorUid,
          referred_user_id: targetUid,
          plan, gross_amount: amountPaid, net_amount: amountPaid, rate,
          commission_amount: commissionAmount,
          status: 'due',
          flagged_for_review: flagged,
          created_at: new Date().toISOString(),
        });

        await db.collection('ambassador_events').add({
          code: refCode, type: 'paid', referred_user_id: targetUid,
          plan, amount: amountPaid, net_amount: amountPaid, created_at: new Date().toISOString(),
        });

        // Éclaireur → Ambassadeur au 1er paid
        if (ambData.level === 'eclaireur') {
          await db.collection('ambassadors').doc(ambassadorUid).set({ level: 'ambassadeur' }, { merge: true });
        }

        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, commission: { id: commissionRef.id, amount: commissionAmount, ambassadorUid } }) };
      }

      // Marquer une commission comme payée (Mobile Money) après versement.
      // Applique automatiquement le solde de clawback éventuel (remboursements
      // survenus après un versement précédent) en le déduisant du montant net versé.
      case 'ambassadorMarkCommissionPaid': {
        const { commissionId } = payload || {};
        if (!commissionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'commissionId requis' }) };
        const commRef = db.collection('ambassador_commissions').doc(commissionId);
        const result = await db.runTransaction(async (tx) => {
          const commSnap = await tx.get(commRef);
          if (!commSnap.exists) throw new Error('Commission introuvable');
          const comm = commSnap.data();
          if (comm.status !== 'due') throw new Error(`Commission déjà au statut "${comm.status}"`);
          const ambRef = db.collection('ambassadors').doc(comm.ambassador_id);
          const ambSnap = await tx.get(ambRef);
          const clawbackBalance = ambSnap.exists ? (ambSnap.data().clawback_balance || 0) : 0;
          const gross = comm.commission_amount;
          const offset = Math.min(clawbackBalance, gross);
          const netPaid = gross - offset;
          tx.update(commRef, {
            status: 'paid', paid_at: new Date().toISOString(),
            net_paid_amount: netPaid, clawback_offset: offset,
          });
          if (offset > 0) {
            tx.update(ambRef, { clawback_balance: admin.firestore.FieldValue.increment(-offset) });
          }
          return { gross, offset, netPaid, ambassadorId: comm.ambassador_id };
        });
        await db.collection('ambassador_notifications').add({
          ambassador_id: result.ambassadorId,
          message: result.offset > 0
            ? `💰 Versement de ${result.netPaid.toLocaleString('fr-FR')} FCFA effectué (${result.offset.toLocaleString('fr-FR')} FCFA déduits pour un clawback en cours).`
            : `💰 Versement de ${result.netPaid.toLocaleString('fr-FR')} FCFA effectué.`,
          read: false,
          created_at: new Date().toISOString(),
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
      }

      // Clawback : remboursement d'un forfait constaté APRÈS que la commission
      // correspondante ait déjà été versée. On ne retire pas d'argent déjà
      // envoyé : on crédite un solde négatif sur l'ambassadeur, déduit
      // automatiquement de son ou ses prochains versements (voir ci-dessus).
      case 'ambassadorClawback': {
        const { commissionId, reason } = payload || {};
        if (!commissionId) return { statusCode: 400, headers, body: JSON.stringify({ error: 'commissionId requis' }) };
        const commRef = db.collection('ambassador_commissions').doc(commissionId);
        const result = await db.runTransaction(async (tx) => {
          const commSnap = await tx.get(commRef);
          if (!commSnap.exists) throw new Error('Commission introuvable');
          const comm = commSnap.data();
          if (comm.status !== 'paid') throw new Error('Seule une commission déjà versée ("paid") peut faire l’objet d’un clawback.');
          const ambRef = db.collection('ambassadors').doc(comm.ambassador_id);
          const clawbackAmount = comm.net_paid_amount ?? comm.commission_amount;
          tx.update(commRef, {
            status: 'clawback', clawback_at: new Date().toISOString(),
            clawback_reason: reason || '', clawback_amount: clawbackAmount,
          });
          tx.update(ambRef, { clawback_balance: admin.firestore.FieldValue.increment(clawbackAmount) });
          return { clawbackAmount, ambassadorUid: comm.ambassador_id };
        });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, ...result }) };
      }

      // Lister toutes les commissions (avec email/code ambassadeur joints),
      // optionnellement filtrées par statut (due / paid / clawback).
      case 'ambassadorListCommissions': {
        const statusFilter = payload?.status;
        let q = db.collection('ambassador_commissions').orderBy('created_at', 'desc').limit(300);
        const snap = await q.get();
        let list = snap.docs.map(d => ({ id: d.id, ...d.data() }));
        if (statusFilter) list = list.filter(c => c.status === statusFilter);
        const ambIds = [...new Set(list.map(c => c.ambassador_id))];
        const ambMap = {};
        await Promise.all(ambIds.map(async (id) => {
          const s = await db.collection('ambassadors').doc(id).get();
          if (s.exists) ambMap[id] = { email: s.data().email || '', code: s.data().code || '' };
        }));
        list = list.map(c => ({ ...c, ambassador: ambMap[c.ambassador_id] || null }));
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, commissions: list }) };
      }

      // Ouvrir/fermer les candidatures ambassadeur (recrutement par vagues)
      case 'ambassadorSetRecruitment': {
        const { open: isOpen, nextWave } = payload || {};
        await db.collection('config').doc('ambassadorRecruitment').set({
          open: !!isOpen,
          nextWave: nextWave || null,
          updated_at: new Date().toISOString(),
        }, { merge: true });
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
      }

      default:
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Action inconnue : ${action}` }) };
    }

  } catch (e) {
    console.error('adminAction error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
