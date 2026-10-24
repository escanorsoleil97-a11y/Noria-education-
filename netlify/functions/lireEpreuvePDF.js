// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — lireEpreuvePDF.js
// Sert le contenu d'une épreuve (fichier Cloudinary) à l'étudiant, SANS jamais
// exposer l'URL ni le nom de domaine Cloudinary — tout transite par ce domaine.
// Débite COUT_CONSULTATION chimis à chaque ouverture (transaction atomique,
// même logique de renouvellement/expiration que useAICredit.js).
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
const cloudinary = require('cloudinary').v2;

if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Coût d'une consultation — modifiable ici uniquement
const COUT_CONSULTATION = 1;
const FREE_MONTHLY_CREDITS = 10;
const MS_30_DAYS = 30 * 24 * 60 * 60 * 1000;

// Limite prudente : les fonctions Netlify renvoient la réponse encodée en base64,
// ce qui gonfle la taille d'environ 33%. La limite DURE de Netlify est ~6 Mo de
// réponse : un fichier de 5 Mo devient ~6,7 Mo une fois encodé → la réponse est
// TRONQUÉE et pdf.js n'arrive plus à ouvrir le PDF ("le PDF refuse de s'afficher").
// On plafonne donc à 4 Mo de fichier brut (≈ 5,3 Mo encodés), ce qui reste sous
// la limite. Pour les épreuves scannées plus lourdes, voir la note en bas de fichier.
const MAX_BYTES = 4 * 1024 * 1024; // 4 Mo (marge de sécurité sous la limite Netlify)

exports.handler = async (event) => {
const _origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const _allowed = [process.env.SITE_ORIGIN, process.env.URL, process.env.DEPLOY_URL, process.env.DEPLOY_PRIME_URL,
    'https://stat-analyse-pro.netlify.app','https://pstat-pro-all.netlify.app','https://statanalyse-pro.netlify.app']
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
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Expose-Headers': 'X-Credits-Remaining, X-Deja-Paye',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'GET') {
    return { statusCode: 405, headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  const jsonHeaders = { ...headers, 'Content-Type': 'application/json' };

  try {
    // ── 1. Authentification étudiant ──
    const authHeader = event.headers.authorization || event.headers.Authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      return { statusCode: 401, headers: jsonHeaders, body: JSON.stringify({ error: 'Token manquant' }) };
    }
    const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    const uid = decoded.uid;

    const epreuveId = event.queryStringParameters?.id;
    if (!epreuveId) {
      return { statusCode: 400, headers: jsonHeaders, body: JSON.stringify({ error: 'Identifiant manquant' }) };
    }

    // ── 2. Charger le document épreuve ──
    const epRef = db.collection('epreuvesPDF').doc(epreuveId);
    const epSnap = await epRef.get();
    if (!epSnap.exists || epSnap.data()?.active === false) {
      return { statusCode: 404, headers: jsonHeaders, body: JSON.stringify({ error: 'Épreuve introuvable ou inactive' }) };
    }
    const ep = epSnap.data();
    if (!ep.publicId || !ep.resourceType) {
      return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: 'Fichier mal configuré côté admin' }) };
    }

    // ── 3. Débiter les chimis : 1 chimis débloque l'accès illimité pour le mois en cours ──
    const userRef = db.collection('users').doc(uid);
    const moisCourant = new Date().toISOString().slice(0,7); // "2026-07"
    const result = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error('Utilisateur introuvable');
      const data = snap.data();
      let credits = data.credits ?? 0;
      const now = Date.now();

      if (data.plan && data.plan !== 'gratuit' && data.planExpiry) {
        const expiry = new Date(data.planExpiry).getTime();
        if (expiry < now) {
          tx.update(userRef, { plan: 'gratuit', planExpiry: null });
          throw new Error('PLAN_EXPIRED');
        }
      }
      if (data.plan === 'gratuit' || !data.plan) {
        const lastRenew = data.lastFreeCreditAt ? new Date(data.lastFreeCreditAt).getTime() : 0;
        if (now - lastRenew >= MS_30_DAYS) {
          credits = FREE_MONTHLY_CREDITS;
          tx.update(userRef, { credits, lastFreeCreditAt: new Date().toISOString() });
        }
      }
      // Accès déjà payé ce mois-ci : pas de nouveau débit
      if (data.pdfAccessMonth === moisCourant) {
        return { creditsRestants: credits, dejaPaye: true };
      }
      if (credits < COUT_CONSULTATION) throw new Error(`INSUFFICIENT:${credits}`);
      tx.update(userRef, { credits: admin.firestore.FieldValue.increment(-COUT_CONSULTATION), pdfAccessMonth: moisCourant });
      return { creditsRestants: credits - COUT_CONSULTATION, dejaPaye: false };
    });

    // ── 4. Générer l'URL Cloudinary signée et récupérer les octets ──
    // Un 404 vient presque toujours d'un décalage sur l'extension (le public_id
    // "raw" contient parfois déjà .pdf, parfois non) ou sur la version. Plutôt que
    // de deviner, on construit plusieurs variantes plausibles et on prend la
    // PREMIÈRE qui renvoie 200. Robuste quelle que soit la façon dont l'épreuve
    // a été uploadée côté admin.
    const rt  = ep.resourceType || 'raw';
    const pid = ep.publicId;
    const fmt = (ep.format || 'pdf').toLowerCase();
    const hasExt = /\.[a-z0-9]{2,5}$/i.test(pid);
    const pidNoExt = pid.replace(/\.[a-z0-9]{2,5}$/i, '');
    const base = { resource_type: rt, type: 'authenticated', sign_url: true, secure: true };
    const withV = ep.version ? { version: ep.version } : {};

    const candidates = [];
    // (a) public_id tel quel, avec version
    candidates.push(cloudinary.url(pid, { ...base, ...withV }));
    // (b) public_id tel quel, sans version
    if (ep.version) candidates.push(cloudinary.url(pid, { ...base }));
    // (c) si pas d'extension dans le public_id → on ajoute le format
    if (!hasExt) {
      candidates.push(cloudinary.url(pid, { ...base, format: fmt, ...withV }));
      if (ep.version) candidates.push(cloudinary.url(pid, { ...base, format: fmt }));
    }
    // (d) si extension présente → variante sans extension + format (cas image/video)
    if (hasExt) {
      candidates.push(cloudinary.url(pidNoExt, { ...base, format: fmt, ...withV }));
    }
    const deliveryUrls = [...new Set(candidates)];

    let fileResp = null;
    let lastStatus = 0;
    for (const url of deliveryUrls) {
      const r = await fetch(url);
      if (r.ok) { fileResp = r; break; }
      lastStatus = r.status;
      console.warn('Cloudinary variante KO:', r.status, url);
    }
    if (!fileResp) {
      console.error('Toutes les variantes Cloudinary ont échoué. Dernier statut:', lastStatus, 'publicId=', pid, 'version=', ep.version, 'format=', ep.format, 'resourceType=', ep.resourceType);
      return { statusCode: 502, headers: jsonHeaders, body: JSON.stringify({ error: `Fichier introuvable sur le serveur de stockage (code ${lastStatus}). L'épreuve a peut-être été mal enregistrée : re-téléverse-la depuis l'espace admin.` }) };
    }
    const arrayBuffer = await fileResp.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_BYTES) {
      const mo = (arrayBuffer.byteLength / 1024 / 1024).toFixed(1);
      return { statusCode: 413, headers: jsonHeaders, body: JSON.stringify({ error: `Épreuve trop lourde (${mo} Mo) pour l'affichage sécurisé (max 4 Mo). Recompressez le PDF ou re-scannez en plus basse résolution avant de le remettre en ligne.` }) };
    }
    const base64 = Buffer.from(arrayBuffer).toString('base64');

    const MIME_BY_FORMAT = {
      pdf:  'application/pdf',
      doc:  'application/msword',
      docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    const formatReel = (ep.format || 'pdf').toLowerCase();
    const contentType = MIME_BY_FORMAT[formatReel] || 'application/octet-stream';

    // ── 5. Renvoyer le fichier sous NOTRE domaine, jamais celui de Cloudinary ──
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Content-Type': contentType,
        'Content-Disposition': `inline; filename="epreuve.${formatReel}"`,
        'X-Credits-Remaining': String(result.creditsRestants),
        'X-Deja-Paye': String(!!result.dejaPaye),
      },
      body: base64,
      isBase64Encoded: true,
    };

  } catch (e) {
    if (e.message === 'PLAN_EXPIRED') {
      return { statusCode: 402, headers: jsonHeaders, body: JSON.stringify({ error: 'plan_expired', message: 'Votre abonnement a expiré.' }) };
    }
    if (e.message?.startsWith('INSUFFICIENT:')) {
      const credits = parseInt(e.message.split(':')[1]);
      return { statusCode: 402, headers: jsonHeaders, body: JSON.stringify({ error: 'insufficient', credits }) };
    }
    console.error('lireEpreuvePDF error:', e);
    return { statusCode: 500, headers: jsonHeaders, body: JSON.stringify({ error: e.message }) };
  }
};
