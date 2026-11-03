// ══════════════════════════════════════════════════════════════════════════════
// Noria Statistique — « Mes questionnaires publiés » (server-side)
//   action "list"      : retrouve TOUS les questionnaires publiés par l'utilisateur
//                        (lien répondant, token admin, nombre de réponses), quel que
//                        soit l'appareil utilisé pour publier.
//   action "republish" : met à jour le titre / les questions d'un questionnaire déjà
//                        publié en CONSERVANT le même lien et le même token admin.
// Le token admin n'est jamais exposé publiquement : il n'est renvoyé qu'au
// propriétaire authentifié (owner_uid), via l'Admin SDK.
// Lecture seule pour "list" ; aucun chimi débité.
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const MAX_ITEMS = 100;
const MAX_VARS_LEN = 500000;

exports.handler = async (event) => {
  const _origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const _allowed = [process.env.SITE_ORIGIN, process.env.URL, process.env.DEPLOY_URL, process.env.DEPLOY_PRIME_URL,
    'https://stat-analyse-pro.netlify.app', 'https://pstat-pro-all.netlify.app', 'https://statanalyse-pro.netlify.app', 'https://noria-education.pages.dev']
    .filter(Boolean).join(',').split(',').map(s => s.trim().replace(/\/$/, '')).filter(Boolean);
  const _originNorm = _origin.replace(/\/$/, '');
  const _allow = (_originNorm && _allowed.includes(_originNorm)) ? _originNorm : (_allowed[0] || 'https://pstat-pro-all.netlify.app');
  if (_originNorm && !_allowed.includes(_originNorm)) {
    return { statusCode: 403, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': _allow }, body: JSON.stringify({ error: 'Origine non autorisée.' }) };
  }
  const headers = {
    'Access-Control-Allow-Origin': _allow,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  };
  const reply = (statusCode, obj) => ({ statusCode, headers, body: JSON.stringify(obj) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Méthode non autorisée' });

  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  const idToken = authHeader.replace(/^Bearer\s+/i, '');
  if (!idToken) return reply(401, { error: 'Non authentifié.' });
  let uid;
  try { uid = (await admin.auth().verifyIdToken(idToken)).uid; }
  catch (e) { return reply(401, { error: 'Session invalide ou expirée.' }); }

  const raw = event.body || '';
  if (typeof raw !== 'string' || raw.length > 700000) return reply(413, { error: 'Requête trop volumineuse' });
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { return reply(400, { error: 'JSON invalide' }); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) return reply(400, { error: 'JSON objet attendu' });

  try {
    // ── LISTE ─────────────────────────────────────────────────────────────
    if (body.action === 'list') {
      const adminSnap = await db.collection('questionnaire_admin').where('owner_uid', '==', uid).limit(MAX_ITEMS).get();
      const rows = adminSnap.docs.map(d => ({ qid: d.id, adminToken: d.data().admin_token, createdAt: d.data().created_at || '' }));
      const items = await Promise.all(rows.map(async (r) => {
        let title = 'Questionnaire', nVars = 0, visible = true;
        try {
          const q = await db.collection('questionnaires').doc(r.qid).get();
          if (q.exists) {
            const qd = q.data();
            title = qd.title || title;
            try { const arr = JSON.parse(qd.variables || '[]'); nVars = Array.isArray(arr) ? arr.length : 0; } catch (e) { /* ignore */ }
            visible = !(qd.settings && qd.settings.isVisible === false);
          } else { return null; } // questionnaire supprimé
        } catch (e) { /* ignore */ }
        let responses = null;
        try {
          const rq = db.collection('responses').where('questionnaire_id', '==', r.qid);
          if (typeof rq.count === 'function') { const c = await rq.count().get(); responses = c.data().count; }
          else { const s = await rq.select().limit(5000).get(); responses = s.size; }
        } catch (e) { responses = null; }
        return { qid: r.qid, adminToken: r.adminToken, createdAt: r.createdAt, title, nVars, visible, responses };
      }));
      const clean = items.filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
      return reply(200, { ok: true, items: clean });
    }

    // ── REPUBLIER (même lien, même token) ─────────────────────────────────
    if (body.action === 'republish') {
      const qid = body.qid;
      if (typeof qid !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(qid)) return reply(400, { error: 'qid invalide.' });
      const own = await db.collection('questionnaire_admin').doc(qid).get();
      if (!own.exists || own.data().owner_uid !== uid) return reply(403, { error: 'Ce questionnaire ne vous appartient pas.' });
      const patch = { updated_at: new Date().toISOString() };
      if (body.title !== undefined) {
        if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 500) return reply(400, { error: 'Titre invalide.' });
        patch.title = body.title.trim();
      }
      if (body.variables !== undefined) {
        const vs = typeof body.variables === 'string' ? body.variables : JSON.stringify(body.variables || []);
        if (vs.length > MAX_VARS_LEN) return reply(400, { error: 'Variables trop volumineuses.' });
        let arr; try { arr = JSON.parse(vs); } catch (e) { return reply(400, { error: 'Variables invalides.' }); }
        if (!Array.isArray(arr) || !arr.length) return reply(400, { error: 'Aucune variable à publier.' });
        patch.variables = vs;
      }
      if (Object.keys(patch).length === 1) return reply(400, { error: 'Rien à mettre à jour.' });
      await db.collection('questionnaires').doc(qid).update(patch);
      return reply(200, { ok: true, qid });
    }

    return reply(400, { error: 'action invalide (list|republish)' });
  } catch (e) {
    console.error('myQuestionnaires:', e && e.message);
    return reply(500, { error: 'Erreur serveur.' });
  }
};
