'use strict';
// ══════════════════════════════════════════════════════════════════════════
// StatAnalyse Pro — qcm.js
// Déplace côté serveur : correction/score/tentatives des QCM (Priorité 1)
// et toute la gestion admin de la banque d'épreuves (Priorité 2).
// Les questions envoyées au client (action "list") ne contiennent JAMAIS
// le champ "answer" ni "explication" — seule "submit" les utilise, côté
// serveur, pour corriger.
// ══════════════════════════════════════════════════════════════════════════
const admin = require('firebase-admin');
if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = admin.firestore();
const sec = require('./_security');

const ADMIN_UIDS = new Set(['SBATLA0GmVbeYWWpWrPoRTTveb32', '0f9FMESHK6gq5Gl77tquCETbFow1']);
const ALLOWED = new Set(['list','submit','admin.list','admin.get','admin.save','admin.delete','admin.toggleActive']);

const ipHits = new Map();
function rate(ip){ const now=Date.now(), a=(ipHits.get(ip)||[]).filter(t=>now-t<60000); if(a.length>=60)return false; a.push(now); ipHits.set(ip,a); return true; }
function headers(origin){return sec.securityHeaders(origin);}
function out(status,body,origin){return {statusCode:status,headers:headers(origin),body:JSON.stringify(body)}}
function cleanString(v,max=300){return typeof v==='string'?v.trim().slice(0,max):''}
function num(v,fallback=0){const n=Number(v);return Number.isFinite(n)?n:fallback}

async function requireAdmin(uid){
  if(!ADMIN_UIDS.has(uid)) throw Object.assign(new Error('Accès refusé'),{status:403});
  const snap=await db.collection('users').doc(uid).get();
  const role=snap.data()?.role||'';
  if(!snap.exists||(role!=='admin'&&role!=='adnim')) throw Object.assign(new Error('Rôle admin requis'),{status:403});
}

// Ne renvoie jamais answer/explication au client avant correction.
function stripAnswers(ep){
  return {
    id:ep.id, titre:ep.titre||'', niveau:ep.niveau||'', matiere:ep.matiere||'',
    dureeMaxSec:ep.dureeMaxSec||null, tentatives:ep.tentatives||0, scoreMoyen:ep.scoreMoyen||0,
    questions:(ep.questions||[]).map(q=>({q:q.q||'', choices:Array.isArray(q.choices)?q.choices:[]}))
  };
}

function validateQuestions(raw){
  if(!Array.isArray(raw)||!raw.length||raw.length>100) throw Object.assign(new Error('Le questionnaire doit contenir entre 1 et 100 questions.'),{status:400});
  return raw.map((q,i)=>{
    const qText=cleanString(q?.q,600);
    const choices=Array.isArray(q?.choices)?q.choices.map(c=>cleanString(c,300)).filter(Boolean):[];
    const answer=Math.trunc(num(q?.answer,-1));
    const explication=cleanString(q?.explication,600);
    if(!qText) throw Object.assign(new Error(`Question ${i+1} : texte requis.`),{status:400});
    if(choices.length<2||choices.length>8) throw Object.assign(new Error(`Question ${i+1} : entre 2 et 8 choix requis.`),{status:400});
    if(answer<0||answer>=choices.length) throw Object.assign(new Error(`Question ${i+1} : index de bonne réponse invalide.`),{status:400});
    return {q:qText,choices,answer,explication};
  });
}

exports.handler=async(event)=>{
  let origin='';
  try{origin=sec.assertOrigin(event)}catch(e){return out(e.status||403,{error:e.message},sec.originOf(event))}
  if(event.httpMethod==='OPTIONS')return sec.preflight(event);
  if(event.httpMethod!=='POST')return out(405,{error:'Méthode non autorisée'},origin);
  const ip=event.headers?.['x-forwarded-for']?.split(',')[0]?.trim()||'unknown';if(!rate(ip))return out(429,{error:'Trop de requêtes, réessayez dans une minute'},origin);
  try{
    await sec.verifyAppCheck(event);
    const uid=(await sec.verifyAuth(event)).uid;
    let body; try{body=sec.body(event,300000)}catch(e){return out(e.status||400,{error:e.message},origin)}
    const action=cleanString(body.action,30); if(!ALLOWED.has(action))return out(400,{error:'Action non autorisée'},origin);

    // ── Étudiant : liste des épreuves actives, sans réponses ────────────────
    if(action==='list'){
      const snap=await db.collection('banqueEpreuves').where('active','==',true).get();
      const items=snap.docs.map(d=>stripAnswers({id:d.id,...d.data()}));
      return out(200,{ok:true,items},origin);
    }

    // ── Étudiant : correction + score, calculés et enregistrés côté serveur ─
    if(action==='submit'){
      const epreuveId=cleanString(body.epreuveId,120);
      const reponses=Array.isArray(body.reponses)?body.reponses:[];
      if(!epreuveId) return out(400,{error:'epreuveId requis'},origin);
      const epRef=db.collection('banqueEpreuves').doc(epreuveId);
      const epSnap=await epRef.get();
      if(!epSnap.exists) return out(404,{error:'Épreuve introuvable'},origin);
      const ep=epSnap.data();
      const questions=Array.isArray(ep.questions)?ep.questions:[];
      if(!questions.length) return out(400,{error:'Épreuve vide'},origin);
      let bonnes=0;
      const correction=questions.map((q,i)=>{
        const given=Number.isInteger(reponses[i])?reponses[i]:null;
        const ok=given===q.answer;
        if(ok)bonnes++;
        return {given,correctIndex:q.answer,correct:ok,explication:q.explication||''};
      });
      const total=questions.length;
      const pct=Math.round(bonnes/total*100);
      const resultRef=db.collection('etudiantResultats').doc();
      await db.runTransaction(async tx=>{
        const fresh=await tx.get(epRef);
        if(!fresh.exists) throw Object.assign(new Error('Épreuve introuvable'),{status:404});
        const d=fresh.data();
        const nouvTentatives=(d.tentatives||0)+1;
        const nouvMoy=Math.round(((d.scoreMoyen||0)*(d.tentatives||0)+pct)/nouvTentatives);
        tx.update(epRef,{tentatives:nouvTentatives,scoreMoyen:nouvMoy});
        tx.set(resultRef,{uid,epreuveId,epreuveTitre:ep.titre||'',score:pct,bonnes,total,createdAt:admin.firestore.FieldValue.serverTimestamp()});
      });
      return out(200,{ok:true,score:pct,bonnes,total,correction},origin);
    }

    // ── Admin : toutes les actions ci-dessous exigent le double verrou ──────
    await requireAdmin(uid);

    if(action==='admin.list'){
      const snap=await db.collection('banqueEpreuves').get();
      return out(200,{ok:true,items:snap.docs.map(d=>({id:d.id,...d.data()}))},origin);
    }
    if(action==='admin.get'){
      const id=cleanString(body.id,120); if(!id)return out(400,{error:'id requis'},origin);
      const s=await db.collection('banqueEpreuves').doc(id).get();
      if(!s.exists)return out(404,{error:'Épreuve introuvable'},origin);
      return out(200,{ok:true,item:{id:s.id,...s.data()}},origin);
    }
    if(action==='admin.save'){
      const id=cleanString(body.id,120)||null;
      const titre=cleanString(body.titre,200); if(!titre)return out(400,{error:'Titre requis'},origin);
      const niveau=cleanString(body.niveau,80), matiere=cleanString(body.matiere,120);
      const active=body.active!==false;
      const dureeMin=Math.max(0,Math.min(600,Math.trunc(num(body.dureeMin,0))));
      const dureeMaxSec=dureeMin>0?dureeMin*60:null;
      let questions; try{questions=validateQuestions(body.questions)}catch(e){return out(e.status||400,{error:e.message},origin)}
      const data={titre,niveau,matiere,questions,active,dureeMaxSec,updatedAt:admin.firestore.FieldValue.serverTimestamp()};
      if(id){
        const ref=db.collection('banqueEpreuves').doc(id);
        const old=await ref.get(); if(!old.exists)return out(404,{error:'Épreuve introuvable'},origin);
        await ref.set(data,{merge:true});
        return out(200,{ok:true,id},origin);
      }
      data.createdAt=admin.firestore.FieldValue.serverTimestamp(); data.tentatives=0; data.scoreMoyen=0;
      const ref=await db.collection('banqueEpreuves').add(data);
      return out(200,{ok:true,id:ref.id},origin);
    }
    if(action==='admin.delete'){
      const id=cleanString(body.id,120); if(!id)return out(400,{error:'id requis'},origin);
      await db.collection('banqueEpreuves').doc(id).delete();
      return out(200,{ok:true},origin);
    }
    if(action==='admin.toggleActive'){
      const id=cleanString(body.id,120); if(!id)return out(400,{error:'id requis'},origin);
      await db.collection('banqueEpreuves').doc(id).set({active:body.active!==false},{merge:true});
      return out(200,{ok:true},origin);
    }
    return out(400,{error:'Requête invalide'},origin);
  }catch(e){console.error('[qcm]',e);return out(e.status||500,{error:e.message||'Erreur serveur'},origin);}
};
