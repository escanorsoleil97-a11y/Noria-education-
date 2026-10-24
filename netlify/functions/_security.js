'use strict';
const admin = require('firebase-admin');

/** Origines autorisées : SITE_ORIGIN + domaines Netlify (jamais fournis par le client). */
function allowedOrigins(){
  const configured=(process.env.SITE_ORIGIN || 'https://stat-analyse-pro.netlify.app,https://pstat-pro-all.netlify.app')
    .split(',').map(s=>s.trim()).filter(Boolean);
  const netlify=[process.env.URL,process.env.DEPLOY_PRIME_URL,process.env.DEPLOY_URL]
    .map(s=>String(s||'').trim().replace(/\/$/,''))
    .filter(s=>/^https:\/\//i.test(s));
  return [...new Set([...configured,...netlify])];
}
function originOf(event){return event.headers?.origin || event.headers?.Origin || ''}
function assertOrigin(event){
  const origin=originOf(event);
  // Requêtes same-origin sans header Origin (navigation directe) : OK
  // Requêtes cross-origin : Origin obligatoire et dans la liste fermée
  if(origin && !allowedOrigins().includes(origin)){
    const e=new Error('Origine non autorisée'); e.status=403; throw e;
  }
  return origin;
}
function securityHeaders(origin){
  const allowed=allowedOrigins(); const o=origin && allowed.includes(origin) ? origin : allowed[0];
  return {
    'Content-Type':'application/json',
    'Cache-Control':'no-store, no-cache, must-revalidate, private',
    'Pragma':'no-cache',
    'X-Content-Type-Options':'nosniff',
    'X-Frame-Options':'DENY',
    'Referrer-Policy':'strict-origin-when-cross-origin',
    'Permissions-Policy':'camera=(), microphone=(), geolocation=(), payment=()',
    'Cross-Origin-Resource-Policy':'same-origin',
    'Cross-Origin-Opener-Policy':'same-origin-allow-popups',
    'Strict-Transport-Security':'max-age=31536000; includeSubDomains; preload',
    'X-XSS-Protection':'0',
    'Vary':'Origin',
    'Access-Control-Allow-Origin':o,
    'Access-Control-Allow-Headers':'Content-Type, Authorization, X-Firebase-AppCheck, X-Requested-With',
    'Access-Control-Allow-Methods':'GET, POST, OPTIONS',
    'Access-Control-Max-Age':'600'
  };
}

/** Parse JSON avec plafond taille + protection pollution prototype. */
function body(event,max=200000){
  const raw=event.body||'';
  if(typeof raw!=='string'){const e=new Error('Corps de requête invalide');e.status=400;throw e;}
  if(raw.length>max){const e=new Error('Requête trop volumineuse');e.status=413;throw e;}
  // Rejeter les patterns de pollution de prototype évidents avant parse
  if(/"\s*__proto__\s*"\s*:|"\s*constructor\s*"\s*:\s*\{|"\s*prototype\s*"\s*:/.test(raw)){
    const e=new Error('Charge utile non autorisée');e.status=400;throw e;
  }
  let parsed;
  try{parsed=JSON.parse(raw||'{}')}catch(e){const x=new Error('JSON invalide');x.status=400;throw x;}
  if(parsed===null || typeof parsed!=='object' || Array.isArray(parsed)){
    const e=new Error('JSON objet attendu');e.status=400;throw e;
  }
  // Neutraliser __proto__ / constructor même si contournement
  if(Object.prototype.hasOwnProperty.call(parsed,'__proto__')) delete parsed.__proto__;
  if(Object.prototype.hasOwnProperty.call(parsed,'constructor')) delete parsed.constructor;
  if(Object.prototype.hasOwnProperty.call(parsed,'prototype')) delete parsed.prototype;
  return parsed;
}

async function verifyAppCheck(event){
  if(process.env.REQUIRE_APP_CHECK !== 'true') return null;
  const token=event.headers?.['x-firebase-appcheck'] || event.headers?.['X-Firebase-AppCheck'] || '';
  if(!token || token.length<20 || token.length>4096){
    const e=new Error('App Check requis');e.status=401;throw e;
  }
  if(!admin.appCheck){const e=new Error('App Check serveur indisponible');e.status=503;throw e;}
  try{return await admin.appCheck().verifyToken(token)}catch(e){
    const x=new Error('Jeton App Check invalide');x.status=401;throw x;
  }
}

async function verifyAuth(event){
  const h=event.headers?.authorization||event.headers?.Authorization||'';
  if(!h.startsWith('Bearer ')){const e=new Error('Authentification requise');e.status=401;throw e;}
  const token=h.slice(7).trim();
  if(!token || token.length<20 || token.length>4096){
    const e=new Error('Jeton d\'authentification invalide');e.status=401;throw e;
  }
  // Rejeter caractères non JWT basiques
  if(!/^[A-Za-z0-9\-_=.]+\.?[A-Za-z0-9\-_=.]*\.?[A-Za-z0-9\-_=.]*$/.test(token)){
    const e=new Error('Format de jeton invalide');e.status=401;throw e;
  }
  if(!admin.apps.length){const e=new Error('Authentification serveur non configurée');e.status=503;throw e;}
  try{
    // checkRevoked=true : sessions révoquées / mots de passe changés refusés
    return await admin.auth().verifyIdToken(token, true);
  }catch(e){
    const x=new Error('Session Firebase invalide ou révoquée');x.status=401;throw x;
  }
}

/** Rate-limit mémoire par IP (partagé au sein de l'instance tiède). */
const _rateBuckets=new Map();
function rateLimit(ip, {limit=40, windowMs=60000}={}){
  const key=String(ip||'unknown').slice(0,128);
  const now=Date.now();
  let arr=_rateBuckets.get(key)||[];
  arr=arr.filter(t=>now-t<windowMs);
  if(arr.length>=limit) return false;
  arr.push(now);
  _rateBuckets.set(key, arr);
  // Purge occasionnelle pour éviter fuite mémoire
  if(_rateBuckets.size>5000){
    for(const [k,v] of _rateBuckets){
      const f=v.filter(t=>now-t<windowMs);
      if(!f.length) _rateBuckets.delete(k); else _rateBuckets.set(k,f);
    }
  }
  return true;
}
function clientIp(event){
  const xf=event.headers?.['x-forwarded-for']||event.headers?.['X-Forwarded-For']||'';
  return String(xf).split(',')[0].trim() || event.headers?.['client-ip'] || 'unknown';
}

function preflight(event){return {statusCode:204,headers:securityHeaders(originOf(event)),body:''}}

function adminUids(){
  const fromEnv=(process.env.ADMIN_UIDS||'').split(',').map(s=>s.trim()).filter(Boolean);
  const defaults=['SBATLA0GmVbeYWWpWrPoRTTveb32','0f9FMESHK6gq5Gl77tquCETbFow1'];
  return new Set(fromEnv.length ? fromEnv : defaults);
}
module.exports={
  allowedOrigins,originOf,assertOrigin,securityHeaders,body,
  verifyAppCheck,verifyAuth,preflight,rateLimit,clientIp,adminUids
};
