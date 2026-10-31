// ══════════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — Génération Discussion / Conclusion (server-side)
// Construit le prompt côté serveur (invisible dans le code client) et fusionne
// la vérification/déduction de chimis avec l'appel IA en une seule opération
// atomique — plus de round-trip séparé et non lié comme avant avec useAICredit.js.
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
if (!admin.apps.length) {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
}
const db = admin.firestore();

const MS_30_DAYS = 30 * 24 * 60 * 60 * 1000;
const FREE_MONTHLY_CREDITS = 10;
const TEXT_COST = 5; // même coût que l'ancien actionType 'discussion' (Discussion ET Conclusion)

// Netlify plan FREE = 10s d'exécution max (hard kill par la plateforme, sans
// réponse JSON possible passé ce délai — donc aucun remboursement de chimis
// possible non plus). Cette fonction essaie jusqu'à 6 providers en SÉQUENCE
// dans UNE SEULE invocation : avec un timeout fixe de 12s par provider,
// le pire cas (6×12s = 72s) dépassait massivement la limite Netlify, ce qui
// causait des échecs d'interprétation silencieux malgré une cascade "en place".
// On utilise donc un budget de temps global : chaque tentative reçoit le temps
// qu'il reste, plafonné, et on arrête la cascade dès qu'il ne reste plus assez
// de marge pour tenter un autre fournisseur.
const HARD_DEADLINE_MS = (parseInt(process.env.AI_TIMEOUT_MS, 10) || 8000) + 1000;      // marge de sécurité sous la limite Netlify (auth + Firestore + réponse finale)
const MAX_PER_PROVIDER_MS = HARD_DEADLINE_MS - 1000; // un seul fournisseur configuré (DeepSeek) : il reçoit tout le budget   // plafond par tentative, pour garder de la marge aux suivantes
const MIN_ATTEMPT_MS = 900;         // sous ce seuil de temps restant, on arrête d'essayer d'autres providers
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
    'https://stat-analyse-pro.netlify.app','https://pstat-pro-all.netlify.app','https://statanalyse-pro.netlify.app','https://noria-education.pages.dev']
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
    // Filet de sécurité absolu : quoi qu'il arrive, on renvoie du JSON valide
    // avec un message exploitable, jamais un crash brut sans body.
    console.error('generateAcademicText fatal error:', fatalErr);
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
  const _t0 = Date.now(); // départ du budget de temps global (voir HARD_DEADLINE_MS)
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin,
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

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return { statusCode: 400, headers, body: JSON.stringify({ error: 'JSON invalide' }) }; }

  const { textType } = body; // 'discussion' | 'conclusion'
  if (textType !== 'discussion' && textType !== 'conclusion') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'textType invalide (discussion|conclusion attendu)' }) };
  }
  if (!body.results || typeof body.results !== 'string') {
    return { statusCode: 400, headers, body: JSON.stringify({ error: 'results manquant' }) };
  }

  // ── MUR PAYANT (avec 1 essai gratuit à vie) : discussion/conclusion de
  // mémoire est la fonctionnalité à plus forte valeur (public "mémoire/thèse")
  // — jamais financée par les chimis gratuits récurrents (mensuels, quêtes,
  // parrainage), pour ne pas saborder la conversion. On autorise UNE SEULE
  // génération gratuite à vie (jamais renouvelée) pour laisser goûter la
  // qualité avant d'exiger un forfait payant.
  let usingFreeTrial = false;
  try {
    const gateSnap = await db.collection('users').doc(uid).get();
    const gateData = gateSnap.exists ? gateSnap.data() : {};
    const hasPaidPlan = gateData.plan && gateData.plan !== 'gratuit';
    const notExpired = !gateData.planExpiry || new Date(gateData.planExpiry).getTime() >= Date.now();
    const planOk = hasPaidPlan && notExpired;
    const trialAlreadyUsed = !!gateData.academicTextTrialUsed;
    if (!planOk) {
      if (trialAlreadyUsed) {
        return {
          statusCode: 402,
          headers,
          body: JSON.stringify({
            error: 'plan_required',
            message: 'Vous avez déjà utilisé votre essai gratuit de génération. La suite nécessite un forfait payant actif (Standard, Professionnel ou Premium).',
          }),
        };
      }
      usingFreeTrial = true;
    }
  } catch (gateErr) {
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Erreur lors de la vérification du forfait.' }) };
  }

  // ── CONSTRUCTION DU PROMPT (server-side, invisible côté client) ────────────
  const prompt = textType === 'discussion' ? buildDiscussionPrompt(body) : buildConclusionPrompt(body);

  // ── CRÉDITS : vérification + déduction ATOMIQUE, liée à cet appel précis ───
  try {
    const userRef = db.collection('users').doc(uid);
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(userRef);
      if (!snap.exists) throw new Error('USER_NOT_FOUND');
      const data = snap.data();
      let credits = data.credits ?? 0;
      const now = Date.now();

      if (usingFreeTrial) {
        tx.update(userRef, { academicTextTrialUsed: true, academicTextTrialUsedAt: new Date().toISOString() });
      }

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
      if (credits < TEXT_COST) throw new Error(`INSUFFICIENT:${credits}`);
      tx.update(userRef, { credits: admin.firestore.FieldValue.increment(-TEXT_COST) });
    });
  } catch (txErr) {
    if (txErr.message === 'PLAN_EXPIRED') {
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'plan_expired', message: 'Votre abonnement a expiré.' }) };
    }
    if (txErr.message?.startsWith('INSUFFICIENT:')) {
      const credits = txErr.message.split(':')[1];
      return { statusCode: 402, headers, body: JSON.stringify({ error: 'insufficient', credits }) };
    }
    return { statusCode: 500, headers, body: JSON.stringify({ error: 'Erreur lors de la vérification des chimis.' }) };
  }

  // ── APPEL IA : cascade identique à l'ancienne (Groq → DeepSeek → Gemini → Cerebras → Mistral → Claude) ──
  const cascade = [
    { provider: 'deepseek', call: callDeepSeek },
    { provider: 'groq',     call: callGroq     },
    { provider: 'gemini',   call: callGemini   },
    { provider: 'cerebras', call: callCerebras },
    { provider: 'mistral',  call: callMistral  },
    { provider: 'claude',   call: callClaude   },
  ];

  let text = null, lastError = null;
  const attempts = [];
  for (const step of cascade) {
    const remaining = HARD_DEADLINE_MS - (Date.now() - _t0);
    if (remaining < MIN_ATTEMPT_MS) break; // plus assez de budget pour tenter un autre fournisseur
    const attemptTimeout = Math.max(500, Math.min(remaining - 200, MAX_PER_PROVIDER_MS));
    try {
      text = await withTimeout(step.call(prompt), attemptTimeout, step.provider);
      if (text) break;
    } catch (e) {
      lastError = e;
      attempts.push(`${step.provider}: ${e.message}`);
    }
  }

  if (!text) {
    // Rembourser les chimis si l'IA a échoué partout — l'utilisateur ne doit
    // pas payer pour un service qui n'a rien produit.
    try {
      await db.collection('users').doc(uid).update({ credits: admin.firestore.FieldValue.increment(TEXT_COST) });
    } catch (refundErr) { /* best-effort */ }
    // Détail complet (noms des fournisseurs IA inclus) uniquement dans les logs
    // serveur Netlify — jamais renvoyé au client, pour ne pas exposer notre
    // architecture multi-fournisseurs.
    console.error('generateAcademicText — cascade IA entièrement échouée :', attempts.join(' | ') || lastError?.message || 'erreur inconnue');
    return { statusCode: 502, headers, body: JSON.stringify({ error: 'Service de rédaction IA temporairement indisponible. Vos chimis ont été remboursés — réessayez dans un instant.', credits: 'remboursé' }) };
  }

  return { statusCode: 200, headers, body: JSON.stringify({ text }) };
}

// ── CONSTRUCTION DES PROMPTS (portage exact depuis le client) ────────────────
function buildDiscussionPrompt(b) {
  const { theme, objectif, results, paras = 4, wMin = 300, wMax = 400, profile = 'master', structureLabel = '', hasRefs, refStyle, references } = b;
  const themeCtx = theme ? `Thème : "${theme}".` : 'Étude statistique générale.';
  const objectifCtx = objectif ? `Objectif principal de l'étude : "${objectif}".` : '';
  const profileLabel = { master: 'Mémoire de Master (normes CAMES/Afrique francophone)', article: 'Article scientifique international (IMRaD)', rapport: 'Rapport court praticien' }[profile] || 'Mémoire';

  const refsList = Array.isArray(references) ? references : [];
  const refsBlock = hasRefs && refsList.length ? `\n\nRÉFÉRENCES DISPONIBLES (citations réelles fournies — à utiliser, ne pas en inventer d'autres) :\n${refsList.join('\n')}` : '';
  const citationRule = hasRefs && refsList.length
    ? (refStyle === 'apa'
        ? `6. Pour la littérature : cite UNIQUEMENT les références fournies ci-dessus, au format APA dans le texte, ex. « (Diallo, 2023) ». N'invente AUCUNE autre référence.`
        : `6. Pour la littérature : cite UNIQUEMENT les références fournies ci-dessus, au format Vancouver dans le texte, ex. « [1] », « [2] », en te basant sur leur numéro. N'invente AUCUNE autre référence.`)
    : `6. Pour la littérature : formules comme « Des résultats similaires ont été observés dans des contextes comparables... » — SANS inventer d'auteurs, d'années ou de revues.`;

  return `Tu es un chercheur expert en biostatistiques et en rédaction académique. Rédige une DISCUSSION SCIENTIFIQUE rigoureuse en français académique pour un ${profileLabel}.

${themeCtx}
${objectifCtx}

RÉSULTATS DE L'ÉTUDE (priorité aux lignes ✅ SIGNIFICATIF) :
${String(results).substring(0, 6000)}
${refsBlock}

CONSIGNES STRICTES — RESPECTE-LES TOUTES SANS EXCEPTION :
${objectifCtx ? `0. Structure ta discussion de façon à répondre explicitement à l'objectif principal énoncé ci-dessus, comme le ferait un chercheur expérimenté qui referme la boucle entre objectif et résultats.\n` : ''}1. Exactement ${paras} paragraphe${paras > 1 ? 's' : ''} selon cette structure : ${structureLabel}
2. Sépare CHAQUE paragraphe par une ligne complètement vide (un saut de ligne double). Ne jamais enchaîner deux paragraphes sur la même ligne ou sans ligne vide entre eux.
3. LONGUEUR TOTALE : MINIMUM ${wMin} mots et MAXIMUM ${wMax} mots. NE DÉPASSE PAS ${wMax} MOTS. Compte tes mots avant de terminer.
4. Chaque argument DOIT citer les chiffres réels de l'étude. NE PAS inventer de données.
5. OBLIGATOIRE : pour chaque résultat statistique cité (Chi², t-test, ANOVA, corrélation, régression), mentionne systématiquement la p-value exacte (ex. « p = 0,013 » ou « p < 0,001 ») ET la force d'association quand elle est disponible dans les résultats fournis (V de Cramér, r/ρ, g de Hedges, η², R²). Ne te contente jamais de dire qu'un résultat est « significatif » sans donner sa p-value.
${citationRule}
7. AUCUN titre, AUCUN sous-titre, AUCUN numéro dans le texte — texte fluide uniquement.
8. AUCUN markdown : ni **, ni ##, ni *, ni tirets.
9. Commence directement par le premier paragraphe.`.trim();
}

function buildConclusionPrompt(b) {
  const { theme, results, discussionText = '', paras = 3, wMin = 200, wMax = 250, recoCount = 5, recoTarget = 'auto', profile = 'master', structureLabel = '' } = b;
  const themeCtx = theme ? `Thème : "${theme}".` : 'Étude statistique.';
  const profileLabel = { master: 'Mémoire de Master (CAMES)', article: 'Article scientifique (IMRaD)', rapport: 'Rapport court' }[profile] || 'Mémoire';
  const targetLabel = { auto: 'selon le thème de l\'étude', decideurs: 'décideurs et gestionnaires', praticiens: 'praticiens et cliniciens', chercheurs: 'chercheurs et académiques', politiques: 'acteurs des politiques publiques' }[recoTarget] || 'selon le thème';

  return `Tu es un chercheur expert. Rédige en français académique une CONCLUSION et des RECOMMANDATIONS pour un ${profileLabel}.

${themeCtx}

RÉSULTATS CLÉS :
${String(results).substring(0, 4000)}

${discussionText ? 'ÉLÉMENTS DE DISCUSSION :\n' + String(discussionText).substring(0, 1200) : ''}

CONSIGNES STRICTES — RESPECTE-LES TOUTES SANS EXCEPTION :
1. Structure : ${structureLabel}
2. Exactement ${paras} paragraphe${paras > 1 ? 's' : ''} de conclusion (texte fluide).
3. LONGUEUR PARAGRAPHES : MINIMUM ${wMin} mots et MAXIMUM ${wMax} mots au total. NE DÉPASSE PAS ${wMax} MOTS. Compte tes mots.
4. Exactement ${recoCount} recommandations numérotées (1. 2. 3…), concrètes, directement issues des résultats, adressées aux ${targetLabel}.
5. AUCUN titre, AUCUN sous-titre dans le corps — texte fluide pour les paragraphes.
6. AUCUN markdown : ni **, ni ##, ni *.
7. Commence directement sans introduction du type "Voici la conclusion...".`.trim();
}

// ── APPELS PROVIDERS (portage depuis proxy.js) ───────────────────────────────
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
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: prompt }], max_tokens: 2048 }),
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
      body: JSON.stringify({ model: process.env.DEEPSEEK_MODEL || 'deepseek-flash', messages: [{ role: 'user', content: prompt }], max_tokens: 2048, thinking: { type: 'disabled' } }),
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
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 2048 } }),
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
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages: [{ role: 'user', content: prompt }], max_tokens: 2048 }),
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
      body: JSON.stringify({ model: 'mistral-small-latest', messages: [{ role: 'user', content: prompt }], max_tokens: 2048 }),
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
    body: JSON.stringify({ model: 'claude-3-5-haiku-latest', max_tokens: 2048, messages: [{ role: 'user', content: prompt }] }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || 'Erreur Claude');
  return json.content[0].text;
}
