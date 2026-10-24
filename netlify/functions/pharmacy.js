'use strict';
const admin=require('firebase-admin');
if(!admin.apps.length){if(!process.env.FIREBASE_SERVICE_ACCOUNT)throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');admin.initializeApp({credential:admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))});}
const db=admin.firestore();
const sec=require('./_security');
const ALLOWED=new Set(['importBatch','list']);
const COLLECTIONS=new Set(['stock','fournisseurs','entrees','sorties','achats','inventaire','peremptions','alertes','factures','ventes','indicateurs']);
const LIMITS={stock:3000,fournisseurs:1000,entrees:3000,sorties:3000,achats:2000,inventaire:3000,peremptions:2000,alertes:2000,factures:2000,ventes:3000,indicateurs:2000};
const ipHits=new Map();
function rate(ip){const now=Date.now(),a=(ipHits.get(ip)||[]).filter(t=>now-t<60000);if(a.length>=90)return false;a.push(now);ipHits.set(ip,a);return true;}
function headers(o){return sec.securityHeaders(o)}
function out(s,b,o){return{statusCode:s,headers:headers(o),body:JSON.stringify(b)}}
function clean(v,max=300){return typeof v==='string'?v.trim().slice(0,max):v==null?'':String(v).slice(0,max)}
function safeId(v){const s=clean(v,120);return /^[A-Za-z0-9_-]{1,120}$/.test(s)?s:null}
function ownerRef(uid,col,id){return db.collection('pharmacy').doc(uid).collection(col).doc(id)}
function normalize(kind,src){const out={ownerUid:null};for(const[k,v]of Object.entries(src||{})){if(['id','kind','createdAt','ownerUid'].includes(k))continue;out[clean(k,80)]=typeof v==='string'?clean(v,500):v}out.kind=kind;return out}
async function importBatch(uid,kind,rows){if(!COLLECTIONS.has(kind))throw Object.assign(new Error('Module pharmacie interdit'),{status:400});if(!Array.isArray(rows)||!rows.length)return{imported:0};if(rows.length>500)throw Object.assign(new Error('Maximum 500 lignes par lot.'),{status:400});if(rows.length>LIMITS[kind])throw Object.assign(new Error('Limite du module dépassée.'),{status:400});const batch=db.batch();let n=0;for(const src of rows){const p=normalize(kind,src);const id=safeId(src?.id)||db.collection('_').doc().id;delete p.id;delete p.ownerUid;p.ownerUid=uid;p.createdAt=admin.firestore.FieldValue.serverTimestamp();p.updatedAt=admin.firestore.FieldValue.serverTimestamp();batch.set(ownerRef(uid,kind,id),p,{merge:true});n++}await batch.commit();return{imported:n}}
async function list(uid,kind,limit=200){if(!COLLECTIONS.has(kind))throw Object.assign(new Error('Module pharmacie interdit'),{status:400});const snap=await db.collection('pharmacy').doc(uid).collection(kind).limit(Math.min(Number(limit)||200,LIMITS[kind])).get();return snap.docs.map(d=>({id:d.id,...d.data()}))}
exports.handler=async event=>{let origin='';try{origin=sec.assertOrigin(event)}catch(e){return out(e.status||403,{error:e.message},sec.originOf(event))}if(event.httpMethod==='OPTIONS')return sec.preflight(event);if(event.httpMethod!=='POST')return out(405,{error:'Méthode non autorisée'},origin);const ip=event.headers?.['x-forwarded-for']?.split(',')[0]?.trim()||'unknown';if(!rate(ip))return out(429,{error:'Trop de requêtes, réessayez dans une minute'},origin);try{await sec.verifyAppCheck(event);const uid=(await sec.verifyAuth(event)).uid;const body=sec.body(event,250000);if(!ALLOWED.has(clean(body.action,30)))return out(400,{error:'Action non autorisée'},origin);if(body.action==='importBatch'){const p=body.payload||{};const r=await importBatch(uid,clean(p.collection,30),p.rows);return out(200,{ok:true,...r},origin)}if(body.action==='list'){return out(200,{ok:true,items:await list(uid,clean(body.collection,30),body.limit)},origin)}return out(400,{error:'Requête pharmacie invalide'},origin)}catch(e){console.error('[pharmacy]',e);return out(e.status||500,{error:e.message||'Erreur serveur'},origin)}};
