// superadmin.js — portail super-admin my batch
// Acces reserve a structify.crm@gmail.com (verifie cote auth et plan founder)

const SUPER_ADMIN_EMAIL = 'structify.crm@gmail.com';

// Cles publiques Supabase (anon) - safe a exposer
// L'auth Supabase + service_role bridge cote function s'occupent du reste
const SB_URL = 'https://loiaubdlhkcnohtbwtxg.supabase.co';
// anon key publique (lecture limitee selon RLS, on utilisera Netlify function pour le reste)
let SB_ANON = null;
let sb = null;

// State
let CURRENT_USER = null;
let CURRENT_PLAN = null;
let DATA_ENT = [];
let FILTER_PLAN = 'all';
let SEARCH_Q = '';

// DOM helpers
const $ = id => document.getElementById(id);
const fmt = n => new Intl.NumberFormat('fr-FR').format(n);
const fmtMoney = n => new Intl.NumberFormat('fr-FR', { style: 'currency', currency: 'EUR', maximumFractionDigits: 0 }).format(n);
const escapeHtml = s => String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));

function toast(msg, type = '') {
  const el = $('toast');
  el.textContent = msg;
  el.className = 'toast on ' + type;
  setTimeout(() => el.classList.remove('on'), 3000);
}

function showApp() {
  $('pAuth').style.display = 'none';
  $('pApp').style.display = 'block';
}
function showAuth() {
  $('pAuth').style.display = 'flex';
  $('pApp').style.display = 'none';
}

// ============= AUTH =============

async function bootstrapAuth() {
  // Cherche la cle anon Supabase via la function publique branding (qui sait y rep)
  // ou plus simple : on demande au login form -> POST /auth/v1/token?grant_type=password directement avec l'apikey publique
  // Pour la rapidite : on stocke la cle anon publiquement dans le HTML/JS
  // (elle est ANON donc safe : Supabase la concoit pour etre exposee cote client)
  // -> on la recup via la function admin-key qui sait la donner si on demande
  // -> ou plus simple: on tente directement auth REST sans charger la lib supabase-js

  // Pour cette version : on utilise la lib supabase-js avec une cle anon hardcodee
  // (a remplacer par la vraie anon key de Supabase)
  // L'anon key est publique et concue pour etre exposee cote client

  // En attendant qu'on hardcode l'anon key, on utilise une approche alternative :
  // Direct REST API call avec le payload de login. Le code se demerde.

  // Vois si une session existe deja dans localStorage
  const sess = localStorage.getItem('mb_session');
  if (sess) {
    try {
      const data = JSON.parse(sess);
      if (data.access_token && data.expires_at > Date.now() / 1000) {
        CURRENT_USER = data.user;
        return await onAuthSuccess(data);
      }
    } catch {}
  }
  showAuth();
}

async function login() {
  const email = $('email').value.trim();
  const password = $('password').value;
  if (!email || !password) {
    showAuthErr('Email et mot de passe requis');
    return;
  }

  $('btnLogin').disabled = true;
  $('btnLogin').textContent = 'Connexion…';
  $('authErr').style.display = 'none';

  try {
    // Login via Supabase REST API
    // On utilise une approche sans cle anon : on hit notre Netlify function admin-key
    // qui validera tout

    const r = await fetch('/.netlify/functions/superadmin-auth', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await r.json();

    if (!r.ok) {
      throw new Error(data.error || 'Identifiants invalides');
    }

    // Sauvegarde la session
    localStorage.setItem('mb_session', JSON.stringify(data));
    CURRENT_USER = data.user;
    await onAuthSuccess(data);
  } catch (e) {
    showAuthErr(e.message);
  } finally {
    $('btnLogin').disabled = false;
    $('btnLogin').textContent = 'Connexion →';
  }
}

function showAuthErr(msg) {
  const el = $('authErr');
  el.textContent = msg;
  el.style.display = 'block';
}

async function onAuthSuccess(authData) {
  if (authData.user?.email !== SUPER_ADMIN_EMAIL) {
    localStorage.removeItem('mb_session');
    showAuthErr('Accès réservé au super-admin.');
    return;
  }
  $('hEmail').textContent = authData.user.email;
  showApp();
  await loadAll(authData.access_token);
}

function logout() {
  localStorage.removeItem('mb_session');
  CURRENT_USER = null;
  showAuth();
}

// ============= DATA =============

async function loadAll(accessToken) {
  try {
    const r = await fetch('/.netlify/functions/superadmin-data', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` }
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    const data = await r.json();
    DATA_ENT = data.entreprises || [];
    renderKpis(data);
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
    const clientsCount = e.clients_count || 0;
    const recettesCount = e.recettes_count || 0;
    return `
      <div class="ent-card">
        <div class="ent-info">
          <h3>${escapeHtml(e.nom_marque || '(sans nom)')}</h3>
          <div class="meta">
            <span>✉️ ${escapeHtml(e.admin_email || '—')}</span>
            <span>📅 depuis ${since}</span>
            <span>👥 ${clientsCount} clientes</span>
            <span>📋 ${recettesCount} recettes</span>
          </div>
          <div class="badges">
            ${statusBadge}
            ${planBadge}
            ${e.cycle ? `<span class="b gray no-dot">${escapeHtml(e.cycle)}</span>` : ''}
          </div>
        </div>
        <div class="ent-actions">
          <button class="btn btn-ghost btn-sm" onclick="openDetail('${e.id}')">Détail</button>
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

function renderActivity(items) {
  if (!items || items.length === 0) {
    $('activity').innerHTML = `<div class="empty"><div class="ic">📭</div>Pas d'activité récente.</div>`;
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
    ['Clientes', e.clients_count || 0, false],
    ['Recettes', e.recettes_count || 0, false],
    ['Commandes 30j', e.recent_commandes_count || 0, false],
  ];
  $('dmBody').innerHTML = `
    <div class="detail-grid">
      ${rows.map(([k, v, mono]) => `
        <div class="detail-row">
          <span class="k">${escapeHtml(k)}</span>
          <span class="v ${mono ? 'mono' : ''}">${escapeHtml(v || '—')}</span>
        </div>
      `).join('')}
    </div>
  `;

  // Show suspend/reactivate button selon etat
  $('dmActSuspend').style.display = e.active === false ? 'none' : 'inline-flex';
  $('dmActReactivate').style.display = e.active === false ? 'inline-flex' : 'none';
  $('dmActSuspend').onclick = () => actSuspend(e.id);
  $('dmActReactivate').onclick = () => actReactivate(e.id);

  $('detailModal').classList.add('on');
}

function closeModal() {
  $('detailModal').classList.remove('on');
}

function openStripe(customerId) {
  window.open(`https://dashboard.stripe.com/customers/${customerId}`, '_blank');
}

async function actSuspend(id) {
  if (!confirm('Suspendre cette entreprise ? Le compte sera désactivé.')) return;
  await callAction('suspend', id);
}

async function actReactivate(id) {
  await callAction('reactivate', id);
}

async function callAction(action, id) {
  try {
    const sess = JSON.parse(localStorage.getItem('mb_session') || '{}');
    const r = await fetch('/.netlify/functions/superadmin-action', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sess.access_token}` },
      body: JSON.stringify({ action, entreprise_id: id })
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${r.status}`);
    }
    toast('Action effectuée', 'success');
    closeModal();
    await loadAll(sess.access_token);
  } catch (e) {
    toast('Erreur : ' + e.message, 'error');
  }
}

// ============= EVENTS =============

document.addEventListener('DOMContentLoaded', () => {
  $('btnLogin').addEventListener('click', login);
  $('btnLogout').addEventListener('click', logout);
  $('email').addEventListener('keydown', e => { if (e.key === 'Enter') $('password').focus(); });
  $('password').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });

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

  $('detailModal').addEventListener('click', e => {
    if (e.target.id === 'detailModal') closeModal();
  });

  bootstrapAuth();
});

// Expose for inline onclicks
window.openDetail = openDetail;
window.openStripe = openStripe;
window.closeModal = closeModal;
