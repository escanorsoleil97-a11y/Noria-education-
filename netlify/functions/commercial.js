'use strict';
const admin = require('firebase-admin');
if (!admin.apps.length) {
  if (!process.env.FIREBASE_SERVICE_ACCOUNT) throw new Error('FIREBASE_SERVICE_ACCOUNT manquant');
  admin.initializeApp({ credential: admin.credential.cert(JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)) });
}
const db = admin.firestore();
const sec = require('./_security');
const ALLOWED = new Set(['profile','clients','products','sales','expenses','tasks','invoices','dashboard','stockAdjust','importBatch']);
const LIMITS = { clients:1000, products:1000, sales:2000, expenses:2000, tasks:1000, invoices:2000 };
const ipHits = new Map();
function rate(ip){ const now=Date.now(), a=(ipHits.get(ip)||[]).filter(t=>now-t<60000); if(a.length>=90)return false; a.push(now); ipHits.set(ip,a); return true; }
function headers(origin){return sec.securityHeaders(origin);}
function out(status,body,origin){return {statusCode:status,headers:headers(origin),body:JSON.stringify(body)}}
function cleanString(v,max=300){return typeof v==='string'?v.trim().slice(0,max):''}
function num(v, fallback=0){const n=Number(v);return Number.isFinite(n)?n:fallback}
function dateIso(v){const d=v?new Date(v):new Date(); return isNaN(d)?new Date().toISOString():d.toISOString()}
async function auth(event){const h=event.headers?.authorization||event.headers?.Authorization||'';if(!h.startsWith('Bearer '))throw Object.assign(new Error('Authentification requise'),{status:401});try{return (await admin.auth().verifyIdToken(h.slice(7))).uid}catch(e){throw Object.assign(new Error('Session invalide ou expirée'),{status:401})}}
function ownerBase(uid,instance){const inst=['1','2','3','4'].includes(String(instance))?String(instance):'1';return inst==='1'?db.collection('commercial').doc(uid):db.collection('commercial').doc(uid).collection('spaces').doc('inst'+inst)}
function ownerRef(uid,col,id,instance){return ownerBase(uid,instance).collection(col).doc(id)}
function docData(s){return {id:s.id,...s.data()}}
function cap(v){return Math.max(0,Math.min(10000000,num(v)))}
function normKey(s){return String(s||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,'_').replace(/^_+|_+$/g,'')}
function mapLabel(v,dict){if(!v)return'Non renseigné';const k=normKey(v);return dict[k]||String(v).trim().slice(0,60)}

async function list(uid,col,limit=200,instance){const snap=await ownerBase(uid,instance).collection(col).limit(Math.min(limit,LIMITS[col]||200)).get();return snap.docs.map(docData)}
async function save(uid,col,payload,id,instance){
  if(!LIMITS[col]) throw Object.assign(new Error('Collection interdite'),{status:400});
  const data={...payload,ownerUid:uid,updatedAt:admin.firestore.FieldValue.serverTimestamp()};
  if(col==='clients'){data.name=cleanString(data.name,160);if(!data.name)throw Object.assign(new Error('Nom client requis'),{status:400});data.phone=cleanString(data.phone,50);data.email=cleanString(data.email,180);data.city=cleanString(data.city,100);data.notes=cleanString(data.notes,1000);data.sexe=cleanString(data.sexe,10);data.trancheAge=cleanString(data.trancheAge,20);data.anneeScolaire=cleanString(data.anneeScolaire,20);data.classe=cleanString(data.classe,100);data.etablissement=cleanString(data.etablissement,160);}
  if(col==='products'){data.name=cleanString(data.name,160);if(!data.name)throw Object.assign(new Error('Nom produit requis'),{status:400});data.sku=cleanString(data.sku,80);data.price=cap(data.price);data.stock=Math.floor(cap(data.stock));data.minStock=Math.floor(cap(data.minStock));data.expiryDate=data.expiryDate?dateIso(data.expiryDate):'';data.supplier=cleanString(data.supplier,160);data.forme=cleanString(data.forme,60);data.dosage=cleanString(data.dosage,60);data.numeroLot=cleanString(data.numeroLot,80);data.niveau=cleanString(data.niveau,100);data.etablissement=cleanString(data.etablissement,160);}
  if(col==='sales'){data.clientId=cleanString(data.clientId,100);data.productId=cleanString(data.productId,100);data.quantity=Math.floor(cap(data.quantity));data.unitPrice=cap(data.unitPrice);if(data.quantity<1||!data.productId)throw Object.assign(new Error('Produit et quantité requis'),{status:400});data.total=data.quantity*data.unitPrice;data.date=dateIso(data.date);data.paymentMethod=cleanString(data.paymentMethod,60);data.typeActivite=cleanString(data.typeActivite,80);data.typeFrais=cleanString(data.typeFrais,80);data.anneeScolaire=cleanString(data.anneeScolaire,20);}
  if(col==='expenses'){data.label=cleanString(data.label,180);if(!data.label)throw Object.assign(new Error('Libellé requis'),{status:400});data.amount=cap(data.amount);data.category=cleanString(data.category,80);data.date=dateIso(data.date);data.supplier=cleanString(data.supplier,160);data.paymentMethod=cleanString(data.paymentMethod,60);}
  if(col==='tasks'){data.title=cleanString(data.title,180);if(!data.title)throw Object.assign(new Error('Tâche requise'),{status:400});data.status= ['todo','done'].includes(data.status)?data.status:'todo';data.dueDate=dateIso(data.dueDate);data.clientId=cleanString(data.clientId,100);}
  if(col==='invoices'){data.number=cleanString(data.number,80);data.clientId=cleanString(data.clientId,100);data.amount=cap(data.amount);data.status=['draft','sent','paid','cancelled'].includes(data.status)?data.status:'draft';data.date=dateIso(data.date);}
  if(id){const ref=ownerRef(uid,col,id,instance);const old=await ref.get();if(!old.exists())throw Object.assign(new Error('Élément introuvable'),{status:404});await ref.set(data,{merge:true});return docData(await ref.get())}
  data.createdAt=admin.firestore.FieldValue.serverTimestamp();const ref=await ownerBase(uid,instance).collection(col).add(data);return docData(await ref.get());
}

async function importBatch(uid,col,rows,instance){
  const allowed=['clients','products','sales','expenses','invoices','tasks'];
  if(!allowed.includes(col)||!Array.isArray(rows)||rows.length>500) throw Object.assign(new Error('Import invalide : maximum 500 lignes par envoi.'),{status:400});
  const isBlankRow=raw=>raw&&typeof raw==='object'&&Object.values(raw).every(v=>v===null||v===undefined||String(v).trim()==='');
  const normalized=[]; const errors=[];
  rows.forEach((raw,index)=>{
    if(isBlankRow(raw)) return; // Les lignes vides du modèle sont normales et ne doivent jamais bloquer l'import.
    try{
      const p={}; const src=raw&&typeof raw==='object'?raw:{};
      const safeId=v=>{const x=cleanString(v,120);return /^[A-Za-z0-9_-]{1,120}$/.test(x)?x:null};
      if(col==='clients'){
        p.name=cleanString(src.name,160); p.phone=cleanString(src.phone,50); p.email=cleanString(src.email,180); p.address=cleanString(src.address,220); p.city=cleanString(src.city,100); p.notes=cleanString(src.notes,1000); p.sexe=cleanString(src.sexe,10); p.trancheAge=cleanString(src.trancheAge,20); p.anneeScolaire=cleanString(src.anneeScolaire,20); p.classe=cleanString(src.classe,100); p.etablissement=cleanString(src.etablissement,160);
        if(!p.name) throw Error('Nom client requis'); p.id=safeId(src.id);
      } else if(col==='products'){
        p.name=cleanString(src.name,160); p.sku=cleanString(src.sku,80); p.category=cleanString(src.category,100); p.price=cap(src.price); p.purchasePrice=cap(src.purchasePrice); p.stock=Math.floor(cap(src.stock)); p.minStock=Math.floor(cap(src.minStock)); p.expiryDate=src.expiryDate?dateIso(src.expiryDate):''; p.supplier=cleanString(src.supplier,160); p.forme=cleanString(src.forme,60); p.dosage=cleanString(src.dosage,60); p.numeroLot=cleanString(src.numeroLot,80); p.niveau=cleanString(src.niveau,100); p.etablissement=cleanString(src.etablissement,160);
        if(!p.name) throw Error('Nom produit requis'); p.id=safeId(src.id);
      } else if(col==='sales'){
        p.productId=cleanString(src.productId,120); p.clientId=cleanString(src.clientId,100); p.quantity=Math.floor(cap(src.quantity)); p.unitPrice=cap(src.unitPrice); p.discount=cap(src.discount); p.paymentMethod=cleanString(src.paymentMethod,60); p.typeActivite=cleanString(src.typeActivite,80); p.typeFrais=cleanString(src.typeFrais,80); p.anneeScolaire=cleanString(src.anneeScolaire,20); p.status=cleanString(src.status,60); p.date=dateIso(src.date);
        if(!p.productId||p.quantity<1) throw Error('Produit ID et Quantité requis'); p.total=Math.max(0,p.quantity*p.unitPrice-p.discount); p.id=safeId(src.id);
      } else if(col==='expenses'){
        p.label=cleanString(src.label,180); p.category=cleanString(src.category,80); p.amount=cap(src.amount); p.paymentMethod=cleanString(src.paymentMethod,60); p.supplier=cleanString(src.supplier,160); p.status=cleanString(src.status,60); p.date=dateIso(src.date);
        if(!p.label) throw Error('Libellé requis'); p.id=safeId(src.id);
      } else if(col==='tasks'){
        p.title=cleanString(src.title,180); p.clientId=cleanString(src.clientId,100); p.dueDate=src.dueDate?dateIso(src.dueDate):dateIso(''); p.status=['todo','done'].includes(String(src.status).toLowerCase())?String(src.status).toLowerCase():'todo';
        if(!p.title) throw Error('Titre de tâche requis'); p.id=safeId(src.id);
      } else if(col==='invoices'){
        p.number=cleanString(src.number,80); p.clientId=cleanString(src.clientId,100); p.amount=cap(src.amount||src.amountTTC||src.amountHT); p.amountHT=cap(src.amountHT); p.vat=cap(src.vat); p.amountTTC=cap(src.amountTTC); p.date=dateIso(src.date); p.dueDate=src.dueDate?dateIso(src.dueDate):''; p.status=['draft','sent','paid','cancelled'].includes(String(src.status).toLowerCase())?String(src.status).toLowerCase():'draft';
        if(!p.number) throw Error('Numéro de facture requis'); p.id=safeId(src.id);
      }
      normalized.push(p);
    }catch(e){ errors.push({row:index+1,error:e.message||'Ligne invalide'}); }
  });
  if(!normalized.length) return {imported:0,skipped:errors.length,errors:errors.slice(0,20)};
  const batch=db.batch(); const seen=new Set();
  normalized.forEach(p=>{
    let id=p.id;
    if(!id||seen.has(col+':'+id)) id=db.collection('_').doc().id;
    seen.add(col+':'+id); delete p.id;
    const ref=ownerRef(uid,col,id,instance);
    batch.set(ref,{...p,ownerUid:uid,createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
  });
  await batch.commit();
  return {imported:normalized.length,skipped:errors.length,errors:errors.slice(0,20)};
}
async function remove(uid,col,id,instance){if(!LIMITS[col]||!id)throw Object.assign(new Error('Suppression invalide'),{status:400});const ref=ownerRef(uid,col,id,instance);const s=await ref.get();if(!s.exists())throw Object.assign(new Error('Élément introuvable'),{status:404});await ref.delete();return {id}}

exports.handler=async(event)=>{
  let origin='';
  try{origin=sec.assertOrigin(event)}catch(e){return out(e.status||403,{error:e.message},sec.originOf(event))}
  if(event.httpMethod==='OPTIONS')return sec.preflight(event);
  if(event.httpMethod!=='POST')return out(405,{error:'Méthode non autorisée'},origin);
  const ip=event.headers?.['x-forwarded-for']?.split(',')[0]?.trim()||'unknown';if(!rate(ip))return out(429,{error:'Trop de requêtes, réessayez dans une minute'},origin);
  try{
    await sec.verifyAppCheck(event); const uid=(await sec.verifyAuth(event)).uid; let body; try{body=sec.body(event,250000)}catch(e){return out(e.status||400,{error:e.message},origin)}
    const action=cleanString(body.action,30);if(!ALLOWED.has(action))return out(400,{error:'Action non autorisée'},origin);
    const instance=['1','2','3','4'].includes(String(body.instance))?String(body.instance):'1';
    if(action==='profile'){
      if(body.mode==='get'){const s=await ownerBase(uid,instance).collection('meta').doc('profile').get();return out(200,{ok:true,profile:s.exists?s.data():{currency:'FCFA',sector:'Commerce'}},origin)}
      const p={companyName:cleanString(body.profile?.companyName,180),sector:cleanString(body.profile?.sector,120),currency:cleanString(body.profile?.currency,20)||'FCFA',objective:cleanString(body.profile?.objective,1000),updatedAt:admin.firestore.FieldValue.serverTimestamp()};if(!p.companyName)return out(400,{error:'Nom de l’entreprise requis'},origin);await ownerBase(uid,instance).collection('meta').doc('profile').set(p,{merge:true});return out(200,{ok:true,profile:(await ownerBase(uid,instance).collection('meta').doc('profile').get()).data()},origin);
    }
    if(action==='dashboard'){
      const [clients,products,sales,expenses,tasks,invoices]=await Promise.all([list(uid,'clients',200,instance),list(uid,'products',200,instance),list(uid,'sales',500,instance),list(uid,'expenses',500,instance),list(uid,'tasks',200,instance),list(uid,'invoices',300,instance)]);
      const now=Date.now(), month=new Date();month.setDate(1);month.setHours(0,0,0,0);
      const salesMonth=sales.filter(x=>new Date(x.date||0)>=month.getTime());
      const expensesMonth=expenses.filter(x=>new Date(x.date||0)>=month.getTime());
      const ca=salesMonth.reduce((s,x)=>s+num(x.total),0), dep=expensesMonth.reduce((s,x)=>s+num(x.amount),0);
      const stockValue=products.reduce((s,x)=>s+num(x.stock)*num(x.price),0), lowStock=products.filter(x=>num(x.stock)<=num(x.minStock)).length;
      const months=[]; const nowD=new Date();
      for(let i=5;i>=0;i--){const d=new Date(nowD.getFullYear(),nowD.getMonth()-i,1);months.push({key:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`,label:d.toLocaleDateString('fr-FR',{month:'short',year:'2-digit'}),sales:0,expenses:0});}
      const monthMap=new Map(months.map(m=>[m.key,m]));
      sales.forEach(x=>{const d=new Date(x.date||0);const k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;if(monthMap.has(k))monthMap.get(k).sales+=num(x.total)});
      expenses.forEach(x=>{const d=new Date(x.date||0);const k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;if(monthMap.has(k))monthMap.get(k).expenses+=num(x.amount)});
      const by=(arr,key,val)=>arr.reduce((m,x)=>{const k=String(x[key]||'Non classé').slice(0,60);m[k]=(m[k]||0)+num(x[val]);return m},{});
      const salesByProduct=by(sales,'productId','total');
      const expensesByCategory=by(expenses,'category','amount');
      const invoiceStatus=by(invoices,'status','amount');
      const stockByProduct=products.reduce((m,x)=>{m[String(x.name||x.sku||x.id||'Produit').slice(0,60)]=num(x.stock);return m},{});
      const PAY_DICT={especes:'Espèces',cash:'Espèces',mobile_money:'Mobile Money',momo:'Mobile Money',orange_money:'Mobile Money',om:'Mobile Money',mtn_momo:'Mobile Money',mtn:'Mobile Money',virement:'Virement',cheque:'Chèque'};
      const paymentLabel=v=>mapLabel(v,PAY_DICT);
      const SEXE_DICT={m:'Masculin',masculin:'Masculin',homme:'Masculin',garcon:'Masculin',f:'Féminin',feminin:'Féminin',femme:'Féminin',fille:'Féminin'};
      const sexeLabel=v=>mapLabel(v,SEXE_DICT);
      const AGE_DICT={'0_5':'0-5 ans','0_5_ans':'0-5 ans','0_5ans':'0-5 ans','6_14':'6-14 ans','6_14_ans':'6-14 ans','6_14ans':'6-14 ans','15_24':'15-24 ans','15_24_ans':'15-24 ans','15_24ans':'15-24 ans','25_59':'25-59 ans','25_59_ans':'25-59 ans','25_59ans':'25-59 ans','60':'60 ans et plus','60_plus':'60 ans et plus','60_ans_et_plus':'60 ans et plus','60ansetplus':'60 ans et plus'};
      const ageLabel=v=>mapLabel(v,AGE_DICT);
      const bySexe=arr=>arr.reduce((m,x)=>{if(!x.sexe)return m;const k=sexeLabel(x.sexe);m[k]=(m[k]||0)+1;return m},{});
      const byAge=arr=>arr.reduce((m,x)=>{if(!x.trancheAge)return m;const k=ageLabel(x.trancheAge);m[k]=(m[k]||0)+1;return m},{});
      const byPayment=(arr,val)=>arr.reduce((m,x)=>{const k=paymentLabel(x.paymentMethod);m[k]=(m[k]||0)+num(x[val]);return m},{});
      const salesByPaymentMethod=byPayment(sales,'total');
      const expensesByPaymentMethod=byPayment(expenses,'amount');
      let pharma;
      if(instance==='1'){
        const nameOf=id=>{const p=products.find(x=>x.id===id);return p?String(p.name||p.sku||id).slice(0,60):String(id||'—').slice(0,60)};
        const qtyByProduct=sales.reduce((m,x)=>{const k=x.productId||'—';m[k]=(m[k]||0)+num(x.quantity);return m},{});
        const topProducts=Object.entries(qtyByProduct).map(([id,qty])=>({name:nameOf(id),qty,revenue:sales.filter(x=>x.productId===id).reduce((s,x)=>s+num(x.total),0)})).sort((a,b)=>b.qty-a.qty).slice(0,10);
        const stockStatus={normal:0,faible:0,rupture:0};
        products.forEach(x=>{const st=num(x.stock);if(st<=0)stockStatus.rupture++;else if(st<=num(x.minStock))stockStatus.faible++;else stockStatus.normal++;});
        const peremptions={expire:0,j30:0,j60:0,j90:0,plus90:0,sansDate:0};
        products.forEach(x=>{if(!x.expiryDate){peremptions.sansDate++;return}const days=Math.floor((new Date(x.expiryDate).getTime()-now)/86400000);if(days<0)peremptions.expire++;else if(days<=30)peremptions.j30++;else if(days<=60)peremptions.j60++;else if(days<=90)peremptions.j90++;else peremptions.plus90++;});
        const supplierAmount=expenses.reduce((m,x)=>{const k=String(x.supplier||x.category||'Non renseigné').slice(0,60);m[k]=(m[k]||0)+num(x.amount);return m},{});
        const topSuppliers=Object.entries(supplierAmount).map(([name,amount])=>({name,amount})).sort((a,b)=>b.amount-a.amount).slice(0,10);
        const rotation=products.map(x=>{const sold=num(qtyByProduct[x.id]||0);const stock=Math.max(1,num(x.stock));return {name:String(x.name||x.sku||x.id).slice(0,60),ratio:+(sold/stock).toFixed(2)}}).sort((a,b)=>b.ratio-a.ratio).slice(0,10);
        pharma={topProducts,stockStatus,peremptions,topSuppliers,rotation,sortiesByPeriod:months};
      }
      let sante;
      if(instance==='2'){
        const nameOfProduct=id=>{const p=products.find(x=>x.id===id);return p?String(p.name||p.sku||id).slice(0,60):String(id||'—').slice(0,60)};
        const nameOfClient=id=>{const c=clients.find(x=>x.id===id);return c?String(c.name||id).slice(0,60):String(id||'—').slice(0,60)};
        const qtyByMotif=sales.reduce((m,x)=>{const k=x.productId||'—';m[k]=(m[k]||0)+num(x.quantity||1);return m},{});
        const topPathologies=Object.entries(qtyByMotif).map(([id,qty])=>({name:nameOfProduct(id),qty,revenue:sales.filter(x=>x.productId===id).reduce((s,x)=>s+num(x.total),0)})).sort((a,b)=>b.qty-a.qty).slice(0,10);
        const countByPatient=sales.reduce((m,x)=>{const k=x.clientId||'—';if(!m[k])m[k]={count:0,amount:0};m[k].count++;m[k].amount+=num(x.total);return m},{});
        const topPatients=Object.entries(countByPatient).filter(([id])=>id!=='—').map(([id,v])=>({name:nameOfClient(id),count:v.count,amount:v.amount})).sort((a,b)=>b.count-a.count).slice(0,10);
        const stockStatus={normal:0,faible:0,rupture:0};
        products.forEach(x=>{const st=num(x.stock);if(st<=0)stockStatus.rupture++;else if(st<=num(x.minStock))stockStatus.faible++;else stockStatus.normal++;});
        const supplierAmount=expenses.reduce((m,x)=>{const k=String(x.supplier||x.category||'Non renseigné').slice(0,60);m[k]=(m[k]||0)+num(x.amount);return m},{});
        const topSuppliers=Object.entries(supplierAmount).map(([name,amount])=>({name,amount})).sort((a,b)=>b.amount-a.amount).slice(0,10);
        const overdueMs=30*86400000;
        const facturationRetard=invoices.filter(x=>x.status!=='paid'&&x.status!=='cancelled'&&x.date&&(now-new Date(x.date).getTime())>overdueMs).length;
        const patientsByPeriod=months.map(m=>({...m}));
        const consultationsByPeriod=months.map(m=>({...m}));
        const monthKeyMap=new Map(patientsByPeriod.map(m=>[m.key,{patients:new Set(),consultations:0}]));
        sales.forEach(x=>{const d=new Date(x.date||0);const k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;const b=monthKeyMap.get(k);if(!b)return;if(x.clientId)b.patients.add(x.clientId);b.consultations++;});
        patientsByPeriod.forEach(m=>{m.patients=monthKeyMap.get(m.key)?.patients.size||0});
        consultationsByPeriod.forEach(m=>{m.consultations=monthKeyMap.get(m.key)?.consultations||0});
        const ACT_DICT={consultation:'Consultation',vaccination:'Vaccination',sante_maternelle:'Santé maternelle',urgence:'Urgence',suivi_chronique:'Suivi chronique'};
        const activiteLabel=v=>mapLabel(v,ACT_DICT);
        const actMap=sales.reduce((m,x)=>{const k=activiteLabel(x.typeActivite);if(!m[k])m[k]={count:0,montant:0};m[k].count+=num(x.quantity||1);m[k].montant+=num(x.total);return m},{});
        const activiteParType=Object.entries(actMap).map(([type,v])=>({type,...v})).sort((a,b)=>b.count-a.count);
        const patientsParSexe=Object.entries(bySexe(clients)).map(([sexe,count])=>({sexe,count})).sort((a,b)=>b.count-a.count);
        const patientsParTrancheAge=Object.entries(byAge(clients)).map(([trancheAge,count])=>({trancheAge,count})).sort((a,b)=>b.count-a.count);
        sante={topPathologies,topPatients,stockStatus,topSuppliers,facturationRetard,patientsByPeriod,consultationsByPeriod,activiteParType,patientsParSexe,patientsParTrancheAge};
      }
      let ecole;
      if(instance==='3'){
        const classeOf=c=>String(c.classe||'Non renseignée').slice(0,60);
        const effMap=clients.reduce((m,c)=>{const k=classeOf(c);m[k]=(m[k]||0)+1;return m},{});
        const effectifsParClasse=Object.entries(effMap).map(([classe,effectif])=>({classe,effectif})).sort((a,b)=>b.effectif-a.effectif);
        const toDateSafe=v=>{if(!v)return null;if(typeof v.toDate==='function')return v.toDate();const d=new Date(v);return isNaN(d)?null:d};
        const inscriptionsByPeriod=months.map(m=>({...m}));
        const inscMap=new Map(inscriptionsByPeriod.map(m=>[m.key,0]));
        clients.forEach(c=>{const d=toDateSafe(c.createdAt);if(!d)return;const k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;if(inscMap.has(k))inscMap.set(k,inscMap.get(k)+1)});
        inscriptionsByPeriod.forEach(m=>{m.inscriptions=inscMap.get(m.key)||0});
        const clientClasse=new Map(clients.map(c=>[c.id,classeOf(c)]));
        const fraisMap=sales.reduce((m,x)=>{const k=clientClasse.get(x.clientId)||'Non renseignée';m[k]=(m[k]||0)+num(x.total);return m},{});
        const fraisEncaissesParClasse=Object.entries(fraisMap).map(([classe,montant])=>({classe,montant})).sort((a,b)=>b.montant-a.montant);
        const impMap=invoices.filter(x=>x.status!=='paid'&&x.status!=='cancelled').reduce((m,x)=>{const k=clientClasse.get(x.clientId)||'Non renseignée';m[k]=(m[k]||0)+num(x.amount);return m},{});
        const impayesParClasse=Object.entries(impMap).map(([classe,montant])=>({classe,montant})).sort((a,b)=>b.montant-a.montant);
        const FRAIS_DICT={inscription:'Inscription',scolarite:'Scolarité',cantine:'Cantine',transport:'Transport',uniforme:'Uniforme'};
        const typeFraisLabel=v=>mapLabel(v,FRAIS_DICT);
        const typeFraisMap=sales.reduce((m,x)=>{const k=typeFraisLabel(x.typeFrais);m[k]=(m[k]||0)+num(x.total);return m},{});
        const fraisEncaissesParType=Object.entries(typeFraisMap).map(([type,montant])=>({type,montant})).sort((a,b)=>b.montant-a.montant);
        const effectifsParSexe=Object.entries(bySexe(clients)).map(([sexe,effectif])=>({sexe,effectif})).sort((a,b)=>b.effectif-a.effectif);
        const anneeMap=sales.reduce((m,x)=>{const k=cleanString(x.anneeScolaire,20)||'Non renseignée';m[k]=(m[k]||0)+num(x.total);return m},{});
        const fraisEncaissesParAnnee=Object.entries(anneeMap).map(([annee,montant])=>({annee,montant})).sort((a,b)=>a.annee.localeCompare(b.annee));
        ecole={effectifsParClasse,inscriptionsByPeriod,fraisEncaissesParClasse,impayesParClasse,fraisEncaissesParType,effectifsParSexe,fraisEncaissesParAnnee,totalImpayes:Object.values(impMap).reduce((a,b)=>a+b,0)};
      }
      let district;
      if(instance==='4'){
        const etabOfClient=c=>String(c.etablissement||'Non renseigné').slice(0,60);
        const nameOfProduct=id=>{const p=products.find(x=>x.id===id);return p?String(p.name||p.sku||id).slice(0,60):String(id||'—').slice(0,60)};
        const clientEtab=new Map(clients.map(c=>[c.id,etabOfClient(c)]));
        const patMap=clients.reduce((m,c)=>{const k=etabOfClient(c);m[k]=(m[k]||0)+1;return m},{});
        const patientsParEtablissement=Object.entries(patMap).map(([etablissement,patients])=>({etablissement,patients})).sort((a,b)=>b.patients-a.patients);
        const actMap=sales.reduce((m,x)=>{const k=clientEtab.get(x.clientId)||'Non renseigné';if(!m[k])m[k]={consultations:0,recettes:0};m[k].consultations+=num(x.quantity||1);m[k].recettes+=num(x.total);return m},{});
        const activiteParEtablissement=Object.entries(actMap).map(([etablissement,v])=>({etablissement,...v})).sort((a,b)=>b.consultations-a.consultations);
        const stockMap=products.reduce((m,p)=>{const k=String(p.etablissement||'Non renseigné').slice(0,60);m[k]=(m[k]||0)+num(p.stock);return m},{});
        const stockParEtablissement=Object.entries(stockMap).map(([etablissement,stock])=>({etablissement,stock})).sort((a,b)=>b.stock-a.stock);
        const qtyByMotif=sales.reduce((m,x)=>{const k=x.productId||'—';m[k]=(m[k]||0)+num(x.quantity||1);return m},{});
        const topPathologies=Object.entries(qtyByMotif).map(([id,qty])=>({name:nameOfProduct(id),qty})).sort((a,b)=>b.qty-a.qty).slice(0,10);
        const patientsByPeriod=months.map(m=>({...m}));
        const consultationsByPeriod=months.map(m=>({...m}));
        const monthKeyMap=new Map(patientsByPeriod.map(m=>[m.key,{patients:new Set(),consultations:0}]));
        sales.forEach(x=>{const d=new Date(x.date||0);const k=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;const b=monthKeyMap.get(k);if(!b)return;if(x.clientId)b.patients.add(x.clientId);b.consultations++});
        patientsByPeriod.forEach(m=>{m.patients=monthKeyMap.get(m.key)?.patients.size||0});
        consultationsByPeriod.forEach(m=>{m.consultations=monthKeyMap.get(m.key)?.consultations||0});
        const ACT_DICT={consultation:'Consultation',vaccination:'Vaccination',sante_maternelle:'Santé maternelle',urgence:'Urgence',suivi_chronique:'Suivi chronique'};
        const activiteLabel=v=>mapLabel(v,ACT_DICT);
        const actTypeMap=sales.reduce((m,x)=>{const k=activiteLabel(x.typeActivite);if(!m[k])m[k]={count:0,montant:0};m[k].count+=num(x.quantity||1);m[k].montant+=num(x.total);return m},{});
        const activiteParType=Object.entries(actTypeMap).map(([type,v])=>({type,...v})).sort((a,b)=>b.count-a.count);
        const patientsParSexe=Object.entries(bySexe(clients)).map(([sexe,count])=>({sexe,count})).sort((a,b)=>b.count-a.count);
        const patientsParTrancheAge=Object.entries(byAge(clients)).map(([trancheAge,count])=>({trancheAge,count})).sort((a,b)=>b.count-a.count);
        district={patientsParEtablissement,activiteParEtablissement,stockParEtablissement,topPathologies,patientsByPeriod,consultationsByPeriod,activiteParType,patientsParSexe,patientsParTrancheAge};
      }
      return out(200,{ok:true,stats:{clients:clients.length,products:products.length,caMonth:ca,expensesMonth:dep,marginMonth:ca-dep,stockValue,lowStock,pendingTasks:tasks.filter(x=>x.status!=='done').length,unpaidInvoices:invoices.filter(x=>x.status!=='paid'&&x.status!=='cancelled').length},charts:{months,salesByProduct,expensesByCategory,invoiceStatus,stockByProduct,salesByPaymentMethod,expensesByPaymentMethod},pharma,sante,ecole,district,recent:{sales:sales.sort((a,b)=>new Date(b.date||0)-new Date(a.date||0)).slice(0,10),tasks:tasks.sort((a,b)=>new Date(a.dueDate||0)-new Date(b.dueDate||0)).slice(0,10)}},origin);
    }

    if(action==='importBatch'){
      if(body.mode!=='save')return out(400,{error:'Mode import invalide'},origin);
      const imp=body.payload||{}, col=cleanString(imp.collection,30), rows=Array.isArray(imp.rows)?imp.rows:[];
      const result=await importBatch(uid,col,rows,instance);
      return out(200,{ok:true,...result},origin);
    }
    if(action==='stockAdjust'){
      if(body.mode!=='adjust')return out(400,{error:'Opération stock invalide'},origin);
      const productId=cleanString(body.productId,120), delta=Math.trunc(num(body.delta,0)), reason=cleanString(body.reason,240);
      if(!productId||!delta||!reason)return out(400,{error:'Produit, variation et motif requis'},origin);
      const pRef=ownerRef(uid,'products',productId,instance);
      const result=await db.runTransaction(async tx=>{const ps=await tx.get(pRef);if(!ps.exists())throw Object.assign(new Error('Produit introuvable'),{status:404});const p=ps.data(),next=Math.trunc(num(p.stock)+delta);if(next<0)throw Object.assign(new Error('Stock final négatif interdit'),{status:400});tx.update(pRef,{stock:next,updatedAt:admin.firestore.FieldValue.serverTimestamp()});const lRef=ownerRef(uid,'stockMovements',db.collection('_').doc().id,instance);tx.set(lRef,{ownerUid:uid,productId,delta,reason,createdAt:admin.firestore.FieldValue.serverTimestamp()});return {stock:next};});
      return out(200,{ok:true,stock:result.stock},origin);
    }
    if(['clients','products','sales','expenses','tasks','invoices'].includes(action)){
      if(body.mode==='list')return out(200,{ok:true,items:await list(uid,action,Number(body.limit)||200,instance)},origin);
      if(body.mode==='delete'){if(action==='sales')return out(409,{error:'Les ventes sont conservées comme journal financier. Utilisez une correction/annulation plutôt qu’une suppression.'},origin);return out(200,{ok:true,deleted:await remove(uid,action,cleanString(body.id,120),instance)},origin);}
      if(body.mode==='save'){
        if(action==='sales'&&!body.id){
          const productId=cleanString(body.payload?.productId,120), qty=Math.floor(cap(body.payload?.quantity));if(!productId||qty<1)return out(400,{error:'Produit et quantité requis'},origin);
          const pRef=ownerRef(uid,'products',productId,instance);const salePayload={...body.payload};const result=await db.runTransaction(async tx=>{const ps=await tx.get(pRef);if(!ps.exists())throw new Error('Produit introuvable');const p=ps.data();if(num(p.stock)<qty)throw new Error(`Stock insuffisant (${num(p.stock)} disponible)`);const requestedUnitPrice=num(salePayload.unitPrice,0);const unitPrice=requestedUnitPrice>0?requestedUnitPrice:num(p.price);const sRef=ownerRef(uid,'sales',db.collection('_').doc().id,instance);const sale={...salePayload,ownerUid:uid,productId,quantity:qty,unitPrice,total:qty*unitPrice,date:dateIso(salePayload.date),paymentMethod:cleanString(salePayload.paymentMethod,60),typeActivite:cleanString(salePayload.typeActivite,80),typeFrais:cleanString(salePayload.typeFrais,80),anneeScolaire:cleanString(salePayload.anneeScolaire,20),createdAt:admin.firestore.FieldValue.serverTimestamp(),updatedAt:admin.firestore.FieldValue.serverTimestamp()};tx.set(sRef,sale);tx.update(pRef,{stock:Math.floor(num(p.stock)-qty),updatedAt:admin.firestore.FieldValue.serverTimestamp()});return {saleRef:sRef,remaining:Math.floor(num(p.stock)-qty)}});return out(200,{ok:true,item:docData(await result.saleRef.get()),stockRemaining:result.remaining},origin);
        }
        return out(200,{ok:true,item:await save(uid,action,body.payload||{},cleanString(body.id,120),instance)},origin);
      }
    }
    return out(400,{error:'Requête commerciale invalide'},origin);
  }catch(e){console.error('[commercial]',e);return out(e.status||500,{error:e.message||'Erreur serveur'},origin);}
};
