/* StatAnalyse Pro — moteur statistique publication (serveur)
 * Les calculs sont déterministes et exécutés côté serveur. Le navigateur ne
 * produit plus les p-values du mode « publication ».
 */
const admin = require('firebase-admin');
const sec=require('./_security');
if (!admin.apps.length) {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw) admin.initializeApp({ credential: admin.credential.cert(JSON.parse(raw)) });
}

function responseHeaders(origin=''){ return sec.securityHeaders(origin); }
const ipCalls = new Map();
function rate(ip){ const now=Date.now(), a=(ipCalls.get(ip)||[]).filter(t=>now-t<60000); if(a.length>=30)return false; a.push(now); ipCalls.set(ip,a); return true; }
const esc = x => String(x ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const num = v => { const x=parseFloat(String(v??'').replace(',','.')); return Number.isFinite(x)?x:null; };
const mean = a => a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN;
const variance = a => { if(a.length<2)return NaN; const m=mean(a); return a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1); };
const sd = a => Math.sqrt(variance(a));
const fmt = x => Number.isFinite(x) ? (Math.abs(x)<0.00005?'0.0000':x.toFixed(4)) : '—';
const pFmt = x => Number.isFinite(x) ? (x<0.0001?'<0.0001':x.toFixed(4)) : '—';
const erf=x=>{const s=x<0?-1:1,z=Math.abs(x),t=1/(1+0.3275911*z),p=((((1.061405429*t-1.453152027)*t+1.421413741)*t-0.284496736)*t+0.254829592)*t;return s*(1-p*Math.exp(-z*z));};
const normCDF=z=>0.5*(1+erf(z/Math.SQRT2));
const normalP = z => Math.max(0,Math.min(1,2*(1-normCDF(Math.abs(z)))));
const logGamma=z=>{const co=[0.9999999999998099,676.5203681218851,-1259.1392167224028,771.3234287776531,-176.6150291621406,12.507343278686905,-0.13857109526572012,9.984369578019572e-6,1.5056327351493116e-7],g=7;if(z<0.5)return Math.log(Math.PI)-Math.log(Math.sin(Math.PI*z))-logGamma(1-z);let zz=z-1,x=co[0];for(let i=1;i<co.length;i++)x+=co[i]/(zz+i);const t=zz+g+0.5;return .5*Math.log(2*Math.PI)+(zz+.5)*Math.log(t)-t+Math.log(x);};
const betacf=(a,b,x)=>{const MAX=300,EPS=3e-14,FPMIN=1e-300;let qab=a+b,qap=a+1,qam=a-1,c=1,d=1-qab*x/qap;if(Math.abs(d)<FPMIN)d=FPMIN;d=1/d;let h=d;for(let m=1;m<=MAX;m++){let m2=2*m,aa=m*(b-m)*x/((qam+m2)*(a+m2));d=1+aa*d;if(Math.abs(d)<FPMIN)d=FPMIN;c=1+aa/c;if(Math.abs(c)<FPMIN)c=FPMIN;d=1/d;h*=d*c;aa=-(a+m)*(qab+m)*x/((a+m2)*(qap+m2));d=1+aa*d;if(Math.abs(d)<FPMIN)d=FPMIN;c=1+aa/c;if(Math.abs(c)<FPMIN)c=FPMIN;d=1/d;const del=d*c;h*=del;if(Math.abs(del-1)<EPS)break;}return h;};
const betaInc=(a,b,x)=>{if(x<=0)return 0;if(x>=1)return 1;const bt=Math.exp(logGamma(a+b)-logGamma(a)-logGamma(b)+a*Math.log(x)+b*Math.log(1-x));return x<(a+1)/(a+b+2)?bt*betacf(a,b,x)/a:1-bt*betacf(b,a,1-x)/b;};
const chiP=(x,df)=>{if(x<=0)return 1;const a=df/2,xx=x/2;let ap=a,sum=1/a,del=sum;if(xx<a+1){for(let n=1;n<=300;n++){ap++;del*=xx/ap;sum+=del;if(Math.abs(del)<Math.abs(sum)*1e-13)break;}return Math.max(0,Math.min(1,1-sum*Math.exp(-xx+a*Math.log(xx)-logGamma(a))));}let b=xx+1-a,c=1e300,d=1/b,h=d;for(let i=1;i<=300;i++){const an=-i*(i-a),aa=b+2*i;d=an*d+aa;if(Math.abs(d)<1e-300)d=1e-300;c=aa+an/c;if(Math.abs(c)<1e-300)c=1e-300;d=1/d;const del=d*c;h*=del;if(Math.abs(del-1)<1e-13)break;}return Math.max(0,Math.min(1,Math.exp(-xx+a*Math.log(xx)-logGamma(a))*h));};
const tP=(t,df)=>{const x=df/(df+t*t),tail=.5*betaInc(df/2,.5,x);return Math.max(0,Math.min(1,2*tail));};
const fP=(f,df1,df2)=>{if(f<=0)return 1;const x=df2/(df2+df1*f);return Math.max(0,Math.min(1,betaInc(df2/2,df1/2,x)));};
const normInv=q=>{let lo=-9,hi=9;for(let i=0;i<100;i++){const m=(lo+hi)/2;if(normCDF(m)<q)lo=m;else hi=m;}return (lo+hi)/2;};
function transpose(A){return A[0].map((_,j)=>A.map(r=>r[j]));}
function mm(A,B){const Bt=transpose(B);return A.map(r=>Bt.map(c=>r.reduce((s,x,i)=>s+x*c[i],0)));}
function mv(A,v){return A.map(r=>r.reduce((s,x,i)=>s+x*v[i],0));}
function dot(a,b){return a.reduce((s,x,i)=>s+x*b[i],0);}
function qrSolve(A,y){
  const m=A.length,n=A[0].length,Q=A.map(r=>r.slice()),R=Array.from({length:n},()=>Array(n).fill(0));
  for(let k=0;k<n;k++){
    let norm=0; for(let i=k;i<m;i++)norm=Math.hypot(norm,Q[i][k]);
    if(norm<1e-12)return null;
    if(Q[k][k]<0)norm=-norm;
    for(let i=k;i<m;i++)Q[i][k]/=norm;
    Q[k][k]+=1;
    for(let j=k+1;j<n;j++){
      const v=Array(m-k).fill(0); for(let i=k;i<m;i++)v[i-k]=Q[i][k];
      let s=0; for(let i=k;i<m;i++)s+=v[i-k]*Q[i][j];
      for(let i=k;i<m;i++)Q[i][j]-=2*v[i-k]*s;
    }
    R[k][k]=-norm;
    for(let j=k+1;j<n;j++){let s=0;for(let i=k;i<m;i++)s+=Q[i][k]*Q[i][j];R[k][j]=-s;}
    for(let i=k+1;i<m;i++)Q[i][k]=0;
  }
  const qty=y.slice();
  for(let k=0;k<n;k++){let s=0;for(let i=k;i<m;i++)s+=Q[i][k]*qty[i];for(let i=k;i<m;i++)qty[i]-=2*Q[i][k]*s;}
  const b=Array(n).fill(0); for(let i=n-1;i>=0;i--){let s=qty[i];for(let j=i+1;j<n;j++)s-=R[i][j]*b[j];if(Math.abs(R[i][i])<1e-12)return null;b[i]=s/R[i][i];}
  return {b,R,Q};
}
function invUpper(R){const n=R.length,I=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?1:0));for(let col=0;col<n;col++)for(let i=n-1;i>=0;i--){let s=I[i][col];for(let j=i+1;j<n;j++)s-=R[i][j]*I[j][col];I[i][col]=s/R[i][i];}return I;}
function ols(X,y){ if(!X.length||X.length<X[0].length)return null; const fit=qrSolve(X,y); if(!fit)return null; const b=fit.b, yh=mv(X,b), res=y.map((v,i)=>v-yh[i]), n=y.length,p=b.length,sse=dot(res,res),df=Math.max(1,n-p),mse=sse/df; const Rinv=invUpper(fit.R),cov=mm(Rinv,transpose(Rinv)).map(r=>r.map(v=>v*mse)); return {b,res,n,p,sse,df,mse,cov,yh}; }
function ranks(a){const s=a.map((v,i)=>({v,i})).sort((x,y)=>x.v-y.v),r=Array(a.length);for(let i=0;i<s.length;){let j=i+1;while(j<s.length&&s[j].v===s[i].v)j++;const rr=(i+j+1)/2;for(let k=i;k<j;k++)r[s[k].i]=rr;i=j;}return r;}
function tieCorrection(a){const s=a.slice().sort((x,y)=>x-y);let sum=0;for(let i=0;i<s.length;){let j=i+1;while(j<s.length&&s[j]===s[i])j++;const t=j-i;if(t>1)sum+=t**3-t;i=j;}return sum/(a.length**3-a.length||1);}
function jacobiSym(A){const n=A.length,M=A.map(r=>r.slice()),V=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?1:0));for(let it=0;it<100*n*n;it++){let p=0,q=1,max=0;for(let i=0;i<n;i++)for(let j=i+1;j<n;j++)if(Math.abs(M[i][j])>max){max=Math.abs(M[i][j]);p=i;q=j;}if(max<1e-12)break;const phi=.5*Math.atan2(2*M[p][q],M[q][q]-M[p][p]),c=Math.cos(phi),s=Math.sin(phi);for(let i=0;i<n;i++){const mip=M[i][p],miq=M[i][q];M[i][p]=c*mip-s*miq;M[i][q]=s*mip+c*miq;}for(let j=0;j<n;j++){const mpj=M[p][j],mqj=M[q][j];M[p][j]=c*mpj-s*mqj;M[q][j]=s*mpj+c*mqj;}for(let i=0;i<n;i++){const vip=V[i][p],viq=V[i][q];V[i][p]=c*vip-s*viq;V[i][q]=s*vip+c*viq;}}const eig=M.map((r,i)=>({value:r[i],vector:V.map(row=>row[i])})).sort((a,b)=>b.value-a.value);return eig;}
function header(title,sub){return `<h3>${title}</h3><p style="color:var(--muted)">${sub}</p><div style="font-size:.72rem;color:var(--muted);margin-top:8px">🔬 Moteur publication serveur · calcul déterministe · résultats non simulés côté navigateur.</div>`;}
function rowsFor(DATA, cols){return DATA.map(r=>cols.map(c=>num(r[c])));}

function sampleSize(b){
  const alpha=Number(b.alpha),power=Number(b.power),effect=Number(b.effect),mode=b.mode||'means';
  if(!(alpha>0&&alpha<1&&power>0&&power<1&&effect>0))throw new Error('Paramètres de taille d’échantillon invalides.');
  const z1=normInv(1-alpha/2),zb=normInv(power);
  let n;if(mode==='means')n=2*((z1+zb)/effect)**2;else if(mode==='props')n=2*(z1+zb)**2*.25/effect**2;else throw new Error('Type inconnu.');
  return {html:header('📐 Taille d’échantillon',`α = ${fmt(alpha)} · puissance = ${fmt(power)} · effet = ${fmt(effect)}`)+`<p><b>${Math.ceil(n)} participants par groupe</b> (${Math.ceil(2*n)} au total).</p><p>Calcul bilatéral standard pour deux groupes indépendants. La correction pour abandon/non-réponse doit être ajoutée séparément.</p>`};
}
function logistic(b){
  const DATA=b.data||[], yName=b.y, xNames=b.x||[]; const cats=[...new Set(DATA.map(r=>String(r[yName]??'').trim()).filter(Boolean))]; if(cats.length!==2)throw new Error('Y doit avoir exactement 2 modalités.'); if(!xNames.length)throw new Error('Sélectionnez au moins une variable X.');
  const pos=cats[1],rows=[]; DATA.forEach(r=>{const y=String(r[yName]??'').trim(),x=xNames.map(n=>num(r[n]));if(y&&x.every(v=>v!==null))rows.push({y:y===pos?1:0,x:[1,...x]});}); if(rows.length<xNames.length+10)throw new Error(`Observations complètes insuffisantes (n=${rows.length}).`);
  let bta=Array(xNames.length+1).fill(0), converged=false, iter=0;
  for(iter=0;iter<100;iter++){
    const p=rows.map(o=>1/(1+Math.exp(-Math.max(-35,Math.min(35,dot(o.x,bta))))));
    const w=p.map(q=>Math.max(q*(1-q),1e-10));
    const z=rows.map((o,i)=>dot(o.x,bta)+(o.y-p[i])/w[i]);
    const X=rows.map((o,i)=>o.x.map(v=>Math.sqrt(w[i])*v)),Y=z.map((v,i)=>Math.sqrt(w[i])*v),fit=qrSolve(X,Y); if(!fit)throw new Error('Matrice singulière : variables X trop redondantes.');
    const next=fit.b; let d=0;for(let j=0;j<next.length;j++)d=Math.max(d,Math.abs(next[j]-bta[j]));bta=next;if(d<1e-8){converged=true;break;}
  }
  if(!converged)throw new Error('La régression logistique n’a pas convergé après 100 itérations. Vérifiez la séparation complète, les valeurs extrêmes et la colinéarité.');
  const eta=rows.map(o=>dot(o.x,bta)),pr=eta.map(e=>1/(1+Math.exp(-Math.max(-35,Math.min(35,e))))),W=Array.from({length:bta.length},()=>Array(bta.length).fill(0));rows.forEach((o,i)=>{const w=Math.max(pr[i]*(1-pr[i]),1e-10);for(let j=0;j<bta.length;j++)for(let k=0;k<bta.length;k++)W[j][k]+=w*o.x[j]*o.x[k];});
  // covariance = inverse information matrix via Gauss-Jordan
  function inverse(M){const n=M.length,A=M.map((r,i)=>r.slice().concat(Array.from({length:n},(_,j)=>i===j?1:0)));for(let c=0;c<n;c++){let p=c;for(let r=c+1;r<n;r++)if(Math.abs(A[r][c])>Math.abs(A[p][c]))p=r;if(Math.abs(A[p][c])<1e-12)return null;[A[p],A[c]]=[A[c],A[p]];const q=A[c][c];for(let j=0;j<2*n;j++)A[c][j]/=q;for(let r=0;r<n;r++)if(r!==c){const f=A[r][c];for(let j=0;j<2*n;j++)A[r][j]-=f*A[c][j];}}return A.map(r=>r.slice(n));}
  const cov=inverse(W); let html=header('📈 Régression logistique',`n = ${rows.length} · événement positif = <b>${esc(pos)}</b> · itérations = ${iter+1}`)+`<div style="overflow:auto"><table><tr><th>Variable</th><th>β</th><th>OR</th><th>IC95% OR</th><th>p</th></tr>`;
  bta.forEach((co,j)=>{const se=cov?Math.sqrt(Math.max(cov[j][j],0)):NaN,z=se?co/se:NaN,or=j?Math.exp(co):NaN,lo=j?Math.exp(co-1.96*se):NaN,hi=j?Math.exp(co+1.96*se):NaN;html+=`<tr><td>${j?' '+esc(xNames[j-1]):'Constante'}</td><td>${fmt(co)}</td><td>${j?fmt(or):'—'}</td><td>${j?`${fmt(lo)}–${fmt(hi)}`:'—'}</td><td>${se?pFmt(normalP(z)):'—'}</td></tr>`});html+='</table></div><p style="color:var(--muted)">Les IC sont des IC asymptotiques de Wald. Vérifier la séparation, les diagnostics de modèle et l’adéquation avant publication.</p>';
  return {html};
}
function ancova(b){
  const DATA=b.data||[],y=b.y,g=b.group,c=b.cov,groups=[...new Set(DATA.map(r=>String(r[g]??'').trim()).filter(Boolean))];if(groups.length<2)throw new Error('Il faut au moins 2 groupes.');const base=groups[0],rows=[];DATA.forEach(r=>{const yy=num(r[y]),cc=num(r[c]),gg=String(r[g]??'').trim();if(yy!==null&&cc!==null&&gg)rows.push({y:yy,g:gg,c:cc});});const X=rows.map(o=>[1,...groups.slice(1).map(z=>o.g===z?1:0),o.c]),Y=rows.map(o=>o.y),fit=ols(X,Y);if(!fit)throw new Error('ANCOVA impossible : matrice singulière.');
  let html=header('⚖️ ANCOVA',`Y = <b>${esc(y)}</b> · facteur = <b>${esc(g)}</b> · covariable = <b>${esc(c)}</b> · n = ${rows.length}`)+`<div style="overflow:auto"><table><tr><th>Effet</th><th>β</th><th>SE</th><th>t</th><th>p</th><th>IC95%</th></tr>`;
  for(let j=1;j<fit.b.length;j++){const se=Math.sqrt(Math.max(fit.cov[j][j],0)),t=se?fit.b[j]/se:NaN,lab=j<groups.length?`${groups[j]} vs ${base}`:`Covariable ${c}`,lo=fit.b[j]-1.96*se,hi=fit.b[j]+1.96*se;html+=`<tr><td>${esc(lab)}</td><td>${fmt(fit.b[j])}</td><td>${fmt(se)}</td><td>${fmt(t)}</td><td>${pFmt(tP(t,fit.df))}</td><td>${fmt(lo)}–${fmt(hi)}</td></tr>`;}html+='</table></div>';
  // Omnibus factor via reduced/full SSE comparison
  const X0=rows.map(o=>[1,o.c]),f0=ols(X0,Y),q=groups.length-1;if(f0&&q>0){const df1=q,df2=fit.df,F=((f0.sse-fit.sse)/df1)/(fit.sse/df2);html+=`<p><b>Test omnibus du facteur :</b> F(${df1}, ${df2}) = ${fmt(F)}, p = <b>${pFmt(fP(F,df1,df2))}</b>.</p>`;}html+='<p style="color:var(--muted)">L’ANCOVA suppose notamment une relation linéaire, une homogénéité des pentes et des résidus compatibles avec le modèle.</p>';return {html};
}
function reliability(b){const DATA=b.data||[],names=b.items||[];if(names.length<2)throw new Error('Sélectionnez au moins 2 items.');const rows=rowsFor(DATA,names).filter(a=>a.every(v=>v!==null));if(rows.length<2)throw new Error('Données insuffisantes.');const k=names.length,tot=rows.map(a=>a.reduce((s,v)=>s+v,0)),sumVar=names.reduce((s,_,j)=>s+variance(rows.map(a=>a[j])),0),vt=variance(tot);if(!(vt>0))throw new Error('Variance totale nulle.');const alpha=(k/(k-1))*(1-sumVar/vt);return {html:header('🔐 Fiabilité interne',`Items = ${k} · observations complètes = ${rows.length}`)+`<p><b>Alpha de Cronbach = ${fmt(alpha)}</b></p><p>Formule calculée sur les observations complètes. L’alpha ne démontre pas l’unidimensionnalité ; examiner la structure factorielle et les items inversés avant interprétation.</p>`};}
function pca(b){const DATA=b.data||[],names=b.items||[];if(names.length<2)throw new Error('Sélectionnez au moins 2 variables.');const rows=rowsFor(DATA,names).filter(a=>a.every(v=>v!==null));if(rows.length<3)throw new Error('Données insuffisantes.');const n=rows.length,k=names.length,Z=Array.from({length:n},()=>Array(k));for(let j=0;j<k;j++){const a=rows.map(r=>r[j]),m=mean(a),s=sd(a);if(!(s>0))throw new Error(`Variance nulle pour ${names[j]}.`);for(let i=0;i<n;i++)Z[i][j]=(a[i]-m)/s;}const C=Array.from({length:k},(_,i)=>Array.from({length:k},(_,j)=>Z.reduce((s,r)=>s+r[i]*r[j],0)/(n-1)));const eig=jacobiSym(C),total=eig.reduce((s,e)=>s+e.value,0);let cum=0,html=header('📉 ACP',`Variables = ${k} · observations complètes = ${n}`)+`<div style="overflow:auto"><table><tr><th>Composante</th><th>Valeur propre</th><th>Variance expliquée</th><th>Cumul</th></tr>`;eig.forEach((e,i)=>{const pct=100*e.value/total;cum+=pct;html+=`<tr><td>CP${i+1}</td><td>${fmt(e.value)}</td><td>${fmt(pct)} %</td><td>${fmt(cum)} %</td></tr>`});html+='</table></div><p style="color:var(--muted)">ACP sur matrice de corrélations standardisée. Utiliser le scree plot, la théorie et les saturations pour décider du nombre de composantes.</p>';return {html};}
function roc(b){const DATA=b.data||[],y=b.y,x=b.x,cats=[...new Set(DATA.map(r=>String(r[y]??'').trim()).filter(Boolean))];if(cats.length!==2)throw new Error('La cible doit avoir 2 modalités.');const pos=cats[1],arr=[];DATA.forEach(r=>{const s=num(r[x]),yy=String(r[y]??'').trim();if(s!==null&&yy)arr.push({s,y:yy===pos?1:0});});if(arr.length<5)throw new Error('Données insuffisantes.');const P=arr.filter(o=>o.y).length,N=arr.length-P;if(!P||!N)throw new Error('La cible doit contenir des positifs et des négatifs.');
  // AUC = Mann-Whitney probability with midranks; tie-aware and independent of threshold ordering.
  const rs=ranks(arr.map(o=>o.s)),sumPos=arr.reduce((s,o,i)=>s+(o.y?rs[i]:0),0),auc=(sumPos-P*(P+1)/2)/(P*N);
  let best={j:-Infinity,thr:null,sens:0,spec:0};const thresholds=[...new Set(arr.map(o=>o.s))].sort((a,b)=>b-a);thresholds.forEach(t=>{let TP=0,FP=0;arr.forEach(o=>{if(o.s>=t)(o.y?TP++:FP++)});const se=TP/P,sp=1-FP/N,j=se+sp-1;if(j>best.j)best={j,thr:t,sens:se,spec:sp};});
  return {html:header('🎯 Courbe ROC',`n = ${arr.length} · positif = <b>${esc(pos)}</b>`)+`<p><b>AUC = ${fmt(auc)}</b></p><p>Seuil de Youden = <b>${fmt(best.thr)}</b> · sensibilité = <b>${fmt(100*best.sens)} %</b> · spécificité = <b>${fmt(100*best.spec)} %</b>.</p><p style="color:var(--muted)">AUC calculée avec gestion des ex æquo par rangs moyens. Pour un IC95% d’AUC, utiliser une méthode bootstrap/DeLong dédiée.</p>`};
}
function survival(b){const DATA=b.data||[],tn=b.time,en=b.event,gn=b.group||null,rows=DATA.map(r=>({t:num(r[tn]),e:num(r[en]),g:gn?String(r[gn]??'').trim():'Tous'})).filter(o=>o.t!==null&&(o.e===0||o.e===1)&&o.g);if(!rows.length)throw new Error('Aucune observation de survie valide.');const groups=[...new Set(rows.map(o=>o.g))];
  const km=g=>{const a=rows.filter(o=>o.g===g).sort((x,y)=>x.t-y.t),out=[];let at=a.length,S=1,med=null,events=0;for(let i=0;i<a.length;){const t=a[i].t;let d=0,c=0,j=i;while(j<a.length&&a[j].t===t){a[j].e===1?d++:c++;j++;}if(d){S*=1-d/at;events+=d;if(med===null&&S<=.5)med=t;out.push({t,S,at,d,c});}at-=d+c;i=j;}return{n:a.length,med,events,pts:out};};
  let html=header('⏳ Analyse de survie — Kaplan-Meier',`Temps = <b>${esc(tn)}</b> · événement = <b>${esc(en)}</b>`)+`<div style="overflow:auto"><table><tr><th>Groupe</th><th>n</th><th>Événements</th><th>Médiane</th><th>Survie finale</th></tr>`;groups.forEach(g=>{const r=km(g),last=r.pts.at(-1);html+=`<tr><td>${esc(g)}</td><td>${r.n}</td><td>${r.events}</td><td>${r.med??'Non atteinte'}</td><td>${last?fmt(last.S*100)+' %':'100.0000 %'}</td></tr>`});html+='</table></div>';
  if(groups.length===2){const [g1,g2]=groups,allT=[...new Set(rows.map(o=>o.t))].sort((a,b)=>a-b);let O1=0,E1=0,V=0;for(const t of allT){const r1=rows.filter(o=>o.g===g1&&o.t>=t).length,r2=rows.filter(o=>o.g===g2&&o.t>=t).length,d1=rows.filter(o=>o.g===g1&&o.t===t&&o.e===1).length,d2=rows.filter(o=>o.g===g2&&o.t===t&&o.e===1).length,d=d1+d2,R=r1+r2;if(R>1&&d>0){const e1=d*r1/R,v=d*r1*r2*(R-d)/(R*R*Math.max(1,R-1));O1+=d1;E1+=e1;V+=v;}}const chi=(V>0?(O1-E1)**2/V:0);html+=`<p><b>Test du log-rank :</b> χ²(1) = ${fmt(chi)}, p = <b>${pFmt(chiP(chi,1))}</b>.</p>`;}
  html+='<p style="color:var(--muted)">La gestion des ex æquo et de la censure suit la construction de Kaplan-Meier. Pour une analyse ajustée, compléter par un modèle de Cox et vérifier les hypothèses.</p>';return {html};
}
function nonparam(b){const test=b.test,DATA=b.data||[];if(test==='mw'){const y=b.y,g=b.group,groups=[...new Set(DATA.map(r=>String(r[g]??'').trim()).filter(Boolean))];if(groups.length!==2)throw new Error('Mann-Whitney nécessite exactement 2 groupes.');const a=[],bb=[];DATA.forEach(r=>{const v=num(r[y]),gg=String(r[g]??'').trim();if(v!==null){if(gg===groups[0])a.push(v);if(gg===groups[1])bb.push(v);}});if(a.length<2||bb.length<2)throw new Error('Données insuffisantes.');const all=a.concat(bb),rs=ranks(all),R1=rs.slice(0,a.length).reduce((s,v)=>s+v,0),n1=a.length,n2=bb.length,U=R1-n1*(n1+1)/2,mu=n1*n2/2,C=tieCorrection(all),varU=n1*n2*(n1+n2+1)/12*(1-C),z=(U-mu-.5*Math.sign(U-mu))/Math.sqrt(Math.max(varU,1e-12));return {html:header('🧪 Mann-Whitney',`${esc(groups[0])}: n=${n1} · ${esc(groups[1])}: n=${n2}`)+`<p>U = <b>${fmt(U)}</b> · z = ${fmt(z)} · p = <b>${pFmt(normalP(z))}</b>.</p><p style="color:var(--muted)">Correction de continuité et correction des ex æquo appliquées à l’approximation normale.</p>`};}
  if(test==='kw'){const y=b.y,g=b.group,groups=[...new Set(DATA.map(r=>String(r[g]??'').trim()).filter(Boolean))],arr=[];DATA.forEach(r=>{const v=num(r[y]),gg=String(r[g]??'').trim();if(v!==null&&gg)arr.push({v,g:gg});});if(groups.length<3)throw new Error('Kruskal-Wallis nécessite au moins 3 groupes.');const rs=ranks(arr.map(o=>o.v)),N=arr.length,C=tieCorrection(arr.map(o=>o.v));let H=0;groups.forEach(gg=>{const idx=arr.map((o,i)=>o.g===gg?i:-1).filter(i=>i>=0),R=idx.reduce((s,i)=>s+rs[i],0);H+=R*R/idx.length;});H=12/(N*(N+1))*H-3*(N+1);H/=Math.max(1,1-C);return {html:header('🧪 Kruskal-Wallis',`k = ${groups.length} · N = ${N}`)+`<p>H corrigé = <b>${fmt(H)}</b> · ddl = ${groups.length-1} · p = <b>${pFmt(chiP(H,groups.length-1))}</b>.</p><p style="color:var(--muted)">Correction des ex æquo appliquée. Si le test est significatif, effectuer des comparaisons post-hoc avec correction de multiplicité.</p>`};}
  const y1=b.y,y2=b.y2,d=[];DATA.forEach(r=>{const x=num(r[y1]),z=num(r[y2]);if(x!==null&&z!==null)d.push(x-z);});const nz=d.filter(v=>v!==0),rs=ranks(nz.map(v=>Math.abs(v))),n=nz.length;if(n<5)throw new Error('Données appariées insuffisantes.');const Wp=nz.reduce((s,v,i)=>s+(v>0?rs[i]:0),0),mu=n*(n+1)/4,C=tieCorrection(nz.map(v=>Math.abs(v))),varW=n*(n+1)*(2*n+1)/24*(1-C),z=(Wp-mu-.5*Math.sign(Wp-mu))/Math.sqrt(Math.max(varW,1e-12));return {html:header('🧪 Wilcoxon apparié',`Paires non nulles = ${n}`)+`<p>W+ = <b>${fmt(Wp)}</b> · z = ${fmt(z)} · p = <b>${pFmt(normalP(z))}</b>.</p><p style="color:var(--muted)">Approximation normale avec correction de continuité et gestion des ex æquo. Pour petits échantillons, préférer la distribution exacte.</p>`};
}


/* ===== V40 PUBLICATION EXTENSIONS ===== */
function combinations(n,k){
  if(k<0||k>n)return 0;k=Math.min(k,n-k);let r=1;
  for(let i=1;i<=k;i++) r=r*(n-k+i)/i;
  return r;
}
function mwExactP(n1,n2,U){
  if(n1>30||n2>30)return null;
  const N=n1+n2, max=n1*n2, target=Math.round(U);
  if(Math.abs(U-target)>1e-9)return null;
  // DP for number of allocations producing each U (no ties).
  let dp=Array.from({length:n1+1},()=>Array(max+1).fill(0)); dp[0][0]=1;
  for(let i=0;i<N;i++){
    const ndp=Array.from({length:n1+1},()=>Array(max+1).fill(0));
    for(let a=0;a<=Math.min(i,n1);a++) for(let u=0;u<=max;u++){
      const c=dp[a][u]; if(!c)continue;
      // next observation assigned group 2
      ndp[a][u]+=c;
      // assigned group 1: contributes number of prior group-2 ranks = i-a
      if(a<n1) ndp[a+1][u+(i-a)]+=c;
    }
    dp=ndp;
  }
  const row=dp[n1], total=combinations(N,n1);
  let lo=0,le=0;
  for(let u=0;u<=max;u++){lo+=row[u];if(u<=target)le+=row[u];}
  const left=le/total, right=1-(target>0?row.slice(0,target).reduce((s,c)=>s+c,0):0)/total;
  return Math.min(1,2*Math.min(left,right));
}
function wilcoxonExactP(absDiffs, signs){
  const n=absDiffs.length;
  if(n>30)return null;
  const ranks0=absDiffs.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v);
  for(let i=1;i<ranks0.length;i++) if(ranks0[i].v===ranks0[i-1].v)return null;
  const rankByOriginal=Array(n);ranks0.forEach((o,i)=>rankByOriginal[o.i]=i+1); const ranks=rankByOriginal,total=n*(n+1)/2;
  let W=0; for(let i=0;i<n;i++)if(signs[i]>0)W+=ranks[i];
  // enumerate subset sums
  const dp=Array(total+1).fill(0);dp[0]=1;
  for(const r of ranks)for(let s=total;s>=r;s--)dp[s]+=dp[s-r];
  let lo=0;for(let s=0;s<=Math.round(W);s++)lo+=dp[s];
  const all=2**n, left=lo/all, right=1-(Math.round(W)>0?dp.slice(0,Math.round(W)).reduce((a,c)=>a+c,0):0)/all;
  return Math.min(1,2*Math.min(left,right));
}
function rankSumEffect(U,n1,n2){return 1-(2*U)/(n1*n2);}
function holmAdjust(pvals){
  const indexed=pvals.map((p,i)=>({p:Math.max(0,Math.min(1,p)),i})).sort((a,b)=>a.p-b.p);
  const out=Array(pvals.length).fill(1);let prev=0;
  indexed.forEach((o,j)=>{const adj=Math.min(1,Math.max(prev,(indexed.length-j)*o.p));out[o.i]=adj;prev=adj;});
  return out;
}
function bhAdjust(pvals){
  const indexed=pvals.map((p,i)=>({p:Math.max(0,Math.min(1,p)),i})).sort((a,b)=>a.p-b.p);
  const out=Array(pvals.length).fill(1);let prev=1;
  for(let j=indexed.length-1;j>=0;j--){const adj=Math.min(prev,indexed[j].p*indexed.length/(j+1));out[indexed[j].i]=adj;prev=adj;}
  return out;
}
function multipleTesting(b){
  const p=(b.pvalues||[]).map(Number).filter(Number.isFinite);
  if(!p.length)throw new Error('Aucune p-value valide.');
  const method=b.methodName||'holm', adj=method==='bonferroni'?p.map(x=>Math.min(1,x*p.length)):method==='bh'?bhAdjust(p):holmAdjust(p);
  return {html:header('🧮 Correction de multiplicité',`m = ${p.length}`)+`<p>Méthode : <b>${esc(method)}</b></p><div style="overflow:auto"><table><tr><th>p brute</th><th>p ajustée</th></tr>${p.map((x,i)=>`<tr><td>${pFmt(x)}</td><td><b>${pFmt(adj[i])}</b></td></tr>`).join('')}</table></div>`,stats:{p_raw:p,p_adjusted:adj,method}};
}
function dunnPosthoc(b){
  const DATA=b.data||[], y=b.y,g=b.group, groups=[...new Set(DATA.map(r=>String(r[g]??'').trim()).filter(Boolean))];
  const arr=[];DATA.forEach(r=>{const v=num(r[y]),gg=String(r[g]??'').trim();if(v!==null&&gg)arr.push({v,g:gg});});
  if(groups.length<3)throw new Error('Dunn nécessite au moins 3 groupes.');
  const rs=ranks(arr.map(o=>o.v)),N=arr.length,C=tieCorrection(arr.map(o=>o.v)),pairs=[],raw=[];
  for(let i=0;i<groups.length;i++)for(let j=i+1;j<groups.length;j++){
    const A=groups[i],B=groups[j],ia=arr.map((o,k)=>o.g===A?k:-1).filter(k=>k>=0),ib=arr.map((o,k)=>o.g===B?k:-1).filter(k=>k>=0);
    const n1=ia.length,n2=ib.length,R1=ia.reduce((s,k)=>s+rs[k],0),z=(R1/n1-R1*0/n1-(N+1)/2)/Math.sqrt(Math.max(1e-12,(N*(N+1)/12)*(1-C)*(1/n1+1/n2)));
    const p=normalP(z);pairs.push([A,B]);raw.push(p);
  }
  const adj=holmAdjust(raw);
  const rows=pairs.map((q,i)=>`<tr><td>${esc(q[0])} vs ${esc(q[1])}</td><td>${pFmt(raw[i])}</td><td><b>${pFmt(adj[i])}</b></td></tr>`).join('');
  return {html:header('🔎 Dunn post-hoc',`k = ${groups.length} · N = ${N}`)+`<div style="overflow:auto"><table><tr><th>Comparaison</th><th>p brute</th><th>p Holm</th></tr>${rows}</table></div>`,stats:{comparisons:pairs.map((q,i)=>({groups:q,p:raw[i],p_adjusted:adj[i]})),method:'Dunn + Holm'}};
}
function rocDeLong(scores,labels){
  const pos=scores.filter((_,i)=>labels[i]===1),neg=scores.filter((_,i)=>labels[i]===0);
  const auc=pos.reduce((s,p)=>s+neg.reduce((a,n)=>a+(p>n?1:p===n?.5:0),0),0)/(pos.length*neg.length);
  const vx=pos.map(p=>neg.reduce((s,n)=>s+(p>n?1:p===n?.5:0),0)/neg.length);
  const vy=neg.map(n=>pos.reduce((s,p)=>s+(p>n?1:p===n?.5:0),0)/pos.length);
  const mx=mean(vx),my=mean(vy),sx=vx.reduce((s,v)=>s+(v-mx)**2,0)/(Math.max(1,vx.length-1)),sy=vy.reduce((s,v)=>s+(v-my)**2,0)/(Math.max(1,vy.length-1));
  const se=Math.sqrt(Math.max(0,sx/pos.length+sy/neg.length)),z=se>0?auc/se:0,ci=[Math.max(0,auc-1.959964*se),Math.min(1,auc+1.959964*se)];
  return {auc,se,z,p:normalP(z),ci95:ci};
}
function coxPH(b){
  const DATA=b.data||[],time=b.time,event=b.event,xNames=b.x||[];
  if(!xNames.length)throw new Error('Sélectionnez au moins une covariable.');
  const rows=DATA.map(r=>({t:num(r[time]),e:num(r[event]),x:xNames.map(n=>num(r[n]))})).filter(o=>o.t!==null&&(o.e===0||o.e===1)&&o.x.every(v=>v!==null));
  if(rows.length<Math.max(20,5*xNames.length)||rows.filter(o=>o.e===1).length<5)throw new Error('Échantillon ou nombre d’événements insuffisant pour Cox.');
  let beta=Array(xNames.length).fill(0),converged=false;
  for(let it=0;it<60;it++){
    const score=Array(xNames.length).fill(0),info=Array.from({length:xNames.length},()=>Array(xNames.length).fill(0));
    const times=[...new Set(rows.filter(o=>o.e===1).map(o=>o.t))].sort((a,b)=>a-b);
    for(const t of times){
      const ev=rows.filter(o=>o.t===t&&o.e===1), risk=rows.filter(o=>o.t>=t);
      const w=risk.map(o=>Math.exp(Math.max(-30,Math.min(30,dot(o.x,beta)))));
      const S0=w.reduce((s,v)=>s+v,0),S1=Array(xNames.length).fill(0),S2=Array.from({length:xNames.length},()=>Array(xNames.length).fill(0));
      risk.forEach((o,i)=>{for(let j=0;j<xNames.length;j++){S1[j]+=w[i]*o.x[j];for(let k=0;k<xNames.length;k++)S2[j][k]+=w[i]*o.x[j]*o.x[k];}});
      ev.forEach(o=>{for(let j=0;j<xNames.length;j++)score[j]+=o.x[j]-S1[j]/S0;});
      for(let j=0;j<xNames.length;j++)for(let k=0;k<xNames.length;k++)info[j][k]+=S2[j][k]/S0-(S1[j]*S1[k])/(S0*S0);
    }
    const step=solveSym(info,score);if(!step)throw new Error('Matrice Cox singulière.');
    let mx=0;beta=beta.map((v,j)=>{const nv=v+step[j];mx=Math.max(mx,Math.abs(step[j]));return nv;});if(mx<1e-8){converged=true;break;}
  }
  if(!converged)throw new Error('Le modèle de Cox n’a pas convergé.');
  const info=coxInfo(rows,beta),cov=matInverse(info); if(!cov)throw new Error('Information de Cox singulière.'); const events=rows.filter(o=>o.e===1).length;
  const out=xNames.map((n,j)=>{const se=Math.sqrt(Math.max(0,cov[j][j])),z=beta[j]/Math.max(se,1e-12);return{name:n,beta:beta[j],HR:Math.exp(beta[j]),se,z,p:normalP(z),ci95:[Math.exp(beta[j]-1.959964*se),Math.exp(beta[j]+1.959964*se)]};});
  return {html:header('⏱️ Régression de Cox',`N = ${rows.length} · événements = ${events}`)+`<div style="overflow:auto"><table><tr><th>Variable</th><th>β</th><th>HR</th><th>IC95%</th><th>p</th></tr>${out.map(o=>`<tr><td>${esc(o.name)}</td><td>${fmt(o.beta)}</td><td>${fmt(o.HR)}</td><td>[${fmt(o.ci95[0])}; ${fmt(o.ci95[1])}]</td><td><b>${pFmt(o.p)}</b></td></tr>`).join('')}</table></div><p style="color:var(--muted)">Méthode de Breslow pour les ex æquo. Vérifier l’hypothèse des risques proportionnels avant publication.</p>`,stats:{n:rows.length,events,coefficients:out,converged:true,ties:'Breslow'}};
}
function solveSym(A,b){
  const n=A.length,M=A.map(r=>r.slice()),v=b.slice();
  for(let k=0;k<n;k++){let p=k;for(let i=k+1;i<n;i++)if(Math.abs(M[i][k])>Math.abs(M[p][k]))p=i;if(Math.abs(M[p][k])<1e-12)return null;[M[k],M[p]]=[M[p],M[k]];[v[k],v[p]]=[v[p],v[k]];for(let i=k+1;i<n;i++){const q=M[i][k]/M[k][k];for(let j=k;j<n;j++)M[i][j]-=q*M[k][j];v[i]-=q*v[k];}}
  const x=Array(n).fill(0);for(let i=n-1;i>=0;i--){let s=v[i];for(let j=i+1;j<n;j++)s-=M[i][j]*x[j];x[i]=s/M[i][i];}return x;
}
function matInverse(A){const n=A.length,M=A.map(r=>r.slice()),I=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?1:0));for(let k=0;k<n;k++){let p=k;for(let i=k+1;i<n;i++)if(Math.abs(M[i][k])>Math.abs(M[p][k]))p=i;if(Math.abs(M[p][k])<1e-12)return null;[M[k],M[p]]=[M[p],M[k]];[I[k],I[p]]=[I[p],I[k]];const q=M[k][k];for(let j=0;j<n;j++){M[k][j]/=q;I[k][j]/=q;}for(let i=0;i<n;i++)if(i!==k){const f=M[i][k];for(let j=0;j<n;j++){M[i][j]-=f*M[k][j];I[i][j]-=f*I[k][j];}}}return I;}
function coxInfo(rows,beta){
  const p=beta.length,I=Array.from({length:p},()=>Array(p).fill(0));
  for(const t of [...new Set(rows.filter(o=>o.e===1).map(o=>o.t))]){
    const risk=rows.filter(o=>o.t>=t),w=risk.map(o=>Math.exp(Math.max(-30,Math.min(30,dot(o.x,beta)))));
    const S0=w.reduce((s,v)=>s+v,0),S1=Array(p).fill(0),S2=Array.from({length:p},()=>Array(p).fill(0));
    risk.forEach((o,i)=>{for(let j=0;j<p;j++){S1[j]+=w[i]*o.x[j];for(let k=0;k<p;k++)S2[j][k]+=w[i]*o.x[j]*o.x[k];}});
    for(let j=0;j<p;j++)for(let k=0;k<p;k++)I[j][k]+=S2[j][k]/S0-(S1[j]*S1[k])/(S0*S0);
  }return I;
}
function sampleSizeV40(b){
  const alpha=Number(b.alpha),power=Number(b.power),effect=Number(b.effect),mode=b.mode||'means',zA=normInv(1-alpha/2),zB=normInv(power);
  if(!(alpha>0&&alpha<1&&power>0&&power<1&&effect>0))throw new Error('Paramètres invalides.');
  let n,desc;
  if(mode==='means')n=2*((zA+zB)/effect)**2,desc='2 moyennes indépendantes';
  else if(mode==='proportions'){const p1=Number(b.p1??0.5),p2=Number(b.p2??(p1-effect));if(!(p1>0&&p1<1&&p2>0&&p2<1))throw new Error('p1/p2 invalides.');const ph=(p1+p2)/2;n=((zA*Math.sqrt(2*ph*(1-ph))+zB*Math.sqrt(p1*(1-p1)+p2*(1-p2)))**2)/(p1-p2)**2;desc='2 proportions indépendantes';}
  else if(mode==='correlation'){const r=Math.abs(effect);n=3+((zA+zB)/Math.atanh(r))**2;desc='corrélation de Pearson';}
  else if(mode==='oneprop'){const p0=Number(b.p0??0.5),p1=Number(b.p1??effect);n=((zA*Math.sqrt(p0*(1-p0))+zB*Math.sqrt(p1*(1-p1)))/(p1-p0))**2;desc='1 proportion';}
  else throw new Error('Mode non pris en charge.');
  const attr=Number(b.attrition||0);const nadj=n/(1-Math.max(0,Math.min(.95,attr)));
  return {html:header('📐 Taille d’échantillon',`${desc} · α = ${alpha} · puissance = ${power}`)+`<p><b>${Math.ceil(n)}</b> sujets avant attrition · <b>${Math.ceil(nadj)}</b> après attrition.</p>`,stats:{n_required:Math.ceil(n),n_with_attrition:Math.ceil(nadj),alpha,power,effect,mode}};
}


function nonparamExact(b,type){
  const DATA=b.data||[];
  if(type==='mw'){
    const y=b.y,g=b.group,groups=[...new Set(DATA.map(r=>String(r[g]??'').trim()).filter(Boolean))];if(groups.length!==2)throw new Error('Mann-Whitney exact nécessite 2 groupes.');
    const a=[],bb=[];DATA.forEach(r=>{const v=num(r[y]),gg=String(r[g]??'').trim();if(v!==null){if(gg===groups[0])a.push(v);else if(gg===groups[1])bb.push(v);}});
    if(a.length<2||bb.length<2)throw new Error('Données insuffisantes.');
    const all=a.concat(bb);if(new Set(all).size!==all.length)throw new Error('Ex æquo détectés : utilisez Mann-Whitney asymptotique ou une méthode exacte spécialisée.');
    const rs=ranks(all),R=rs.slice(0,a.length).reduce((s,v)=>s+v,0),U=R-a.length*(a.length+1)/2,p=mwExactP(a.length,bb.length,U);
    if(p===null)throw new Error('Distribution exacte disponible jusqu’à 30 sujets par groupe.');
    return {html:header('🧪 Mann-Whitney exact',`${esc(groups[0])}: n=${a.length} · ${esc(groups[1])}: n=${bb.length}`)+`<p>U = <b>${fmt(U)}</b> · p exacte = <b>${pFmt(p)}</b>.</p>`,stats:{U,p_exact:p,n1:a.length,n2:bb.length,effect_rank_biserial:rankSumEffect(U,a.length,bb.length)}};
  }
  const y1=b.y,y2=b.y2,d=[],sg=[];DATA.forEach(r=>{const x=num(r[y1]),z=num(r[y2]);if(x!==null&&z!==null&&x!==z){d.push(Math.abs(x-z));sg.push(Math.sign(x-z));}});
  if(d.length<5)throw new Error('Au moins 5 paires non nulles.');
  const p=wilcoxonExactP(d,sg);if(p===null)throw new Error('Wilcoxon exact disponible seulement sans ex æquo et jusqu’à 30 paires.');
  const rb=d.map((v,i)=>({v,i})).sort((a,b)=>a.v-b.v),ranksBy=Array(d.length);rb.forEach((o,i)=>ranksBy[o.i]=i+1);const Wp=sg.reduce((s,v,i)=>s+(v>0?ranksBy[i]:0),0);
  return {html:header('🧪 Wilcoxon exact',`Paires non nulles = ${d.length}`)+`<p>W+ = <b>${fmt(Wp)}</b> · p exacte = <b>${pFmt(p)}</b>.</p>`,stats:{W_plus:Wp,p_exact:p,n:d.length}};
}
function rocDeLongMethod(b){
  const DATA=b.data||[],y=b.y,x=b.x,cats=[...new Set(DATA.map(r=>String(r[y]??'').trim()).filter(Boolean))];if(cats.length!==2)throw new Error('La cible doit avoir 2 modalités.');
  const pos=cats[1],scores=[],labels=[];DATA.forEach(r=>{const s=num(r[x]),yy=String(r[y]??'').trim();if(s!==null&&yy){scores.push(s);labels.push(yy===pos?1:0);}});
  const P=labels.filter(v=>v===1).length,N=labels.length-P;if(P<2||N<2)throw new Error('Au moins 2 positifs et 2 négatifs.');
  const d=rocDeLong(scores,labels);return {html:header('🎯 ROC — DeLong',`n = ${scores.length} · positifs = ${P} · négatifs = ${N}`)+`<p>AUC = <b>${fmt(d.auc)}</b> · SE = ${fmt(d.se)} · IC95% = [${fmt(d.ci95[0])}; ${fmt(d.ci95[1])}] · p(AUC=0,5) = <b>${pFmt(d.p)}</b>.</p>`,stats:{auc:d.auc,se:d.se,ci95:d.ci95,p:d.p,positives:P,negatives:N,method:'DeLong'}}; 
}

function designCategorical(DATA,yName,xNames){
  const levels={};xNames.forEach(n=>{const vals=DATA.map(r=>r[n]).filter(v=>v!==null&&v!==undefined&&String(v).trim()!=='');const nums=vals.map(num);levels[n]=nums.every(v=>v!==null)?null:[...new Set(vals.map(v=>String(v).trim()))].sort();if(levels[n]&&levels[n].length<2)levels[n]=null;});
  const cols=[];xNames.forEach(n=>{if(!levels[n])cols.push({name:n,fn:r=>num(r[n])});else levels[n].slice(1).forEach(l=>cols.push({name:`${n}=${l}`,fn:r=>String(r[n]??'').trim()===l?1:0}));});
  const cats=[...new Set(DATA.map(r=>String(r[yName]??'').trim()).filter(Boolean))];if(cats.length!==2)throw new Error('Y doit avoir exactement 2 modalités.');const positive=cats[1];const rows=[];DATA.forEach(r=>{const ys=String(r[yName]??'').trim();if(!ys)return;const xx=cols.map(c=>c.fn(r));if(xx.every(v=>v!==null&&Number.isFinite(v)))rows.push({y:ys===positive?1:0,x:[1,...xx]});});return {rows,positive,cols,levels};
}
function logisticV40(b){
  const d=designCategorical(b.data||[],b.y,b.x||[]),rows=d.rows,p=rows[0]?.x.length||0;if(rows.length<Math.max(20,p*5))throw new Error(`Observations complètes insuffisantes (n=${rows.length}).`);
  let beta=Array(p).fill(0),conv=false,iters=0;
  for(let it=0;it<80;it++){iters=it+1;const H=Array.from({length:p},()=>Array(p).fill(0)),g=Array(p).fill(0);rows.forEach(o=>{const eta=Math.max(-35,Math.min(35,dot(o.x,beta))),pr=1/(1+Math.exp(-eta)),w=Math.max(pr*(1-pr),1e-9);for(let j=0;j<p;j++){g[j]+=o.x[j]*(o.y-pr);for(let k=0;k<p;k++)H[j][k]+=w*o.x[j]*o.x[k];}});const step=solveSym(H,g);if(!step)throw new Error('Matrice singulière ou séparation quasi complète.');let mx=0;beta=beta.map((v,j)=>{const nv=v+step[j];mx=Math.max(mx,Math.abs(step[j]));return nv;});if(mx<1e-8){conv=true;break;}}
  if(!conv)throw new Error('Régression logistique non convergente.');
  const H=Array.from({length:p},()=>Array(p).fill(0));let ll=0,dev0=0,dev=0;rows.forEach(o=>{const eta=Math.max(-35,Math.min(35,dot(o.x,beta))),pr=1/(1+Math.exp(-eta)),w=Math.max(pr*(1-pr),1e-9);ll+=o.y*Math.log(Math.max(pr,1e-15))+(1-o.y)*Math.log(Math.max(1-pr,1e-15));dev+=-2*(o.y*Math.log(Math.max(pr,1e-15))+(1-o.y)*Math.log(Math.max(1-pr,1e-15)));for(let j=0;j<p;j++)for(let k=0;k<p;k++)H[j][k]+=w*o.x[j]*o.x[k];});const m=mean(rows.map(o=>o.y));dev0=-2*rows.reduce((s,o)=>s+o.y*Math.log(Math.max(m,1e-15))+(1-o.y)*Math.log(Math.max(1-m,1e-15)),0);const cov=matInverse(H);if(!cov)throw new Error('Matrice de variance singulière.');const coef=d.cols.map((c,j)=>{const idx=j+1,se=Math.sqrt(Math.max(0,cov[idx][idx])),z=beta[idx]/Math.max(se,1e-12);return{name:c.name,beta:beta[idx],OR:Math.exp(beta[idx]),SE:se,CI95:[Math.exp(beta[idx]-1.959964*se),Math.exp(beta[idx]+1.959964*se)],p:normalP(z)};});
  const k=p, AIC=dev+2*k,BIC=dev+k*Math.log(rows.length),pseudo=dev0>0?1-dev/dev0:NaN,lr=dev0-dev,pGlobal=chiP(lr,Math.max(1,k-1));
  const html=header('📈 Régression logistique — V40',`n = ${rows.length} · événement positif = ${esc(d.positive)} · itérations = ${iters}`)+`<div style="overflow:auto"><table><tr><th>Variable</th><th>β</th><th>OR</th><th>IC95%</th><th>p</th></tr>${coef.map(o=>`<tr><td>${esc(o.name)}</td><td>${fmt(o.beta)}</td><td>${fmt(o.OR)}</td><td>[${fmt(o.CI95[0])}; ${fmt(o.CI95[1])}]</td><td><b>${pFmt(o.p)}</b></td></tr>`).join('')}</table></div><p>Déviance = ${fmt(dev)} · AIC = ${fmt(AIC)} · BIC = ${fmt(BIC)} · pseudo-R² McFadden = ${fmt(pseudo)} · test global p = <b>${pFmt(pGlobal)}</b>.</p>`;
  return {html,stats:{n:rows.length,complete_n:rows.length,missing:(b.data||[]).length-rows.length,positive:d.positive,levels:d.levels,coefficients:coef,AIC,BIC,pseudo_R2_McFadden:pseudo,global_LR:lr,global_p:pGlobal,converged:conv,iterations:iters}};
}
function pcaV40(b){
  const DATA=b.data||[],names=b.items||[],rows=rowsFor(DATA,names).filter(a=>a.every(v=>v!==null));if(names.length<2||rows.length<3)throw new Error('Données insuffisantes pour ACP.');const Z=names.map((_,j)=>{const a=rows.map(r=>r[j]),m=mean(a),s=sd(a);if(!(s>0))throw new Error(`Variance nulle : ${names[j]}.`);return rows.map(r=>(r[j]-m)/s);});const C=names.map((_,i)=>names.map((_,j)=>mean(Z[i].map((_,k)=>Z[i][k]*Z[j][k]))));const eig=jacobiSym(C),total=eig.reduce((s,e)=>s+Math.max(0,e.value),0);const explained=eig.map(e=>Math.max(0,e.value)/total);const loadings=eig.map((e,k)=>names.map((_,j)=>e.vector[j]*Math.sqrt(Math.max(0,e.value))));const rowsHtml=eig.map((e,i)=>`<tr><td>PC${i+1}</td><td>${fmt(e.value)}</td><td>${fmt(explained[i]*100)} %</td></tr>`).join('');return {html:header('🧭 ACP — V40',`N = ${rows.length} · variables = ${names.length}`)+`<div style="overflow:auto"><table><tr><th>Composante</th><th>Valeur propre</th><th>Variance expliquée</th></tr>${rowsHtml}</table></div><p>Les loadings et scores sont disponibles dans la sortie structurée.</p>`,stats:{n:rows.length,variables:names,eigenvalues:eig.map(e=>e.value),explained_variance:explained,loadings}};
}
function reliabilityV40(b){
  const DATA=b.data||[],names=b.items||[],rows=rowsFor(DATA,names).filter(a=>a.every(v=>v!==null));if(names.length<2||rows.length<3)throw new Error('Données insuffisantes.');const k=names.length,means=names.map((_,j)=>mean(rows.map(r=>r[j]))),vars=names.map((_,j)=>variance(rows.map(r=>r[j]))),tot=rows.map(r=>r.reduce((s,v)=>s+v,0)),vt=variance(tot),alpha=k/(k-1)*(1-vars.reduce((s,v)=>s+v,0)/vt);const stdItems=names.map((_,j)=>{const a=rows.map(r=>r[j]),m=mean(a),s=sd(a);return a.map(v=>(v-m)/s)}),zt=stdItems[0].map((_,i)=>stdItems.reduce((s,a)=>s+a[i],0)),vzt=variance(zt),alphaStd=k/(k-1)*(1-stdItems.reduce((s,a)=>s+variance(a),0)/vzt);return {html:header('🔐 Fiabilité interne — V40',`Items = ${k} · N = ${rows.length}`)+`<p>α de Cronbach = <b>${fmt(alpha)}</b> · α standardisé = <b>${fmt(alphaStd)}</b>.</p><p>Pour une publication, l’alpha ne suffit pas à démontrer l’unidimensionnalité.</p>`,stats:{n:rows.length,k,alpha,alpha_standardized:alphaStd,item_variances:vars}};
}
function nonparamPublication(b){
  // Sélection robuste : seules les modalités ayant au moins 2 observations
  // quantitatives exploitables sont considérées. Cela évite qu'une modalité
  // vide/entièrement manquante force à tort Mann-Whitney à échouer.
  if(b.test==='auto' || b.auto===true || b.test==='mw'){
    const y=b.y,g=b.group,counts=new Map();
    (b.data||[]).forEach(r=>{const v=num(r?.[y]),gg=String(r?.[g]??'').trim();if(v!==null&&gg)counts.set(gg,(counts.get(gg)||0)+1);});
    const groups=[...counts.entries()].filter(([,n])=>n>=2).map(([gg])=>gg);
    if(groups.length>=3){
      const r=nonparam({...b,test:'kw'});
      r.html=String(r.html||'').replace('🧪 Kruskal-Wallis','🎯 Kruskal-Wallis — sélection automatique');
      r.stats=Object.assign({},r.stats,{auto_selected_test:'kw',usable_groups:groups.length});
      return r;
    }
    if((b.test==='auto'||b.auto===true) && groups.length===2){
      const r=nonparamExact({...b,test:'mw'},'mw');
      r.html=String(r.html||'').replace('🧪 Mann-Whitney exact','🎯 Mann-Whitney — sélection automatique');
      r.stats=Object.assign({},r.stats,{auto_selected_test:'mw',usable_groups:2});
      return r;
    }
    if(b.test==='mw' && groups.length!==2){
      throw new Error(groups.length<2?'Données insuffisantes : au moins 2 groupes avec 2 observations quantitatives sont nécessaires.':'Mann-Whitney nécessite exactement 2 groupes exploitables.');
    }
  }
  if(b.test==='wilcox'){try{return nonparamExact(b,'wilcoxon')}catch(e){/* asymptotic fallback remains labeled */}}
  return nonparam(b);
}

exports._test={mwExactP,wilcoxonExactP,rocDeLong,holmAdjust,bhAdjust,coxPH,sampleSizeV40};
exports.handler = async event => {
  let origin=''; try{origin=sec.assertOrigin(event)}catch(x){return {statusCode:x.status||403,headers:sec.securityHeaders(sec.originOf(event)),body:JSON.stringify({error:x.message})}}
  if(event.httpMethod==='OPTIONS')return sec.preflight(event);
  if(event.httpMethod!=='POST')return {statusCode:405,headers:responseHeaders(origin),body:JSON.stringify({error:'Méthode non autorisée'})};
  const ip=(event.headers?.['x-forwarded-for']||'unknown').split(',')[0].trim();if(!rate(ip))return {statusCode:429,headers:responseHeaders(origin),body:JSON.stringify({error:'Trop de requêtes — réessayez dans une minute.'})};
  try{ await sec.verifyAppCheck(event); await sec.verifyAuth(event); }
  catch(e){ return {statusCode:e.status||401,headers:responseHeaders(origin),body:JSON.stringify({error:e.message||'Authentification invalide'})}; }
  try{const b=sec.body(event,1200000);if(!Array.isArray(b.data)&&!['multiple','samplesize'].includes(b.method))throw new Error('Jeu de données absent.');if(Array.isArray(b.data)&&b.data.length>50000)throw new Error('Jeu de données absent ou trop volumineux (maximum 50 000 lignes).');let r;switch(b.method){case'samplesize':r=sampleSizeV40(b);break;case'logistic':r=logisticV40(b);break;case'ancova':r=ancova(b);break;case'reliability':r=reliabilityV40(b);break;case'pca':r=pcaV40(b);break;case'roc':r=rocDeLongMethod(b);break;case'survival':r=survival(b);break;case'cox':r=coxPH(b);break;case'nonparam':r=nonparamPublication(b);break;case'mw_exact':r=nonparamExact(b,'mw');break;case'wilcoxon_exact':r=nonparamExact(b,'wilcoxon');break;case'dunn':r=dunnPosthoc(b);break;case'multiple':r=multipleTesting(b);break;case'roc_delong':r=rocDeLongMethod(b);break;default:throw new Error('Méthode statistique non prise en charge.');}const initialN=Array.isArray(b.data)?b.data.length:null;const stats=Object.assign({method:b.method,engine:'server-publication-v40',n_initial:initialN},r.stats||{});return {statusCode:200,headers:responseHeaders(origin),body:JSON.stringify({ok:true,engine:'server-publication-v40',html:r.html,stats})};}catch(e){console.error('advancedStats:',e);return {statusCode:400,headers:responseHeaders(origin),body:JSON.stringify({ok:false,error:e.message||'Erreur statistique serveur.'})};}
};
