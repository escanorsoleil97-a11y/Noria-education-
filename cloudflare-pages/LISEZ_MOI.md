# Noria sur Cloudflare Pages (pages.dev)

Le site seul est servi par Pages. Les fonctions Netlify restent sur Netlify (le front les appelle automatiquement en absolu hors netlify.app).

## 1. Déployer le site
```
cd cloudflare-pages
sh build.sh
npx wrangler pages deploy dist --project-name=noria-education
```
(Git : dossier racine = `cloudflare-pages`, commande = `sh build.sh`, sortie = `dist`.)
Les dossiers `functions/__/auth` et `functions/__/firebase` (connexion Google) sont pris en compte automatiquement.

## 2. Réglages à faire (une seule fois)
- **Netlify** → variable `SITE_ORIGIN` : `https://noria-education.pages.dev,https://pstat-pro-all.netlify.app` (adapter au vrai nom pages.dev).
- **Firebase** → Authentication → Domaines autorisés : ajouter `noria-education.pages.dev`.
- **Google Cloud** → client OAuth web → URI de redirection : `https://noria-education.pages.dev/__/auth/handler`.
- **Worker IA** : `ALLOWED_ORIGINS` doit contenir l'URL pages.dev. Puis dans `index.html`, remplacer `TON_SOUS_DOMAINE` par le sous-domaine du Worker.

## Non modifié
Aucune fonction Netlify, aucune règle Firestore. Sur netlify.app le comportement est identique à avant.
