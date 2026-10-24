# Proxy IA Cloudflare (Noria Education)

Ce Worker remplace le proxy Netlify **uniquement pour les appels LLM**.
Admin, credits (chimi), Firebase : **inchanges** (Netlify / existant).

## Deploy (toi)

```bash
cd cloudflare
npm i -g wrangler
wrangler login
wrangler secret put DEEPSEEK_KEY
wrangler secret put FIREBASE_WEB_API_KEY
# optionnel:
# wrangler secret put GROQ_KEY
# wrangler secret put GEMINI_API_KEY
wrangler secret put ALLOWED_ORIGINS
# valeur exemple: https://ton-projet.pages.dev,https://statanalyse-pro.netlify.app

wrangler deploy
```

Note l'URL du Worker, ex: `https://noria-ai-proxy.TON_COMPTE.workers.dev`

## Brancher le front

Dans `index.html` (deja prevu), defini avant le chargement de l'app:

```html
<script>
  window.SA_AI_PROXY_URL = "https://noria-ai-proxy.TON_COMPTE.workers.dev";
</script>
```

Ou en console / localStorage:
```js
localStorage.setItem("sa_ai_proxy_url", "https://noria-ai-proxy.TON_COMPTE.workers.dev");
```

Si non defini → repli automatique sur `/.netlify/functions/proxy`.

## Securite

- Token Firebase obligatoire
- Rate limit **300 req/min** par IP (modifiable : `wrangler secret put RATE_LIMIT_PER_MIN`)
- DeepSeek prioritaire, puis Groq, Gemini
- Timeout ~**55 s** cote Worker

## Pages

Deploie le site statique sur **Cloudflare Pages** comme d'habitude.
Les autres functions Netlify (admin, useAICredit, ...) peuvent rester sur Netlify tant que tu n'as pas tout migre.
