// superadmin.js - Portail super-admin my batch (version complete)

const SUPER_ADMIN_EMAIL = 'structify.crm@gmail.com';

// State
let CURRENT_USER = null;
let DATA_ENT = [];
let FULL_DATA = null;
let FILTER_PLAN = 'all';
let SEARCH_Q = '';
let CURRENT_DETAIL_ID = null;

// Helpers
const $ = id => document.getElementById(id);
const fmt = n => new Intl.NumberFormat('fr-FR').format(n);
const fmtMoney = n => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n || 0);
const fmtMoneyDec = n => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR' }).format(n || 0);
const fmtDate = d => d ? new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' }) : '—';
const fmtDateTime = d => d ? new Date(d).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
const escapeHtml = s => String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast on ' + type;
  setTimeout(() => el.classList.remove('on'), 3000);
}

const getToken = () => {
  try { return JSON.parse(localStorage.getItem('mb_session') || '{}').access_token || null; }
  catch { return null; }
};

// ============= AUTH =============

function showApp() { $('pAuth').style.display = 'none'; $('pApp').style.display = 'block'; }
function showAuth() { $('pAuth').style.display = 'flex'; $('pApp').style.display = 'none'; }

async function bootstrapAuth() {
  // Pas de login propre : si pas de session valide, on renvoie vers la page d'accueil
  // qui gere le login unifie (batchcookeuses, clientes, super-admin)
  const redirectToHome = () => {
    localStorage.removeItem('mb_session');
    window.location.href = '/';
  };

  const sess = localStorage.getItem('mb_session');
  if (!sess) { redirectToHome(); return; }
  let data;
  try { data = JSON.parse(sess); }
  catch { redirectToHome(); return; }
  if (!data.access_token) { redirectToHome(); return; }

  CURRENT_USER = data.user;
  $('hEmail').textContent = data.user?.email || '';
  showApp();
  try {
    await loadAll();
  } catch (e) {
    if (String(e.message).includes('Token') || String(e.message).match(/401/)) {
      const refreshed = await tryRefresh(data.refresh_token);
      if (refreshed) {
        localStorage.setItem('mb_session', JSON.stringify(refreshed));
        CURRENT_USER = refreshed.user;
        try { await loadAll(); return; } catch {}
      }
      redirectToHome();
    }
  }
}

async function tryRefresh(refreshToken) {
  if (!refreshToken) return null;
  try {
    const r = await fetch('/.netlify/functions/superadmin-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken })
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

// Plus de login local : on passe par la home unifiee a /


async function logout() {
  localStorage.removeItem('mb_session');
  CURRENT_USER = null;
  // Aussi signOut cote Supabase pour purger la session unifiee
  try {
    // Cherche les keys Supabase auth (format sb-<ref>-auth-token) et les efface
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('sb-') && k.endsWith('-auth-token')) localStorage.removeItem(k);
    }
  } catch {}
  window.location.href = '/';
}

// ============= DATA =============

async function loadAll() {
  const token = getToken();
  if (!token) { showAuth(); return; }
  try {
    const r = await fetch('/.netlify/functions/superadmin-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` }
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    const data = await r.json();
    FULL_DATA = data;
    DATA_ENT = data.entreprises || [];
    renderKpis(data);
    renderChart(DATA_ENT);
    renderEntreprises();
    renderActivity(data.activity || []);
  } catch (e) {
    toast('Erreur chargement : ' + e.message, 'error');
    $('entGrid').innerHTML = `<div class="empty"><div class="ic">⚠️</div>${escapeHtml(e.message)}</div>`;
    $('activity').innerHTML = '';
  }
}

function renderKpis(d) {
  $('kMrr').innerHTML = fmtMoney(d.mrr || 0) + '<small>/mois</small>';
  $('kActive').textContent = d.active_count || 0;
  $('kTrial').textContent = d.trial_count || 0;
  $('kChurn').textContent = d.churn_count || 0;
}

// ============= CHART 6 MOIS =============

function renderChart(entreprises) {
  const months = [];
  const now = new Date();
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({
      key: d.toISOString().slice(0, 7),
      label: d.toLocaleDateString('fr-FR', { month: 'short' }),
      count: 0
    });
  }
  entreprises.forEach(e => {
    if (!e.created_at) return;
    const key = e.created_at.slice(0, 7);
    const m = months.find(x => x.key === key);
    if (m) m.count++;
  });
  const max = Math.max(1, ...months.map(m => m.count));
  $('chartBars').innerHTML = months.map(m => `
    <div class="chart-bar">
      <div class="bar" style="height:${(m.count / max) * 100}%">${m.count > 0 ? `<span class="v">${m.count}</span>` : ''}</div>
      <div class="l">${m.label}</div>
    </div>
  `).join('');
}

// ============= ENTREPRISES LIST =============

function renderEntreprises() {
  let list = DATA_ENT.filter(e => {
    if (FILTER_PLAN !== 'all') {
      if (FILTER_PLAN === 'active' && e.subscription_status !== 'active') return false;
      if (FILTER_PLAN === 'trial' && e.subscription_status !== 'trialing') return false;
      if (FILTER_PLAN === 'canceled' && !['canceled', 'past_due', 'incomplete'].includes(e.subscription_status)) return false;
    }
    if (SEARCH_Q) {
      const q = SEARCH_Q.toLowerCase();
      if (![e.nom_marque, e.admin_email, e.slug].some(s => (s || '').toLowerCase().includes(q))) return false;
    }
    return true;
  });

  $('entCount').textContent = `(${list.length})`;

  if (list.length === 0) {
    $('entGrid').innerHTML = `<div class="empty"><div class="ic">🔍</div>Aucune entreprise ne correspond aux filtres.</div>`;
    return;
  }

  $('entGrid').innerHTML = list.map(e => {
    const statusBadge = renderStatusBadge(e);
    const planBadge = `<span class="b ${e.plan === 'founder' ? 'orange' : 'gray'} no-dot">${escapeHtml(e.plan || 'standard')}</span>`;
    const since = e.created_at ? new Date(e.created_at).toLocaleDateString('fr-FR') : '—';
    const onb = e.onboarding || { completed_steps: 0, total_steps: 4, score: 0, has_recettes: false, has_clientes: false, has_commandes: false, has_branding: false };
    return `
      <div class="ent-card">
        <div class="ent-info">
          <h3>${escapeHtml(e.nom_marque || '(sans nom)')}</h3>
          <div class="meta">
            <span>✉️ ${escapeHtml(e.admin_email || '—')}</span>
            <span>📅 depuis ${since} (${e.age_days || 0}j)</span>
            <span>👥 ${e.clients_count || 0}</span>
            <span>📋 ${e.recettes_count || 0}</span>
            <span>🍱 ${e.total_commandes_count || 0} commandes</span>
          </div>
          <div class="badges">
            ${statusBadge}
            ${planBadge}
            ${e.cycle ? `<span class="b gray no-dot">${escapeHtml(e.cycle)}</span>` : ''}
          </div>
          <div class="onb" title="Onboarding : ${onb.completed_steps}/${onb.total_steps}">
            <span class="onb-step ${onb.has_recettes ? 'done' : ''}" title="5+ recettes créées">📋</span>
            <span class="onb-step ${onb.has_clientes ? 'done' : ''}" title="Au moins 1 cliente">👥</span>
            <span class="onb-step ${onb.has_commandes ? 'done' : ''}" title="Au moins 1 commande">🍱</span>
            <span class="onb-step ${onb.has_branding ? 'done' : ''}" title="Branding personnalisé">🎨</span>
            <span class="onb-score">${onb.score}%</span>
          </div>
        </div>
        <div class="ent-actions">
          <button class="btn btn-ghost btn-sm" onclick="openDetail('${e.id}')">Détail</button>
          <button class="btn btn-orange btn-sm" onclick="openInvoice('${e.id}')">📄 Facture</button>
          ${e.stripe_customer_id ? `<button class="btn btn-ghost btn-sm" onclick="openStripe('${e.stripe_customer_id}')">Stripe ↗</button>` : ''}
        </div>
      </div>
    `;
  }).join('');
}

function renderStatusBadge(e) {
  const s = e.subscription_status;
  if (s === 'active') return '<span class="b green">Active</span>';
  if (s === 'trialing') return '<span class="b blue">Essai 7j</span>';
  if (s === 'past_due') return '<span class="b orange">Paiement en attente</span>';
  if (s === 'canceled') return '<span class="b red">Annulée</span>';
  if (s === 'incomplete') return '<span class="b red">Incomplète</span>';
  if (e.active === false) return '<span class="b gray">Désactivée</span>';
  if (e.plan === 'founder') return '<span class="b orange">Founder</span>';
  return '<span class="b gray">' + escapeHtml(s || 'pending') + '</span>';
}

// ============= ACTIVITY =============

function renderActivity(items) {
  if (!items || items.length === 0) {
    $('activity').innerHTML = `<div class="empty"><div class="ic">📭</div>Aucun événement d'abonnement récent. Les nouvelles inscriptions, fins d'essai et changements de plan apparaîtront ici.</div>`;
    return;
  }
  $('activity').innerHTML = items.map(a => {
    const when = a.when ? new Date(a.when).toLocaleString('fr-FR', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—';
    return `
      <div class="act-item">
        <span class="when">${when}</span>
        <span class="ic">${a.icon || '•'}</span>
        <span class="txt">${a.html || escapeHtml(a.text || '')}</span>
      </div>
    `;
  }).join('');
}

// ============= DETAIL MODAL =============

function openDetail(id) {
  const e = DATA_ENT.find(x => x.id === id);
  if (!e) return;
  CURRENT_DETAIL_ID = id;
  $('dmTitle').textContent = e.nom_marque || '(sans nom)';
  $('dmSub').textContent = e.admin_email || '';

  const rows = [
    ['ID', e.id, true],
    ['Slug', e.slug, false],
    ['Plan', e.plan, false],
    ['Cycle', e.cycle, false],
    ['Statut sub', e.subscription_status, false],
    ['Actif', e.active ? 'Oui' : 'Non', false],
    ['Stripe customer', e.stripe_customer_id, true],
    ['Stripe sub', e.stripe_subscription_id, true],
    ['Trial fin', e.trial_ends_at ? new Date(e.trial_ends_at).toLocaleDateString('fr-FR') : '—', false],
    ['Période fin', e.current_period_end ? new Date(e.current_period_end).toLocaleDateString('fr-FR') : '—', false],
    ['Créée', e.created_at ? new Date(e.created_at).toLocaleString('fr-FR') : '—', false],
    ['Anciennete', (e.age_days || 0) + ' jours', false],
    ['Clientes', e.clients_count || 0, false],
    ['Recettes', e.recettes_count || 0, false],
    ['Commandes totales', e.total_commandes_count || 0, false],
    ['Commandes 30j', e.recent_commandes_count || 0, false],
    ['Salariées', e.salaries_count || 0, false],
  ];

  const onb = e.onboarding || {};
  const noteKey = `mb_note_${e.id}`;
  const existingNote = localStorage.getItem(noteKey) || '';

  $('dmBody').innerHTML = `
    <div class="detail-grid">
      ${rows.map(([k, v, mono]) => `
        <div class="detail-row">
          <span class="k">${escapeHtml(k)}</span>
          <span class="v ${mono ? 'mono' : ''}">${escapeHtml(v || '—')}</span>
        </div>
      `).join('')}
    </div>

    <div class="modal-section">
      <h3><span class="ic">🎯</span> Onboarding</h3>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:13px;color:var(--tx)">
        <div>${onb.has_recettes ? '✅' : '⬜'} <strong>5+ recettes</strong> (${e.recettes_count || 0})</div>
        <div>${onb.has_clientes ? '✅' : '⬜'} <strong>1+ cliente</strong> (${e.clients_count || 0})</div>
        <div>${onb.has_commandes ? '✅' : '⬜'} <strong>1+ commande</strong> (${e.total_commandes_count || 0})</div>
        <div>${onb.has_branding ? '✅' : '⬜'} <strong>Branding personnalisé</strong></div>
      </div>
      <div style="margin-top:10px;font-size:13px;color:var(--tx-2)">Score : <strong>${onb.score || 0}%</strong></div>
    </div>

    <div class="modal-section">
      <h3><span class="ic">💳</span> Paiements Stripe</h3>
      <div id="stripeSection" class="stripe-list"><div class="loading"><span class="spin"></span>Chargement Stripe…</div></div>
    </div>

    ${e.subscription_status === 'trialing' || e.subscription_status === 'past_due' ? `
      <div class="modal-section">
        <h3><span class="ic">⏰</span> Extension d'essai</h3>
        <div class="trial-extend-bar">
          <select id="trialDays">
            <option value="3">+3 jours</option>
            <option value="7" selected>+7 jours (1 semaine)</option>
            <option value="14">+14 jours (2 semaines)</option>
            <option value="30">+30 jours (1 mois)</option>
          </select>
          <button class="btn btn-orange btn-sm" onclick="actExtendTrial('${e.id}')">Étendre l'essai</button>
        </div>
      </div>
    ` : ''}

    <div class="modal-section">
      <h3><span class="ic">📝</span> Notes internes <span style="font-size:11px;color:var(--muted);font-weight:400;text-transform:none;letter-spacing:0">(privées, stockées localement)</span></h3>
      <textarea id="entNotes" class="notes-area" placeholder="Rappels, contexte support, notes commerciales…">${escapeHtml(existingNote)}</textarea>
      <div class="notes-save"><span id="notesStatus">Auto-save activé</span></div>
    </div>
  `;

  // Show/hide action buttons
  $('dmActSuspend').style.display = e.active === false ? 'none' : 'inline-flex';
  $('dmActReactivate').style.display = e.active === false ? 'inline-flex' : 'none';
  $('dmActSuspend').onclick = () => actSuspend(e.id);
  $('dmActReactivate').onclick = () => actReactivate(e.id);

  // Autosave notes
  const notesEl = $('entNotes');
  if (notesEl) {
    let saveTimer;
    notesEl.addEventListener('input', () => {
      clearTimeout(saveTimer);
      $('notesStatus').textContent = 'Sauvegarde…';
      saveTimer = setTimeout(() => {
        localStorage.setItem(noteKey, notesEl.value);
        $('notesStatus').textContent = 'Sauvegardé à ' + new Date().toLocaleTimeString('fr-FR');
      }, 500);
    });
  }

  $('detailModal').classList.add('on');

  // Load Stripe data async
  loadStripeData(e.id, e.stripe_customer_id);
}

async function loadStripeData(entId, stripeCustomerId) {
  const el = $('stripeSection');
  if (!el) return;
  if (!stripeCustomerId) {
    el.innerHTML = '<div class="empty-mini">Pas de customer Stripe associé.</div>';
    return;
  }
  try {
    const token = getToken();
    const r = await fetch(`/.netlify/functions/superadmin-stripe?entreprise_id=${encodeURIComponent(entId)}`, {
      headers: { 'Authorization': `Bearer ${token}` }
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const data = await r.json();
    if (data.no_stripe) { el.innerHTML = '<div class="empty-mini">Pas de Stripe customer.</div>'; return; }

    const subBox = data.subscription ? `
      <div style="margin-bottom:12px;padding:10px 14px;background:var(--green-pale);border-radius:8px;font-size:12.5px">
        <strong>Sub ${data.subscription.status}</strong>
        ${data.subscription.cancel_at_period_end ? ' (annulation prévue)' : ''}
        <br>Prochaine échéance : ${fmtDate(data.subscription.current_period_end)}
      </div>
    ` : '';

    const invList = (data.invoices || []).slice(0, 5).map(i => {
      const failed = i.status !== 'paid' && i.amount_due > 0;
      return `
        <div class="stripe-item ${failed ? 'failed' : ''}">
          <div class="si-info">
            <div><strong>${escapeHtml(i.number || i.id)}</strong> — ${escapeHtml(i.status)}</div>
            <div class="si-date">${fmtDate(i.created)}${i.paid_at ? ' · payée le ' + fmtDate(i.paid_at) : ''}</div>
          </div>
          <div class="si-amount">${fmtMoneyDec(i.status === 'paid' ? i.amount_paid : i.amount_due)}</div>
        </div>
      `;
    }).join('');

    el.innerHTML = subBox + (invList || '<div class="empty-mini">Aucune facture Stripe.</div>');
  } catch (e) {
    el.innerHTML = `<div class="empty-mini">Stripe : ${escapeHtml(e.message)}</div>`;
  }
}

function closeModal() { $('detailModal').classList.remove('on'); CURRENT_DETAIL_ID = null; }

function openStripe(customerId) {
  window.open(`https://dashboard.stripe.com/customers/${customerId}`, '_blank');
}

function openInvoice(entrepriseId) {
  window.open(`invoice.html?entreprise_id=${encodeURIComponent(entrepriseId)}`, '_blank');
}

// ============= ACTIONS =============

async function actSuspend(id) {
  if (!confirm('Suspendre cette entreprise ? Le compte sera désactivé.')) return;
  await callAction('suspend', { entreprise_id: id });
}

async function actReactivate(id) {
  await callAction('reactivate', { entreprise_id: id });
}

async function actExtendTrial(id) {
  const days = parseInt($('trialDays').value, 10) || 7;
  if (!confirm(`Étendre l'essai de ${days} jours ?`)) return;
  await callAction('trial_extend', { entreprise_id: id, days });
}

async function callAction(action, payload) {
  try {
    const token = getToken();
    const r = await fetch('/.netlify/functions/superadmin-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
      body: JSON.stringify({ action, ...payload })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    toast('Action effectuée', 'success');
    closeModal();
    await loadAll();
  } catch (e) {
    toast('Erreur : ' + e.message, 'error');
  }
}

// ============= EXPORT CSV =============

function exportCsv() {
  if (!DATA_ENT.length) { toast('Pas de données à exporter', 'error'); return; }
  const headers = ['ID','Nom','Slug','Email admin','Plan','Cycle','Statut sub','Active','Trial fin','Période fin','Stripe customer','Créée','Ancienneté (j)','Clientes','Recettes','Commandes totales','Onboarding %'];
  const rows = DATA_ENT.map(e => [
    e.id, e.nom_marque, e.slug, e.admin_email, e.plan, e.cycle, e.subscription_status,
    e.active ? 'oui' : 'non',
    e.trial_ends_at ? new Date(e.trial_ends_at).toLocaleDateString('fr-FR') : '',
    e.current_period_end ? new Date(e.current_period_end).toLocaleDateString('fr-FR') : '',
    e.stripe_customer_id || '',
    e.created_at ? new Date(e.created_at).toLocaleDateString('fr-FR') : '',
    e.age_days || 0,
    e.clients_count || 0, e.recettes_count || 0, e.total_commandes_count || 0,
    (e.onboarding?.score || 0)
  ]);
  const csv = [headers, ...rows].map(row => row.map(cell => {
    const s = String(cell ?? '');
    return /[",;\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(';')).join('\n');
  const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `mybatch-entreprises-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  toast('Export CSV téléchargé', 'success');
}

// ============= EVENTS =============

document.addEventListener('DOMContentLoaded', () => {
  $('btnLogout').addEventListener('click', logout);

  document.querySelectorAll('.filter-chip').forEach(b => {
    b.addEventListener('click', () => {
      document.querySelectorAll('.filter-chip').forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      FILTER_PLAN = b.dataset.fp;
      renderEntreprises();
    });
  });

  $('entSearch').addEventListener('input', e => {
    SEARCH_Q = e.target.value;
    renderEntreprises();
  });

  $('btnExportCsv').addEventListener('click', exportCsv);

  $('detailModal').addEventListener('click', e => {
    if (e.target.id === 'detailModal') closeModal();
  });

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeModal();
  });

  bootstrapAuth();
});

// Expose for inline onclicks
window.openDetail = openDetail;
window.openStripe = openStripe;
window.openInvoice = openInvoice;
window.closeModal = closeModal;
window.actExtendTrial = actExtendTrial;
