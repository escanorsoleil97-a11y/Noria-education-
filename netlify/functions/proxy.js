// ══════════════════════════════════════════════════════════════════════════════
// Noria Education — Proxy Netlify
// Providers : Cerebras · Groq · Gemini · Mistral · DeepSeek · Claude · OpenRouter
// Variables d'env à configurer sur Netlify :
//   CEREBRAS_KEY_1/2/3 ou CEREBRAS_API_KEY_1/2/3 · GROQ_KEY_1/2/3 ou GROQ_API_KEY_1/2/3 · GEMINI_KEY_1/2/3 ou GEMINI_API_KEY_1/2/3
//   MISTRAL_KEY_1/2/3 ou MISTRAL_API_KEY_1/2/3 · DEEPSEEK_KEY · CLAUDE_KEY · OPENROUTER_KEY_1/2/3
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

// ── RATE LIMITING IP en mémoire (max 20 req/min par IP) ──────────────────────
// Netlify Functions = serverless → mémoire non partagée entre instances.
// Ce rate limit est une défense de surface : il bloque les spams depuis une IP
// sur la même instance. Pour un rate limit global, utiliser Netlify Edge ou Redis.
const _ipCalls = new Map();
function checkIpRateLimit(ip) {
  const now = Date.now();
  const window = 60000; // 1 minute
  const maxReq  = 20;
  const calls = _ipCalls.get(ip) || [];
  const recent = calls.filter(t => now - t < window);
  if (recent.length >= maxReq) return false;
  recent.push(now);
  _ipCalls.set(ip, recent);
  return true;
}

// Providers autorisés (whitelist explicite — rejette tout provider non prévu)
const ALLOWED_PROVIDERS = new Set(['cerebras','groq','gemini','mistral','deepseek','claude','openrouter']);

// Netlify plan FREE = 10s d'exécution max (hard kill par la plateforme, sans
// réponse JSON possible passé ce délai). Ce proxy fait un appel Auth Firebase +
// une vérification de crédits Firestore avant l'appel IA (~0.5-1.5s), d'où une
// marge de sécurité sous les 10s plutôt que 12s.
const PROVIDER_TIMEOUT_MS = parseInt(process.env.AI_TIMEOUT_MS, 10) || 20000; // defaut 20s (Pro 26s); Free Netlify ~10s -> set AI_TIMEOUT_MS=9000 if Free
async function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`TIMEOUT_${label}`)), ms);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

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


  try {
    return await handleRequest(event, _allow);
  } catch (fatalErr) {
    // Filet de sécurité absolu : ne jamais laisser Netlify renvoyer une
    // erreur brute sans JSON exploitable (ce qui produit "Erreur lors de la
    // génération." côté client, sans aucun détail).
    console.error('proxy fatal error:', fatalErr);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': _allow,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ error: `Erreur serveur inattendue : ${fatalErr.message || fatalErr}` }),
    };
  }
};

async function handleRequest(event, allowOrigin) {
  // CORS — autoriser ton domaine GitHub Pages
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };

  // Preflight OPTIONS
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers, body: '' };
  }

  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers, body: JSON.stringify({ error: 'Méthode non autorisée' }) };
  }

  // ── VÉRIFICATION AUTH Firebase ──────────────────────────────────────────────
  // Empêche l'utilisation du proxy sans compte valide (vol de crédits API)
  const authHeader = event.headers.authorization || event.headers.Authorization || '';
  if (!authHeader.startsWith('Bearer ')) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Non authentifié — token manquant' }) };
  }
  let callerUid;
  try {
    callerUid = (await admin.auth().verifyIdToken(authHeader.split('Bearer ')[1])).uid;
  } catch (authErr) {
    return { statusCode: 401, headers, body: JSON.stringify({ error: 'Token invalide ou expiré' }) };
  }
  // ────────────────────────────────────────────────────────────────────────────

  // Le débit et la vérification du coût sont effectués atomiquement par
  // useAICredit.js avant cet appel. Un solde à zéro est donc légitime lorsque
  // l’utilisateur avait exactement le coût de la requête avant le débit.
  let body;
  try {
    body = JSON.parse(event.body);
  } catch {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON invalide' }) };
  }

  // Liste des fournisseurs réellement configurés (le client saute les autres sans appel réseau)
  if (body.action === 'providers') {
    return { statusCode: 200, headers, body: JSON.stringify({ providers: PROVIDER_ORDER.filter(isProviderConfigured) }) };
  }

  // ── RATE LIMITING IP ── (les reprises d'une réponse coupée, body.cont, ne comptent pas)
  const clientIp = event.headers['x-forwarded-for']?.split(',')[0]?.trim() || 'unknown';
  if (!body.cont && !checkIpRateLimit(clientIp)) {
    return { statusCode: 429, headers, body: JSON.stringify({ error: 'Trop de requêtes — réessayez dans une minute' }) };
  }

  let { prompt, provider, model } = body;

  if (!prompt || !provider) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'prompt et provider requis' }) };
  }

  // Whitelist providers — rejette toute valeur non prévue (injection de provider)
  if (!ALLOWED_PROVIDERS.has(provider)) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: `Provider non autorisé : ${provider}` }) };
  }

  const providerKeyPrefixes = { cerebras: ['CEREBRAS_KEY','CEREBRAS_API_KEY'], groq: ['GROQ_KEY','GROQ_API_KEY'], gemini: ['GEMINI_KEY','GEMINI_API_KEY'], mistral: ['MISTRAL_KEY','MISTRAL_API_KEY'], deepseek: ['DEEPSEEK_KEY','DEEPSEEK_API_KEY'], claude: ['CLAUDE_KEY'], openrouter: ['OPENROUTER_KEY'] };
  const _isConfigured = (p) => (providerKeyPrefixes[p] || []).some(prefix => collectKeys(prefix).length > 0);
  // Demande vers un fournisseur SANS clé : redirigée vers le premier fournisseur configuré
  if (!_isConfigured(provider)) { const _alt = PROVIDER_ORDER.find(_isConfigured); if (_alt) { provider = _alt; model = undefined; } }
  const configured = _isConfigured(provider);
  if (!configured) {
    return { statusCode: 503, headers, body: JSON.stringify({ error: 'provider_unavailable', provider }) };
  }

  // Limite longueur prompt (anti-abus tokens)
  if (prompt.length > 40000) {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Prompt trop long (max 40 000 caractères)' }) };
  }

  try {
    let text;

    const opts = { maxTokens: body.maxTokens, startedAt: Date.now(), truncated: false };
    text = await withTimeout(callProvider(provider, prompt, model, opts), PROVIDER_TIMEOUT_MS, provider);
    await _aiHealth(callerUid, true);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(opts.truncated ? { text, truncated: true } : { text }),
    };

  } catch (err) {
    console.error(`[proxy] Erreur ${provider}:`, err.message);
    await _aiHealth(callerUid, false, err);
    const _balance = err && (err.status === 402 || /insufficient balance/i.test(err.message || ''));
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: _balance ? 'Service IA momentanément indisponible' : err.message }),
    };
  }
}

// Essaie chaque clé de la liste DANS L'ORDRE (1, 2, 3, ...) et passe à la
// suivante uniquement si l'appel échoue (clé invalide, quota épuisé, rate
// limit, etc.). Remonte l'erreur de la DERNIÈRE clé tentée si toutes échouent,
// pour que le message d'erreur reflète l'état le plus récent.
async function tryKeysInOrder(keys, callFn) {
  if (!keys.length) throw new Error('NO_KEY');
  let lastErr;
  for (const key of keys) {
    try {
      return await callFn(key);
    } catch (err) {
      lastErr = err;
      // on continue avec la clé suivante
    }
  }
  throw lastErr;
}

// Scanne dynamiquement TOUTES les variables d'env correspondant à un préfixe
// donné (ex. "GROQ_KEY") — accepte un nombre illimité de clés numérotées
// (GROQ_KEY_1, GROQ_KEY_2, ... GROQ_KEY_N), triées dans l'ordre numérique, plus
// la variante sans suffixe (GROQ_KEY) et le pluriel _KEYS_n si présent.
// Optionnellement, un ou plusieurs alias de préfixe (ex. GEMINI_API_KEY) sont
// scannés en plus, pour couvrir les variantes de nommage déjà en place.
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

const PROVIDER_ORDER = ['deepseek', 'groq', 'gemini', 'cerebras', 'mistral', 'claude'];
const _KEY_PREFIXES = { cerebras: ['CEREBRAS_KEY','CEREBRAS_API_KEY'], groq: ['GROQ_KEY','GROQ_API_KEY'], gemini: ['GEMINI_KEY','GEMINI_API_KEY'], mistral: ['MISTRAL_KEY','MISTRAL_API_KEY'], deepseek: ['DEEPSEEK_KEY','DEEPSEEK_API_KEY'], claude: ['CLAUDE_KEY'] };
function isProviderConfigured(p) { return (_KEY_PREFIXES[p] || []).some(prefix => collectKeys(prefix).length > 0); }

// Suivi santé IA par utilisateur (sert à valider un remboursement de chimis côté
// useAICredit.js) + alerte admin si le solde DeepSeek est épuisé (1 alerte / 6 h).
async function _aiHealth(uid, ok, err) {
  try {
    await db.collection('aiHealth').doc(uid).set(
      ok ? { okAt: Date.now() } : { failAt: Date.now(), failMsg: String((err && err.message) || '').slice(0, 200) },
      { merge: true });
    if (!ok && err && (err.status === 402 || /insufficient balance/i.test(err.message || ''))) {
      const gref = db.collection('aiHealth').doc('_balance');
      const g = await gref.get();
      const last = g.exists ? (g.data().alertAt || 0) : 0;
      if (Date.now() - last > 6 * 3600 * 1000) {
        await db.collection('alerts').add({ uid: 'system', email: '', type: 'ai_balance',
          detail: 'Solde DeepSeek épuisé ou insuffisant — recharger le compte API', createdAt: new Date().toISOString() });
        await gref.set({ alertAt: Date.now() }, { merge: true });
      }
    }
  } catch (e) { console.warn('aiHealth write failed:', e.message); }
}

// DeepSeek en streaming : si le budget de temps serveur est atteint, on renvoie le
// texte déjà généré (opts.truncated = true) et le client demande la suite.
async function streamDeepSeek(key, prompt, model, maxTok, deadline, opts) {
  const ctrl = new AbortController();
  const killer = setTimeout(() => ctrl.abort(), Math.max(500, deadline - Date.now()));
  let out = '';
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], max_tokens: maxTok, stream: true, thinking: { type: 'disabled' } }),
    });
    if (!res.ok) {
      let msg = 'Erreur DeepSeek';
      try { const j = await res.json(); msg = (j.error && j.error.message) || msg; } catch (_) {}
      const e = new Error(msg); e.status = res.status; throw e;
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '', finish = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim(); buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data); const c = j.choices && j.choices[0];
          if (c) { if (c.delta && c.delta.content) out += c.delta.content; if (c.finish_reason) finish = c.finish_reason; }
        } catch (_) {}
      }
    }
    if (finish === 'length') opts.truncated = true;
    if (!out) throw new Error('Réponse vide DeepSeek');
    return out;
  } catch (err) {
    if (out && (err.name === 'AbortError' || /abort/i.test(err.message || ''))) { opts.truncated = true; return out; }
    throw err;
  } finally { clearTimeout(killer); }
}

// Plusieurs clés : on passe à la suivante en cas d'échec. Une seule clé : 1 nouvel essai.
async function tryDeepSeek(keys, prompt, model, maxTok, deadline, opts) {
  let lastErr;
  const order = keys.length > 1 ? keys : [keys[0], keys[0]];
  for (const key of order) {
    if (Date.now() >= deadline - 500) break;
    try { return await streamDeepSeek(key, prompt, model, maxTok, deadline, opts); }
    catch (err) {
      lastErr = err;
      if (keys.length === 1 && [400, 401, 402, 422].includes(err.status)) break; // inutile de réessayer
      if (err.status !== 401 && err.status !== 402) await new Promise(r => setTimeout(r, 400));
    }
  }
  throw lastErr || new Error('Erreur DeepSeek');
}

async function callProvider(provider, prompt, model, opts = {}) {
    let text;
    switch (provider) {

      // ── CEREBRAS ────────────────────────────────────────────────────────────
      case 'cerebras': {
        const cerebrasKeys = collectKeys('CEREBRAS_KEY', 'CEREBRAS_API_KEY');
        if (!cerebrasKeys.length) throw new Error('Aucune CEREBRAS_KEY/CEREBRAS_API_KEY configurée');
        text = await tryKeysInOrder(cerebrasKeys, async (key) => {
          const res = await fetch('https://api.cerebras.ai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: model || 'openai/gpt-oss-120b',
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 2048,
            }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error?.message || 'Erreur Cerebras');
          return json.choices[0].message.content;
        });
        break;
      }

      // ── GROQ ────────────────────────────────────────────────────────────────
      case 'groq': {
        // Essai des clés DANS L'ORDRE 1 → 2 → 3 → ... → N pour contourner les rate limits
        const groqKeys = collectKeys('GROQ_KEY', 'GROQ_API_KEY');
        if (!groqKeys.length) throw new Error('Aucune GROQ_KEY ou GROQ_API_KEY configurée');
        text = await tryKeysInOrder(groqKeys, async (key) => {
          const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: model || 'openai/gpt-oss-120b',
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 2048,
            }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error?.message || 'Erreur Groq');
          return json.choices[0].message.content;
        });
        break;
      }

      // ── GEMINI ──────────────────────────────────────────────────────────────
      case 'gemini': {
        // Accepte GEMINI_KEY_* (nom historique) ET GEMINI_API_KEY_* (nom
        // actuellement configuré sur Netlify), nombre de clés illimité.
        const geminiKeys = collectKeys('GEMINI_KEY', 'GEMINI_API_KEY');
        if (!geminiKeys.length) throw new Error('Aucune GEMINI_KEY configurée');
        const geminiModel = model || 'gemini-3.5-flash';
        text = await tryKeysInOrder(geminiKeys, async (key) => {
          const res = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/${geminiModel}:generateContent?key=${key}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { maxOutputTokens: 2048 },
              }),
            }
          );
          const json = await res.json();
          if (!res.ok) throw new Error(json.error?.message || 'Erreur Gemini');
          return json.candidates[0].content.parts[0].text;
        });
        break;
      }

      // ── MISTRAL ─────────────────────────────────────────────────────────────
      case 'mistral': {
        const mistralKeys = collectKeys('MISTRAL_KEY', 'MISTRAL_API_KEY');
        if (!mistralKeys.length) throw new Error('Aucune MISTRAL_KEY/MISTRAL_API_KEY configurée');
        text = await tryKeysInOrder(mistralKeys, async (key) => {
          const res = await fetch('https://api.mistral.ai/v1/chat/completions', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model: model || 'mistral-small-latest',
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 2048,
            }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error?.message || 'Erreur Mistral');
          return json.choices[0].message.content;
        });
        break;
      }

      // ── DEEPSEEK ────────────────────────────────────────────────────────────
      case 'deepseek': {
        const dsKeys = collectKeys('DEEPSEEK_KEY', 'DEEPSEEK_API_KEY');
        if (!dsKeys.length) throw new Error('DEEPSEEK_KEY non configurée');
        const maxTok = Math.min(4096, Math.max(256, parseInt(opts.maxTokens, 10) || 2048));
        const deadline = (opts.startedAt || Date.now()) + Math.max(2000, PROVIDER_TIMEOUT_MS - 1200);
        text = await tryDeepSeek(dsKeys, prompt, model || process.env.DEEPSEEK_MODEL || 'deepseek-flash', maxTok, deadline, opts);
        break;
      }

      // ── CLAUDE (Anthropic) ──────────────────────────────────────────────────
      case 'claude': {
        const key = process.env.CLAUDE_KEY;
        if (!key) throw new Error('CLAUDE_KEY non configurée');
        const res = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: {
            'x-api-key': key,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: model || 'claude-3-5-haiku-20241022',
            max_tokens: 2048,
            messages: [{ role: 'user', content: prompt }],
          }),
        });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error?.message || 'Erreur Claude');
        text = json.content[0].text;
        break;
      }

      // ── OPENROUTER ──────────────────────────────────────────────────────────
      case 'openrouter': {
        const orKeys = collectKeys('OPENROUTER_KEY');
        if (!orKeys.length) throw new Error('Aucune OPENROUTER_KEY configurée');
        text = await tryKeysInOrder(orKeys, async (key) => {
          const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${key}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': 'https://statanalyse.pro',
              'X-Title': 'Noria Education',
            },
            body: JSON.stringify({
              model: model || 'mistralai/mistral-7b-instruct',
              messages: [{ role: 'user', content: prompt }],
              max_tokens: 2048,
            }),
          });
          const json = await res.json();
          if (!res.ok) throw new Error(json.error?.message || 'Erreur OpenRouter');
          return json.choices[0].message.content;
        });
        break;
      }

      default:
        throw new Error(`Provider inconnu : ${provider}`);
    }

    return text;
}
