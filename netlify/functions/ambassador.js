// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — Module Ambassadeurs : actions côté utilisateur
// (candidature "Devenir ambassadeur", tracking clic/inscription du lien ?ref=)
// Les actions admin (approve/suspend/confirmPayment) sont dans adminAction.js
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON invalide' }) }; }
  const { action } = body;

  try {
    // ── Candidature "Devenir ambassadeur" — nécessite d'être connecté ──
    if (action === 'apply') {
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non authentifié.' }) };
      }
      const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
      const uid = decoded.uid;

      const existing = await db.collection('ambassadors').doc(uid).get();
      if (existing.exists) {
        const st = existing.data().status;
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: st, msg: st === 'active' ? 'Déjà ambassadeur.' : 'Demande déjà en cours.' }) };
      }

      // Recrutement par vagues : si fermé, on n'accepte pas de nouvelle candidature.
      const recruitSnap = await db.collection('config').doc('ambassadorRecruitment').get();
      const recruitData = recruitSnap.exists ? recruitSnap.data() : { open: true };
      if (recruitData.open === false) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: 'closed', nextWave: recruitData.nextWave || null, msg: 'Candidatures fermées pour le moment.' }) };
      }

      const userSnap = await db.collection('users').doc(uid).get();
      await db.collection('ambassadors').doc(uid).set({
        user_id: uid,
        email: userSnap.data()?.email || '',
        status: 'pending',
        level: null,
        code: null,
        createdAt: new Date().toISOString(),
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: 'pending' }) };
    }

    // ── Tracking clic sur un lien ?ref=CODE (dernier clic gagne, géré côté client) ──
    if (action === 'trackClick') {
      const { code } = body;
      if (!code) return { statusCode: 400, headers, body: JSON.stringify({ error: 'code requis' }) };
      const ambQuery = await db.collection('ambassadors').where('code', '==', code).limit(1).get();
      if (ambQuery.empty || ambQuery.docs[0].data().status !== 'active') {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, valid: false }) };
      }
      await db.collection('ambassador_events').add({
        code, type: 'click', created_at: new Date().toISOString(),
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, valid: true }) };
    }

    // ── Rattachement à l'inscription : seuls les NOUVEAUX comptes comptent ──
    // Appelé juste après createUserWithEmailAndPassword côté client, avec le
    // code ambassadeur trouvé dans le cookie/localStorage.
    if (action === 'trackSignup') {
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non authentifié.' }) };
      }
      const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
      const uid = decoded.uid;
      const { code } = body;
      if (!code) return { statusCode: 400, headers, body: JSON.stringify({ error: 'code requis' }) };

      const userRef = db.collection('users').doc(uid);
      const userSnap = await userRef.get();
      if (!userSnap.exists) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Utilisateur introuvable' }) };

      // Blocage : si ambassadorRef est déjà rempli, le compte a déjà été
      // rattaché (à l'inscription) — un ré-attachement ultérieur est refusé,
      // évite le risque de "reparrainage" a posteriori.
      if (userSnap.data().ambassadorRef) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, attached: false, msg: 'Compte déjà rattaché.' }) };
      }

      const ambQuery = await db.collection('ambassadors').where('code', '==', code).limit(1).get();
      if (ambQuery.empty || ambQuery.docs[0].data().status !== 'active') {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, attached: false, msg: 'Code invalide ou inactif.' }) };
      }
      const ambassadorUid = ambQuery.docs[0].id;

      // Anti-auto-parrainage par compte, email ou téléphone.
      const ambassadorUserSnap = await db.collection('users').doc(ambassadorUid).get();
      const ambassadorUser = ambassadorUserSnap.exists ? (ambassadorUserSnap.data() || {}) : {};
      const normEmail = v => String(v || '').trim().toLowerCase();
      const normPhone = v => String(v || '').replace(/[^0-9]/g, '');
      const sameIdentity = ambassadorUid === uid
        || (normEmail(ambassadorUser.email) && normEmail(ambassadorUser.email) === normEmail(userSnap.data().email))
        || (normPhone(ambassadorUser.phone || ambassadorUser.telephone || ambassadorUser.tel) && normPhone(ambassadorUser.phone || ambassadorUser.telephone || ambassadorUser.tel) === normPhone(userSnap.data().phone || userSnap.data().telephone || userSnap.data().tel));
      if (sameIdentity) {
        return { statusCode: 200, headers, body: JSON.stringify({ ok: true, attached: false, msg: 'Auto-parrainage refusé.' }) };
      }

      await userRef.update({ ambassadorRef: code, ambassadorRefSetAt: new Date().toISOString() });
      await db.collection('ambassador_events').add({
        code, type: 'signup', referred_user_id: uid, created_at: new Date().toISOString(),
      });
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, attached: true }) };
    }

    // ── Mon statut ambassadeur (dashboard minimal) ──
    if (action === 'myStatus') {
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non authentifié.' }) };
      }
      const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
      const uid = decoded.uid;
      const ambSnap = await db.collection('ambassadors').doc(uid).get();
      if (!ambSnap.exists) return { statusCode: 200, headers, body: JSON.stringify({ ok: true, status: null }) };
      const ambData = ambSnap.data();

      let clicks = 0, signups = 0, paid = 0, due = 0, paidAmount = 0;
      if (ambData.code) {
        const evSnap = await db.collection('ambassador_events').where('code', '==', ambData.code).get();
        evSnap.forEach(d => {
          const t = d.data().type;
          if (t === 'click') clicks++;
          else if (t === 'signup') signups++;
          else if (t === 'paid') paid++;
        });
        const commSnap = await db.collection('ambassador_commissions').where('ambassador_id', '==', uid).get();
        commSnap.forEach(d => {
          const c = d.data();
          if (c.status === 'due') due += c.commission_amount;
          else if (c.status === 'paid') paidAmount += (c.net_paid_amount ?? c.commission_amount);
        });
      }
      // Solde de clawback restant (remboursements après commission déjà versée,
      // à déduire du prochain versement — voir adminAction.ambassadorMarkCommissionPaid).
      const clawbackBalance = ambData.clawback_balance || 0;
      const netDue = Math.max(0, due - clawbackBalance);
      return {
        statusCode: 200, headers,
        body: JSON.stringify({ ok: true, ...ambData, stats: { clicks, signups, paid, due, netDue, clawbackBalance, paidAmount } }),
      };
    }

    // ── État du recrutement (ouvert / prochaine vague) — public, pas besoin d'auth ──
    if (action === 'recruitmentStatus') {
      const recruitSnap = await db.collection('config').doc('ambassadorRecruitment').get();
      const recruitData = recruitSnap.exists ? recruitSnap.data() : { open: true };
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, open: recruitData.open !== false, nextWave: recruitData.nextWave || null }) };
    }

    // ── Notifications de l'ambassadeur (ex : "commission versée") ──
    if (action === 'myNotifications') {
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non authentifié.' }) };
      }
      const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
      const uid = decoded.uid;
      const notifSnap = await db.collection('ambassador_notifications')
        .where('ambassador_id', '==', uid).orderBy('created_at', 'desc').limit(20).get();
      const notifications = notifSnap.docs.map(d => ({ id: d.id, ...d.data() }));
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, notifications }) };
    }

    // ── Marquer les notifications comme lues ──
    if (action === 'markNotificationsRead') {
      const authHeader = event.headers.authorization || event.headers.Authorization || '';
      if (!authHeader.startsWith('Bearer ')) {
        return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non authentifié.' }) };
      }
      const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
      const uid = decoded.uid;
      const unreadSnap = await db.collection('ambassador_notifications')
        .where('ambassador_id', '==', uid).where('read', '==', false).limit(50).get();
      const batch = db.batch();
      unreadSnap.forEach(d => batch.update(d.ref, { read: true }));
      await batch.commit();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true, updated: unreadSnap.size }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'action invalide' }) };
  } catch (e) {
    console.error('ambassador.js error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
