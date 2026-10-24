/**
 * Noria Education — Proxy IA Cloudflare Worker
 * DeepSeek prioritaire, timeout long, rate limit par IP (defaut 300 req/min, reglable via RATE_LIMIT_PER_MIN).
 * Credits / admin restent sur Netlify (useAICredit) — ce worker ne fait que l'appel LLM.
 *
 * Secrets (wrangler secret put ...):
 *   DEEPSEEK_KEY ou DEEPSEEK_API_KEY
 *   GROQ_KEY (optionnel)
 *   GEMINI_API_KEY (optionnel)
 *   FIREBASE_WEB_API_KEY  (clé web Firebase pour vérifier le token)
 *   ALLOWED_ORIGINS (optionnel, CSV)
 */
const PROVIDER_ORDER = ['deepseek', 'groq', 'gemini'];
const RATE_LIMIT_PER_MIN = 300; // par IP (CGNAT mobile: plusieurs etudiants partagent une IP)
const PROVIDER_TIMEOUT_MS = 55000; // ~55s (cible 60s)

const _ipHits = new Map();

function corsHeaders(origin, env) {
  const allowed = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map((s) => s.trim().replace(/\/$/, ''))
    .filter(Boolean);
  const defaults = [
    'https://stat-analyse-pro.netlify.app',
    'https://pstat-pro-all.netlify.app',
    'https://statanalyse-pro.netlify.app',
  ];
  const list = allowed.length ? allowed : defaults;
  const o = (origin || '').replace(/\/$/, '');
  const allow = o && (list.includes(o) || list.includes('*')) ? o : list[0] || '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json',
  };
}

function checkIpRateLimit(ip, limit) {
  const now = Date.now();
  const windowMs = 60000;
  const hits = (_ipHits.get(ip) || []).filter((t) => now - t < windowMs);
  if (hits.length >= (limit || RATE_LIMIT_PER_MIN)) return false;
  hits.push(now);
  _ipHits.set(ip, hits);
  return true;
}

function collectKeys(env, ...prefixes) {
  const keys = [];
  for (const prefix of prefixes) {
    if (env[prefix]) keys.push(env[prefix]);
    for (let i = 1; i <= 10; i++) {
      const k = env[`${prefix}_${i}`] || env[`${prefix}${i}`];
      if (k) keys.push(k);
    }
  }
  return [...new Set(keys.filter(Boolean))];
}

function isConfigured(env, provider) {
  if (provider === 'deepseek') return collectKeys(env, 'DEEPSEEK_KEY', 'DEEPSEEK_API_KEY').length > 0;
  if (provider === 'groq') return collectKeys(env, 'GROQ_KEY', 'GROQ_API_KEY').length > 0;
  if (provider === 'gemini') return collectKeys(env, 'GEMINI_KEY', 'GEMINI_API_KEY').length > 0;
  return false;
}

async function verifyFirebaseToken(idToken, apiKey) {
  if (!apiKey) {
    // Mode degrade: refuse si pas de cle (securite)
    throw new Error('FIREBASE_WEB_API_KEY manquante sur le Worker');
  }
  const res = await fetch(
    `https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=${encodeURIComponent(apiKey)}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ idToken }),
    }
  );
  const data = await res.json();
  if (!res.ok || !data.users || !data.users[0]) {
    throw new Error('Token invalide ou expire');
  }
  return data.users[0].localId;
}

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

async function tryKeysInOrder(keys, fn) {
  let lastErr;
  for (const key of keys) {
    try {
      return await fn(key);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('Toutes les cles ont echoue');
}

async function callDeepSeek(env, prompt, model) {
  const keys = collectKeys(env, 'DEEPSEEK_KEY', 'DEEPSEEK_API_KEY');
  if (!keys.length) throw new Error('NOT_CONFIGURED_deepseek');
  return tryKeysInOrder(keys, async (key) => {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || env.DEEPSEEK_MODEL || 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2048,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || `DeepSeek HTTP ${res.status}`);
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new Error('Reponse vide DeepSeek');
    return text;
  });
}

async function callGroq(env, prompt, model) {
  const keys = collectKeys(env, 'GROQ_KEY', 'GROQ_API_KEY');
  if (!keys.length) throw new Error('NOT_CONFIGURED_groq');
  return tryKeysInOrder(keys, async (key) => {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: model || 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 2048,
      }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error?.message || `Groq HTTP ${res.status}`);
    const text = json.choices?.[0]?.message?.content;
    if (!text) throw new Error('Reponse vide Groq');
    return text;
  });
}

async function callGemini(env, prompt, model) {
  const keys = collectKeys(env, 'GEMINI_KEY', 'GEMINI_API_KEY');
  if (!keys.length) throw new Error('NOT_CONFIGURED_gemini');
  return tryKeysInOrder(keys, async (key) => {
    const m = model || 'gemini-2.0-flash';
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`,
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
    if (!res.ok) throw new Error(json.error?.message || `Gemini HTTP ${res.status}`);
    const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text).join('') || '';
    if (!text) throw new Error('Reponse vide Gemini');
    return text;
  });
}

async function callProvider(env, provider, prompt, model) {
  if (provider === 'deepseek') return callDeepSeek(env, prompt, model);
  if (provider === 'groq') return callGroq(env, prompt, model);
  if (provider === 'gemini') return callGemini(env, prompt, model);
  throw new Error('provider_unavailable');
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin') || '';
    const headers = corsHeaders(origin, env);

    if (request.method === 'OPTIONS') {
      return new Response('', { status: 204, headers });
    }
    if (request.method !== 'POST') {
      return new Response(JSON.stringify({ error: 'Methode non autorisee' }), { status: 405, headers });
    }

    // Auth Firebase
    const authHeader = request.headers.get('Authorization') || '';
    if (!authHeader.startsWith('Bearer ')) {
      return new Response(JSON.stringify({ error: 'Non authentifie — token manquant' }), {
        status: 401,
        headers,
      });
    }
    try {
      await verifyFirebaseToken(authHeader.slice(7), env.FIREBASE_WEB_API_KEY);
    } catch (e) {
      return new Response(JSON.stringify({ error: e.message || 'Token invalide' }), {
        status: 401,
        headers,
      });
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return new Response(JSON.stringify({ error: 'JSON invalide' }), { status: 400, headers });
    }

    if (body.action === 'providers') {
      const providers = PROVIDER_ORDER.filter((p) => isConfigured(env, p));
      return new Response(JSON.stringify({ providers }), { status: 200, headers });
    }

    const ip =
      request.headers.get('CF-Connecting-IP') ||
      (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
      'unknown';
    if (!body.cont && !checkIpRateLimit(ip, Number(env.RATE_LIMIT_PER_MIN) || RATE_LIMIT_PER_MIN)) {
      return new Response(JSON.stringify({ error: 'Trop de requetes — reessayez dans une minute' }), {
        status: 429,
        headers,
      });
    }

    let { prompt, provider, model } = body;
    if (!prompt || !provider) {
      return new Response(JSON.stringify({ error: 'prompt et provider requis' }), {
        status: 400,
        headers,
      });
    }
    provider = String(provider).toLowerCase();
    if (!PROVIDER_ORDER.includes(provider)) {
      return new Response(JSON.stringify({ error: 'provider_unavailable', provider }), {
        status: 400,
        headers,
      });
    }
    if (!isConfigured(env, provider)) {
      const alt = PROVIDER_ORDER.find((p) => isConfigured(env, p));
      if (alt) {
        provider = alt;
        model = undefined;
      } else {
        return new Response(JSON.stringify({ error: 'Aucun provider IA configure sur le Worker' }), {
          status: 503,
          headers,
        });
      }
    }

    try {
      const text = await withTimeout(
        callProvider(env, provider, prompt, model),
        PROVIDER_TIMEOUT_MS,
        provider
      );
      // truncate flag simple si tres long (client peut redemander suite)
      const maxChars = 12000;
      if (text.length > maxChars) {
        return new Response(
          JSON.stringify({ text: text.slice(0, maxChars), truncated: true, provider }),
          { status: 200, headers }
        );
      }
      return new Response(JSON.stringify({ text, provider }), { status: 200, headers });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      const status = /^TIMEOUT_/.test(msg) ? 504 : /^NOT_CONFIGURED/.test(msg) ? 503 : 502;
      return new Response(JSON.stringify({ error: msg, provider }), { status, headers });
    }
  },
};
