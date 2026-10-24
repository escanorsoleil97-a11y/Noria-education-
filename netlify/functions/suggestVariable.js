// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — Suggestion de variable dépendante par IA (server-side)
// Construit le prompt côté serveur (invisible dans le code client), appelle la
// cascade de fournisseurs, valide et parse le JSON retourné, avec une tentative
// de retry si le nom de variable renvoyé ne correspond à aucune variable réelle.
// Gratuit comme avant : aucune déduction de chimis (comportement inchangé).
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
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  // ── AUTH ─────────────────────────────────────────────────────────────────
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non authentifié — token manquant' }) };
  }
  let uid;
  try {
    uid = (await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1])).uid;
  } catch (e) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token invalide ou expiré' }) };
  }

  // Cette fonctionnalité est gratuite et ne débite pas de chimis : elle ne doit
  // pas être bloquée lorsque le solde de l'utilisateur est nul.

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON invalide' }) }; }

  const { theme, context, varsExactes, variableNames } = body;
  if (!theme || typeof theme !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'theme manquant' }) };
  }
  if (!varsExactes || typeof varsExactes !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'varsExactes manquant' }) };
  }
  if (!Array.isArray(variableNames) || !variableNames.length) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'variableNames manquant' }) };
  }

  const prompt = buildPrompt({ theme, context, varsExactes });
  const nomsValides = new Set(variableNames);

  async function runCascadeOnce() {
    const cascade = [callDeepSeek, callCerebras, callGroq, callGemini, callMistral, callClaude];
    let lastErr = null;
    for (const call of cascade) {
      try {
        const text = await call(prompt);
        const clean = text.replace(/```json|```/g, '').trim();
        const match = clean.match(/\{[\s\S]*\}/);
        if (!match) throw new Error('Pas de JSON trouvé dans la réponse');
        return JSON.parse(match[0]);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error('Aucun fournisseur IA disponible.');
  }

  try {
    let result = await runCascadeOnce();

    // Retry unique si le nom de variable renvoyé n'est pas exact (même logique
    // que l'ancien code client : un seul passage de cascade supplémentaire).
    if (result && !nomsValides.has(result.variable_dependante)) {
      try { result = await runCascadeOnce(); } catch (e) { /* on garde le résultat précédent */ }
    }

    if (!result || !nomsValides.has(result.variable_dependante)) {
      return { statusCode: 502, headers, body: JSON.stringify({ error: "L'IA n'a pas retourné un nom de variable exact après vérification." }) };
    }

    return { statusCode: 200, headers, body: JSON.stringify(result) };
  } catch (e) {
    return { statusCode: 502, headers, body: JSON.stringify({ error: e.message || 'Erreur IA.' }) };
  }
};

// ── CONSTRUCTION DU PROMPT (portage exact depuis le client) ──────────────────
function buildPrompt({ theme, context, varsExactes }) {
  const contextLabel = context === 'reg'
    ? 'régression (modélisation statistique)'
    : 'analyse bivariée (tableaux croisés, tests statistiques)';

  return `Biostatisticien expert. Étude : "${theme}". Analyse : ${contextLabel}.

VARIABLES DISPONIBLES (utilise UNIQUEMENT ces noms exacts, avec leur résumé statistique réel) :
${varsExactes}

RÈGLES ABSOLUES :
1. "variable_dependante" = nom COPIÉ mot pour mot depuis la liste ci-dessus (respecte la casse et les accents exactement)
2. "variables_independantes_suggerees" = noms COPIÉS mot pour mot depuis la liste
3. Choisis la VD qui mesure directement l'outcome principal de l'étude — appuie-toi sur le résumé statistique (une variable outcome est souvent binaire ou à faible variance de non-réponse, pas un simple identifiant à forte cardinalité ou à % de manquants élevé)
4. Priorité aux variables avec p-value potentiellement significative (p<0,05) — préfère les variables qualitatives pour ${context === 'biv' ? 'le Chi²' : 'la régression logistique'} si la VD est catégorielle, ou numériques continues pour la régression linéaire
5. "justification" : 3 à 4 phrases directes et exploitables telles quelles dans la Discussion/Conclusion — explique pourquoi cette variable est l'outcome central (en t'appuyant sur son résumé statistique), puis pourquoi les VI choisies sont les facteurs associés les plus probables

JSON STRICT, aucun texte autour :
{"variable_dependante":"NomExactIci","justification":"3 à 4 phrases.","variables_independantes_suggerees":["Var1","Var2","Var3"]}`;
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
      body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-flash', messages: [{ role: 'user', content: prompt }], max_tokens: 1024, thinking: { type: 'disabled' } }),
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
