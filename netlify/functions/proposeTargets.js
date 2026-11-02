// ══════════════════════════════════════════════════════════════════════════════
// Noria — Proposition des variables cibles (thème / objectifs → variable dépendante)
// Flux : 1) le navigateur essaie d'abord une détection locale (gratuite en API) ;
//        2) s'il n'y arrive pas, ce serveur interroge l'IA.
// Facturation : DANS LES DEUX CAS un débit de chimis est fait ici, côté serveur.
//   - détection locale réussie  → LOCAL_COST chimi(s), aucun appel IA
//   - secours IA                → AI_COST chimis, remboursés si l'IA échoue
// Le coût n'est jamais fourni par le client. Un client qui prétend avoir réussi
// en local ne gagne rien : il paie le tarif local et n'obtient aucun appel IA.
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const LOCAL_COST = 1;   // détection par le navigateur validée
const AI_COST = 3;      // analyse IA de secours (appel API payant)
const FREE_MONTHLY_CREDITS = 10;
const MS_30_DAYS = 30 * 24 * 60 * 60 * 1000;
const MAX_VARS = 150;

exports.handler = async (event) => {
  const _origin = (event.headers && (event.headers.origin || event.headers.Origin)) || '';
  const _allowed = [process.env.SITE_ORIGIN, process.env.URL, process.env.DEPLOY_URL, process.env.DEPLOY_PRIME_URL,
    'https://stat-analyse-pro.netlify.app','https://pstat-pro-all.netlify.app','https://statanalyse-pro.netlify.app','https://noria-education.pages.dev']
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
  };
  const reply = (code, obj) => ({ statusCode: code, headers, body: JSON.stringify(obj) });

  if (event.httpMethod === 'OPTIONS') return { statusCode: 204, headers, body: '' };
  if (event.httpMethod !== 'POST') return reply(405, { error: 'Méthode non autorisée' });

  // ── AUTH ──
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) return reply(401, { error: 'Token manquant' });
  let uid;
  try { uid = (await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1])).uid; }
  catch (e) { return reply(401, { error: 'Token invalide ou expiré' }); }

  // ── ENTRÉE ──
  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return reply(400, { error: 'JSON invalide' }); }
  const clip = (v, n) => String(v == null ? '' : v).slice(0, n);
  const theme = clip(body.theme, 600).trim();
  const generalObjective = clip(body.generalObjective, 800).trim();
  const specificObjectives = clip(body.specificObjectives, 1500).trim();
  const varsExactes = clip(body.varsExactes, 12000);
  const variableNames = Array.isArray(body.variableNames) ? body.variableNames.map(v => String(v)).slice(0, MAX_VARS) : [];
  const localOk = body.localOk === true;
  const localPick = clip(body.localPick, 200);

  if (!variableNames.length) return reply(400, { error: 'variableNames manquant' });
  if (!theme && !generalObjective && !specificObjectives) {
    return reply(400, { error: 'Renseignez le thème ou les objectifs avant de lancer la proposition.' });
  }
  if (localOk && !variableNames.includes(localPick)) {
    return reply(400, { error: 'Variable locale inconnue.' });
  }
  if (!localOk && !varsExactes) return reply(400, { error: 'varsExactes manquant' });

  const cost = localOk ? LOCAL_COST : AI_COST;

  // ── 1) DÉBIT ATOMIQUE (avant tout appel IA) ──
  const userRef = db.collection('users').doc(uid);
  let creditsRestants;
  try {
    creditsRestants = await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error('Utilisateur introuvable');
      const data = snap.data();
      const now = Date.now();
      let credits = data.credits ?? 0;

      const lastCall = data.lastAICallAt ? new Date(data.lastAICallAt).getTime() : 0;
      if (now - lastCall < 3000) throw new Error('RATELIMIT');

      if (data.plan && data.plan !== 'gratuit' && data.planExpiry) {
        if (new Date(data.planExpiry).getTime() < now) {
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
      if (credits < cost) throw new Error(`INSUFFICIENT:${credits}`);

      const cutoff48h = now - 48 * 60 * 60 * 1000;
      let usageLog = (Array.isArray(data.usageLog) ? data.usageLog : []).filter(e => e && e.ts >= cutoff48h);
      usageLog.push({ ts: now, cost });
      usageLog = usageLog.slice(-60);

      tx.update(userRef, {
        credits: admin.firestore.FieldValue.increment(-cost),
        lastAICallAt: new Date().toISOString(),
        usageLog,
      });
      return credits - cost;
    });
  } catch (e) {
    if (e.message === 'RATELIMIT') return reply(429, { error: 'ratelimit', message: 'Trop de requêtes — attendez quelques secondes' });
    if (e.message === 'PLAN_EXPIRED') return reply(402, { error: 'plan_expired', message: 'Votre abonnement a expiré.' });
    if (e.message && e.message.startsWith('INSUFFICIENT:')) return reply(402, { error: 'insufficient', credits: parseInt(e.message.split(':')[1], 10), cost });
    console.error('proposeTargets debit error:', e);
    return reply(500, { error: 'Erreur de débit des chimis.' });
  }

  // Trace du débit (audit + garantit un remboursement unique)
  let chargeRef = null;
  try {
    chargeRef = await db.collection('aiCharges').add({
      uid, cost, ts: Date.now(), refunded: false, kind: localOk ? 'targets_local' : 'targets_ai',
      expireAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
    });
  } catch (e) { console.warn('aiCharges write failed:', e.message); }

  async function refund() {
    try {
      await db.runTransaction(async (tx) => {
        if (chargeRef) {
          const c = await tx.get(chargeRef);
          if (!c.exists || c.data().refunded) return;
          tx.update(chargeRef, { refunded: true, refundedAt: Date.now() });
        }
        tx.update(userRef, { credits: admin.firestore.FieldValue.increment(cost) });
      });
      return true;
    } catch (e) { console.error('proposeTargets refund failed:', e); return false; }
  }

  // ── 2a) DÉTECTION LOCALE VALIDÉE : pas d'appel IA ──
  if (localOk) {
    return reply(200, { ok: true, mode: 'local', variable_dependante: localPick, charged: cost, creditsRestants });
  }

  // ── 2b) SECOURS IA ──
  const prompt = buildPrompt({ theme, generalObjective, specificObjectives, varsExactes });
  const valid = new Set(variableNames);

  async function runCascadeOnce() {
    const cascade = [callDeepSeek, callCerebras, callGroq, callGemini, callMistral, callClaude];
    let lastErr = null;
    for (const call of cascade) {
      try {
        const text = await call(prompt);
        const m = text.replace(/```json|```/g, '').trim().match(/\{[\s\S]*\}/);
        if (!m) throw new Error('Pas de JSON trouvé dans la réponse');
        return JSON.parse(m[0]);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Aucun fournisseur IA disponible.');
  }

  try {
    let result = await runCascadeOnce();
    if (result && !valid.has(result.variable_dependante)) {
      try { result = await runCascadeOnce(); } catch (e) { /* on garde le premier résultat */ }
    }
    if (!result || !valid.has(result.variable_dependante)) {
      const refunded = await refund();
      return reply(502, { error: "L'IA n'a pas retourné un nom de variable exact.", refunded, ...(refunded ? { creditsRestants: creditsRestants + cost } : {}) });
    }
    const second = valid.has(result.deuxieme_variable) && result.deuxieme_variable !== result.variable_dependante ? result.deuxieme_variable : '';
    return reply(200, {
      ok: true, mode: 'ai', charged: cost, creditsRestants,
      variable_dependante: result.variable_dependante,
      deuxieme_variable: second,
      justification: clip(result.justification, 1500),
      variables_independantes_suggerees: (Array.isArray(result.variables_independantes_suggerees) ? result.variables_independantes_suggerees : []).filter(v => valid.has(v)).slice(0, 12),
    });
  } catch (e) {
    const refunded = await refund();
    return reply(502, { error: e.message || 'Erreur IA.', refunded, ...(refunded ? { creditsRestants: creditsRestants + cost } : {}) });
  }
};

function buildPrompt({ theme, generalObjective, specificObjectives, varsExactes }) {
  return `Biostatisticien expert. Tu aides à choisir la variable dépendante d'une étude.
THÈME : "${theme || 'non précisé'}"
OBJECTIF GÉNÉRAL : "${generalObjective || 'non précisé'}"
OBJECTIFS SPÉCIFIQUES : "${specificObjectives || 'non précisés'}"

VARIABLES DISPONIBLES (utilise UNIQUEMENT ces noms exacts, avec leur résumé réel) :
${varsExactes}

RÈGLES ABSOLUES :
1. "variable_dependante" = nom COPIÉ mot pour mot depuis la liste (casse et accents exacts).
2. Choisis la variable qui mesure directement le résultat visé par le thème et les objectifs. Ne la choisis JAMAIS uniquement parce qu'une modalité domine ; évite les identifiants et les variables très manquantes.
3. "deuxieme_variable" = une seconde candidate facultative (nom exact) ou chaîne vide.
4. "variables_independantes_suggerees" = au plus 8 noms exacts de facteurs explicatifs plausibles.
5. "justification" = 3 à 4 phrases, reliées aux objectifs, sans inventer de résultats.

JSON STRICT, aucun texte autour :
{"variable_dependante":"NomExact","deuxieme_variable":"","justification":"...","variables_independantes_suggerees":["Var1","Var2"]}`;
}

// ── APPELS PROVIDERS (identiques à generateAcademicText.js) ──────────────────
// Essaie chaque clé DANS L'ORDRE (1, 2, 3...) et passe à la suivante
// uniquement en cas d'échec (clé invalide, quota épuisé, rate limit).
async function tryKeysInOrder(keys, callFn) {
  if (!keys.length) throw new Error('NO_KEY');
  let lastErr;
  for (const key of keys) {
    try { return await callFn(key); } catch (err) { lastErr = err; }
  }
  throw lastErr;
}

// Scanne dynamiquement TOUTES les variables d'env correspondant à un préfixe
// donné (ex. "GROQ_KEY") — nombre de clés illimité (GROQ_KEY_1 ... GROQ_KEY_N).
function collectKeys(...prefixes) {
  const found = [];
  for (const prefix of prefixes) {
    const numbered = [];
    for (const [envName, value] of Object.entries(process.env)) {
      if (!value) continue;
      const m = envName.match(new RegExp(`^${prefix}_(\\d+)$`));
      if (m) numbered.push([parseInt(m[1], 10), value]);
    }
    numbered.sort((a, b) => a[0] - b[0]);
    for (const [, value] of numbered) found.push(value);
    if (process.env[prefix]) found.push(...String(process.env[prefix]).split(',').map(s => s.trim()).filter(Boolean));
  }
  return found;
}

async function callGroq(prompt) {
  const keys = collectKeys('GROQ_KEY');
  if (!keys.length) throw new Error('Aucune GROQ_KEY configurée');
  return tryKeysInOrder(keys, async (key) => {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Erreur Groq');
    return json.choices[0].message.content;
  });
}

async function callDeepSeek(prompt) {
  const keys = collectKeys('DEEPSEEK_KEY', 'DEEPSEEK_API_KEY');
  if (!keys.length) throw new Error('Aucune DEEPSEEK_KEY configurée');
  return tryKeysInOrder(keys, async (key) => {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash', messages: [{ role: 'user', content: prompt }], max_tokens: 1024, thinking: { type: 'disabled' } }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Erreur DeepSeek');
    return json.choices[0].message.content;
  });
}

async function callGemini(prompt) {
  // Accepte GEMINI_KEY_* (nom historique) ET GEMINI_API_KEY_* (nom
  // actuellement configuré sur Netlify), nombre de clés illimité.
  const keys = collectKeys('GEMINI_KEY', 'GEMINI_API_KEY');
  if (!keys.length) throw new Error('Aucune GEMINI_KEY configurée');
  return tryKeysInOrder(keys, async (key) => {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent?key=${key}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 1024 } }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Erreur Gemini');
    return json.candidates[0].content.parts[0].text;
  });
}

async function callCerebras(prompt) {
  const keys = collectKeys('CEREBRAS_KEY');
  if (!keys.length) throw new Error('Aucune CEREBRAS_KEY configurée');
  return tryKeysInOrder(keys, async (key) => {
    const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Erreur Cerebras');
    return json.choices[0].message.content;
  });
}

async function callMistral(prompt) {
  const keys = collectKeys('MISTRAL_KEY');
  if (!keys.length) throw new Error('Aucune MISTRAL_KEY configurée');
  return tryKeysInOrder(keys, async (key) => {
    const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }], max_tokens: 1024 }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || 'Erreur Mistral');
    return json.choices[0].message.content;
  });
}

async function callClaude(prompt) {
  const key = process.env.CLAUDE_KEY;
  if (!key) throw new Error('Aucune CLAUDE_KEY configurée');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'claude-3-5-haiku-latest', max_tokens: 1024, messages: [{ role: 'user', content: prompt }] }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Erreur Claude');
  return json.content[0].text;
}
