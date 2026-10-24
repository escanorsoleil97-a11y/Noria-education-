// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — Gestion des bases de données sauvegardées (server-side)
// Actions : save | list | load | update | delete
// Toujours gaté par le token Firebase de l'utilisateur — chacun ne voit/modifie
// que ses propres bases. Aucun accès direct client à Firestore pour cette
// collection (règle recommandée : allow read, write: if false).
// Protections additionnelles (alignées sur pharmacy.js / commercial.js) :
// origine autorisée, App Check (si REQUIRE_APP_CHECK=true), rate limiting IP.
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();
const sec = require('./_security');

const MAX_ROWS = 20000;      // garde-fou taille (mémoire Firestore : 1 Mo/document)
const MAX_NAME_LEN = 120;

// Rate limit IP en mémoire (même approche que proxy.js / pharmacy.js) :
// défense de surface par instance, 60 req/min/IP pour cette fonction CRUD.
const _ipCalls = new Map();
function checkIpRateLimit(ip) {
  const now = Date.now();
  const window = 60000; // 1 minute
  const maxReq = 60;
  const recent = (_ipCalls.get(ip) || []).filter(t => now - t < window);
  if (recent.length >= maxReq) return false;
  recent.push(now);
  _ipCalls.set(ip, recent);
  return true;
}

exports.handler = async (event) => {
  let origin = '';
  try {
    origin = sec.assertOrigin(event);
  } catch (e) {
    return { statusCode: e.status || 403, headers: sec.securityHeaders(sec.originOf(event)), body: JSON.stringify({ error: e.message }) };
  }
  if (event.httpMethod === 'OPTIONS') return sec.preflight(event);

  const headers = sec.securityHeaders(origin);
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  const ip = event.headers?.['x-forwarded-for']?.split(',')[0]?.trim() || event.headers?.['client-ip'] || 'unknown';
  if (!checkIpRateLimit(ip)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Trop de requêtes, réessayez dans une minute.' }) };
  }

  let uid;
  try {
    await sec.verifyAppCheck(event);
    uid = (await sec.verifyAuth(event)).uid;
  } catch (e) {
    return { statusCode: e.status || 401, headers, body: JSON.stringify({ error: e.message || 'Authentification invalide' }) };
  }

  let body;
  try { body = sec.body(event, 3000000); } catch (e) { return { statusCode: e.status || 400, headers, body: JSON.stringify({ error: e.message || 'JSON invalide' }) }; }
  const { action } = body;
  const col = db.collection('savedDatabases');

  try {
    if (action === 'save') {
      const { name, data, cols } = body;
      if (!Array.isArray(data) || !Array.isArray(cols)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'data/cols invalides' }) };
      }
      if (data.length > MAX_ROWS) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Trop de lignes (max ${MAX_ROWS}).` }) };
      }
      const safeName = String(name || 'Base sans nom').substring(0, MAX_NAME_LEN);
      const docRef = await col.add({
        uid, name: safeName,
        dataJSON: JSON.stringify(data), colsJSON: JSON.stringify(cols),
        nbLignes: data.length, nbVariables: cols.length,
        createdAt: Date.now(), updatedAt: Date.now(),
      });
      return { statusCode: 200, headers, body: JSON.stringify({ id: docRef.id }) };
    }

    if (action === 'list') {
      const snap = await col.where('uid', '==', uid).get();
      const items = snap.docs
        .map(d => ({ id: d.id, name: d.data().name, nbLignes: d.data().nbLignes, nbVariables: d.data().nbVariables, updatedAt: d.data().updatedAt }))
        .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
      return { statusCode: 200, headers, body: JSON.stringify({ items }) };
    }

    if (action === 'load') {
      const { id } = body;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id manquant' }) };
      const doc = await col.doc(id).get();
      if (!doc.exists || doc.data().uid !== uid) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Base introuvable.' }) };
      }
      const d = doc.data();
      return { statusCode: 200, headers, body: JSON.stringify({ name: d.name, data: JSON.parse(d.dataJSON), cols: JSON.parse(d.colsJSON) }) };
    }

    if (action === 'update') {
      const { id, name, data, cols } = body;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id manquant' }) };
      const doc = await col.doc(id).get();
      if (!doc.exists || doc.data().uid !== uid) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Base introuvable.' }) };
      }
      if (!Array.isArray(data) || !Array.isArray(cols)) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: 'data/cols invalides' }) };
      }
      if (data.length > MAX_ROWS) {
        return { statusCode: 400, headers, body: JSON.stringify({ error: `Trop de lignes (max ${MAX_ROWS}).` }) };
      }
      const update = {
        dataJSON: JSON.stringify(data), colsJSON: JSON.stringify(cols),
        nbLignes: data.length, nbVariables: cols.length, updatedAt: Date.now(),
      };
      if (name) update.name = String(name).substring(0, MAX_NAME_LEN);
      await col.doc(id).update(update);
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'delete') {
      const { id } = body;
      if (!id) return { statusCode: 400, headers, body: JSON.stringify({ error: 'id manquant' }) };
      const doc = await col.doc(id).get();
      if (!doc.exists || doc.data().uid !== uid) {
        return { statusCode: 404, headers, body: JSON.stringify({ error: 'Base introuvable.' }) };
      }
      await col.doc(id).delete();
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'action invalide (save|list|load|update|delete)' }) };
  } catch (e) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message || 'Erreur serveur.' }) };
  }
};
