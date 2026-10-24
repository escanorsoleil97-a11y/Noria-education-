// ══════════════════════════════════════════════════════════════════════════════
// Noria Education — admin.js
// Dashboard admin servi côté serveur — code jamais visible côté client
// Accès : /.netlify/functions/admin?token=FIREBASE_ID_TOKEN
// ══════════════════════════════════════════════════════════════════════════════

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ credential: admin.credential.cert(
    JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
  )});
}
const db = admin.firestore();

const ADMIN_UIDS = new Set([
  'SBATLA0GmVbeYWWpWrPoRTTveb32',
  '0f9FMESHK6gq5Gl77tquCETbFow1'
]);

// ── Vérification admin ───────────────────────────────────────────────────────
async function verifyAdmin(token) {
  if (!token) throw new Error('Token manquant');
  const decoded = await admin.auth().verifyIdToken(token);
  if (!ADMIN_UIDS.has(decoded.uid)) throw new Error('Accès refusé');
  const snap = await db.collection('users').doc(decoded.uid).get();
  const role = snap.data()?.role || '';
  if (role !== 'admin' && role !== 'adnim') throw new Error('Rôle admin requis');
  return decoded.uid;
}

// ── Charger les stats ────────────────────────────────────────────────────────
async function loadStats() {
  const snap = await db.collection('users').get();
  const stats = { total: 0, byPlan: {}, suspended: 0, newThisMonth: 0 };
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0,0,0,0);
  snap.docs.forEach(d => {
    const data = d.data();
    stats.total++;
    const plan = data.plan || 'gratuit';
    stats.byPlan[plan] = (stats.byPlan[plan] || 0) + 1;
    if (data.suspended) stats.suspended++;
    if (data.createdAt && new Date(data.createdAt) >= monthStart) stats.newThisMonth++;
  });
  const PRIX = { standard: 10000, professionnel: 25000, premium: 35000 };
  stats.revenus = Object.entries(PRIX).reduce((s, [p, px]) => s + (stats.byPlan[p]||0)*px, 0);
  return stats;
}

// ── Charger les utilisateurs ─────────────────────────────────────────────────
async function loadUsers() {
  const snap = await db.collection('users').limit(200).get();
  return snap.docs.map(d => ({
    uid: d.id, ...d.data()
  })).sort((a,b) => (b.createdAt||'') > (a.createdAt||'') ? 1 : -1);
}

// ── Charger les alertes anti-partage (juste pour le badge côté serveur) ──────
async function loadAlerts() {
  try {
    const snap = await db.collection('alerts').limit(200).get();
    return snap.docs.map(d => ({ id: d.id, ...d.data() }));
  } catch (e) {
    return [];
  }
}

// ── Générer le HTML du dashboard ─────────────────────────────────────────────
function buildDashboard(stats, users, uid, alerts) {
  const planColors = { gratuit:'#94a3b8', standard:'#60a5fa', professionnel:'#a78bfa', premium:'#fbbf24', institution:'#34d399', centre_sante:'#f97316', ecole:'#22c55e', hopital_district:'#ef4444', pharmacie:'#f59e0b' };
  const planLabels = { gratuit:'🆓 Gratuit', standard:'🥉 Standard', professionnel:'🥈 Professionnel', premium:'🥇 Premium', institution:'🏛️ Institution', centre_sante:'🏥 Centre de santé', ecole:'🏫 École', hopital_district:'🏥 Hôpital de district', pharmacie:'💊 Pharmacie' };

  const statCards = `
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin-bottom:24px;">
      <div class="scard"><div class="snum" style="color:#10b981">${stats.total}</div><div class="slbl">Utilisateurs</div></div>
      <div class="scard"><div class="snum" style="color:#60a5fa">${stats.newThisMonth}</div><div class="slbl">Inscrits ce mois</div></div>
      <div class="scard"><div class="snum" style="color:#f43f5e">${stats.suspended}</div><div class="slbl">Suspendus</div></div>
      <div class="scard"><div class="snum" style="color:#fbbf24">${(stats.revenus||0).toLocaleString()} FCFA</div><div class="slbl">Revenus estimés</div></div>
    </div>`;

  const planBars = Object.entries(stats.byPlan||{}).map(([plan, count]) => {
    const pct = Math.round((count / (stats.total||1)) * 100);
    return `<div style="margin-bottom:10px;">
      <div style="display:flex;justify-content:space-between;font-size:0.78rem;margin-bottom:4px;">
        <span style="color:${planColors[plan]||'#fff'}">${plan}</span>
        <span style="color:#94a3b8">${count} (${pct}%)</span>
      </div>
      <div style="background:#1e293b;border-radius:4px;height:6px;">
        <div style="background:${planColors[plan]||'#10b981'};width:${pct}%;height:6px;border-radius:4px;"></div>
      </div>
    </div>`;
  }).join('');

  const userRows = users.map(u => {
    const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString('fr-FR') : '—';
    const expiry  = u.planExpiry ? new Date(u.planExpiry).toLocaleDateString('fr-FR') : '—';
    const statusBadge = u.suspended
      ? `<span class="badge-red">Suspendu</span>`
      : `<span class="badge-green">Actif</span>`;
    const adminBadge = u.role ? ` <span class="badge-admin">${u.role}</span>` : '';
    return `<tr>
      <td>${u.email||'—'}${adminBadge}</td>
      <td style="color:${planColors[u.plan]||'#fff'};font-weight:600">${planLabels[u.plan]||u.plan||'gratuit'}</td>
      <td style="text-align:center">${u.credits??0}</td>
      <td>${expiry}</td>
      <td>${created}</td>
      <td>${statusBadge}</td>
      <td>
        <div style="display:flex;gap:4px;flex-wrap:wrap;">
          <select onchange="setPlan('${u.uid}',this.value)" style="background:#1e293b;color:#f1f5f9;border:1px solid #334155;border-radius:6px;padding:3px 6px;font-size:0.7rem;cursor:pointer;">
            ${['gratuit','standard','professionnel','premium','institution','ecole','hopital_district','centre_sante','pharmacie'].map(p =>
              `<option value="${p}"${u.plan===p?' selected':''}>${p}</option>`
            ).join('')}
          </select>
          <button onclick="addCredits('${u.uid}')" class="btn-act" title="Ajouter crédits">+💳</button>
          <button onclick="genererLienUpgrade('${u.uid}')" class="btn-act" title="Générer un lien d'upgrade">🔗 Upgrade</button>
          <button onclick="appliquerUpgrade('${u.uid}')" class="btn-act btn-green" title="Appliquer l'upgrade (après paiement reçu)">✅ Upgrade</button>
          <button onclick="modifierInfosUtilisateur('${u.uid}')" class="btn-act" title="Modifier les informations utilisateur">✏️ Infos</button>
          ${u.suspended
            ? `<button onclick="setSuspend('${u.uid}',false)" class="btn-act btn-green" title="Réactiver">✅</button>`
            : `<button onclick="setSuspend('${u.uid}',true)" class="btn-act btn-red" title="Suspendre">🚫</button>`
          }
        </div>
      </td>
    </tr>`;
  }).join('');

  return `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin — Noria Education</title>
  <style>
    *{box-sizing:border-box;margin:0;padding:0}
    body{background:#0f172a;color:#f1f5f9;font-family:system-ui,sans-serif;padding:20px;min-height:100vh;overflow-x:hidden}
    h1{font-size:1.4rem;margin-bottom:4px;color:#10b981}
    .sub{color:#64748b;font-size:0.8rem;margin-bottom:24px}
    .scard{background:#1e293b;border:1px solid #334155;border-radius:10px;padding:16px;text-align:center}
    .snum{font-size:1.6rem;font-weight:700;margin-bottom:4px}
    .slbl{font-size:0.72rem;color:#64748b}
    .section{font-size:0.75rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin:24px 0 10px}
    .card{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:16px;margin-bottom:16px}
    table{width:100%;border-collapse:collapse;font-size:0.78rem}
    th{padding:8px;text-align:left;color:#64748b;font-weight:500;border-bottom:1px solid #334155;font-size:0.7rem}
    td{padding:9px 8px;border-bottom:1px solid #1e293b;vertical-align:middle}
    tr:hover td{background:rgba(255,255,255,0.02)}
    .badge-green{background:rgba(16,185,129,.15);color:#10b981;padding:2px 7px;border-radius:10px;font-size:0.68rem}
    .badge-red{background:rgba(239,68,68,.15);color:#f87171;padding:2px 7px;border-radius:10px;font-size:0.68rem}
    .badge-admin{background:rgba(244,63,94,.15);color:#f43f5e;padding:1px 5px;border-radius:5px;font-size:0.65rem;margin-left:4px}
    .btn-act{background:#334155;border:none;border-radius:5px;padding:3px 7px;cursor:pointer;color:#f1f5f9;font-size:0.72rem}
    .btn-act:hover{background:#475569}
    .btn-green{background:rgba(16,185,129,.2);color:#10b981}
    .btn-red{background:rgba(239,68,68,.12);color:#f87171}
    input[type=text]{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:7px 12px;color:#f1f5f9;font-size:0.82rem;width:100%}
    .msg{padding:10px 14px;border-radius:8px;font-size:0.8rem;margin-top:10px;display:none}
    .msg.ok{background:rgba(16,185,129,.1);color:#10b981;border-left:3px solid #10b981}
    .msg.err{background:rgba(239,68,68,.1);color:#f87171;border-left:3px solid #f87171}
    .tabs{display:flex;gap:8px;margin-bottom:20px;flex-wrap:wrap;max-width:100%;min-width:0}
    .tab-btn{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:8px 16px;cursor:pointer;color:#94a3b8;font-size:0.82rem;transition:all .2s;flex:0 1 auto;min-width:0;white-space:nowrap;user-select:none;-webkit-user-select:none;touch-action:manipulation;-webkit-tap-highlight-color:transparent}
    .tab-btn.active,.tab-btn:hover{background:#334155;color:#f1f5f9}
    .tab-pane{display:none!important}.tab-pane.active{display:block!important}
    .search{margin-bottom:12px;display:flex;gap:8px;flex-wrap:wrap}
    select.filter{background:#1e293b;border:1px solid #334155;border-radius:8px;padding:7px 10px;color:#f1f5f9;font-size:0.78rem}
    .modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;z-index:1000;padding:16px}
    .modal-box{background:#1e293b;border:1px solid #334155;border-radius:12px;padding:20px;width:100%;max-width:340px}
    .modal-box h3{font-size:0.95rem;margin-bottom:12px;color:#f1f5f9}
    .modal-box input[type=text],.modal-box input[type=number]{background:#0f172a;border:1px solid #334155;border-radius:8px;padding:9px 12px;color:#f1f5f9;font-size:0.9rem;width:100%;margin-bottom:14px}
    .modal-actions{display:flex;gap:8px;justify-content:flex-end}
    .modal-actions button{border:none;border-radius:8px;padding:8px 16px;font-size:0.82rem;cursor:pointer}
    .modal-cancel{background:#334155;color:#f1f5f9}
    .modal-confirm{background:#10b981;color:#000;font-weight:700}
    @media(max-width:600px){
      table{font-size:0.7rem}
      td,th{padding:6px 4px}
      body{padding:14px}
      .tabs{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:7px;overflow:visible}
      .tab-btn{width:100%;padding:9px 5px;font-size:0.72rem;line-height:1.15;white-space:normal;min-height:38px;display:flex;align-items:center;justify-content:center}
    }
  </style>
</head>
<body>
  <h1>⚙️ Dashboard Admin</h1>
  <div class="sub">Noria Education — Accès restreint — UID : ${uid}</div>

  <div id="inlineModalOverlay" class="modal-overlay" style="display:none">
    <div class="modal-box">
      <h3 id="inlineModalTitle"></h3>
      <input type="text" id="inlineModalInput">
      <div class="modal-actions">
        <button type="button" class="modal-cancel" onclick="_inlineModalResolve(null)">Annuler</button>
        <button type="button" class="modal-confirm" onclick="_inlineModalResolve(document.getElementById('inlineModalInput').value)">OK</button>
      </div>
    </div>
  </div>

  <div class="tabs">
    <a href="#pane-stats" class="tab-btn active" data-tab="stats" aria-selected="true" role="button">📊 Statistiques</a>
    <a href="#pane-users" class="tab-btn" data-tab="users" aria-selected="false" role="button">👥 Utilisateurs</a>
    <a href="#pane-institutions" class="tab-btn" data-tab="institutions" aria-selected="false" role="button">🏛 Institutions</a>
    <a href="#pane-payments" class="tab-btn" data-tab="payments" aria-selected="false" role="button">💳 Paiements</a>
    <a href="#pane-alerts" class="tab-btn" data-tab="alerts" aria-selected="false" role="button">🚨 Alertes${alerts.length ? ` <span style="background:#f43f5e;color:#fff;border-radius:10px;padding:1px 6px;font-size:0.68rem;margin-left:4px;">${alerts.length}</span>` : ''}</a>
    <a href="#pane-groups" class="tab-btn" data-tab="groups" aria-selected="false" role="button">📦 Campagnes groupe</a>
    <a href="#pane-ambassadors" class="tab-btn" data-tab="ambassadors" aria-selected="false" role="button">🤝 Ambassadeurs</a>
    <a href="#pane-promo" class="tab-btn" data-tab="promo" aria-selected="false" role="button">🔥 Promotions</a>
    <a href="#pane-help" class="tab-btn" data-tab="help" aria-selected="false" role="button">🆘 Aide étudiants</a>
    <a href="#pane-ranking" class="tab-btn" data-tab="ranking" aria-selected="false" role="button">🏆 Classement</a>
    <a href="#pane-chimilinks" class="tab-btn" data-tab="chimilinks" aria-selected="false" role="button">⚡ Liens chimi</a>
    <a href="#pane-infos" class="tab-btn" data-tab="infos" aria-selected="false" role="button">📢 Infos & Budget</a>
  </div>


  <!-- STATS -->
  <div id="pane-stats" class="tab-pane active">
    ${statCards}
    <div class="card">
      <div class="section">Répartition par plan</div>
      ${planBars || '<p style="color:#64748b;font-size:0.82rem">Aucune donnée</p>'}
    </div>
    <div style="padding:10px 14px;background:#1e293b;border-radius:8px;font-size:0.75rem;color:#64748b;margin-top:8px;">
      💳 Paiements disponibles après configuration API NotchPay ou Monetbil
    </div>
  </div>

  <!-- USERS -->
  <div id="pane-users" class="tab-pane">
    <div class="search">
      <input type="text" id="srch" placeholder="Rechercher email…" oninput="filterTable()" style="flex:1;min-width:160px">
      <button type="button" class="btn-act" onclick="loadUsersCurrent()">↻ Actualiser</button>
      <span id="users-refresh-status" style="align-self:center;color:#64748b;font-size:.72rem">Les données seront actualisées à l’ouverture.</span>
      <select id="fplan" class="filter" onchange="filterTable()">
        <option value="">Tous plans</option>
        ${['gratuit','standard','professionnel','premium','institution','ecole','hopital_district','centre_sante','pharmacie'].map(p=>`<option value="${p}">${p==='centre_sante'?'🏥 Centre de santé':p}</option>`).join('')}
      </select>
      <select id="fstatus" class="filter" onchange="filterTable()">
        <option value="">Tous statuts</option>
        <option value="actif">Actifs</option>
        <option value="suspendu">Suspendus</option>
      </select>
    </div>
    <div class="card" style="overflow-x:auto">
      <table>
        <thead><tr>
          <th>Email</th><th>Plan</th><th style="text-align:center">Crédits</th>
          <th>Expiry</th><th>Inscrit</th><th>Statut</th><th>Actions</th>
        </tr></thead>
        <tbody id="user-tbody">${userRows}</tbody>
      </table>
    </div>
    <div id="action-msg" class="msg"></div>
  </div>

  <!-- INSTITUTIONS -->
  <div id="pane-institutions" class="tab-pane">

    <!-- Activer manuellement une institution -->
    <div class="card" style="margin-bottom:16px;">
      <div class="section">➕ Activer une institution manuellement</div>
      <div style="display:grid;gap:10px;">
        <div style="display:flex;gap:8px;flex-wrap:wrap;">
          <input type="text" id="instUid" placeholder="UID Firebase de l'utilisateur" style="flex:2;min-width:200px;background:#1e293b;border:1px solid #334155;border-radius:6px;padding:7px 10px;color:#f1f5f9;font-size:0.8rem;">
          <input type="text" id="instNomAdmin" placeholder="Nom de l'établissement" style="flex:2;min-width:160px;background:#1e293b;border:1px solid #334155;border-radius:6px;padding:7px 10px;color:#f1f5f9;font-size:0.8rem;">
          <input type="number" id="instNbAdmin" placeholder="Nb individus (min 5)" min="5" oninput="calcInstAdmin()" style="width:120px;background:#1e293b;border:1px solid #334155;border-radius:6px;padding:7px 10px;color:#f1f5f9;font-size:0.8rem;">
        </div>
        <div id="instAdminEstimate" style="font-size:0.78rem;color:#60a5fa;font-weight:600;"></div>
        <button onclick="activateInstitution()" style="background:linear-gradient(135deg,#3b82f6,#1d4ed8);color:#fff;border:none;border-radius:8px;padding:9px 20px;font-weight:700;cursor:pointer;font-size:0.82rem;width:fit-content;">
          🏛 Activer l'institution
        </button>
        <div id="instAdminMsg" style="font-size:0.8rem;"></div>
      </div>
    </div>

    <!-- Demandes en attente -->
    <div class="card" style="margin-bottom:16px;">
      <div class="section">📩 Demandes en attente</div>
      <div id="inst-requests-list" style="font-size:0.8rem;color:#64748b;">Chargement…</div>
    </div>

    <!-- Institutions actives -->
    <div class="card">
      <div class="section">✅ Institutions actives</div>
      <div style="overflow-x:auto;">
        <table>
          <thead><tr>
            <th>Email</th><th>Établissement</th><th style="text-align:center">Individus</th>
            <th style="text-align:center">Crédits/an</th><th style="text-align:right">Prix total</th><th>Expiry</th>
          </tr></thead>
          <tbody id="inst-tbody"><tr><td colspan="6" style="text-align:center;color:#64748b;padding:20px;">Chargement…</td></tr></tbody>
        </table>
      </div>
    </div>
  </div>

  <!-- GROUP CAMPAIGNS -->
  <div id="pane-groups" class="tab-pane">
    <div class="card"><div class="section">➕ Créer une campagne</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;">
        <input type="text" id="gcName" placeholder="Nom du pack">
        <select id="gcPlan" class="filter" onchange="syncCampaignPrice()"><option value="standard">10 000 FCFA</option><option value="professionnel">25 000 FCFA</option><option value="premium">35 000 FCFA Premium</option></select>
        <select id="gcProfile" class="filter"><option value="stats">Statistiques uniquement</option><option value="student">Statistiques + Espace Personnel</option></select>
        <input type="number" id="gcPrice" value="10000" placeholder="Prix FCFA" min="0" readonly title="Prix fixé par le forfait sélectionné">
        <input type="number" id="gcMax" placeholder="Places max" min="1">
        <input type="datetime-local" id="gcExpiry">
      </div><label style="display:flex;align-items:center;gap:8px;margin-top:10px;color:#94a3b8;font-size:.78rem;"><input type="checkbox" id="gcPermanent"> Lien permanent (sans expiration)</label><button class="btn-act btn-green" style="margin-top:10px;padding:8px 14px" onclick="createGroupCampaign()">Créer les liens de campagne</button><div id="gcMsg" class="msg"></div><div id="gcLinks" style="display:none;margin-top:10px;font-size:.78rem;line-height:1.7;"></div>
    </div>
    <div class="card"><div class="section">📣 Campagnes créées</div><div id="gcList" style="font-size:.8rem;color:#94a3b8">Chargement…</div></div>
    <div class="card" style="overflow-x:auto"><div class="section">📩 Demandes groupe</div><table><thead><tr><th>Date</th><th>Email</th><th>Campagne</th><th>Statut</th><th>Prix</th><th>Action</th></tr></thead><tbody id="gcRequests"><tr><td colspan="6" style="text-align:center;color:#64748b;padding:20px">Chargement…</td></tr></tbody></table></div>
    <div id="gcReqMsg" class="msg"></div>
  </div>

  <!-- AMBASSADORS -->
  <div id="pane-ambassadors" class="tab-pane">
    <div class="card" style="margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
      <div><div class="section">📢 Recrutement ambassadeurs</div><div style="font-size:.75rem;color:#64748b" id="amb-recruit-desc">Chargement…</div></div>
      <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">
        <input id="amb-recruit-nextwave" type="text" placeholder="Prochaine vague (ex: 1er sept.)" style="background:#1e293b;color:#f1f5f9;border:1px solid #334155;border-radius:5px;padding:6px 8px;font-size:.78rem;">
        <button id="amb-recruit-toggle" class="btn-act btn-green" onclick="toggleAmbRecruitment()">…</button>
      </div>
    </div>
    <div class="card" style="overflow-x:auto;margin-bottom:16px;">
      <div class="section">🤝 Ambassadeurs (candidatures + actifs + suspendus)</div>
      <table>
        <thead><tr>
          <th>Email</th><th>Code</th><th>Statut</th><th>Niveau</th><th>Solde clawback</th><th>Actions</th>
        </tr></thead>
        <tbody id="amb-tbody"><tr><td colspan="6" style="text-align:center;color:#64748b;padding:20px;">Chargement…</td></tr></tbody>
      </table>
    </div>
    <div id="amb-msg" class="msg"></div>

    <div class="card" style="overflow-x:auto;">
      <div class="section" style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
        <span>💰 Commissions</span>
        <div style="display:flex;gap:8px;align-items:center;">
          <select id="amb-comm-filter" class="filter" onchange="loadAmbCommissions()">
            <option value="">Tous statuts</option>
            <option value="due">Dû (due)</option>
            <option value="paid">Versé (paid)</option>
            <option value="clawback">Clawback</option>
          </select>
          <button class="btn-act" onclick="exportAmbCommissionsCSV()">⬇️ Export CSV</button>
        </div>
      </div>
      <table>
        <thead><tr>
          <th>Date</th><th>Ambassadeur</th><th>Plan</th><th style="text-align:right">Montant net</th>
          <th style="text-align:right">Commission (15%)</th><th>Statut</th><th>Action</th>
        </tr></thead>
        <tbody id="amb-comm-tbody"><tr><td colspan="7" style="text-align:center;color:#64748b;padding:20px;">Chargement…</td></tr></tbody>
      </table>
    </div>
    <div id="amb-comm-msg" class="msg"></div>
  </div>

  <!-- PROMOTIONS -->
  <div id="pane-promo" class="tab-pane">
    <div class="card" style="margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
      <div><div class="section">🔥 Promotions</div><div style="font-size:.75rem;color:#64748b">Interrupteur maître : si désactivé, aucun badge promo ne s'affiche sur le site, quels que soient les forfaits cochés ci-dessous.</div></div>
      <label style="display:flex;align-items:center;gap:8px;font-size:.85rem;font-weight:600;">
        <input id="promo-master" type="checkbox" style="width:18px;height:18px">
        Activer les promotions
      </label>
    </div>
    <div class="card" style="margin-bottom:14px;">
      <div class="section">Forfaits en promotion</div>
      <div style="font-size:.75rem;color:#64748b;margin-bottom:10px">Coche les forfaits à mettre en avant. Chaque forfait est indépendant.</div>
      <div style="display:grid;gap:14px;font-size:.85rem;">
        <div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;">
          <label style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;"><input id="promo-plan-standard" type="checkbox" onchange="updatePromoPreview('standard')"> 🥉 Standard — normal 10 000 FCFA/an</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-left:26px;">
            <input id="promo-price-standard" type="number" min="0" placeholder="Prix promo (ex: 8000)" oninput="updatePromoPreview('standard')" style="width:160px">
            <input id="promo-bonus-standard" type="text" placeholder="Ex: Badge 🥉 +1 Go stockage" oninput="updatePromoPreview('standard')" style="flex:1;min-width:200px">
          </div>
          <div id="promo-preview-standard" style="margin-left:26px;margin-top:6px;font-size:.72rem;color:#f59e0b"></div>
        </div>
        <div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;">
          <label style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;"><input id="promo-plan-avance" type="checkbox" onchange="updatePromoPreview('avance')"> 🆕 Avancé — normal 18 000 FCFA/an</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-left:26px;">
            <input id="promo-price-avance" type="number" min="0" placeholder="Prix promo (ex: 14000)" oninput="updatePromoPreview('avance')" style="width:160px">
            <input id="promo-bonus-avance" type="text" placeholder="Ex: bonus activation Avancé" oninput="updatePromoPreview('avance')" style="flex:1;min-width:200px">
          </div>
          <div id="promo-preview-avance" style="margin-left:26px;margin-top:6px;font-size:.72rem;color:#f59e0b"></div>
        </div>
        <div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;">
          <label style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;"><input id="promo-plan-professionnel" type="checkbox" onchange="updatePromoPreview('professionnel')"> 🥈 Professionnel — normal 25 000 FCFA/an</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-left:26px;">
            <input id="promo-price-professionnel" type="number" min="0" placeholder="Prix promo (ex: 20000)" oninput="updatePromoPreview('professionnel')" style="width:160px">
            <input id="promo-bonus-professionnel" type="text" placeholder="Ex: Badge 🥈 +3 Go + 5j LumiStreaming" oninput="updatePromoPreview('professionnel')" style="flex:1;min-width:200px">
          </div>
          <div id="promo-preview-professionnel" style="margin-left:26px;margin-top:6px;font-size:.72rem;color:#f59e0b"></div>
        </div>
        <div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;">
          <label style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:6px;"><input id="promo-plan-premium" type="checkbox" onchange="updatePromoPreview('premium')"> 🥇 Premium — normal 50 000 FCFA/an</label>
          <div style="display:flex;gap:8px;flex-wrap:wrap;margin-left:26px;">
            <input id="promo-price-premium" type="number" min="0" placeholder="Prix promo (ex: 30000)" oninput="updatePromoPreview('premium')" style="width:160px">
            <input id="promo-bonus-premium" type="text" placeholder="Ex: Badge 🥇 +6 Go + 10j LumiStreaming" oninput="updatePromoPreview('premium')" style="flex:1;min-width:200px">
          </div>
          <div id="promo-preview-premium" style="margin-left:26px;margin-top:6px;font-size:.72rem;color:#f59e0b"></div>
        </div>
        <div style="border:1px solid #e2e8f0;border-radius:10px;padding:10px 12px;">
          <label><input id="promo-plan-institution" type="checkbox"> 🏛️ Institution — sur devis</label>
        </div>
      </div>
      <div style="font-size:.72rem;color:#64748b;margin-top:10px">Une case cochée sans prix promo ni cadeau ne peut pas être enregistrée (évite d'activer une promo vide). Sans prix promo renseigné, le prix normal reste affiché — le cadeau s'ajoute simplement à côté.</div>
      <button class="btn-act btn-green" style="width:max-content;margin-top:14px" onclick="savePromoConfig()">Enregistrer</button>
      <div id="promo-config-msg" class="msg"></div>
    </div>
  </div>

  <!-- STUDENT HELP -->
  <div id="pane-help" class="tab-pane">
    <div class="card" style="margin-bottom:14px;display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;">
      <div><div class="section">🆘 Espace d’aide temporaire</div><div style="font-size:.75rem;color:#64748b">Choisissez les forfaits autorisés. Le quota est mensuel et contrôlé côté serveur.</div></div>
      <button id="help-toggle" data-enabled="true" class="btn-act btn-green" onclick="toggleHelpSpace()">Fermer temporairement</button>
    </div>
    <div class="card" style="margin-bottom:14px;"><div class="section">⚙️ Forfaits autorisés et quotas</div><div style="display:grid;gap:8px;font-size:.8rem;"><label><input id="help-plan-standard" type="checkbox"> 10k — quota mensuel <input id="help-limit-standard" type="number" min="0" max="10" value="1" style="width:70px;margin-left:8px;background:#1e293b;color:#f1f5f9;border:1px solid #334155;border-radius:5px;padding:4px"></label><label><input id="help-plan-professionnel" type="checkbox"> 25k — quota mensuel <input id="help-limit-professionnel" type="number" min="0" max="10" value="2" style="width:70px;margin-left:8px;background:#1e293b;color:#f1f5f9;border:1px solid #334155;border-radius:5px;padding:4px"></label><label><input id="help-plan-premium" type="checkbox" checked> 50k Premium — quota mensuel <input id="help-limit-premium" type="number" min="0" max="10" value="3" style="width:70px;margin-left:8px;background:#1e293b;color:#f1f5f9;border:1px solid #334155;border-radius:5px;padding:4px"></label><button class="btn-act btn-green" style="width:max-content;margin-top:6px" onclick="saveHelpConfig()">Enregistrer la configuration</button></div><div id="help-config-msg" class="msg"></div></div>
    <div class="card" style="overflow-x:auto"><div class="section">Demandes d’aide récentes</div><select id="help-filter-plan" class="filter" onchange="loadHelpRequests()" style="margin-bottom:10px"><option value="">Tous les forfaits</option><option value="standard">10k</option><option value="professionnel">25k</option><option value="premium">50k Premium</option></select><div id="help-admin-list" style="font-size:.8rem;color:#94a3b8">Chargement…</div></div><div class="card" style="overflow-x:auto;margin-top:14px"><div class="section">🎁 Demandes de récompenses</div><div id="reward-admin-list" style="font-size:.8rem;color:#94a3b8">Chargement…</div></div>
    <div id="help-admin-msg" class="msg"></div>
  </div>

  <!-- QUARTER RANKING -->
  <div id="pane-ranking" class="tab-pane">
    <div class="card" style="margin-bottom:14px;"><div class="section">🏆 Classement trimestriel</div><div style="font-size:.75rem;color:#64748b;margin-bottom:10px">Règle : score moyen sur au moins 3 exercices validés. Les comptes suspendus ou signalés pour multi-compte sont exclus. Égalité : meilleur score, puis nombre de tentatives.</div><button class="btn-act btn-green" onclick="loadQuarterRanking()">Actualiser</button></div>
    <div class="card" style="overflow-x:auto"><div id="ranking-list" style="font-size:.8rem;color:#94a3b8">Chargement…</div></div>
  </div>

  <!-- PAYMENTS -->
  <div id="pane-payments" class="tab-pane">
    <div class="card" style="text-align:center;padding:40px">
      <div style="font-size:2rem;margin-bottom:12px">⏳</div>
      <p style="color:#64748b;font-size:0.85rem">Paiements disponibles après configuration API.<br>
      Ajoutez <code style="background:#1e293b;padding:2px 6px;border-radius:4px">NOTCHPAY_PUBLIC_KEY</code> dans Netlify.</p>
    </div>
  </div>

  <!-- ALERTS -->
  <div id="pane-alerts" class="tab-pane">
    <div style="padding:10px 14px;background:#1e293b;border-radius:8px;font-size:0.75rem;color:#64748b;margin-bottom:14px;">
      🚨 Détection anti-partage — non-bloquante. <b style="color:#f87171">usage_burst</b> = conso ≥40% du stock annuel en 48h.
      <b style="color:#f59e0b">device_multi</b> = plus de 2 appareils distincts en 7 jours.
    </div>
    <div class="card" style="overflow-x:auto">
      <table>
        <thead><tr>
          <th>Date</th><th>Email</th><th>Type</th><th>Détail</th><th>Action</th>
        </tr></thead>
        <tbody id="alerts-tbody"><tr><td colspan="5" style="text-align:center;color:#64748b;padding:20px;">Chargement…</td></tr></tbody>
      </table>
    </div>
    <div id="alerts-msg" class="msg"></div>
  </div>

  <!-- CHIMI LINKS -->
  <div id="pane-chimilinks" class="tab-pane">
    <div class="card" style="max-width:480px">
      <div class="section">⚡ Générer un lien de chimis offerts</div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
        <label style="font-size:0.78rem;color:#94a3b8">Nombre de chimis
          <input type="number" id="cl-nb" min="1" value="5" style="width:100%;padding:8px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#f1f5f9;margin-top:3px">
        </label>
        <label style="font-size:0.78rem;color:#94a3b8">Durée de vie des chimis reçus (jours, 1 à 7)
          <input type="number" id="cl-duree-chimis" min="1" max="7" value="3" style="width:100%;padding:8px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#f1f5f9;margin-top:3px">
        </label>
        <label style="font-size:0.78rem;color:#94a3b8">Durée de vie du lien (heures)
          <input type="number" id="cl-duree-lien" min="1" value="48" style="width:100%;padding:8px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#f1f5f9;margin-top:3px">
        </label>
        <label style="font-size:0.78rem;color:#94a3b8">Nombre d'utilisations max (1 = usage unique)
          <input type="number" id="cl-max-claims" min="1" value="1" style="width:100%;padding:8px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#f1f5f9;margin-top:3px">
        </label>
        <label style="font-size:0.78rem;color:#94a3b8">Plafond quotidien (0 = illimité)
          <input type="number" id="cl-daily-max" min="0" value="0" style="width:100%;padding:8px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#f1f5f9;margin-top:3px">
        </label>
        <button class="btn-act btn-green" onclick="genererLienChimi()">🔗 Générer le lien</button>
        <div id="cl-result" style="font-size:0.78rem;color:#94a3b8;word-break:break-all"></div>
      </div>
    </div>
  </div>

  <!-- INFOS & BUDGET -->
  <div id="pane-infos" class="tab-pane">
    <div class="card" style="max-width:480px">
      <div class="section">💰 Budget chimis gratuits (quêtes + parrainage)</div>
      <div id="budget-status" style="font-size:0.82rem;color:#94a3b8;margin:8px 0">Chargement…</div>
      <label style="font-size:0.78rem;color:#94a3b8">Nouveau plafond mensuel (chimis)
        <input type="number" id="budget-cap-input" min="0" style="width:100%;padding:8px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#f1f5f9;margin-top:3px">
      </label>
      <button class="btn-act btn-green" style="margin-top:8px" onclick="setBudgetCap()">Mettre à jour le plafond</button>
      <div id="budget-set-msg" style="font-size:0.78rem;color:#94a3b8;margin-top:6px"></div>
      <div style="font-size:0.72rem;color:#64748b;margin-top:6px">Au-delà de ce plafond, les quêtes et bonus de parrainage se suspendent automatiquement jusqu'au mois suivant — jamais une réduction silencieuse des taux.</div>
    </div>

    <div class="card" style="max-width:560px;margin-top:14px">
      <div class="section">📢 Publier une info officielle</div>
      <div style="display:flex;flex-direction:column;gap:10px;margin-top:10px">
        <input type="text" id="info-title" placeholder="Titre (ex : Maintenance prévue ce soir)" maxlength="140" style="width:100%;padding:8px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#f1f5f9">
        <textarea id="info-text" placeholder="Contenu détaillé..." maxlength="3000" rows="4" style="width:100%;padding:8px;border-radius:6px;border:1px solid #334155;background:#0f172a;color:#f1f5f9;font-family:inherit"></textarea>
        <button class="btn-act btn-green" onclick="publierInfo()">📢 Publier</button>
        <div id="info-publish-msg" style="font-size:0.78rem;color:#94a3b8"></div>
      </div>
    </div>

    <div class="card" style="max-width:560px;margin-top:14px">
      <div class="section">Infos publiées</div>
      <div id="infos-admin-list" style="margin-top:10px;font-size:0.82rem;color:#94a3b8">Chargement…</div>
    </div>

    <div class="card" style="max-width:560px;margin-top:14px">
      <div class="section">👥 Répartition par profil</div>
      <div style="font-size:0.72rem;color:#64748b;margin:4px 0 8px">Segmentation choisie à l'inscription — sert à adapter les campagnes par public.</div>
      <div id="profil-stats-list" style="font-size:0.82rem;color:#94a3b8">Chargement…</div>
    </div>
  </div>

  <script>
    // Token récupéré depuis localStorage de l'app principale
    // Le token de l’URL est le plus récent ; ne jamais privilégier un ancien token du localStorage.
    const URL_TOKEN = new URLSearchParams(location.search).get('t') || '';
    const TOKEN = URL_TOKEN || localStorage.getItem('sa_admin_token') || '';
    if (URL_TOKEN) localStorage.setItem('sa_admin_token', URL_TOKEN);

    function switchTab(id, btn) {
      const pane = document.getElementById('pane-' + id);
      if (!pane) return false;
      document.querySelectorAll('.tab-pane').forEach(function(p) {
        p.classList.remove('active');
        p.style.display = 'none';
        p.setAttribute('aria-hidden', 'true');
      });
      document.querySelectorAll('.tab-btn').forEach(function(b) {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
      });
      pane.classList.add('active');
      pane.style.display = 'block';
      pane.setAttribute('aria-hidden', 'false');
      if (btn && btn.classList) {
        btn.classList.add('active');
        btn.setAttribute('aria-selected', 'true');
      }
      // Chaque onglet recharge ses données au moment de l’ouverture.
      // Les appels sont centralisés ici afin d’éviter les panneaux statiques.
      const loaders = {
        users: () => loadUsersCurrent(),
        institutions: () => loadInstitutions(),
        alerts: () => loadAlerts(),
        groups: () => loadGroups(),
        ambassadors: () => Promise.all([loadAmbassadors(), loadAmbCommissions(), loadAmbRecruitmentStatus()]),
        promo: () => loadPromoConfig(),
        help: () => Promise.all([loadHelpConfig(), loadHelpRequests(), loadRewardRequests()]),
        ranking: () => loadQuarterRanking(),
        infos: () => Promise.all([loadInfosAdmin(), loadBudgetStatus(), loadProfilStats()])
      };
      if (loaders[id]) {
        Promise.resolve(loaders[id]()).catch(function(err) {
          const paneError = pane.querySelector('.tab-load-error');
          if (paneError) paneError.textContent = '❌ Actualisation impossible : ' + (err.message || err);
          else console.error('Erreur chargement onglet ' + id, err);
        });
      }
      return false;
    }

    // Navigation robuste : aucun panneau ne reste masqué lorsque l’URL contient
    // #pane-users ou un autre fragment. Le rendu est piloté uniquement par JS,
    // sans dépendre du sélecteur CSS :has, inégalement supporté sur mobile.
    document.querySelectorAll('.tab-btn[data-tab]').forEach(function(tabButton) {
      tabButton.addEventListener('click', function(event) {
        event.preventDefault();
        event.stopPropagation();
        switchTab(tabButton.getAttribute('data-tab'), tabButton);
      }, false);
    });
    function activateTabFromHash() {
      const hash = String(location.hash || '').replace(/^#/, '');
      const id = hash.indexOf('pane-') === 0 ? hash.slice(5) : (hash || 'stats');
      const button = document.querySelector('.tab-btn[data-tab="' + id + '"]');
      switchTab(button ? id : 'stats', button || document.querySelector('.tab-btn[data-tab="stats"]'));
    }
    window.addEventListener('hashchange', activateTabFromHash, false);
    activateTabFromHash();

    function filterTable() {
      const s = document.getElementById('srch').value.toLowerCase();
      const fp = document.getElementById('fplan').value;
      const fs = document.getElementById('fstatus').value;
      document.querySelectorAll('#user-tbody tr').forEach(tr => {
        const cells = tr.querySelectorAll('td');
        if (!cells.length) return;
        const email = cells[0].textContent.toLowerCase();
        const plan  = cells[1].textContent.trim();
        const susp  = cells[5].textContent.trim().toLowerCase();
        const show  = (!s || email.includes(s))
                   && (!fp || plan === fp)
                   && (!fs || susp.includes(fs === 'actif' ? 'actif' : 'suspendu'));
        tr.style.display = show ? '' : 'none';
      });
    }

    function showMsg(msg, ok) {
      const el = document.getElementById('action-msg');
      el.textContent = msg;
      el.className = 'msg ' + (ok ? 'ok' : 'err');
      el.style.display = 'block';
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (ok) {
        // Succès : on recharge pour refléter le nouvel état, en laissant le
        // temps de lire le message de confirmation.
        setTimeout(() => { el.style.display = 'none'; location.reload(); }, 2500);
      } else {
        // Échec : on NE recharge PAS automatiquement — un reload immédiat
        // effaçait le message d'erreur avant que l'admin ait pu le lire,
        // donnant l'impression que "rien ne se passe".
        setTimeout(() => { el.style.display = 'none'; }, 8000);
      }
    }

    function escapeUserValue(value) {
      return String(value ?? '').replace(/[&<>\"']/g, function(ch) {
        return {'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;',"'":'&#39;'}[ch];
      });
    }
    function renderCurrentUsers(users) {
      const tbody = document.getElementById('user-tbody');
      if (!tbody) return;
      if (!Array.isArray(users) || !users.length) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:24px">Aucun utilisateur trouvé.</td></tr>';
        return;
      }
      tbody.innerHTML = users.map(function(u) {
        const uid = escapeUserValue(u.uid);
        const email = escapeUserValue(u.email || '—');
        const plan = escapeUserValue(u.plan || 'gratuit');
        const role = u.role ? ' <span class="badge-admin">' + escapeUserValue(u.role) + '</span>' : '';
        const expiry = u.planExpiry ? new Date(u.planExpiry).toLocaleDateString('fr-FR') : '—';
        const created = u.createdAt ? new Date(u.createdAt).toLocaleDateString('fr-FR') : '—';
        const status = u.suspended ? '<span class="badge-red">Suspendu</span>' : '<span class="badge-green">Actif</span>';
        const suspendAction = u.suspended
          ? '<button onclick="setSuspend(\\'' + uid + '\\',false)" class="btn-act btn-green" title="Réactiver">✅</button>'
          : '<button onclick="setSuspend(\\'' + uid + '\\',true)" class="btn-act btn-red" title="Suspendre">🚫</button>';
        return '<tr><td>' + email + role + '</td><td style="font-weight:600">' + plan + '</td>' +
          '<td style="text-align:center">' + Number(u.credits || 0) + '</td><td>' + expiry + '</td><td>' + created + '</td><td>' + status + '</td>' +
          '<td><div style="display:flex;gap:4px;flex-wrap:wrap">' +
          '<select onchange="setPlan(\\'' + uid + '\\',this.value)" style="background:#1e293b;color:#f1f5f9;border:1px solid #334155;border-radius:6px;padding:3px 6px;font-size:0.7rem;cursor:pointer">' +
          ['gratuit','standard','professionnel','premium','institution','ecole','hopital_district','centre_sante','pharmacie'].map(function(p) { const labels={gratuit:'🆓 Gratuit',standard:'🥉 Standard',professionnel:'🥈 Professionnel',premium:'🥇 Premium',institution:'🏛️ Institution',ecole:'🏫 École',hopital_district:'🏥 Hôpital de district',centre_sante:'🏥 Centre de santé',pharmacie:'💊 Pharmacie'}; return '<option value="' + p + '"' + (plan === p ? ' selected' : '') + '>' + labels[p] + '</option>'; }).join('') +
          '</select><button onclick="addCredits(\\'' + uid + '\\')" class="btn-act" title="Ajouter crédits">+💳</button>' +
          '<button onclick="genererLienUpgrade(\\'' + uid + '\\')" class="btn-act" title="Générer un lien d’upgrade">🔗 Upgrade</button>' +
          '<button onclick="appliquerUpgrade(\\'' + uid + '\\')" class="btn-act btn-green" title="Appliquer l’upgrade">✅ Upgrade</button>' +
          '<button onclick="modifierInfosUtilisateur(\\'' + uid + '\\')" class="btn-act" title="Modifier les informations utilisateur">✏️ Infos</button>' + suspendAction +
          '</div></td></tr>';
      }).join('');
      filterTable();
    }
    async function loadUsersCurrent() {
      const tbody = document.getElementById('user-tbody');
      if (!tbody || window.__usersLoading) return;
      window.__usersLoading = true;
      tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#94a3b8;padding:24px">⏳ Actualisation des utilisateurs…</td></tr>';
      try {
        const result = await apiCall('listUsers', null, {});
        if (!result.ok) throw new Error(result.error || 'Impossible de charger les utilisateurs');
        window.__adminUsers = Array.isArray(result.users) ? result.users : [];
        renderCurrentUsers(window.__adminUsers);
        const stamp = document.getElementById('users-refresh-status');
        if (stamp) stamp.textContent = 'Mis à jour à ' + new Date().toLocaleTimeString('fr-FR');
      } catch (e) {
        tbody.innerHTML = '<tr><td colspan="7" style="text-align:center;color:#f87171;padding:24px">❌ ' + escapeUserValue(e.message) + '</td></tr>';
      } finally {
        window.__usersLoading = false;
      }
    }
    let __adminAuthPromise = null;
    let __adminUserPromise = null;
    async function getAdminAuth() {
      if (!__adminAuthPromise) {
        __adminAuthPromise = import('https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js')
          .then(async ({ initializeApp, getApps }) => {
            const cfg = {
              apiKey: 'AIzaSyA3pT5-TNZTiOUz3AeMRUBdblucyp0EWSI',
              authDomain: 'pstat-pro-all.netlify.app',
              projectId: 'statanalyse-pro',
              storageBucket: 'statanalyse-pro.firebasestorage.app',
              messagingSenderId: '548600157788',
              appId: '1:548600157788:web:c4a4063ad1dc824e75b899'
            };
            const app = getApps().length ? getApps()[0] : initializeApp(cfg);
            const authMod = await import('https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js');
            const auth = authMod.getAuth(app);
            // Persistance inter-onglets : permet au dashboard admin de renouveler
            // le token Firebase dans ce nouvel onglet. En cas de navigateur qui
            // bloque le stockage, le token signé transmis dans l'URL reste le
            // dernier recours et les contrôles serveur restent obligatoires.
            if (authMod.setPersistence && authMod.browserLocalPersistence) {
              try { await authMod.setPersistence(auth, authMod.browserLocalPersistence); } catch (_) {}
            }
            return auth;
          });
      }
      return __adminAuthPromise;
    }
    async function getFreshAdminToken() {
      // L'admin est ouvert dans un nouvel onglet. La persistence locale est
      // activée au moment de l'ouverture depuis l'application principale, ce qui
      // permet à cet onglet de récupérer le compte Firebase et de renouveler
      // réellement le token au lieu de réutiliser un token URL expiré.
      try {
        const auth = await getAdminAuth();
        if (auth.currentUser) return await auth.currentUser.getIdToken(true);
        if (!__adminUserPromise) {
          __adminUserPromise = new Promise(resolve => {
            let done = false;
            const finish = u => { if (done) return; done = true; try { unsub(); } catch (_) {} resolve(u || null); };
            const timer = setTimeout(() => finish(null), 5000);
            const unsub = auth.onAuthStateChanged ? auth.onAuthStateChanged(u => { clearTimeout(timer); finish(u); }) : null;
          });
        }
        const u = await __adminUserPromise;
        if (u) return await u.getIdToken(true);
      } catch (e) {
        console.warn('Impossible de rafraîchir le token admin Firebase :', e);
      }
      if (TOKEN) return TOKEN;
      throw new Error('Session administrateur expirée. Ouvrez à nouveau le tableau Admin depuis Noria Education.');
    }

    async function apiCall(action, targetUid, payload) {
      let freshToken = await getFreshAdminToken();
      let r = await fetch('/.netlify/functions/adminAction', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + freshToken },
        body: JSON.stringify({ action, targetUid, payload })
      });
      let data = {};
      try { data = await r.json(); } catch (_) { data = { error: 'Réponse serveur invalide (' + r.status + ')' }; }
      if (r.status === 401) {
        try {
          const auth = await getAdminAuth();
          if (auth.currentUser) {
            freshToken = await auth.currentUser.getIdToken(true);
            r = await fetch('/.netlify/functions/adminAction', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + freshToken },
              body: JSON.stringify({ action, targetUid, payload })
            });
            try { data = await r.json(); } catch (_) { data = { error: 'Réponse serveur invalide (' + r.status + ')' }; }
          }
        } catch (_) {}
      }
      if (!r.ok) throw new Error(data.error || ('Action refusée (HTTP ' + r.status + ').'));
      return data;
    }

    // ── Modal de saisie inline (remplace window.prompt, peu fiable sur mobile) ──
    let _inlineModalResolver = null;
    function askInline(title, defaultValue) {
      return new Promise(resolve => {
        _inlineModalResolver = resolve;
        document.getElementById('inlineModalTitle').textContent = title;
        const input = document.getElementById('inlineModalInput');
        input.value = defaultValue || '';
        document.getElementById('inlineModalOverlay').style.display = 'flex';
        setTimeout(() => input.focus(), 50);
      });
    }
    function _inlineModalResolve(value) {
      document.getElementById('inlineModalOverlay').style.display = 'none';
      if (_inlineModalResolver) { _inlineModalResolver(value); _inlineModalResolver = null; }
    }

    async function setPlan(uid, plan) {
      try {
        const r = await apiCall('setPlan', uid, { plan });
        showMsg(r.ok ? '✅ ' + r.msg : '❌ ' + (r.error || 'Modification refusée'), r.ok);
        if (!r.ok) loadUsersCurrent();
      } catch (e) { showMsg('❌ ' + (e.message || 'Modification impossible'), false); }
    }

    async function genererLienUpgrade(uid) {
      try {
        const r = await apiCall('generateUpgradeLink', uid, {});
        if (!r.ok) { showMsg('❌ ' + (r.error || 'Erreur'), false); return; }
        const url = window.location.origin + '/upgrade.html?token=' + r.token;
        await askInline("🔗 Lien à envoyer à l'étudiant (valable 48h, usage unique) — copiez-le puis OK :", url);
        showMsg('✅ Lien généré', true);
      } catch (e) { showMsg('❌ ' + (e.message || 'Génération impossible'), false); }
    }

    async function genererLienChimi() {
      const nbChimis = parseInt(document.getElementById('cl-nb').value, 10);
      const dureeChimisJours = parseInt(document.getElementById('cl-duree-chimis').value, 10);
      const dureeLienHeures = parseInt(document.getElementById('cl-duree-lien').value, 10);
      const maxClaims = parseInt(document.getElementById('cl-max-claims').value, 10);
      const dailyMaxClaims = parseInt(document.getElementById('cl-daily-max').value, 10);
      const r = await apiCall('generateChimiLink', null, { nbChimis, dureeChimisJours, dureeLienHeures, maxClaims, dailyMaxClaims });
      const resEl = document.getElementById('cl-result');
      if (!r.ok) { resEl.innerHTML = '❌ ' + (r.error || 'Erreur'); return; }
      const url = window.location.origin + '/?chimi=' + r.token;
      resEl.innerHTML = '✅ Lien généré (expire le ' + new Date(r.expiresAt).toLocaleString('fr-FR') + ', ' + r.maxClaims + ' utilisation(s) max) :<br><br><a href="' + url + '" target="_blank" style="color:#22d3ee">' + url + '</a>';
    }

    async function appliquerUpgrade(uid) {
      const plan = await askInline('Palier à appliquer (standard / professionnel / premium) :', '');
      if (plan === null) return;
      const p = plan.trim().toLowerCase();
      if (!['standard','professionnel','premium'].includes(p)) { showMsg('❌ Palier invalide', false); return; }
      const confirmed = await askInline('Tapez OUI pour confirmer la mise à niveau vers ' + p + ' (stock complet accordé, expiration inchangée) :', '');
      if (!confirmed || confirmed.trim().toUpperCase() !== 'OUI') return;
      try {
        const r = await apiCall('applyUpgrade', uid, { targetPlan: p });
        showMsg(r.ok ? '✅ ' + r.msg : '❌ ' + (r.error || 'Erreur'), r.ok);
      } catch (e) { showMsg('❌ ' + (e.message || 'Upgrade impossible'), false); }
    }

    // ── Campagnes groupe ─────────────────────────────────────────────
    async function groupApi(action, payload) { const token=await getFreshAdminToken(); const r=await fetch('/.netlify/functions/groupCampaign',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({action,...payload})}); return r.json(); }
    async function growthApi(action, payload) { const token=await getFreshAdminToken(); const r=await fetch('/.netlify/functions/growth',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({action,...payload})}); return r.json(); }
    async function loadBudgetStatus() {
      const el = document.getElementById('budget-status'); if (!el) return;
      el.textContent = 'Chargement…';
      try {
        const d = await growthApi('budgetStatus', {});
        if (!d.ok) throw new Error(d.error || 'Erreur');
        document.getElementById('budget-cap-input').value = d.cap;
        el.innerHTML = 'Mois ' + d.monthKey + ' — <b style="color:#f1f5f9">' + d.spent + ' / ' + d.cap + '</b> chimis distribués — <span style="color:' + (d.remaining < d.cap * 0.2 ? '#f59e0b' : '#10b981') + '">' + d.remaining + ' restants</span>';
      } catch (e) { el.textContent = '❌ ' + e.message; }
    }
    async function setBudgetCap() {
      const cap = parseInt(document.getElementById('budget-cap-input').value, 10);
      const msg = document.getElementById('budget-set-msg');
      if (!Number.isFinite(cap) || cap < 0) { msg.textContent = '❌ Plafond invalide'; return; }
      msg.textContent = '⏳ Mise à jour…';
      try {
        const d = await growthApi('setBudget', { cap });
        if (!d.ok) throw new Error(d.error || 'Erreur');
        msg.textContent = '✅ Plafond mis à jour';
        loadBudgetStatus();
      } catch (e) { msg.textContent = '❌ ' + e.message; }
    }
    async function publierInfo() {
      const title = document.getElementById('info-title').value.trim();
      const text = document.getElementById('info-text').value.trim();
      const msg = document.getElementById('info-publish-msg');
      if (!title || !text) { msg.textContent = '❌ Titre et contenu requis'; return; }
      msg.textContent = '⏳ Publication…';
      try {
        const d = await growthApi('publishInfo', { title, text });
        if (!d.ok) throw new Error(d.error || 'Erreur');
        msg.textContent = '✅ Publié';
        document.getElementById('info-title').value = '';
        document.getElementById('info-text').value = '';
        loadInfosAdmin();
      } catch (e) { msg.textContent = '❌ ' + e.message; }
    }
    async function loadInfosAdmin() {
      const el = document.getElementById('infos-admin-list'); if (!el) return;
      el.textContent = 'Chargement…';
      try {
        const d = await growthApi('listInfos', {});
        if (!d.ok) throw new Error(d.error || 'Erreur');
        if (!d.items.length) { el.textContent = 'Aucune info publiée.'; return; }
        el.innerHTML = d.items.map(function(p) {
          var esc = function(s){ return String(s||'').replace(/[<>]/g,''); };
          var d2 = p.createdAt ? new Date(p.createdAt).toLocaleDateString('fr-FR', {day:'2-digit',month:'2-digit',year:'numeric'}) : '';
          return '<div style="padding:8px 0;border-bottom:1px solid #334155"><b style="color:#f1f5f9">' + esc(p.title) + '</b> <span style="color:#64748b">(' + d2 + ')</span><br>' +
            '<span style="color:#94a3b8">' + esc(p.text).slice(0,150) + '</span> ' +
            '<button class="btn-act" style="background:#7f1d1d;margin-left:6px" onclick="supprimerInfoAdmin(\\'' + p.id + '\\')">Supprimer</button></div>';
        }).join('');
      } catch (e) { el.textContent = '❌ ' + e.message; }
    }
    async function supprimerInfoAdmin(id) {
      if (!confirm('Supprimer cette info ?')) return;
      try {
        const d = await growthApi('deleteInfo', { id });
        if (!d.ok) throw new Error(d.error || 'Erreur');
        loadInfosAdmin();
      } catch (e) { alert('❌ ' + e.message); }
    }
    async function loadProfilStats() {
      const el = document.getElementById('profil-stats-list'); if (!el) return;
      el.textContent = 'Chargement…';
      try {
        const d = await growthApi('profilStats', {});
        if (!d.ok) throw new Error(d.error || 'Erreur');
        if (!d.items.length) { el.textContent = 'Aucune donnée pour le moment.'; return; }
        el.innerHTML = d.items.map(function(it) {
          var barColor = it.conversionPct >= 10 ? '#10b981' : it.conversionPct >= 3 ? '#f59e0b' : '#64748b';
          return '<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-bottom:1px solid #334155">' +
            '<span style="color:#f1f5f9">' + it.label + '</span>' +
            '<span>' + it.total + ' util. — <b style="color:' + barColor + '">' + it.conversionPct + '% payants</b> (' + it.paid + ')</span>' +
            '</div>';
        }).join('') + '<div style="font-size:0.72rem;color:#64748b;margin-top:8px">Total : ' + d.totalUsers + ' comptes</div>';
      } catch (e) { el.textContent = '❌ ' + e.message; }
    }
    function groupMsg(id,msg,ok){const e=document.getElementById(id);e.textContent=msg;e.className='msg '+(ok?'ok':'err');e.style.display='block';setTimeout(()=>e.style.display='none',3500)}
    function syncCampaignPrice(){const prices={standard:10000,professionnel:25000,premium:35000};const el=document.getElementById('gcPrice');if(el)el.value=prices[document.getElementById('gcPlan')?.value]||10000}
    async function createGroupCampaign(){const payload={name:document.getElementById('gcName').value.trim(),targetPlan:document.getElementById('gcPlan').value,profile:document.getElementById('gcProfile').value,permanent:document.getElementById('gcPermanent').checked,priceFCFA:parseInt(document.getElementById('gcPrice').value,10),maxPlaces:parseInt(document.getElementById('gcMax').value,10),expiresAt:document.getElementById('gcExpiry').value};const r=await groupApi('create',{payload});if(!r.ok){groupMsg('gcMsg','❌ '+r.error,false);return}const base=location.origin+'/?campagne='+encodeURIComponent(r.id);const statsUrl=base+'&profil=stats';const studentUrl=base+'&profil=student';const links=document.getElementById('gcLinks');if(links){links.style.display='block';links.innerHTML='<b>Liens à partager</b><br>📊 Statistiques uniquement : <a href="'+statsUrl+'" target="_blank" style="color:#60a5fa">'+statsUrl+'</a><br>🎓 Statistiques + Étudiant : <a href="'+studentUrl+'" target="_blank" style="color:#22d3ee">'+studentUrl+'</a>'}groupMsg('gcMsg','✅ Campagne créée',true);loadGroups()}
    async function loadGroups(){const [cr,rr]=await Promise.all([groupApi('list',{}),groupApi('listRequests',{})]);const list=document.getElementById('gcList');if(cr.ok&&cr.campaigns.length){list.innerHTML=cr.campaigns.map(c=>'<div style="border-bottom:1px solid #334155;padding:10px 0"><b>'+c.name+'</b> — '+c.targetPlan+' — '+Number(c.priceFCFA).toLocaleString('fr-FR')+' FCFA — '+c.usedPlaces+'/'+c.maxPlaces+' places <button class="btn-act" onclick="copyCampaignLink(&quot;'+c.id+'&quot;,&quot;stats&quot;)">📊 Lien stats</button> <button class="btn-act" onclick="copyCampaignLink(&quot;'+c.id+'&quot;,&quot;student&quot;)">🎓 Lien étudiant</button> <button class="btn-act" onclick="changeQuota(&quot;'+c.id+'&quot;,'+c.maxPlaces+')">Quota</button><br><small>'+(c.permanent?'Lien permanent':'Expire le '+new Date(c.expiresAt).toLocaleString('fr-FR'))+'</small></div>').join('')}else list.innerHTML='Aucune campagne.';const tbody=document.getElementById('gcRequests');if(!rr.ok||!rr.requests.length){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:#64748b;padding:20px">Aucune demande</td></tr>';return}tbody.innerHTML=rr.requests.map(r=>'<tr><td>'+new Date(r.requestedAt).toLocaleString('fr-FR')+'</td><td>'+ (r.email||'—')+'</td><td>'+r.campaignId+'</td><td>'+r.status+'</td><td>'+Number(r.priceFCFA||0).toLocaleString('fr-FR')+' FCFA</td><td>'+(['pending','waitlist'].includes(r.status)?'<button class="btn-act btn-green" onclick="confirmGroup(&quot;'+r.id+'&quot;)">✅ Confirmer</button> <button class="btn-act btn-red" onclick="rejectGroup(&quot;'+r.id+'&quot;)">Refuser</button>':'—')+'</td></tr>').join('')}
    async function copyCampaignLink(id,profile){const u=location.origin+'/?campagne='+encodeURIComponent(id)+'&profil='+profile;try{await navigator.clipboard.writeText(u);groupMsg('gcMsg','✅ Lien copié : '+u,true)}catch(e){prompt('Lien public :',u)}}

    // ── Ambassadeurs ─────────────────────────────────────────────────
    let _ambRecruitOpen = true;
    async function loadAmbRecruitmentStatus(){
      try{
        const resp = await fetch('/.netlify/functions/ambassador',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'recruitmentStatus'})});
        const d = await resp.json();
        _ambRecruitOpen = d.ok ? (d.open !== false) : true;
        const desc = document.getElementById('amb-recruit-desc');
        const btn = document.getElementById('amb-recruit-toggle');
        const nextWaveInput = document.getElementById('amb-recruit-nextwave');
        if(_ambRecruitOpen){
          desc.textContent = 'Candidatures actuellement ouvertes.';
          btn.textContent = '🔒 Fermer le recrutement';
          btn.className = 'btn-act btn-red';
        }else{
          desc.textContent = 'Candidatures actuellement fermées.' + (d.nextWave ? (' Prochaine vague : ' + d.nextWave) : '');
          btn.textContent = '🔓 Ouvrir le recrutement';
          btn.className = 'btn-act btn-green';
          if(d.nextWave) nextWaveInput.value = d.nextWave;
        }
      }catch(e){}
    }
    async function toggleAmbRecruitment(){
      const nextWave = document.getElementById('amb-recruit-nextwave').value.trim();
      const r = await apiCall('ambassadorSetRecruitment', null, { open: !_ambRecruitOpen, nextWave: nextWave || null });
      if(r.ok) loadAmbRecruitmentStatus();
    }
    function exportAmbCommissionsCSV(){
      const rows = [['Date','Ambassadeur','Plan','Montant net','Commission','Statut','Action']];
      document.querySelectorAll('#amb-comm-tbody tr').forEach(function(tr){
        const cells = Array.prototype.slice.call(tr.querySelectorAll('td')).map(function(td){return td.textContent.trim()});
        if(cells.length >= 6) rows.push(cells.slice(0,7).map(function(c){return c.replace(/"/g,'""')}));
      });
      if(rows.length <= 1){ambMsg('amb-comm-msg','Aucune donnée à exporter.',false);return}
      const csv = rows.map(function(r){return r.map(function(c){return '"'+c+'"'}).join(';')}).join('\\n');
      const blob = new Blob(['\uFEFF'+csv], {type:'text/csv;charset=utf-8;'});
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'commissions_ambassadeurs_'+new Date().toISOString().slice(0,10)+'.csv';
      document.body.appendChild(a); a.click(); document.body.removeChild(a); URL.revokeObjectURL(url);
    }
    function ambMsg(id,msg,ok){const e=document.getElementById(id);if(!e)return;e.textContent=msg;e.className='msg '+(ok?'ok':'err');e.style.display='block';setTimeout(()=>e.style.display='none',3000)}
    async function loadAmbassadors(){
      const tbody=document.getElementById('amb-tbody');
      const r=await apiCall('ambassadorList',null,{});
      if(!r.ok){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:#f87171;padding:20px;">Erreur : '+(r.error||'')+'</td></tr>';return}
      if(!r.ambassadors||!r.ambassadors.length){tbody.innerHTML='<tr><td colspan="6" style="text-align:center;color:#64748b;padding:20px;">Aucun ambassadeur.</td></tr>';return}
      const statusBadge={pending:'<span class="badge-red" style="background:rgba(245,158,11,.15);color:#f59e0b">En attente</span>',active:'<span class="badge-green">Actif</span>',suspended:'<span class="badge-red">Suspendu</span>'};
      tbody.innerHTML=r.ambassadors.map(a=>{
        const actions=[];
        if(a.status==='pending')actions.push('<button class="btn-act btn-green" onclick="approveAmbassador(&quot;'+a.id+'&quot;)">✅ Approuver</button>');
        if(a.status==='active')actions.push('<button class="btn-act btn-red" onclick="suspendAmbassador(&quot;'+a.id+'&quot;)">🚫 Suspendre</button>');
        if(a.status==='suspended')actions.push('<button class="btn-act btn-green" onclick="reactivateAmbassador(&quot;'+a.id+'&quot;)">✅ Réactiver</button>');
        return '<tr><td>'+(a.email||'—')+'</td><td>'+(a.code||'—')+'</td><td>'+(statusBadge[a.status]||a.status)+'</td><td>'+(a.level||'—')+'</td><td>'+(a.clawback_balance?('<span style="color:#f87171">'+Number(a.clawback_balance).toLocaleString('fr-FR')+' FCFA</span>'):'—')+'</td><td><div style="display:flex;gap:4px;flex-wrap:wrap;">'+actions.join('')+'</div></td></tr>';
      }).join('');
    }
    async function approveAmbassador(uid){
      const r=await apiCall('ambassadorApprove',uid,{});
      ambMsg('amb-msg',r.ok?'✅ Code généré : '+r.code:'❌ '+r.error,r.ok);
      if(r.ok)loadAmbassadors();
    }
    async function suspendAmbassador(uid){
      const reason=prompt('Motif de suspension (obligatoire) :');
      if(!reason||!reason.trim()){ambMsg('amb-msg','❌ Motif requis — suspension annulée.',false);return}
      const r=await apiCall('ambassadorSuspend',uid,{status:'suspended',reason:reason.trim()});
      ambMsg('amb-msg',r.ok?'✅ Ambassadeur suspendu':'❌ '+r.error,r.ok);
      if(r.ok)loadAmbassadors();
    }
    async function reactivateAmbassador(uid){
      if(!confirm('Réactiver cet ambassadeur ?'))return;
      const r=await apiCall('ambassadorSuspend',uid,{status:'active'});
      ambMsg('amb-msg',r.ok?'✅ Ambassadeur réactivé':'❌ '+r.error,r.ok);
      if(r.ok)loadAmbassadors();
    }
    async function loadAmbCommissions(){
      const tbody=document.getElementById('amb-comm-tbody');
      const status=document.getElementById('amb-comm-filter')?.value||'';
      const r=await apiCall('ambassadorListCommissions',null,{status});
      if(!r.ok){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;color:#f87171;padding:20px;">Erreur : '+(r.error||'')+'</td></tr>';return}
      if(!r.commissions||!r.commissions.length){tbody.innerHTML='<tr><td colspan="7" style="text-align:center;color:#64748b;padding:20px;">Aucune commission.</td></tr>';return}
      const statusBadge={due:'<span class="badge-red" style="background:rgba(96,165,250,.15);color:#60a5fa">Dû</span>',paid:'<span class="badge-green">Versé</span>',clawback:'<span class="badge-red">Clawback</span>'};
      tbody.innerHTML=r.commissions.map(c=>{
        const d=c.created_at?new Date(c.created_at).toLocaleDateString('fr-FR'):'—';
        const amb=c.ambassador?(c.ambassador.email||c.ambassador.code||c.ambassador_id):c.ambassador_id;
        let action='—';
        if(c.status==='due')action='<button class="btn-act btn-green" onclick="markCommissionPaid(&quot;'+c.id+'&quot;)">✅ Marquer payé</button>';
        else if(c.status==='paid')action='<button class="btn-act btn-red" onclick="clawbackCommission(&quot;'+c.id+'&quot;)">↩️ Clawback</button>';
        return '<tr><td>'+d+'</td><td>'+amb+'</td><td>'+(c.plan||'—')+'</td><td style="text-align:right">'+Number(c.gross_amount||0).toLocaleString('fr-FR')+' FCFA</td><td style="text-align:right">'+Number(c.commission_amount||0).toLocaleString('fr-FR')+' FCFA'+(c.clawback_offset?(' <small style="color:#f87171">(dont '+Number(c.clawback_offset).toLocaleString('fr-FR')+' déduit)</small>'):'')+'</td><td>'+(statusBadge[c.status]||c.status)+'</td><td>'+action+'</td></tr>';
      }).join('');
    }
    async function markCommissionPaid(id){
      if(!confirm('Confirmer le versement Mobile Money de cette commission ?'))return;
      const r=await apiCall('ambassadorMarkCommissionPaid',null,{commissionId:id});
      ambMsg('amb-comm-msg',r.ok?('✅ Versé — net : '+Number(r.netPaid).toLocaleString('fr-FR')+' FCFA'+(r.offset?(' (dont '+Number(r.offset).toLocaleString('fr-FR')+' déduit pour clawback)'):'')):'❌ '+r.error,r.ok);
      if(r.ok){loadAmbCommissions();loadAmbassadors()}
    }
    async function clawbackCommission(id){
      const reason=prompt('Motif du clawback (ex : remboursement étudiant) :');
      if(reason===null)return;
      const r=await apiCall('ambassadorClawback',null,{commissionId:id,reason:(reason||'').trim()});
      ambMsg('amb-comm-msg',r.ok?'✅ Clawback enregistré — '+Number(r.clawbackAmount).toLocaleString('fr-FR')+' FCFA à déduire du prochain versement':'❌ '+r.error,r.ok);
      if(r.ok){loadAmbCommissions();loadAmbassadors()}
    }
    async function loadQuarterRanking(){const el=document.getElementById('ranking-list');if(!el)return;el.textContent='Chargement…';try{const token=await getFreshAdminToken(); const r=await fetch('/.netlify/functions/quarterLeaderboard',{headers:{'Authorization':'Bearer '+token}});const d=await r.json();if(!r.ok)throw new Error(d.error||'Erreur');el.innerHTML='<div style="margin-bottom:8px;color:#64748b">Période '+d.period+' · minimum '+d.minimumAttempts+' tentatives · '+d.excludedCount+' compte(s) exclu(s)</div>'+(d.gobeletWinner?'<div style="padding:10px;margin-bottom:10px;border:1px solid rgba(245,158,11,.35);border-radius:8px;color:#fbbf24">🏆 Candidat gobelet : '+String(d.gobeletWinner.email||d.gobeletWinner.uid).replace(/[<>]/g,'')+' — '+d.gobeletWinner.average+'% — '+d.gobeletWinner.attempts+' examens '+(d.alreadyAwarded?'· déjà attribué':'<button class="btn-act" onclick="awardGobelet(&quot;'+d.gobeletWinner.uid+'&quot;,&quot;'+d.period+'&quot;)">Attribuer le gobelet</button>')+'</div>':'')+(d.items.length?'<table><thead><tr><th>Rang</th><th>Email</th><th>Moyenne</th><th>Meilleur</th><th>Tentatives</th></tr></thead><tbody>'+d.items.map(x=>'<tr><td>'+x.rank+'</td><td>'+String(x.email||x.uid).replace(/[<>]/g,'')+'</td><td>'+x.average+'%</td><td>'+x.best+'%</td><td>'+x.attempts+'</td></tr>').join('')+'</tbody></table>':'Aucun compte éligible.');}catch(e){el.textContent='❌ '+e.message}}
    async function awardGobelet(uid,period){if(!confirm('Confirmer l’attribution du gobelet pour '+period+' ?'))return;const token=await getFreshAdminToken(); const r=await fetch('/.netlify/functions/quarterLeaderboard',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({action:'award',uid,period})});const d=await r.json();document.getElementById('help-admin-msg').textContent=r.ok?'✅ Gobelet attribué':'❌ '+(d.error||'Erreur');if(r.ok)loadQuarterRanking()}
    async function helpApi(action,payload){const token=await getFreshAdminToken(); const r=await fetch('/.netlify/functions/studentHelp',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({action,...payload})});return r.json()}
    async function loadPromoConfig(){
      const msg=document.getElementById('promo-config-msg');
      if(msg)msg.textContent='';
      try{
        const r=await fetch('/.netlify/functions/promotions');
        const d=await r.json();
        if(!r.ok||!d.ok)throw new Error(d.error||'Erreur de chargement');
        document.getElementById('promo-master').checked=!!d.active;
        const NORMAL_PRICES={standard:10000,avance:18000,professionnel:25000,premium:50000};
        ['standard','avance','professionnel','premium','institution'].forEach(function(p){
          const el=document.getElementById('promo-plan-'+p);
          if(el)el.checked=!!(d.plans&&d.plans[p]);
          const priceEl=document.getElementById('promo-price-'+p);
          if(priceEl)priceEl.value=(d.promoPrices&&d.promoPrices[p]!=null)?d.promoPrices[p]:'';
          const bonusEl=document.getElementById('promo-bonus-'+p);
          if(bonusEl)bonusEl.value=(d.promoBonuses&&d.promoBonuses[p])?d.promoBonuses[p]:'';
          if(NORMAL_PRICES[p])updatePromoPreview(p);
        });
      }catch(e){
        if(msg)msg.textContent='❌ '+e.message;
      }
    }
    const PROMO_NORMAL_PRICES={standard:'10 000 FCFA',avance:'18 000 FCFA',professionnel:'25 000 FCFA',premium:'50 000 FCFA'};
    function updatePromoPreview(plan){
      const preview=document.getElementById('promo-preview-'+plan);
      if(!preview)return;
      const price=(document.getElementById('promo-price-'+plan)||{}).value;
      const bonus=(document.getElementById('promo-bonus-'+plan)||{}).value;
      const checked=(document.getElementById('promo-plan-'+plan)||{}).checked;
      if(!checked){preview.textContent='';return}
      if(!price&&!bonus){preview.textContent='⚠️ Vide — renseigne un prix promo et/ou un cadeau avant activation.';return}
      let txt='👁️ Aperçu visiteur : ';
      txt+=price?('prix affiché → '+Number(price).toLocaleString('fr-FR')+' FCFA/an (au lieu de '+(PROMO_NORMAL_PRICES[plan]||'')+'/an)'):('prix inchangé ('+(PROMO_NORMAL_PRICES[plan]||'')+'/an)');
      if(bonus)txt+=' · 🎁 '+bonus;
      preview.textContent=txt;
    }
    async function savePromoConfig(){
      const msg=document.getElementById('promo-config-msg');
      const plansToCheck=['standard','avance','professionnel','premium'];
      for(const p of plansToCheck){
        const checked=document.getElementById('promo-plan-'+p).checked;
        const price=document.getElementById('promo-price-'+p).value;
        const bonus=document.getElementById('promo-bonus-'+p).value;
        if(checked&&!price&&!bonus){
          msg.textContent='❌ '+p+' : coché mais sans prix promo ni cadeau — renseigne au moins un des deux.';
          return;
        }
      }
      msg.textContent='⏳ Enregistrement…';
      try{
        const token=await getFreshAdminToken();
        const active=document.getElementById('promo-master').checked;
        const plans={};
        const promoPrices={};
        const promoBonuses={};
        ['standard','avance','professionnel','premium','institution'].forEach(function(p){
          plans[p]=!!document.getElementById('promo-plan-'+p).checked;
          const priceEl=document.getElementById('promo-price-'+p);
          promoPrices[p]=priceEl&&priceEl.value!==''?priceEl.value:null;
          const bonusEl=document.getElementById('promo-bonus-'+p);
          promoBonuses[p]=bonusEl&&bonusEl.value!==''?bonusEl.value:null;
        });
        const r=await fetch('/.netlify/functions/promotions',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+token},body:JSON.stringify({active,plans,promoPrices,promoBonuses})});
        const d=await r.json();
        if(!r.ok||!d.ok)throw new Error(d.error||'Erreur');
        msg.textContent='✅ Promotions mises à jour.';
      }catch(e){
        msg.textContent='❌ '+e.message;
      }
    }
    async function loadHelpConfig(){const r=await helpApi('config',{});if(!r.ok)return;const c=r.config||{};['standard','professionnel','premium'].forEach(p=>{const a=document.getElementById('help-plan-'+p),l=document.getElementById('help-limit-'+p);if(a)a.checked=c.allowedPlans?.[p]===true;if(l)l.value=Number(c.limits?.[p]??0)});const b=document.getElementById('help-toggle');if(b){b.dataset.enabled=String(c.enabled!==false);b.textContent=c.enabled!==false?'Fermer temporairement':'Ouvrir l’espace'}}
    async function saveHelpConfig(){const payload={enabled:document.getElementById('help-toggle')?.dataset.enabled!=='false',allowedPlans:{standard:document.getElementById('help-plan-standard')?.checked===true,professionnel:document.getElementById('help-plan-professionnel')?.checked===true,premium:document.getElementById('help-plan-premium')?.checked===true},limits:{standard:parseInt(document.getElementById('help-limit-standard')?.value||'0',10),professionnel:parseInt(document.getElementById('help-limit-professionnel')?.value||'0',10),premium:parseInt(document.getElementById('help-limit-premium')?.value||'0',10)}};const r=await helpApi('setConfig',payload);const m=document.getElementById('help-config-msg');if(m){m.style.display='block';m.textContent=r.ok?'✅ Configuration enregistrée':'❌ '+(r.error||'Erreur')}if(r.ok)loadHelpConfig()}
    async function loadRewardRequests(){const list=document.getElementById('reward-admin-list');if(!list)return;list.textContent='Chargement…';const r=await helpApi('listRewards',{});if(!r.ok){list.textContent='❌ '+(r.error||'Erreur');return}list.innerHTML=r.items.length?r.items.map(x=>'<div style="border-bottom:1px solid #334155;padding:10px 0"><b>'+String(x.matricule||x.email||x.uid).replace(/[<>]/g,'')+'</b> — '+x.plan+' — '+x.period+' — choix : <strong>'+(x.choice==='go'?'Bonus Go':'LumiStreaming')+'</strong> — <span>'+x.status+'</span><br><small>Activités : '+x.activity+'</small> <button class="btn-act" onclick="updateRewardRequest(&quot;'+x.id+'&quot;,&quot;approved&quot;)">Valider</button> <button class="btn-act" onclick="updateRewardRequest(&quot;'+x.id+'&quot;,&quot;granted&quot;)">Attribuée</button> <button class="btn-act" onclick="updateRewardRequest(&quot;'+x.id+'&quot;,&quot;rejected&quot;)">Refuser</button></div>').join(''):'Aucune demande.'}
    async function updateRewardRequest(id,status){const r=await helpApi('updateReward',{id,status});if(r.ok)loadRewardRequests();else document.getElementById('help-admin-msg').textContent='❌ '+r.error}
    async function loadHelpRequests(){const list=document.getElementById('help-admin-list');if(!list)return;list.textContent='Chargement…';const r=await helpApi('list',{});if(!r.ok){list.textContent='❌ '+(r.error||'Erreur');return}const wanted=document.getElementById('help-filter-plan')?.value||'';const items=wanted?r.items.filter(x=>x.plan===wanted):r.items;list.innerHTML=items.length?items.map(x=>'<div style="border-bottom:1px solid #334155;padding:10px 0"><b>'+String(x.title||'Demande').replace(/[<>]/g,'')+'</b> — '+String(x.email||'').replace(/[<>]/g,'')+' — '+(x.planLabel||({standard:'10k',professionnel:'25k',premium:'35k Premium'}[x.plan]||x.plan))+' — <span>'+x.status+'</span><br><small>'+String(x.prompt||'').replace(/[<>]/g,'').slice(0,240)+'</small> <button class="btn-act" onclick="updateHelpRequest(&quot;'+x.id+'&quot;,&quot;done&quot;)">Traiter</button> <button class="btn-act" onclick="updateHelpRequest(&quot;'+x.id+'&quot;,&quot;rejected&quot;)">Refuser</button></div>').join(''):'Aucune demande.';}
    async function toggleHelpSpace(){const btn=document.getElementById('help-toggle');const current=btn.dataset.enabled==='true';const r=await helpApi('setSpace',{enabled:!current});if(r.ok){btn.dataset.enabled=String(r.enabled);btn.textContent=r.enabled?'Fermer temporairement':'Ouvrir l’espace';document.getElementById('help-admin-msg').textContent=r.enabled?'✅ Espace ouvert':'✅ Espace fermé'}else document.getElementById('help-admin-msg').textContent='❌ '+r.error}
    async function updateHelpRequest(id,status){const r=await helpApi('update',{id,status});if(r.ok)loadHelpRequests();else document.getElementById('help-admin-msg').textContent='❌ '+r.error}
    async function changeQuota(id,current){const n=parseInt(prompt('Nouveau quota (actuellement '+current+') :')||'',10);if(!n)return;const r=await groupApi('setQuota',{campaignId:id,payload:{maxPlaces:n}});groupMsg('gcMsg',r.ok?'✅ '+r.msg:'❌ '+r.error,!!r.ok);if(r.ok)loadGroups()}
    async function confirmGroup(id){if(!confirm('Confirmer le paiement et appliquer l’upgrade ?'))return;const r=await groupApi('confirm',{requestId:id});groupMsg('gcReqMsg',r.ok?'✅ '+r.msg:'❌ '+r.error,!!r.ok);if(r.ok)loadGroups()}
    async function rejectGroup(id){if(!confirm('Refuser cette demande ?'))return;const r=await groupApi('reject',{requestId:id});groupMsg('gcReqMsg',r.ok?'✅ '+r.msg:'❌ '+r.error,!!r.ok);if(r.ok)loadGroups()}

    // ── Institution ──────────────────────────────────────────────────
    const INST_TIERS_ADMIN = [
      { minComptes: 50, prixParCompte: 10000 },
      { minComptes: 20, prixParCompte: 14000 },
      { minComptes: 5,  prixParCompte: 18000 },
    ];
    function getInstTierAdmin(nb) {
      return INST_TIERS_ADMIN.find(t => nb >= t.minComptes) || null;
    }
    function calcInstAdmin() {
      const nb = parseInt(document.getElementById('instNbAdmin')?.value, 10);
      const el = document.getElementById('instAdminEstimate');
      if (!el) return;
      if (!nb || nb < 5) { el.textContent = ''; return; }
      const tier = getInstTierAdmin(nb);
      if (!tier) { el.textContent = 'Palier introuvable'; return; }
      el.textContent = '-> ' + nb + ' x ' + tier.prixParCompte.toLocaleString('fr-FR') + ' FCFA = ' + (tier.prixParCompte*nb).toLocaleString('fr-FR') + ' FCFA/an - ' + (nb*2000).toLocaleString('fr-FR') + ' credits';
    }
    async function activateInstitution() {
      const uid  = document.getElementById('instUid')?.value?.trim();
      const nom  = document.getElementById('instNomAdmin')?.value?.trim();
      const nb   = parseInt(document.getElementById('instNbAdmin')?.value, 10);
      const msgEl = document.getElementById('instAdminMsg');
      if (!uid || !nom || !nb || nb < 5) {
        msgEl.innerHTML = '<span style="color:#ef4444;">⚠️ UID, nom et nombre individus (≥5) requis.</span>';
        return;
      }
      msgEl.innerHTML = '<span style="color:#94a3b8;">Activation en cours…</span>';
      const r = await apiCall('createInstitutionMember', uid, { nbIndividus: nb, institutionName: nom });
      msgEl.innerHTML = r.ok
      msgEl.innerHTML = r.ok ? '<span style="color:#10b981;">OK : ' + r.msg + '</span>' : '<span style="color:#ef4444;">Erreur : ' + r.error + '</span>';
      if (r.ok) loadInstitutions();
    }
    async function loadInstitutions() {
      // Charger institutions actives
      const r = await apiCall('listInstitutions', null, {});
      const tbody = document.getElementById('inst-tbody');
      if (!r.ok || !r.institutions?.length) {
        if (tbody) tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#64748b;padding:20px;">Aucune institution active</td></tr>';
      } else {
        tbody.innerHTML = r.institutions.map(function(i) {
          return '<tr><td>' + (i.email||'-') + '</td><td>' + (i.nom||'-') + '</td><td>' + (i.nbComptes||'-') + '</td><td>' + (i.creditsAlloues||'-') + '</td><td>' + (i.prixTotal ? i.prixTotal + ' FCFA' : '-') + '</td><td>' + (i.planExpiry ? new Date(i.planExpiry).toLocaleDateString('fr-FR') : '-') + '</td></tr>';
        }).join('');
      }
      // Charger demandes en attente (depuis institution_requests)
      const reqEl = document.getElementById('inst-requests-list');
      if (reqEl) {
        // On réutilise listUsers filtré sur status pending — pas d'action dédiée
        // on affiche juste un message de fallback pour l'instant
        reqEl.innerHTML = '<span style="color:#64748b;">Consultez Firestore → collection <code>institution_requests</code> pour les demandes en attente.</span>';
      }
    }

    async function loadAlerts() {
      const tbody = document.getElementById('alerts-tbody');
      const r = await apiCall('listAlerts', null, {});
      if (!r.ok) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#f87171;padding:20px;">Erreur : ' + (r.error||'') + '</td></tr>'; return; }
      if (!r.alerts || !r.alerts.length) { tbody.innerHTML = '<tr><td colspan="5" style="text-align:center;color:#64748b;padding:20px;">Aucune alerte 🎉</td></tr>'; return; }
      const typeLabel = { usage_burst: '<span style="color:#f87171;font-weight:600;">⚡ usage_burst</span>', device_multi: '<span style="color:#f59e0b;font-weight:600;">📱 device_multi</span>' };
      tbody.innerHTML = r.alerts.map(function(a) {
        const d = a.createdAt ? new Date(a.createdAt).toLocaleString('fr-FR') : '—';
        return '<tr><td>' + d + '</td><td>' + (a.email||a.uid||'—') + '</td><td>' + (typeLabel[a.type]||a.type) + '</td><td>' + (a.detail||'') + '</td>' +
          '<td><button class="btn-act" onclick="resolveAlert(&quot;' + a.id + '&quot;)">✅ Traité</button></td></tr>';
      }).join('');
    }

    async function resolveAlert(alertId) {
      const r = await apiCall('resolveAlert', null, { alertId });
      const el = document.getElementById('alerts-msg');
      el.textContent = r.ok ? '✅ Alerte traitée' : '❌ ' + r.error;
      el.className = 'msg ' + (r.ok ? 'ok' : 'err');
      el.style.display = 'block';
      setTimeout(function(){ el.style.display = 'none'; }, 1500);
      if (r.ok) loadAlerts();
    }

    async function addCredits(uid) {
      const raw = await askInline('Nombre de chimi à ajouter :', '');
      if (raw === null) return;
      const n = parseInt(raw || '0', 10);
      if (!n || n < 1) { showMsg('❌ Nombre invalide', false); return; }
      try {
        const r = await apiCall('addCredits', uid, { amount: n });
        showMsg(r.ok ? '✅ ' + r.msg : '❌ ' + (r.error || 'Erreur'), r.ok);
      } catch (e) { showMsg('❌ ' + (e.message || 'Ajout impossible'), false); }
    }

    async function modifierInfosUtilisateur(uid) {
      const user = (window.__adminUsers || []).find(function(x) { return x.uid === uid; }) || { uid };
      try {
        const displayName = await askInline('Nom affiché :', user.displayName || user.name || '');
        if (displayName === null) return;
        const phone = await askInline('Téléphone :', user.phone || user.telephone || '');
        if (phone === null) return;
        const matricule = await askInline('Matricule :', user.matricule || '');
        if (matricule === null) return;
        const accessProfile = await askInline('Profil établissement (laisser vide si aucun) :', user.accessProfile || '');
        if (accessProfile === null) return;
        const planExpiry = await askInline('Expiration ISO ou vide :', user.planExpiry || '');
        if (planExpiry === null) return;
        const r = await apiCall('updateUserInfo', uid, { displayName, phone, matricule, accessProfile, planExpiry });
        showMsg(r.ok ? '✅ ' + r.msg : '❌ ' + (r.error || 'Erreur'), r.ok);
        if (r.ok) setTimeout(loadUsersCurrent, 700);
      } catch (e) { showMsg('❌ ' + (e.message || 'Modification impossible'), false); }
    }
    async function setSuspend(uid, suspended) {
      try {
        const r = await apiCall('setSuspend', uid, { suspended });
        showMsg(r.ok ? '✅ ' + r.msg : '❌ ' + (r.error || 'Erreur'), r.ok);
      } catch (e) { showMsg('❌ ' + (e.message || 'Action impossible'), false); }
    }

    // Exposition explicite des handlers : les boutons sont injectés par innerHTML
    // et doivent rester appelables comme fonctions globales, notamment dans les
    // navigateurs mobiles et les contextes d’onglet isolé.
    Object.assign(window, {
      switchTab, filterTable, loadUsersCurrent, setPlan, addCredits, setSuspend,
      genererLienUpgrade, genererLienChimi, appliquerUpgrade, modifierInfosUtilisateur,
      _inlineModalResolve
    });
  </script>
</body>
</html>`;
}

// ── Handler principal ────────────────────────────────────────────────────────
exports.handler = async (event) => {
  const headers = { 'Content-Type': 'text/html; charset=utf-8',
    'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store' };

  // Token depuis query param ou header Authorization
  const token = event.queryStringParameters?.t
    || (event.headers.authorization || '').replace('Bearer ', '');

  if (!token) {
    return { statusCode: 401, headers, body: `<!DOCTYPE html><html><body style="background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center;flex-direction:column;gap:12px">
      <div style="font-size:2.5rem">🔐</div>
      <h2 style="color:#f43f5e">Accès non autorisé</h2>
      <p style="color:#64748b">Connectez-vous via l'application Noria Education.</p>
      <a href="/" style="color:#10b981;font-size:0.85rem">← Retour à l'app</a>
    </body></html>` };
  }

  try {
    const uid = await verifyAdmin(token);
    const [stats, users, alerts] = await Promise.all([loadStats(), loadUsers(), loadAlerts()]);
    const html = buildDashboard(stats, users, uid, alerts);
    return { statusCode: 200, headers, body: html };
  } catch (e) {
    return { statusCode: 403, headers, body: `<!DOCTYPE html><html><body style="background:#0f172a;color:#f1f5f9;display:flex;align-items:center;justify-content:center;height:100vh;font-family:sans-serif;text-align:center;flex-direction:column;gap:12px">
      <div style="font-size:2.5rem">⛔</div>
      <h2 style="color:#f43f5e">Accès refusé</h2>
      <p style="color:#64748b">${e.message}</p>
      <a href="/" style="color:#10b981;font-size:0.85rem">← Retour à l'app</a>
    </body></html>` };
  }
};
