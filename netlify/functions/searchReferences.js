// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — Recherche de références bibliographiques
// Sources : PubMed (NCBI E-utilities) + Crossref, ou liste insérée manuellement.
// Formats de sortie : Vancouver (défaut) ou APA.
// Variables d'env à configurer sur Netlify :
//   FIREBASE_SERVICE_ACCOUNT (déjà présent pour les autres fonctions)
//   PUBMED_API_KEY   → clé NCBI (augmente la limite de requêtes/s)
//   CROSSREF_EMAIL   → email pro utilisé pour le "polite pool" Crossref
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const REFERENCE_SEARCH_COST = 4; // chimis — ajustable ici sans toucher au reste
const MAX_REFERENCES = 5;

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
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };
  }

  // ── 1. Auth Firebase ─────────────────────────────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token manquant' }) };
  }
  let uid;
  try {
    const decoded = await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1]);
    uid = decoded.uid;
  } catch (e) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token invalide' }) };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch (e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Body invalide' }) }; }

  const theme     = (payload.theme || '').trim();
  const style     = payload.style === 'apa' ? 'apa' : 'vancouver'; // Vancouver par défaut
  const manualRaw = Array.isArray(payload.manualReferences) ? payload.manualReferences : [];
  const manualReferences = manualRaw.map(s => String(s || '').trim()).filter(Boolean).slice(0, MAX_REFERENCES);

  if (!theme && !manualReferences.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Thème ou références manuelles requis' }) };
  }

  // ── 2. Déduction des chimis (même logique transactionnelle que useAICredit) ─
  const FREE_MONTHLY_CREDITS = 10;
  const MS_30_DAYS = 30 * 24 * 60 * 60 * 1000;
  const userRef = db.collection('users').doc(uid);
  let creditsRestants;
  try {
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
      if (credits < REFERENCE_SEARCH_COST) throw new Error(`INSUFFICIENT:${credits}`);
      tx.update(userRef, { credits: admin.firestore.FieldValue.increment(-REFERENCE_SEARCH_COST) });
      return { creditsRestants: credits - REFERENCE_SEARCH_COST };
    });
    creditsRestants = result.creditsRestants;
  } catch (e) {
    if (e.message === 'PLAN_EXPIRED') {
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'plan_expired' }) };
    }
    if (e.message?.startsWith('INSUFFICIENT:')) {
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'insufficient', credits: parseInt(e.message.split(':')[1]) }) };
    }
    console.error('searchReferences credit error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: e.message }) };
  }

  // ── 3. Récupération des références ───────────────────────────────────────
  try {
    let rawRefs = [];

    if (manualReferences.length) {
      // Mode manuel : l'utilisateur fournit déjà ses revues/articles, pas d'appel externe
      rawRefs = manualReferences.map(text => ({ manual: true, text }));
    } else {
      rawRefs = await fetchFromPubMedAndCrossref(theme);
    }

    const formatted = rawRefs.slice(0, MAX_REFERENCES).map((ref, idx) =>
      ref.manual
        ? formatManual(ref.text, idx, style)
        : (style === 'apa' ? formatAPA(ref, idx) : formatVancouver(ref, idx))
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ ok: true, style, references: formatted, creditsRestants }),
    };
  } catch (e) {
    console.error('searchReferences fetch error:', e);
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'search_failed', message: e.message }) };
  }
};

// ── Sources externes ──────────────────────────────────────────────────────────
async function fetchFromPubMedAndCrossref(theme) {
  const results = [];

  // PubMed (prioritaire — cohérent avec le public santé/paramédical)
  try {
    const pubmedRefs = await fetchPubMed(theme, MAX_REFERENCES);
    results.push(...pubmedRefs);
  } catch (e) {
    console.warn('PubMed fetch failed:', e.message);
  }

  // Complète avec Crossref si PubMed n'a pas suffi
  if (results.length < MAX_REFERENCES) {
    try {
      const crossrefRefs = await fetchCrossref(theme, MAX_REFERENCES - results.length);
      results.push(...crossrefRefs);
    } catch (e) {
      console.warn('Crossref fetch failed:', e.message);
    }
  }

  return results;
}

async function fetchPubMed(theme, limit) {
  const apiKey = process.env.PUBMED_API_KEY || '';
  const keySuffix = apiKey ? `&api_key=${encodeURIComponent(apiKey)}` : '';

  const searchUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&retmode=json&retmax=${limit}&sort=relevance&term=${encodeURIComponent(theme)}${keySuffix}`;
  const searchRes = await fetch(searchUrl);
  if (!searchRes.ok) throw new Error('PubMed esearch HTTP ' + searchRes.status);
  const searchData = await searchRes.json();
  const ids = (searchData.esearchresult && searchData.esearchresult.idlist) || [];
  if (!ids.length) return [];

  const summaryUrl = `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&retmode=json&id=${ids.join(',')}${keySuffix}`;
  const summaryRes = await fetch(summaryUrl);
  if (!summaryRes.ok) throw new Error('PubMed esummary HTTP ' + summaryRes.status);
  const summaryData = await summaryRes.json();
  const uids = (summaryData.result && summaryData.result.uids) || [];

  return uids.map(id => {
    const item = summaryData.result[id] || {};
    const doiEntry = (item.articleids || []).find(a => a.idtype === 'doi');
    return {
      manual: false,
      authors: (item.authors || []).map(a => a.name).filter(Boolean),
      title: (item.title || '').replace(/\.$/, ''),
      journal: item.fulljournalname || item.source || '',
      year: (item.pubdate || '').match(/\d{4}/)?.[0] || '',
      volume: item.volume || '',
      issue: item.issue || '',
      pages: item.pages || '',
      doi: doiEntry ? doiEntry.value : '',
    };
  });
}

async function fetchCrossref(theme, limit) {
  const email = process.env.CROSSREF_EMAIL || '';
  const mailtoParam = email ? `&mailto=${encodeURIComponent(email)}` : '';
  const url = `https://api.crossref.org/works?query=${encodeURIComponent(theme)}&rows=${limit}${mailtoParam}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Crossref HTTP ' + res.status);
  const data = await res.json();
  const items = (data.message && data.message.items) || [];

  return items.map(item => ({
    manual: false,
    authors: (item.author || []).map(a => [a.given, a.family].filter(Boolean).join(' ')).filter(Boolean),
    title: (item.title && item.title[0]) || '',
    journal: (item['container-title'] && item['container-title'][0]) || '',
    year: (item.published && item.published['date-parts'] && item.published['date-parts'][0] && item.published['date-parts'][0][0]) || '',
    volume: item.volume || '',
    issue: item.issue || '',
    pages: item.page || '',
    doi: item.DOI || '',
  }));
}

// ── Formatage ──────────────────────────────────────────────────────────────────
function formatAuthorsVancouver(authors) {
  if (!authors || !authors.length) return '';
  const list = authors.slice(0, 6).map(a => a.replace(/\./g, ''));
  let out = list.join(', ');
  if (authors.length > 6) out += ', et al';
  return out;
}

function formatVancouver(ref, idx) {
  const n = idx + 1;
  const authors = formatAuthorsVancouver(ref.authors);
  const parts = [];
  if (authors) parts.push(authors + '.');
  parts.push((ref.title || 'Titre indisponible') + '.');
  if (ref.journal) parts.push(ref.journal + '.');
  let tail = ref.year || '';
  if (ref.volume) tail += (tail ? ';' : '') + ref.volume;
  if (ref.issue) tail += `(${ref.issue})`;
  if (ref.pages) tail += ':' + ref.pages;
  if (tail) parts.push(tail + '.');
  return { number: n, text: `${n}. ${parts.join(' ')}`.replace(/\s+/g, ' ').trim() };
}

function formatAuthorsAPA(authors) {
  if (!authors || !authors.length) return '';
  const fmt = name => {
    const bits = name.trim().split(/\s+/);
    if (bits.length < 2) return name;
    const family = bits[bits.length - 1];
    const initials = bits.slice(0, -1).map(b => b[0].toUpperCase() + '.').join(' ');
    return `${family}, ${initials}`;
  };
  const list = authors.slice(0, 6).map(fmt);
  if (list.length === 1) return list[0];
  return list.slice(0, -1).join(', ') + ', & ' + list[list.length - 1];
}

function formatAPA(ref, idx) {
  const n = idx + 1;
  const authors = formatAuthorsAPA(ref.authors);
  const year = ref.year ? `(${ref.year}).` : '(s.d.).';
  const parts = [];
  if (authors) parts.push(authors + ' ' + year);
  else parts.push(year);
  parts.push((ref.title || 'Titre indisponible') + '.');
  if (ref.journal) {
    let j = ref.journal;
    if (ref.volume) j += `, ${ref.volume}`;
    if (ref.pages) j += `, ${ref.pages}`;
    parts.push(j + '.');
  }
  if (ref.doi) parts.push('https://doi.org/' + ref.doi);
  return { number: n, text: parts.join(' ').replace(/\s+/g, ' ').trim() };
}

function formatManual(text, idx, style) {
  const n = idx + 1;
  return { number: n, text: style === 'vancouver' ? `${n}. ${text}` : text };
}
