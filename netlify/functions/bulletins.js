'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = admin.firestore();
const sec = require('./_security');
const ALLOWED = new Set(['notes.save','notes.delete','notes.list','notes.importBatch','stats.classe','stats.palmares','stats.evolution','bulletin.eleve','bulletin.classe']);
const ipHits = new Map();
function rate(ip){ const now=Date.now(), a=(ipHits.get(ip)||[]).filter(t=>now-t<60000); if(a.length>=90)return false; a.push(now); ipHits.set(ip,a); return true; }
function headers(origin){return sec.securityHeaders(origin);}
function out(status,body,origin){return {statusCode:status,headers:headers(origin),body:JSON.stringify(body)}}
function cleanString(v,max=300){return typeof v==='string'?v.trim().slice(0,max):''}
function num(v, fallback=0){const n=Number(v);return Number.isFinite(n)?n:fallback}
function cap20(v){return Math.max(0,Math.min(20,num(v)))}
function docData(s){return {id:s.id,...s.data()}}

// Même base que la Gestion Commerciale École (instance 3) : le roster élèves
// (collection "clients") est donc partagé entre facturation et notes/bulletins,
// pas de double saisie.
function base(uid){return db.collection('commercial').doc(uid).collection('spaces').doc('inst3')}
function notesCol(uid){return base(uid).collection('notes')}

async function saveNote(uid,payload,id){
  const data={
    ownerUid:uid,
    clientId:cleanString(payload.clientId,120),
    eleve:cleanString(payload.eleve,160),
    classe:cleanString(payload.classe,100),
    matiere:cleanString(payload.matiere,100),
    trimestre:cleanString(payload.trimestre,20)||'T1',
    anneeScolaire:cleanString(payload.anneeScolaire,20),
    note:cap20(payload.note),
    coefficient:Math.max(1,Math.min(20,Math.floor(num(payload.coefficient,1)))),
    dateEvaluation:cleanString(payload.dateEvaluation,20),
    updatedAt:admin.firestore.FieldValue.serverTimestamp()
  };
  if(!data.eleve) throw Object.assign(new Error('Nom de l’élève requis'),{status:400});
  if(!data.matiere) throw Object.assign(new Error('Matière requise'),{status:400});
  if(id){const ref=notesCol(uid).doc(id);const old=await ref.get();if(!old.exists())throw Object.assign(new Error('Note introuvable'),{status:404});await ref.set(data,{merge:true});return docData(await ref.get())}
  data.createdAt=admin.firestore.FieldValue.serverTimestamp();
  const ref=await notesCol(uid).add(data);return docData(await ref.get());
}

async function importNotes(uid,rows){
  if(!Array.isArray(rows)||rows.length>800) throw Object.assign(new Error('Import invalide : maximum 800 lignes par envoi.'),{status:400});
  const isBlank=raw=>raw&&typeof raw==='object'&&Object.values(raw).every(v=>v===null||v===undefined||String(v).trim()==='');
  const normalized=[]; const errors=[];
  rows.forEach((raw,index)=>{
    if(isBlank(raw)) return;
    try{
      const src=raw&&typeof raw==='object'?raw:{};
      const eleve=cleanString(src.eleve,160); const matiere=cleanString(src.matiere,100);
      if(!eleve) throw new Error('Élève requis');
      if(!matiere) throw new Error('Matière requise');
      normalized.push({
        ownerUid:uid, clientId:cleanString(src.clientId,120), eleve, classe:cleanString(src.classe,100),
        matiere, trimestre:cleanString(src.trimestre,20)||'T1', anneeScolaire:cleanString(src.anneeScolaire,20),
        note:cap20(src.note), coefficient:Math.max(1,Math.min(20,Math.floor(num(src.coefficient,1)))),
        dateEvaluation:cleanString(src.dateEvaluation,20)
      });
    }catch(e){ errors.push({row:index+1,error:e.message||'Ligne invalide'}); }
  });
  if(!normalized.length) return {imported:0,skipped:errors.length,errors:errors.slice(0,20)};
  const batch=db.batch();
  normalized.forEach(p=>{
    const ref=notesCol(uid).doc();
    batch.set(ref,{...p,createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
  });
  await batch.commit();
  return {imported:normalized.length,skipped:errors.length,errors:errors.slice(0,20)};
}

async function fetchNotes(uid,filters={}){
  let q=notesCol(uid).limit(3000);
  const snap=await q.get();
  let rows=snap.docs.map(docData);
  if(filters.classe) rows=rows.filter(r=>r.classe===filters.classe);
  if(filters.trimestre) rows=rows.filter(r=>r.trimestre===filters.trimestre);
  if(filters.anneeScolaire) rows=rows.filter(r=>r.anneeScolaire===filters.anneeScolaire);
  return rows;
}

// Moyenne pondérée (note*coef / somme coef) — regroupement par élève.
function moyennesParEleve(rows){
  const m=new Map();
  rows.forEach(r=>{
    const key=r.clientId||r.eleve;
    if(!m.has(key)) m.set(key,{eleve:r.eleve,clientId:r.clientId,classe:r.classe,sumPond:0,sumCoef:0,matieres:{}});
    const e=m.get(key);
    e.sumPond+=r.note*r.coefficient; e.sumCoef+=r.coefficient;
    if(!e.matieres[r.matiere]) e.matieres[r.matiere]={sumPond:0,sumCoef:0};
    e.matieres[r.matiere].sumPond+=r.note*r.coefficient; e.matieres[r.matiere].sumCoef+=r.coefficient;
  });
  return [...m.values()].map(e=>({
    eleve:e.eleve, clientId:e.clientId, classe:e.classe,
    moyenneGenerale:e.sumCoef?Math.round((e.sumPond/e.sumCoef)*100)/100:0,
    matieres:Object.fromEntries(Object.entries(e.matieres).map(([mat,v])=>[mat,v.sumCoef?Math.round((v.sumPond/v.sumCoef)*100)/100:0]))
  }));
}

exports.handler=async(event)=>{
  let origin='';
  try{origin=sec.assertOrigin(event)}catch(e){return out(e.status||403,{error:e.message},sec.originOf(event))}
  if(event.httpMethod==='OPTIONS')return sec.preflight(event);
  if(event.httpMethod!=='POST')return out(405,{error:'Méthode non autorisée'},origin);
  const ip=event.headers?.['x-forwarded-for']?.split(',')[0]?.trim()||'unknown';if(!rate(ip))return out(429,{error:'Trop de requêtes, réessayez dans une minute'},origin);
  try{
    await sec.verifyAppCheck(event); const uid=(await sec.verifyAuth(event)).uid; let body; try{body=sec.body(event,250000)}catch(e){return out(e.status||400,{error:e.message},origin)}
    const action=cleanString(body.action,30); if(!ALLOWED.has(action))return out(400,{error:'Action non autorisée'},origin);
    const filters={classe:cleanString(body.classe,100),trimestre:cleanString(body.trimestre,20),anneeScolaire:cleanString(body.anneeScolaire,20)};

    if(action==='notes.save') return out(200,{ok:true,item:await saveNote(uid,body.payload||{},cleanString(body.id,120)||null)},origin);
    if(action==='notes.delete'){
      const id=cleanString(body.id,120); if(!id)return out(400,{error:'Identifiant requis'},origin);
      const ref=notesCol(uid).doc(id); const s=await ref.get(); if(!s.exists())return out(404,{error:'Note introuvable'},origin);
      await ref.delete(); return out(200,{ok:true,deleted:{id}},origin);
    }
    if(action==='notes.list') return out(200,{ok:true,items:await fetchNotes(uid,filters)},origin);
    if(action==='notes.importBatch'){
      const rows=Array.isArray(body.rows)?body.rows:[];
      return out(200,{ok:true,...(await importNotes(uid,rows))},origin);
    }
    if(action==='stats.classe'){
      const rows=await fetchNotes(uid,filters); const moyennes=moyennesParEleve(rows);
      const admis=moyennes.filter(m=>m.moyenneGenerale>=10).length;
      const valeurs=moyennes.map(m=>m.moyenneGenerale);
      return out(200,{ok:true,effectif:moyennes.length,moyenneClasse:valeurs.length?Math.round((valeurs.reduce((a,b)=>a+b,0)/valeurs.length)*100)/100:0,min:valeurs.length?Math.min(...valeurs):0,max:valeurs.length?Math.max(...valeurs):0,tauxAdmis:moyennes.length?Math.round((admis/moyennes.length)*1000)/10:0},origin);
    }
    if(action==='stats.palmares'){
      const rows=await fetchNotes(uid,filters); const moyennes=moyennesParEleve(rows).sort((a,b)=>b.moyenneGenerale-a.moyenneGenerale);
      return out(200,{ok:true,items:moyennes.map((m,i)=>({rang:i+1,...m}))},origin);
    }
    if(action==='stats.evolution'){
      const rowsAll=await fetchNotes(uid,{classe:filters.classe,anneeScolaire:filters.anneeScolaire});
      const parTrimestre={};
      rowsAll.forEach(r=>{(parTrimestre[r.trimestre]=parTrimestre[r.trimestre]||[]).push(r)});
      const items=Object.entries(parTrimestre).map(([trimestre,rows])=>{
        const moyennes=moyennesParEleve(rows).map(m=>m.moyenneGenerale);
        return {trimestre,moyenneClasse:moyennes.length?Math.round((moyennes.reduce((a,b)=>a+b,0)/moyennes.length)*100)/100:0,effectif:moyennes.length};
      }).sort((a,b)=>a.trimestre.localeCompare(b.trimestre));
      return out(200,{ok:true,items},origin);
    }
    if(action==='bulletin.eleve'){
      const cible=cleanString(body.clientId,120)||cleanString(body.eleve,160); if(!cible)return out(400,{error:'Élève requis'},origin);
      const rows=await fetchNotes(uid,filters); const moyennes=moyennesParEleve(rows).sort((a,b)=>b.moyenneGenerale-a.moyenneGenerale);
      const idx=moyennes.findIndex(m=>(m.clientId||m.eleve)===cible);
      if(idx<0)return out(404,{error:'Aucune note trouvée pour cet élève sur cette période'},origin);
      return out(200,{ok:true,bulletin:{...moyennes[idx],rang:idx+1,effectifClasse:moyennes.length,detail:rows.filter(r=>(r.clientId||r.eleve)===cible)}},origin);
    }
    if(action==='bulletin.classe'){
      const rows=await fetchNotes(uid,filters); const moyennes=moyennesParEleve(rows).sort((a,b)=>b.moyenneGenerale-a.moyenneGenerale);
      return out(200,{ok:true,items:moyennes.map((m,i)=>({rang:i+1,...m}))},origin);
    }
    return out(400,{error:'Requête invalide'},origin);
  }catch(e){console.error('[bulletins]',e);return out(e.status||500,{error:e.message||'Erreur serveur'},origin);}
};
