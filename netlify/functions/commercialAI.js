'use strict';
const admin=require('firebase-admin');
if(!admin.apps.length){if(!process.env.FIREBASE_SERVICE_ACCOUNT)throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');admin.initializeApp({credential:admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT))});}
const db=admin.firestore();
const sec=require('./_security');
const ipHits=new Map();function rate(ip){const n=Date.now(),a=(ipHits.get(ip)||[]).filter(t=>n-t<60000);if(a.length>=12)return false;a.push(n);ipHits.set(ip,a);return true}
function headers(origin){return sec.securityHeaders(origin);}
const out=(s,b,origin)=>({statusCode:s,headers:headers(origin),body:JSON.stringify(b)});
async function uid(e){const h=e.headers?.authorization||e.headers?.Authorization||'';if(!h.startsWith('Bearer '))throw Object.assign(new Error('Authentification requise'),{status:401});try{return (await admin.auth().verifyIdToken(h.slice(7))).uid}catch{throw Object.assign(new Error('Session invalide'),{status:401})}}
function keys(...p){const a=[];for(const pref of p){const n=[];for(const [k,v] of Object.entries(process.env)){const m=k.match(new RegExp('^'+pref+'_(\\d+)$'));if(v&&m)n.push([+m[1],v])}n.sort((a,b)=>a[0]-b[0]);a.push(...n.map(x=>x[1]));if(process.env[pref])a.push(...String(process.env[pref]).split(',').map(s=>s.trim()).filter(Boolean))}return a}
async function jfetch(url,opt,ms=7500){const c=new AbortController(),t=setTimeout(()=>c.abort(),ms);try{const r=await fetch(url,{...opt,signal:c.signal});const tx=await r.text();if(!r.ok)throw new Error(tx.slice(0,500)||`HTTP ${r.status}`);try{return JSON.parse(tx)}catch{return {text:tx}}}finally{clearTimeout(t)}}
async function callOpenAI(key,base,model,prompt){const d=await jfetch(base+'/chat/completions',{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({model,messages:[{role:'system',content:'Tu es un conseiller commercial. Réponds en français, de façon concrète, prudente et chiffrée à partir des données fournies. Ne fabrique jamais une donnée absente.'},{role:'user',content:prompt}],max_tokens:1200,temperature:.2,...(base.includes('deepseek')?{thinking:{type:'disabled'}}:{})})});return d.choices?.[0]?.message?.content||''}
async function callGemini(key,prompt){let model=process.env.GEMINI_COMMERCIAL_MODEL||'gemini-3.7-flash';if(/^gemini-2\.0-/i.test(model))model='gemini-3.7-flash';const models=[...new Set([model,'gemini-3.7-flash','gemini-3.6-flash','gemini-3.5-flash'])];let last='';for(const m of models){try{const d=await jfetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(key)}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({contents:[{parts:[{text:prompt}]}],generationConfig:{maxOutputTokens:1200}})});const text=d.candidates?.[0]?.content?.parts?.map(x=>x.text||'').join('')||'';if(text)return text}catch(e){last=e.message}}throw new Error(last||'Gemini indisponible')}
async function callClaude(key,prompt){const model=process.env.CLAUDE_COMMERCIAL_MODEL||'claude-3-5-haiku-latest';const d=await jfetch('https://api.anthropic.com/v1/messages',{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},body:JSON.stringify({model,max_tokens:1200,messages:[{role:'user',content:prompt}]})});return d.content?.map(x=>x.text||'').join('')||''}
async function cascade(prompt){const attempts=[];for(const k of keys('DEEPSEEK_KEY','DEEPSEEK_API_KEY'))attempts.push(()=>callOpenAI(k,'https://api.deepseek.com/v1',process.env.DEEPSEEK_COMMERCIAL_MODEL||process.env.DEEPSEEK_MODEL||'deepseek-flash',prompt));for(const k of keys('CEREBRAS_KEY'))attempts.push(()=>callOpenAI(k,'https://api.cerebras.ai/v1',process.env.CEREBRAS_COMMERCIAL_MODEL||'llama-3.3-70b',prompt));for(const k of keys('GROQ_KEY','GROQ_API_KEY'))attempts.push(()=>callOpenAI(k,'https://api.groq.com/openai/v1',process.env.GROQ_COMMERCIAL_MODEL||'openai/gpt-oss-120b',prompt));for(const k of keys('GEMINI_KEY','GEMINI_API_KEY'))attempts.push(()=>callGemini(k,prompt));for(const k of keys('MISTRAL_KEY'))attempts.push(()=>callOpenAI(k,'https://api.mistral.ai/v1',process.env.MISTRAL_COMMERCIAL_MODEL||'mistral-small-latest',prompt));for(const k of keys('CLAUDE_KEY'))attempts.push(()=>callClaude(k,prompt));for(const k of keys('OPENROUTER_KEY'))attempts.push(()=>callOpenAI(k,'https://openrouter.ai/api/v1',process.env.OPENROUTER_COMMERCIAL_MODEL||'openai/gpt-4o-mini',prompt));let last='';for(const fn of attempts){try{const t=await fn();if(t)return t}catch(e){last=e.message}}throw new Error(last||'Aucun fournisseur IA disponible')}
exports.handler=async e=>{
  let origin='';
  try{origin=sec.assertOrigin(e)}catch(x){return out(x.status||403,{error:x.message},sec.originOf(e))}
  if(e.httpMethod==='OPTIONS')return sec.preflight(e);
  if(e.httpMethod!=='POST')return out(405,{error:'Méthode non autorisée'},origin);
  const ip=e.headers?.['x-forwarded-for']?.split(',')[0]?.trim()||'unknown';
  if(!rate(ip))return out(429,{error:'Trop de demandes IA'},origin);
  let charged=false, userRef=null, cost=2;
  try{
    await sec.verifyAppCheck(e); const u=(await sec.verifyAuth(e)).uid;
    let b;try{b=sec.body(e,40000)}catch(x){return out(x.status||400,{error:x.message},origin)}
    const q=String(b.question||'').trim();if(!q||q.length>5000)return out(400,{error:'Question invalide'},origin);
    const instance=['1','2','3','4'].includes(String(b.instance))?String(b.instance):'1';
    userRef=db.collection('users').doc(u);
    await db.runTransaction(async tx=>{const us=await tx.get(userRef);if(!us.exists)throw new Error('Utilisateur introuvable');const d=us.data();const credits=Number(d.credits||0);if(d.plan&&d.plan!=='gratuit'&&d.planExpiry&&new Date(d.planExpiry).getTime()<Date.now())throw new Error('PLAN_EXPIRED');if(credits<cost)throw new Error(`INSUFFICIENT:${credits}`);const now=new Date().toISOString();tx.update(userRef,{credits:admin.firestore.FieldValue.increment(-cost),lastAICallAt:now,totalAiActions:admin.firestore.FieldValue.increment(1)});});
    charged=true;
    const base=instance==='1'?db.collection('commercial').doc(u):db.collection('commercial').doc(u).collection('spaces').doc('inst'+instance);
    const [p,c,s,e2,pr,t,i]=await Promise.all(['meta/profile','clients','sales','expenses','products','tasks','invoices'].map(async path=>{const parts=path.split('/');if(parts.length===2){const x=await base.collection(parts[0]).doc(parts[1]).get();return x.exists?x.data():{}}const x=await base.collection(parts[0]).limit(120).get();return x.docs.map(d=>d.data())}));
    const by=(arr,key,valKey)=>arr.reduce((m,x)=>{const k=String(x[key]||'Non classé').slice(0,80);m[k]=(m[k]||0)+Number(x[valKey]||0);return m},{});
    const summary={profile:p,clients:c.length,products:pr.length,stockAlerts:pr.filter(x=>Number(x.stock||0)<=Number(x.minStock||0)).length,stockValue:pr.reduce((z,x)=>z+Number(x.stock||0)*Number(x.price||0),0),salesCount:s.length,salesTotal:s.reduce((z,x)=>z+Number(x.total||0),0),salesByProduct:by(s,'productId','total'),expensesCount:e2.length,expensesTotal:e2.reduce((z,x)=>z+Number(x.amount||0),0),expensesByCategory:by(e2,'category','amount'),tasksOpen:t.filter(x=>x.status!=='done').length,invoicesCount:i.length,invoicesByStatus:i.reduce((m,x)=>{const k=String(x.status||'draft');m[k]=(m[k]||0)+Number(x.amount||0);return m},{})};
    const prompt=`Tu es un conseiller commercial expert. Réponds en français, maximum 180 mots.\nFORMAT OBLIGATOIRE :\nDIAGNOSTIC : 2 phrases maximum.\nPOINTS CLÉS : 3 puces maximum.\nACTIONS PRIORITAIRES : 3 puces maximum.\nALERTE : une phrase si nécessaire.\nN'invente aucun chiffre. N'utilise pas de tableau Markdown.\nDonnées internes : ${JSON.stringify(summary).slice(0,28000)}\nDemande : ${q}`;
    let text;try{text=await cascade(prompt)}catch(aiErr){
      if(charged){try{await db.runTransaction(async tx=>{const us=await tx.get(userRef);if(us.exists)tx.update(userRef,{credits:admin.firestore.FieldValue.increment(cost),totalAiActions:admin.firestore.FieldValue.increment(-1)})})}catch(refErr){console.error('[commercialAI] refund failed',refErr.message)}}
      throw aiErr;
    }
    return out(200,{ok:true,text,cost},origin);
  }catch(e){
    console.error('[commercialAI]',e);const msg=e.message||'Erreur IA';
    if(msg.startsWith('INSUFFICIENT:'))return out(402,{error:'Solde chimi insuffisant',credits:Number(msg.split(':')[1]||0)},origin);
    return out(e.status||500,{error:msg},origin);
  }
};
