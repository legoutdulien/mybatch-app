// app.js — Portail client Le Gout du Lien
// Backend: Supabase

const SUPABASE_URL = 'https://loiaubdlhkcnohtbwtxg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvaWF1YmRsaGtjbm9odGJ3dHhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMzU1NDAsImV4cCI6MjA5MjcxMTU0MH0.2S2xnnpFT-kcblTzSC_x2ybSUUipUi5jMPe_DbNBUcA';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const JOURS_ORDER = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const JMAP_FULL = { Lundi: 0, Mardi: 1, Mercredi: 2, Jeudi: 3, Vendredi: 4, Samedi: 5, Dimanche: 6 };
let creneauxTemplate = [];
function fmtHeure(t) { if (!t) return ''; const [h, m] = t.split(':'); return `${parseInt(h, 10)}h${m}`; }
function fmtSlotLabel(start, end) { return `${fmtHeure(start)} - ${fmtHeure(end)}`; }
function getSlotsForJour(jour) {
  return creneauxTemplate.filter(t => t.jour === jour).sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
}
const REMOJI = {
  'Fruits & Légumes': '🥦', 'Fruits et légumes': '🥦', 'Fruits & légumes': '🥦',
  'Viandes': '🥩', 'Boucherie': '🥩', 'Charcuterie': '🥓',
  'Poissonnerie': '🐟', 'Crémerie': '🧀', 'Cremerie': '🧀',
  'Épicerie': '🥫', 'Epicerie': '🥫', 'Épices': '🌶️', 'Epices': '🌶️',
  'Surgelés': '❄️', 'Boulangerie': '🥖', 'Produits frais': '🥗'
};

// state
let clientProfile = null;
let recettes = [];
let ingredients = [];
let recettesIngredients = [];
let mesCommandes = [];
let sel = [];
let semSel = null;
let crenSel = null;
let platsDetailCache = [];
let currentCmdId = null;
let currentDetailPortions = 4;
let favoris = new Set();
let forfaits = [];
let forfaitSel = null;

async function loadFavoris() {
  if (!clientProfile) return;
  try {
    const { data } = await sb.from('favoris').select('recette_id').eq('client_id', clientProfile.id);
    favoris = new Set((data || []).map(f => f.recette_id));
  } catch (e) {
    favoris = new Set();
  }
}

async function toggleFavori(recetteId, btn) {
  if (!clientProfile) return;
  if (favoris.has(recetteId)) {
    const { error } = await sb.from('favoris').delete().eq('client_id', clientProfile.id).eq('recette_id', recetteId);
    if (error) { showToast('Erreur: ' + error.message, 'err'); return; }
    favoris.delete(recetteId);
    btn.textContent = '♡';
    btn.classList.remove('on');
  } else {
    const { error } = await sb.from('favoris').insert({ client_id: clientProfile.id, recette_id: recetteId });
    if (error) { showToast('Erreur: ' + error.message, 'err'); return; }
    favoris.add(recetteId);
    btn.textContent = '♥';
    btn.classList.add('on');
  }
  if (platCatFilter === 'favoris') renderPlats();
}

// helpers UI
const $ = (id) => document.getElementById(id);
const showLoad = (t) => { $('lov').style.display = 'flex'; $('ltxt').textContent = t || 'Chargement...'; };
const hideLoad = () => { $('lov').style.display = 'none'; };
const showToast = (m, t) => {
  const el = $('toast'); el.textContent = m; el.className = 'toast show ' + (t || '');
  setTimeout(() => { el.className = 'toast'; }, 3000);
};
const showPage = (p) => {
  ['pLogin', 'pDash', 'pApp', 'pDetail', 'pAVenir'].forEach(x => { const el = $(x); if (el) el.style.display = 'none'; });
  const el = $(p); if (el) el.style.display = p === 'pLogin' ? 'flex' : 'block';
};
const getEtat = (r) => (r && r.etat) ? r.etat : (r && r.active ? 'actif' : 'inactif');

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const escapeAttr = escapeHtml;
function fmtN(n) { return n % 1 === 0 ? n : parseFloat(n.toFixed(2)); }
function fmtDate(iso) {
  if (!iso) return '';
  try {
    const d = new Date(iso + (iso.length === 10 ? 'T00:00:00' : ''));
    return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
  } catch (e) { return iso; }
}
function catCls(c) {
  if (!c) return 'cd';
  const l = c.toLowerCase();
  if (l.includes('vég') || l.includes('vege')) return 'cv';
  if (l.includes('viande')) return 'cm';
  if (l.includes('poisson')) return 'cp';
  if (l.includes('post partum')) return 'cpp';
  return 'cd';
}

// --- AUTH ---
// Detecte le role d'un user authentifie : 'admin' | 'salarie' | 'client' | null
async function detectRole(userId) {
  const [adm, sal, cli] = await Promise.all([
    sb.from('admins_entreprise').select('entreprise_id').eq('user_id', userId).maybeSingle(),
    sb.from('salaries').select('*').eq('id', userId).maybeSingle(),
    sb.from('clients').select('*').eq('id', userId).maybeSingle()
  ]);
  if (adm.data) return { role: 'admin', data: adm.data };
  if (sal.data) return { role: 'salarie', data: sal.data };
  if (cli.data) return { role: 'client', data: cli.data };
  return { role: null };
}

async function login() {
  const email = $('iEmail').value.trim();
  const mdp = $('iMdp').value.trim();
  const err = $('lerr');
  err.style.display = 'none';
  if (!email || !mdp) {
    err.textContent = 'Remplissez tous les champs.'; err.style.display = 'block'; return;
  }
  showLoad('Connexion...');
  try {
    const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email, password: mdp });
    if (authErr) throw new Error('Email ou mot de passe incorrect.');
    const r = await detectRole(auth.user.id);
    if (r.role === 'admin') {
      // Super-admin my batch -> stocke le token au format mb_session pour superadmin.html, puis redirige
      if ((auth.user.email || '').toLowerCase() === 'structify.crm@gmail.com') {
        const { data: { session: sess } } = await sb.auth.getSession();
        if (sess) {
          localStorage.setItem('mb_session', JSON.stringify({
            access_token: sess.access_token,
            refresh_token: sess.refresh_token,
            expires_at: sess.expires_at,
            user: { id: auth.user.id, email: auth.user.email }
          }));
        }
        window.location.href = 'superadmin.html';
        return;
      }
      window.location.href = 'admin.html';
      return;
    }
    if (r.role === 'salarie') {
      window.location.href = 'salarie.html';
      return;
    }
    if (r.role === 'client') {
      clientProfile = r.data;
      // Re-applique le branding selon l'entreprise reelle de la cliente (au cas ou
      // elle a atterri sur un domaine generique)
      if (clientProfile.entreprise_id && CURRENT_BRANDING?.id !== clientProfile.entreprise_id) {
        await loadBranding({ id: clientProfile.entreprise_id });
      }
      await loadDash();
      return;
    }
    await sb.auth.signOut();
    throw new Error("Ce compte n'est rattache a aucune entreprise.");
  } catch (e) {
    err.textContent = e.message || String(e); err.style.display = 'block';
  } finally {
    hideLoad();
  }
}

async function logout() {
  await sb.auth.signOut();
  clientProfile = null; sel = []; semSel = null; crenSel = null;
  sessionStorage.clear();
  showPage('pLogin');
}

// --- DASHBOARD ---
async function loadDash() {
  const prenom = (clientProfile.nom || '').split(' ')[0];
  $('unom').textContent = prenom;
  $('welcomeTxt').textContent = `Bonjour ${prenom}`;
  const today = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  const dateEl = $('welcomeDate');
  if (dateEl) dateEl.textContent = today;
  showPage('pDash');
  await Promise.all([loadFavoris(), loadNotifs(), loadForfaits()]);
  await chargerMesCommandes();
  setupRealtimeNotifs();
}

async function loadForfaits() {
  try {
    const { data } = await sb.from('forfaits').select('*').eq('active', true).order('ordre', { ascending: true });
    forfaits = data || [];
  } catch (e) {
    forfaits = [];
  }
}

let realtimeChannel = null;
let notifsList = [];

async function loadNotifs() {
  if (!clientProfile) return;
  const { data } = await sb.from('notifications')
    .select('*')
    .eq('recipient_id', clientProfile.id)
    .order('created_at', { ascending: false })
    .limit(20);
  notifsList = data || [];
  renderBell();
}

function renderBell() {
  const unread = notifsList.filter(n => !n.lu).length;
  const badge = $('notifBellBadge');
  if (badge) {
    badge.textContent = unread > 9 ? '9+' : String(unread);
    badge.classList.toggle('show', unread > 0);
  }
  const panel = $('notifPanel');
  if (!panel) return;
  if (notifsList.length === 0) {
    panel.innerHTML = `<div class="notif-panel-head">Notifications</div><div class="notif-empty">🔔 Aucune notification pour l'instant</div>`;
    return;
  }
  panel.innerHTML = `
    <div class="notif-panel-head">Notifications ${unread > 0 ? `· ${unread} non lue${unread > 1 ? 's' : ''}` : ''}</div>
    ${notifsList.map(n => `
      <div class="notif-item ${n.lu ? '' : 'unread'}" data-id="${n.id}">
        <div class="notif-title">${escapeHtml(n.title)}</div>
        ${n.body ? `<div class="notif-body">${escapeHtml(n.body)}</div>` : ''}
        <div class="notif-time">${formatNotifTime(n.created_at)}</div>
      </div>
    `).join('')}
  `;
  panel.querySelectorAll('.notif-item').forEach(el => {
    el.addEventListener('click', () => markNotifRead(el.dataset.id));
  });
}

async function markNotifRead(id) {
  const n = notifsList.find(x => x.id === id);
  if (!n || n.lu) return;
  n.lu = true;
  renderBell();
  try { await sb.from('notifications').update({ lu: true }).eq('id', id); } catch (e) {}
}

function formatNotifTime(iso) {
  const d = new Date(iso); const now = new Date();
  const diff = (now - d) / 1000;
  if (diff < 60) return "à l'instant";
  if (diff < 3600) return `il y a ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `il y a ${Math.floor(diff / 3600)} h`;
  return d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
}

function setupRealtimeNotifs() {
  if (realtimeChannel || !clientProfile) return;
  realtimeChannel = sb.channel(`client-${clientProfile.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${clientProfile.id}` }, (payload) => {
      notifsList.unshift(payload.new);
      if (notifsList.length > 20) notifsList.pop();
      renderBell();
      showToast('🔔 ' + payload.new.title, 'ok');
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'commandes', filter: `client_id=eq.${clientProfile.id}` }, (payload) => {
      // refetch en arriere-plan pour mise a jour de l'affichage
      const neu = payload.new || {}, old = payload.old || {};
      if (neu.statut === 'Confirmée' && old.statut !== 'Confirmée') {
        chargerMesCommandes();
      }
    })
    .subscribe();
}

async function chargerMesCommandes() {
  const div = $('dashCommandes');
  div.innerHTML = '<div style="text-align:center;padding:20px"><div class="spin" style="margin:0 auto"></div></div>';
  try {
    if (!recettes.length) await loadRecettesData();
    const { data, error } = await sb.from('commandes')
      .select('*')
      .eq('client_id', clientProfile.id)
      .order('semaine_du', { ascending: false });
    if (error) throw error;
    mesCommandes = data || [];

    if (!mesCommandes.length) {
      div.innerHTML = `<div class="section-titre">Mes commandes</div><div class="empty-state"><div class="eicon">📭</div><p>Vous n'avez pas encore de commande.</p></div>`;
      return;
    }
    div.innerHTML = `<div class="section-titre">Mes commandes (${mesCommandes.length})</div><div class="cmd-liste">${mesCommandes.map((cmd, i) => {
      const platIds = [cmd.plat_1_id, cmd.plat_2_id, cmd.plat_3_id, cmd.plat_4_id, cmd.plat_5_id].filter(Boolean);
      const plats = platIds.map(id => (recettes.find(r => r.id === id) || {}).nom_du_plat).filter(Boolean);
      const ok = cmd.statut === 'Confirmée';
      return `<div class="cmd-item" data-idx="${i}">
        <div class="cmd-info">
          <h4>Semaine du ${escapeHtml(fmtDate(cmd.semaine_du))}</h4>
          <p>${escapeHtml(cmd.creneau || '')}</p>
          <div class="cmd-plats">${plats.slice(0, 3).map(escapeHtml).join(' · ')}${plats.length > 3 ? ' · ...' : ''}</div>
        </div>
        <div class="cmd-status">
          <span class="badge ${ok ? 'ok' : 'wait'}">${ok ? '✓ Confirmee' : '⏳ En attente'}</span>
          <span class="cmd-arrow">›</span>
        </div>
      </div>`;
    }).join('')}</div>`;
    div.querySelectorAll('.cmd-item').forEach(el => {
      el.addEventListener('click', () => ouvrirCommande(parseInt(el.dataset.idx, 10)));
    });
  } catch (e) {
    div.innerHTML = '<p style="color:var(--txl);padding:20px">Erreur chargement: ' + escapeHtml(e.message) + '</p>';
  }
}

function showMesCommandes() {
  const div = $('dashCommandes');
  if (div) div.scrollIntoView({ behavior: 'smooth' });
}

// --- DETAIL COMMANDE ---
async function ouvrirCommande(idx) {
  const cmd = mesCommandes[idx];
  if (!cmd) return;
  currentCmdId = cmd.id;
  currentDetailPortions = cmd.nombre_portions || 4;
  showPage('pDetail');
  showLoad('Chargement...');
  try {
    if (!recettes.length) await loadRecettesData();
    const platIds = [cmd.plat_1_id, cmd.plat_2_id, cmd.plat_3_id, cmd.plat_4_id, cmd.plat_5_id].filter(Boolean);
    platsDetailCache = platIds.map(id => recettes.find(r => r.id === id)).filter(Boolean);
    const semLabel = cmd.semaine_du ? 'Semaine du ' + fmtDate(cmd.semaine_du) : '';
    // Detecte si la cliente a choisi un forfait avec courses incluses
    const f = forfaits.find(x => x.id === cmd.forfait_id);
    const forfaitInclutCourses = !!f?.inclut_courses;
    renderDetail({ nom: clientProfile.nom || '', semLabel, creneau: cmd.creneau || '', id: cmd.id, statut: cmd.statut || 'En attente de paiement', montant: cmd.montant ?? CURRENT_BRANDING?.montant_client_default ?? 60, forfaitInclutCourses });
  } catch (e) {
    showToast('Erreur: ' + e.message, 'err');
  } finally {
    hideLoad();
  }
}

function renderDetail(data) {
  const ok = data.statut === 'Confirmée';
  const titre = ok ? 'Commande confirmee' : 'Commande en attente';
  const icone = ok
    ? '<svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>'
    : '<svg viewBox="0 0 24 24"><path d="M12 2C6.5 2 2 6.5 2 12s4.5 10 10 10 10-4.5 10-10S17.5 2 12 2zm0 18c-4.4 0-8-3.6-8-8s3.6-8 8-8 8 3.6 8 8-3.6 8-8 8zm.5-13H11v6l5.2 3.2.8-1.3-4.5-2.7V7z"/></svg>';
  // Si la cuisiniere fait les courses (soit via le forfait choisi, soit toggle legacy sur la cliente), on cache l'onglet et le contenu Liste de courses
  const showCourses = !data.forfaitInclutCourses && !clientProfile?.courses_par_cuisiniere;
  $('detailMain').innerHTML = `
    <div class="cbanner">
      <div class="cicon">${icone}</div>
      <h1>${titre}</h1>
      <p>${escapeHtml(data.semLabel)} · ${escapeHtml(data.creneau)}</p>
    </div>
    <div class="igrid">
      <div><div class="ilbl">Client</div><div class="ival">${escapeHtml(data.nom)}</div></div>
      <div><div class="ilbl">Semaine</div><div class="ival">${escapeHtml(data.semLabel)}</div></div>
      <div><div class="ilbl">Creneau</div><div class="ival">${escapeHtml(data.creneau)}</div></div>
      <div><div class="ilbl">Montant</div><div class="ival">${data.montant}€</div></div>
    </div>
    <div class="tabs">
      <button class="tab on" data-tab="plats">🍽️ Mes plats</button>
      ${showCourses ? `<button class="tab" data-tab="courses">🛒 Liste de courses</button>` : ''}
      <button class="tab" data-tab="memo">♨️ Rechauffage & conservation</button>
    </div>
    <div id="tc-plats" class="tc on">
      <div class="ecgrid">${platsDetailCache.map(p => `
        <div class="eccard" data-platid="${p.id}">
          ${p.photo_url ? `<img class="ecimg" src="${escapeHtml(p.photo_url)}" alt="${escapeHtml(p.nom_du_plat)}">` : `<div class="ecph">🍽️</div>`}
          <div class="ecinfo">
            <div class="ecnom">${escapeHtml(p.nom_du_plat)}</div>
            <div class="echint">Cliquez pour les ingredients</div>
          </div>
        </div>`).join('')}
      </div>
    </div>
    ${showCourses ? `<div id="tc-courses" class="tc">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;flex-wrap:wrap;gap:10px">
        <div class="cnote" style="margin-bottom:0;flex:1">🛒 Quantites pour <strong>${currentDetailPortions} portions</strong> par plat</div>
        <button id="btnPrint" style="padding:9px 18px;background:var(--vert);color:#fff;border:none;border-radius:10px;font-family:'DM Sans',sans-serif;font-size:13px;cursor:pointer;white-space:nowrap">🖨️ Imprimer</button>
      </div>
      <div id="coursesDiv"></div>
    </div>` : ''}
    <div id="tc-memo" class="tc">
      ${platsDetailCache.map(p => `
        <div class="mcard">
          <div class="mnom">${escapeHtml(p.nom_du_plat)}</div>
          <div class="mgrid">
            <div class="mi miv"><div class="mlbl">♨️ Rechauffage</div><div class="mtxt">${escapeHtml(p.instructions_rechauffage || 'Non renseigne')}</div></div>
            <div class="mi mij"><div class="mlbl">🧊 Conservation</div><div class="mtxt">${p.frigo_en_jours ? p.frigo_en_jours + ' jours au refrigerateur' : 'Non renseigne'}</div></div>
            ${p.congelation ? `<div class="mi" style="background:#e3f2fd;border-left:3px solid #64b5f6"><div class="mlbl">❄️ Congelation</div><div class="mtxt">${escapeHtml(p.congelation)}</div></div>` : ''}
          </div>
        </div>`).join('')}
    </div>`;

  $('detailMain').querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => chgTab(t.dataset.tab, t)));
  $('detailMain').querySelectorAll('.eccard').forEach(c => c.addEventListener('click', () => voirIngDetail(c.dataset.platid)));
  const btnP = $('btnPrint');
  if (btnP) {
    btnP.addEventListener('click', imprimerCourses);
    loadCourses(platsDetailCache.map(p => p.id));
  }
}

function chgTab(t, btn) {
  document.querySelectorAll('.tab').forEach(x => x.classList.remove('on'));
  document.querySelectorAll('.tc').forEach(x => x.classList.remove('on'));
  btn.classList.add('on');
  $('tc-' + t).classList.add('on');
}

// Couleur de bordure gauche par rayon (carte courses)
const RAYON_COLOR = {
  'Fruits & Légumes': '#7cb342', 'Fruits et légumes': '#7cb342', 'Fruits & légumes': '#7cb342',
  'Boucherie': '#c62828', 'Viandes': '#c62828', 'Charcuterie': '#e57373',
  'Poissonnerie': '#1976d2',
  'Crémerie': '#fdd835', 'Cremerie': '#fdd835',
  'Épicerie': '#a1887f', 'Epicerie': '#a1887f',
  'Épices': '#ef6c00', 'Epices': '#ef6c00',
  'Surgelés': '#4dd0e1',
  'Boulangerie': '#bf6019',
  'Produits frais': '#66bb6a'
};

// Calcule les rayons agreges pour les plats donnes : reutilise par loadCourses + imprimerCourses
function buildCoursesData(platIds, portions) {
  const p = portions || currentDetailPortions || 4;
  const rayons = {};
  platIds.forEach(pid => {
    const ris = recettesIngredients.filter(ri => ri.recette_id === pid);
    ris.forEach(ri => {
      const ing = ingredients.find(i => i.id === ri.ingredient_id);
      if (!ing) return;
      const ray = ing.rayon || 'Autres';
      const u = ing.unite_par_defaut && ing.unite_par_defaut !== 'Unité par défaut' ? ing.unite_par_defaut : '';
      const qte = (ri.quantite_par_portion || 0) * p;
      if (!rayons[ray]) rayons[ray] = {};
      if (!rayons[ray][ing.nom]) rayons[ray][ing.nom] = { qte: 0, u };
      rayons[ray][ing.nom].qte += qte;
    });
  });
  return Object.entries(rayons).sort((a, b) => a[0].localeCompare(b[0]));
}

function loadCourses(platIds) {
  const sorted = buildCoursesData(platIds);
  const el = $('coursesDiv');
  if (!sorted.length) { el.innerHTML = '<p style="color:var(--txl);padding:20px">Aucun ingredient trouve.</p>'; return; }

  // Cle de stockage local pour les cochages : par commande
  const storageKey = `courses-${currentCmdId || 'na'}`;
  const checkedSet = new Set(JSON.parse(localStorage.getItem(storageKey) || '[]'));

  el.innerHTML = sorted.map(([ray, ings]) => {
    const color = RAYON_COLOR[ray] || (CURRENT_BRANDING?.couleur_principale || '#3d6b4f');
    const emoji = REMOJI[ray] || '🛒';
    const items = Object.entries(ings);
    return `
    <div style="background:var(--wh);border-radius:14px;border-left:5px solid ${color};padding:14px 16px 6px;margin-bottom:14px;box-shadow:0 2px 12px rgba(0,0,0,.04)">
      <div style="display:flex;align-items:baseline;justify-content:space-between;margin-bottom:8px;padding-bottom:8px;border-bottom:1px solid var(--bgd)">
        <div style="font-family:'Playfair Display',serif;font-size:17px;font-weight:600;color:var(--tx);display:flex;align-items:center;gap:8px">
          <span style="font-size:20px">${emoji}</span> ${escapeHtml(ray)}
        </div>
        <span style="font-size:11px;color:var(--txl);background:var(--bg);padding:2px 9px;border-radius:12px">${items.length} article${items.length > 1 ? 's' : ''}</span>
      </div>
      ${items.map(([n, { qte, u }]) => {
        const key = `${ray}::${n}`;
        const checked = checkedSet.has(key);
        return `
        <label class="course-line" data-key="${escapeAttr(key)}" style="display:flex;align-items:center;gap:10px;padding:10px 4px;border-bottom:1px solid var(--bgd);cursor:pointer;user-select:none;${checked ? 'opacity:.45' : ''}">
          <input type="checkbox" class="course-ck" ${checked ? 'checked' : ''} style="width:18px;height:18px;accent-color:${color};cursor:pointer;flex-shrink:0">
          <span style="flex:1;font-size:14px;font-weight:500;color:var(--tx);${checked ? 'text-decoration:line-through' : ''}">${escapeHtml(n)}</span>
          <span style="background:var(--vp);color:var(--vert);padding:3px 10px;border-radius:14px;font-size:12px;font-weight:500;white-space:nowrap">${qte > 0 ? fmtN(qte) + (u ? ' ' + u : '') : '–'}</span>
        </label>`;
      }).join('')}
    </div>`;
  }).join('');

  // Retire la bordure du dernier item de chaque carte
  el.querySelectorAll('label.course-line:last-child').forEach(l => l.style.borderBottom = 'none');

  // Cochage avec persistance localStorage
  el.querySelectorAll('label.course-line').forEach(label => {
    const ck = label.querySelector('.course-ck');
    label.addEventListener('click', (e) => {
      // Eviter double-click si clic direct sur la checkbox (laisser le comportement natif)
      if (e.target !== ck) {
        e.preventDefault();
        ck.checked = !ck.checked;
      }
      const key = label.dataset.key;
      const cur = new Set(JSON.parse(localStorage.getItem(storageKey) || '[]'));
      if (ck.checked) cur.add(key); else cur.delete(key);
      localStorage.setItem(storageKey, JSON.stringify([...cur]));
      label.style.opacity = ck.checked ? '.45' : '1';
      const txt = label.querySelector('span:nth-child(2)');
      if (txt) txt.style.textDecoration = ck.checked ? 'line-through' : 'none';
    });
  });
}

function voirIngDetail(platId) {
  const plat = recettes.find(r => r.id === platId);
  if (!plat) return;
  const portions = currentDetailPortions || 4;
  const ris = recettesIngredients.filter(ri => ri.recette_id === platId).sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  const html = `
    ${plat.photo_url ? `<img class="mimg" src="${escapeHtml(plat.photo_url)}" alt="${escapeHtml(plat.nom_du_plat)}">` : `<div class="mph">🍽️</div>`}
    <div class="mbody">
      <div class="mtit2">${escapeHtml(plat.nom_du_plat)}</div>
      ${ris.length ? `
      <div class="mstit">🥕 Ingredients (${portions} portions)</div>
      <ul class="ings">${ris.map(ri => {
        const ing = ingredients.find(i => i.id === ri.ingredient_id);
        if (!ing) return '';
        const qte = (ri.quantite_par_portion || 0) * portions;
        const u = ing.unite_par_defaut && ing.unite_par_defaut !== 'Unité par défaut' ? ing.unite_par_defaut : '';
        return `<li style="display:flex;justify-content:space-between"><span>${escapeHtml(ing.nom)}</span><span style="color:var(--txl)">${qte > 0 ? fmtN(qte) + (u ? ' ' + u : '') : '–'}</span></li>`;
      }).join('')}</ul>` : ''}
      <div class="mstit">♨️ Rechauffage</div>
      <div class="mrec">${escapeHtml(plat.instructions_rechauffage || 'Non renseigne')}</div>
      <div class="mstit">🧊 Conservation</div>
      <div class="mcon">${plat.frigo_en_jours ? plat.frigo_en_jours + ' jours au refrigerateur' : 'Non renseigne'}</div>
      ${plat.congelation ? `<div class="mstit">❄️ Congelation</div><div class="mcon" style="border-left-color:#64b5f6;background:#e3f2fd">${escapeHtml(plat.congelation)}</div>` : ''}
      <button class="mclose" id="mcloseBtn">Fermer</button>
    </div>`;
  $('mcont').innerHTML = html;
  $('mbg').classList.add('show');
  $('mcloseBtn').addEventListener('click', () => $('mbg').classList.remove('show'));
}

function imprimerCourses() {
  const semaineEl = document.querySelector('.cbanner p');
  const semaine = semaineEl ? semaineEl.textContent : '';
  const sorted = buildCoursesData(platsDetailCache.map(p => p.id));

  const printHtml = sorted.map(([ray, ings]) => {
    const items = Object.entries(ings);
    const emoji = REMOJI[ray] || '🛒';
    return `<div class="r">
      <h2>${emoji} ${escapeHtml(ray)} <span class="cnt">${items.length}</span></h2>
      ${items.map(([n, { qte, u }]) => `<div class="i">
        <span class="ck"></span>
        <span class="nm">${escapeHtml(n)}</span>
        <span class="qt">${qte > 0 ? fmtN(qte) + (u ? ' ' + u : '') : '–'}</span>
      </div>`).join('')}
    </div>`;
  }).join('');

  const win = window.open('', '_blank');
  const brandColor = (CURRENT_BRANDING?.couleur_principale) || '#3d6b4f';
  const brandName = (CURRENT_BRANDING?.nom_marque) || 'Mon espace Batchcooking';
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>Liste de courses - ${brandName}</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:24px auto;padding:0 20px;color:#222;font-size:12px;line-height:1.4}
      h1{font-size:17px;margin:0 0 2px;color:${brandColor};font-weight:700}
      .sub{font-size:10px;color:#777;margin-bottom:14px;text-transform:uppercase;letter-spacing:.5px}
      .r{margin-bottom:10px;break-inside:avoid;page-break-inside:avoid}
      .r h2{font-size:12px;font-weight:600;border-bottom:1.5px solid #ddd;padding-bottom:2px;margin:0 0 4px;color:#333;display:flex;align-items:baseline;gap:5px}
      .r h2 .cnt{font-size:9px;color:#999;font-weight:400;margin-left:auto}
      .i{display:flex;align-items:center;gap:7px;padding:2px 0;font-size:11px;line-height:1.3}
      .i .ck{display:inline-block;width:10px;height:10px;border:1px solid #555;border-radius:2px;flex-shrink:0}
      .i .nm{flex:1}
      .i .qt{color:${brandColor};font-weight:600;font-size:10px;white-space:nowrap}
      .foot{margin-top:18px;font-size:9px;color:#bbb;text-align:center;border-top:1px solid #eee;padding-top:8px}
      @page{margin:10mm}
      @media print{body{margin:0;max-width:100%;padding:0 10mm}}
    </style>
  </head><body>
    <h1>Liste de courses · ${brandName}</h1>
    <div class="sub">${escapeHtml(semaine)} · ${escapeHtml(clientProfile?.nom || '')}</div>
    ${printHtml}
    <div class="foot">Imprime depuis ${brandName}</div>
  </body></html>`);
  win.document.close();
  win.focus();
  setTimeout(() => win.print(), 500);
}

// --- NOUVEAUTES A VENIR ---
let aVenirSearch = '';
let aVenirCatFilter = 'all';

async function showAVenir() {
  showPage('pAVenir');
  if (!recettes.length) await loadRecettesData();
  renderAVenirGrid();
}

function renderAVenirGrid() {
  renderPlatChips('aVenirCatChips', aVenirCatFilter, (c) => { aVenirCatFilter = c; renderAVenirGrid(); });
  const search = aVenirSearch.toLowerCase().trim();
  const aVenir = recettes.filter(r => {
    if (getEtat(r) !== 'a_venir') return false;
    if (aVenirCatFilter !== 'all' && r.categorie !== aVenirCatFilter) return false;
    if (search && !(r.nom_du_plat || '').toLowerCase().includes(search)) return false;
    return true;
  });
  const grid = $('aVenirGrid');
  if (!aVenir.length) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="eicon">⏰</div><p>Aucune nouveauté annoncée pour le moment.<br>Revenez bientôt — ${escapeHtml(CURRENT_BRANDING?.nom_contact || 'votre cuisinière')} prépare de nouvelles recettes !</p></div>`;
    return;
  }
  grid.innerHTML = aVenir.map(rec => `
    <div class="pcard" style="cursor:default">
      ${rec.photo_url ? `<img class="pimg" src="${escapeHtml(rec.photo_url)}" alt="${escapeHtml(rec.nom_du_plat)}" loading="lazy">` : `<div class="pph">🍽️</div>`}
      <div class="pinfo">
        <div class="ptop">
          <span class="pcat ${catCls(rec.categorie)}">${escapeHtml(rec.categorie || 'Plat')}</span>
        </div>
        <div class="pnom">${escapeHtml(rec.nom_du_plat)}</div>
        <div style="font-size:11px;font-style:italic;color:var(--txl);margin-top:6px">Disponible prochainement</div>
      </div>
    </div>`).join('');
}

// --- APP COMMANDE (selection plats) ---
async function showApp() {
  sel = []; semSel = null; crenSel = null;
  currentDetailPortions = clientProfile?.nombre_portions || 4;
  showPage('pApp');
  affSemaines();
  if (!recettes.length) await loadRecettesData();
  renderPlats();
  majBarre();
}

async function loadRecettesData() {
  showLoad('Chargement des plats...');
  try {
    const [recRes, riRes, ingRes, ctRes] = await Promise.all([
      sb.from('recettes').select('*').order('nom_du_plat'),
      sb.from('recettes_ingredients').select('*').order('ordre', { ascending: true }),
      sb.from('ingredients').select('*'),
      sb.from('creneaux_template').select('*')
    ]);
    if (recRes.error) throw recRes.error;
    if (riRes.error) throw riRes.error;
    if (ingRes.error) throw ingRes.error;
    recettes = recRes.data || [];
    recettesIngredients = riRes.data || [];
    ingredients = ingRes.data || [];
    creneauxTemplate = ctRes.data || [];
  } finally {
    hideLoad();
  }
}

function getLundis() {
  const res = [];
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const dow = (new Date(y, m, d)).getDay() || 7;
  const diffToMonday = dow - 1;
  for (let i = 0; i < 4; i++) {
    const l = new Date(y, m, d - diffToMonday + i * 7);
    const v = new Date(y, m, d - diffToMonday + i * 7 + 4);
    const f = x => x.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
    const yy = l.getFullYear(), mm = String(l.getMonth() + 1).padStart(2, '0'), dd = String(l.getDate()).padStart(2, '0');
    res.push({ id: `${yy}-${mm}-${dd}`, label: `Semaine du ${f(l)}`, det: `${f(l)} au ${f(v)}` });
  }
  return res;
}

function affSemaines() {
  const c = $('slist');
  c.innerHTML = '';
  getLundis().forEach(s => {
    const el = document.createElement('div');
    el.className = 'sitem';
    el.innerHTML = `<div>${escapeHtml(s.label)}</div><div class="sdates">${escapeHtml(s.det)}</div>`;
    el.addEventListener('click', () => {
      document.querySelectorAll('.sitem').forEach(x => x.classList.remove('on'));
      el.classList.add('on');
      semSel = s;
      affCreneaux(s);
    });
    c.appendChild(el);
  });
}

async function affCreneaux(sem) {
  const c = $('clist');
  c.innerHTML = '<div class="cph">Chargement...</div>';
  crenSel = null;
  let pris = [], crenRecs = [];
  try {
    const [cmdRes, crRes] = await Promise.all([
      sb.from('commandes').select('creneau, slot_key').eq('semaine_du', sem.id),
      sb.from('creneaux').select('*').eq('semaine', sem.id)
    ]);
    pris = cmdRes.data || [];
    crenRecs = crRes.data || [];
  } catch (e) { /* default to all open */ }

  function isActif(j, slot) {
    const k = `${j}_${slot}`;
    const found = crenRecs.find(r => r.slot === k);
    return found ? !!found.actif : true;
  }
  const [y, mo, d] = sem.id.split('-').map(Number);
  c.innerHTML = '';
  const jours = JOURS_ORDER.filter(j => creneauxTemplate.some(t => t.jour === j));
  if (!jours.length) {
    c.innerHTML = '<div class="cph">Aucun creneau disponible cette semaine</div>';
    return;
  }
  jours.forEach(j => {
    const jd = new Date(y, mo - 1, d + JMAP_FULL[j]);
    const jl = jd.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    getSlotsForJour(j).forEach(slot => {
      const h = fmtSlotLabel(slot.heure_debut, slot.heure_fin);
      const lbl = `${jl} · ${h}`;
      const slotKey = `${j}_${slot.nom_slot}`;
      const taken = pris.some(p => p.slot_key === slotKey || (p.creneau && p.creneau.trim() === lbl.trim()));
      const ferme = !isActif(j, slot.nom_slot);
      const el = document.createElement('div');
      el.className = 'citem' + ((taken || ferme) ? ' cpris' : '');
      const tag = taken ? '<span class="cpris-tag">Complet</span>' : ferme ? '<span class="cpris-tag">Ferme</span>' : '';
      el.innerHTML = `<div class="cjour">${escapeHtml(jl)}</div><div style="display:flex;align-items:center;justify-content:space-between"><span>${h}</span>${tag}</div>`;
      if (!taken && !ferme) {
        el.addEventListener('click', () => {
          document.querySelectorAll('.citem').forEach(x => x.classList.remove('on'));
          el.classList.add('on');
          crenSel = { lbl, slotKey };
          majBarre();
        });
      }
      c.appendChild(el);
    });
  });
}

const CATS_FIXED = ['Viande', 'Poisson', 'Végé', 'Poulet', 'Pâtes', 'Cuisine du monde', 'Post partum'];
let platSearch = '';
let platCatFilter = 'all';

function renderPlatChips(containerId, current, onSelect, includeFavoris = false) {
  const c = $(containerId); if (!c) return;
  const chipCss = (active, fav) => active
    ? (fav ? 'background:#fde2e4;border-color:#e63946;color:#e63946;font-weight:600' : 'background:var(--vp);border-color:var(--vert);color:var(--vert);font-weight:600')
    : 'background:var(--bg);border-color:var(--bgd);color:var(--txl)';
  const cats = includeFavoris ? ['favoris', 'all', ...CATS_FIXED] : ['all', ...CATS_FIXED];
  c.innerHTML = cats.map(cat => {
    const label = cat === 'favoris' ? '❤️ Mes favoris' : cat === 'all' ? 'Tous' : cat;
    return `<button class="cat-chip" data-cat="${escapeHtml(cat)}" style="padding:6px 13px;border:1.5px solid;border-radius:18px;font-size:12px;cursor:pointer;font-family:'DM Sans',sans-serif;transition:.15s;${chipCss(cat === current, cat === 'favoris')}">${escapeHtml(label)}</button>`;
  }).join('');
  c.querySelectorAll('.cat-chip').forEach(b => b.addEventListener('click', () => onSelect(b.dataset.cat)));
}

function renderPlats() {
  const g = $('pgrid');
  g.innerHTML = '';
  renderPlatChips('platCatChips', platCatFilter, (c) => { platCatFilter = c; renderPlats(); }, true);
  const search = platSearch.toLowerCase().trim();
  const actifs = recettes.filter(r => {
    if (getEtat(r) !== 'actif') return false;
    if (platCatFilter === 'favoris' && !favoris.has(r.id)) return false;
    if (platCatFilter !== 'all' && platCatFilter !== 'favoris' && r.categorie !== platCatFilter) return false;
    if (search && !(r.nom_du_plat || '').toLowerCase().includes(search)) return false;
    return true;
  });
  if (!actifs.length) {
    const msg = platCatFilter === 'favoris'
      ? 'Vous n\'avez pas encore de favori. Cliquez sur le ♡ d\'un plat pour le marquer.'
      : 'Aucun plat ne correspond a votre recherche.';
    g.innerHTML = `<div class="empty-state" style="grid-column:1/-1"><div class="eicon">${platCatFilter === 'favoris' ? '❤️' : '🔍'}</div><p>${msg}</p></div>`;
    return;
  }
  actifs.forEach(rec => {
    const card = document.createElement('div');
    card.className = 'pcard';
    card.dataset.id = rec.id;
    const isFav = favoris.has(rec.id);
    card.innerHTML = `
      <button class="fav-btn ${isFav ? 'on' : ''}" data-act="fav" data-id="${rec.id}" title="${isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${isFav ? '♥' : '♡'}</button>
      <div class="pchk"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
      ${rec.photo_url ? `<img class="pimg" src="${escapeHtml(rec.photo_url)}" alt="${escapeHtml(rec.nom_du_plat)}" loading="lazy">` : `<div class="pph">🍽️</div>`}
      <div class="pinfo">
        <div class="ptop">
          <span class="pcat ${catCls(rec.categorie)}">${escapeHtml(rec.categorie || 'Plat')}</span>
          <button class="bing" data-act="ing" data-id="${rec.id}">🥕 Ingredients</button>
        </div>
        <div class="pnom">${escapeHtml(rec.nom_du_plat)}</div>
      </div>`;
    card.addEventListener('click', (e) => {
      if (e.target.closest('[data-act="ing"]')) return;
      if (e.target.closest('[data-act="fav"]')) return;
      togglePlat(rec.id, card);
    });
    card.querySelector('[data-act="ing"]').addEventListener('click', (e) => {
      e.stopPropagation();
      voirIngSel(rec.id);
    });
    card.querySelector('[data-act="fav"]').addEventListener('click', (e) => {
      e.stopPropagation();
      toggleFavori(rec.id, e.currentTarget);
    });
    g.appendChild(card);
  });
}

function togglePlat(id, card) {
  const idx = sel.findIndex(p => p.id === id);
  if (idx > -1) {
    sel.splice(idx, 1);
    card.classList.remove('on');
  } else {
    if (sel.length >= 5) { showToast('Maximum 5 plats !', 'err'); return; }
    const rec = recettes.find(r => r.id === id);
    if (!rec) return;
    sel.push({ id, nom: rec.nom_du_plat });
    card.classList.add('on');
  }
  document.querySelectorAll('.pcard').forEach(c => {
    if (!c.classList.contains('on')) c.classList.toggle('off', sel.length >= 5);
  });
  majBarre();
}

function majBarre() {
  const n = sel.length;
  const ok = n === 5 && semSel && crenSel;
  for (let i = 1; i <= 5; i++) $('d' + i).classList.toggle('on', i <= n);
  $('ctxt').textContent = n + ' / 5 plats';
  $('barre').classList.toggle('show', n > 0);
  $('btxt').textContent = n + ' / 5 plats selectionnes';
  $('bcren').textContent = crenSel ? '📅 ' + crenSel.lbl : semSel ? 'Choisissez un creneau' : 'Choisissez une semaine et un creneau';
  const bv = $('bval');
  bv.disabled = !ok;
  bv.textContent = ok ? '✓ Valider ma semaine' : (n < 5 ? 'Encore ' + (5 - n) + ' plat' + (5 - n > 1 ? 's' : '') : 'Choisissez un creneau');
}

function voirIngSel(platId) {
  voirIngDetail(platId);
}

function valider() {
  if (sel.length < 5 || !semSel || !crenSel) return;
  afficherRecap();
}

function afficherRecap() {
  const pop = document.createElement('div');
  pop.id = 'recapPop';
  pop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:center;justify-content:center;padding:20px';
  const semaine = semSel ? semSel.label : '';
  const creneau = crenSel ? crenSel.lbl : '';
  const instructionsPaiement = CURRENT_BRANDING?.instructions_paiement || '';
  const cuisiniereName = CURRENT_BRANDING?.nom_contact || 'votre cuisiniere';

  // Initialise la selection forfait : par defaut le 1er actif (ou le moins cher)
  if (!forfaitSel || !forfaits.find(f => f.id === forfaitSel.id)) {
    forfaitSel = forfaits[0] || null;
  }
  const montantClient = forfaitSel?.prix ?? CURRENT_BRANDING?.montant_client_default ?? 60;
  const platsHtml = sel.map((p, i) => `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #ede7db">
    <span style="background:var(--vp);color:var(--vert);width:24px;height:24px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0">${i + 1}</span>
    <span style="font-size:14px">${escapeHtml(p.nom)}</span>
  </div>`).join('');

  pop.innerHTML = `<div id="recapBox" style="background:#fff;border-radius:20px;padding:0;max-width:480px;width:100%;box-shadow:0 20px 60px rgba(0,0,0,.2);overflow:hidden;max-height:90vh;overflow-y:auto">
    <div style="background:var(--vert);padding:24px;text-align:center;color:#fff">
      <div style="font-size:36px;margin-bottom:10px">📋</div>
      <div style="font-family:'Playfair Display',serif;font-size:22px;font-weight:700;margin-bottom:4px">Recapitulatif</div>
      <div style="font-size:13px;opacity:.85">Verifiez votre selection avant de confirmer</div>
    </div>
    <div style="padding:24px">
      <div style="background:#f8f4ee;border-radius:12px;padding:14px 16px;margin-bottom:16px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b6b6b;margin-bottom:4px">📅 Semaine</div>
        <div style="font-size:15px;font-weight:500">${escapeHtml(semaine)}</div>
      </div>
      <div style="background:#f8f4ee;border-radius:12px;padding:14px 16px;margin-bottom:16px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b6b6b;margin-bottom:4px">🕐 Creneau</div>
        <div style="font-size:15px;font-weight:500">${escapeHtml(creneau)}</div>
      </div>
      <div style="background:#f8f4ee;border-radius:12px;padding:14px 16px;margin-bottom:20px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b6b6b;margin-bottom:8px">🍽️ Vos 5 plats</div>
        ${platsHtml}
      </div>
      ${forfaits.length > 1 ? `<div style="background:#f8f4ee;border-radius:12px;padding:14px 16px;margin-bottom:16px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b6b6b;margin-bottom:10px">📦 Choisissez votre forfait</div>
        <div id="forfaitChoix" style="display:flex;flex-direction:column;gap:8px">
          ${forfaits.map(f => `
            <label style="display:flex;align-items:flex-start;gap:10px;padding:10px 12px;border:2px solid ${f.id === forfaitSel?.id ? 'var(--vert)' : 'var(--bgd)'};border-radius:10px;cursor:pointer;background:${f.id === forfaitSel?.id ? 'var(--vp)' : 'var(--wh)'};transition:.15s">
              <input type="radio" name="forfaitRadio" value="${f.id}" ${f.id === forfaitSel?.id ? 'checked' : ''} style="margin-top:2px;flex-shrink:0">
              <div style="flex:1;min-width:0">
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;margin-bottom:2px">
                  <strong style="font-size:14px">${escapeHtml(f.nom)}</strong>
                  ${f.badge ? `<span style="background:var(--vp);color:var(--vert);font-size:10px;padding:1px 7px;border-radius:8px;text-transform:uppercase;letter-spacing:.3px">${escapeHtml(f.badge)}</span>` : ''}
                </div>
                ${f.description ? `<div style="font-size:11px;color:#6b6b6b;line-height:1.4">${escapeHtml(f.description)}</div>` : ''}
              </div>
              <span style="font-size:16px;font-weight:700;color:var(--vert);white-space:nowrap">${f.prix}€</span>
            </label>
          `).join('')}
        </div>
      </div>` : ''}
      <div style="background:var(--vp);border-radius:12px;padding:12px 16px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:15px;font-weight:500">A votre charge</span>
        <span id="recapMontant" style="font-size:20px;font-weight:700;color:var(--vert)">${montantClient}€</span>
      </div>
      <div style="background:#f8f4ee;border-radius:12px;padding:12px 16px;margin-bottom:16px">
        <label for="recapMessage" style="display:block;font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b6b6b;margin-bottom:6px">💬 Message à ${escapeHtml(cuisiniereName)} (optionnel)</label>
        <textarea id="recapMessage" rows="3" placeholder="Allergies, demande spéciale, info livraison..." style="width:100%;border:1px solid #ede7db;border-radius:8px;padding:10px;font-family:'DM Sans',sans-serif;font-size:13px;background:#fff;color:#2c2c2c;resize:vertical"></textarea>
      </div>
      ${instructionsPaiement ? `<div style="background:#fff8e7;border-left:3px solid #f9c74f;border-radius:10px;padding:14px 16px;margin-bottom:20px">
        <div style="font-size:13px;font-weight:600;margin-bottom:6px;color:#8a6a1a">💳 Modalité de paiement</div>
        <div style="font-size:12px;line-height:1.6;color:#5a5a3a;white-space:pre-wrap">${escapeHtml(instructionsPaiement)}</div>
      </div>` : ''}
      <button id="recapConfirm" style="display:block;width:100%;padding:14px;background:var(--vert);color:#fff;border-radius:12px;border:none;font-weight:500;font-size:15px;cursor:pointer;font-family:'DM Sans',sans-serif;margin-bottom:10px">✓ Confirmer ma commande</button>
      <button id="recapModifier" style="width:100%;padding:12px;background:#f8f4ee;color:#6b6b6b;border-radius:12px;border:none;font-size:14px;cursor:pointer;font-family:'DM Sans',sans-serif">← Modifier ma selection</button>
    </div>
  </div>`;
  document.body.appendChild(pop);

  $('recapModifier').addEventListener('click', () => pop.remove());
  $('recapConfirm').addEventListener('click', () => confirmerCommande(pop));
  // Sync radio forfait → met a jour montant et selection
  document.querySelectorAll('input[name="forfaitRadio"]').forEach(r => {
    r.addEventListener('change', () => {
      forfaitSel = forfaits.find(f => f.id === r.value) || null;
      const m = $('recapMontant');
      if (m && forfaitSel) m.textContent = `${forfaitSel.prix}€`;
      // Re-render labels pour highlight visuel
      document.querySelectorAll('#forfaitChoix label').forEach(lab => {
        const inp = lab.querySelector('input');
        const isSel = inp.value === forfaitSel?.id;
        lab.style.borderColor = isSel ? 'var(--vert)' : 'var(--bgd)';
        lab.style.background = isSel ? 'var(--vp)' : 'var(--wh)';
      });
    });
  });
}

async function confirmerCommande(pop) {
  const btn = $('recapConfirm');
  btn.disabled = true;
  btn.textContent = 'Enregistrement...';
  btn.style.opacity = '0.6';
  btn.style.cursor = 'not-allowed';
  const instructionsPaiement = CURRENT_BRANDING?.instructions_paiement || '';
  try {
    const payload = {
      client_id: clientProfile.id,
      entreprise_id: clientProfile.entreprise_id,
      semaine_du: semSel.id,
      creneau: crenSel.lbl,
      slot_key: crenSel.slotKey || null,
      statut: 'En attente de paiement',
      plat_1_id: sel[0].id,
      plat_2_id: sel[1].id,
      plat_3_id: sel[2].id,
      plat_4_id: sel[3].id,
      plat_5_id: sel[4].id,
      nombre_portions: clientProfile?.nombre_portions || 4,
      forfait_id: forfaitSel?.id || null,
      montant: forfaitSel?.prix ?? CURRENT_BRANDING?.montant_client_default ?? 60,
      message_client: $('recapMessage')?.value.trim() || null
    };
    const { error } = await sb.from('commandes').insert(payload);
    if (error) throw error;

    // Remplace le contenu de la modal par l'ecran de succes
    $('recapBox').innerHTML = `
      <div style="background:var(--vert);padding:32px 24px;text-align:center;color:#fff">
        <div style="font-size:54px;margin-bottom:12px">✅</div>
        <div style="font-family:'Playfair Display',serif;font-size:24px;font-weight:700;margin-bottom:6px">Commande validee !</div>
        <div style="font-size:13px;opacity:.85">Merci, on s'occupe de tout</div>
      </div>
      <div style="padding:28px 24px">
        <p style="font-size:14px;line-height:1.7;color:#2c2c2c;margin-bottom:18px">
          ${instructionsPaiement ? escapeHtml(instructionsPaiement).replace(/\n/g, '<br>') + '<br><br>' : ''}
          Vous recevrez une notification quand votre commande passera en <strong>"Confirmee"</strong>.
        </p>
        <button id="recapClose" style="display:block;width:100%;padding:14px;background:var(--vert);color:#fff;border-radius:12px;border:none;font-weight:500;font-size:15px;cursor:pointer;font-family:'DM Sans',sans-serif">Voir mes commandes</button>
      </div>`;
    $('recapClose').addEventListener('click', async () => {
      pop.remove();
      sel = []; semSel = null; crenSel = null;
      await chargerMesCommandes();
      showPage('pDash');
    });
  } catch (e) {
    btn.disabled = false;
    btn.textContent = '✓ Confirmer ma commande';
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
    const msg = (e && e.message) || String(e);
    // Si le trigger DB rejette pour limite mensuelle, on affiche un message plus explicite
    if (/limite atteinte/i.test(msg) || /commandes\/mois/i.test(msg)) {
      const cuisiniere = CURRENT_BRANDING?.nom_contact || 'votre cuisiniere';
      alert(`📦 Plafond mensuel atteint\n\nVotre cuisinière a déjà accepté le maximum de commandes pour ce mois. Contactez ${cuisiniere} ou réessayez le mois prochain.`);
    } else {
      showToast('Erreur: ' + msg, 'err');
    }
  }
}

// --- branding dynamique selon le sous-domaine ---
// Renvoie le slug entreprise si on est sur un sous-domaine type
// <slug>.mybatch.cooking ou <slug>.netlify.app, sinon null pour le root.
function getSubdomainSlug() {
  const host = window.location.hostname;
  if (host === 'mybatch.cooking' || host === 'www.mybatch.cooking') return null;
  if (host === 'localhost' || host.startsWith('127.') || host.startsWith('192.168.')) return null;
  let m = host.match(/^([^.]+)\.mybatch\.cooking$/);
  if (m) return m[1] === 'www' ? null : m[1];
  m = host.match(/^([^.]+)\.netlify\.app$/);
  if (m) return m[1];
  return null;
}

const GENERIC_BRANDING = {
  id: null,
  slug: null,
  nom_marque: 'my batch',
  nom_contact: 'le support my batch',
  logo_url: null,
  couleur_principale: '#E8843D',
  couleur_secondaire: '#3D6B4F'
};

let CURRENT_BRANDING = null;
async function loadBranding(opts = {}) {
  try {
    let qs = null;
    if (opts.id) qs = `id=${encodeURIComponent(opts.id)}`;
    else if (opts.slug) qs = `slug=${encodeURIComponent(opts.slug)}`;
    else {
      const slug = getSubdomainSlug();
      if (slug) qs = `slug=${encodeURIComponent(slug)}`;
    }
    if (!qs) {
      CURRENT_BRANDING = GENERIC_BRANDING;
      applyBranding(GENERIC_BRANDING);
      return;
    }
    const r = await fetch(`/.netlify/functions/branding?${qs}`);
    if (!r.ok) {
      CURRENT_BRANDING = GENERIC_BRANDING;
      applyBranding(GENERIC_BRANDING);
      return;
    }
    const b = await r.json();
    CURRENT_BRANDING = b;
    applyBranding(b);
  } catch (e) {
    CURRENT_BRANDING = GENERIC_BRANDING;
    applyBranding(GENERIC_BRANDING);
  }
}

function applyBranding(b) {
  if (!b) return;
  if (b.nom_marque) {
    document.title = b.nom_marque;
    // Si on est sur le brand "my batch", on garde le logo avec dot orange (innerHTML)
    // Sinon on remplace par le nom_marque texte
    const isMyBatch = b.nom_marque === 'my batch' && (!b.slug || b.slug === null);
    document.querySelectorAll('.llogo, .logo').forEach(el => {
      if (isMyBatch) {
        el.innerHTML = 'my batch<span class="mb-dot"></span>';
      } else {
        el.textContent = b.nom_marque;
      }
    });
  }
  if (b.nom_contact) {
    const helpNote = document.querySelector('#pLogin .lcard .l-help');
    if (helpNote) {
      if (b.slug) helpNote.innerHTML = `Problème de connexion ? Contactez <strong>${b.nom_contact}</strong>`;
    } else {
      const legacyNote = document.querySelector('#pLogin .lcard > div[style*="margin-top:20px"]');
      if (legacyNote) legacyNote.textContent = `Probleme ? Contactez ${b.nom_contact}.`;
    }
  }
  if (b.couleur_principale) document.documentElement.style.setProperty('--brand-primary', b.couleur_principale);
  if (b.couleur_secondaire) document.documentElement.style.setProperty('--brand-secondary', b.couleur_secondaire);
  if (b.logo_url) {
    const llogo = document.querySelector('#pLogin .llogo');
    if (llogo && !document.getElementById('brandingLogoImg')) {
      const img = document.createElement('img');
      img.id = 'brandingLogoImg';
      img.src = b.logo_url;
      img.alt = b.nom_marque || '';
      img.style.cssText = 'max-height:64px;width:auto;object-fit:contain;display:block;margin:0 auto 12px;border-radius:12px';
      llogo.parentElement.insertBefore(img, llogo);
    }
  }
}

// --- bind events ---
document.addEventListener('DOMContentLoaded', async () => {
  loadBranding();
  $('btnLogin').addEventListener('click', login);
  $('btnLogout1').addEventListener('click', logout);
  $('btnLogout2').addEventListener('click', logout);
  $('btnLogout3').addEventListener('click', logout);
  $('btnRetourDash').addEventListener('click', () => showPage('pDash'));
  $('btnRetourDash2').addEventListener('click', () => showPage('pDash'));
  $('cardCommander').addEventListener('click', showApp);
  $('cardMesCommandes').addEventListener('click', showMesCommandes);
  $('cardAVenir').addEventListener('click', showAVenir);
  $('btnRetourFromAVenir').addEventListener('click', () => showPage('pDash'));
  $('btnLogoutAVenir').addEventListener('click', logout);
  // Recherche plats (selection commande)
  const ps = $('platSearch'); if (ps) ps.addEventListener('input', (e) => { platSearch = e.target.value; renderPlats(); setTimeout(() => { ps.focus(); ps.setSelectionRange(ps.value.length, ps.value.length); }, 0); });
  // Recherche plats (page Nouveautes a venir)
  const avs = $('aVenirSearch'); if (avs) avs.addEventListener('input', (e) => { aVenirSearch = e.target.value; renderAVenirGrid(); setTimeout(() => { avs.focus(); avs.setSelectionRange(avs.value.length, avs.value.length); }, 0); });
  $('bval').addEventListener('click', valider);
  $('iEmail').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('iMdp').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('mbg').addEventListener('click', (e) => { if (e.target === $('mbg')) $('mbg').classList.remove('show'); });
  // Cloche notifications
  const bell = $('notifBell');
  if (bell) {
    bell.addEventListener('click', (e) => {
      e.stopPropagation();
      $('notifPanel').classList.toggle('show');
    });
  }
  document.addEventListener('click', (e) => {
    const panel = $('notifPanel');
    if (panel && panel.classList.contains('show') && !e.target.closest('#notifPanel') && !e.target.closest('#notifBell')) {
      panel.classList.remove('show');
    }
  });

  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    const r = await detectRole(session.user.id);
    if (r.role === 'admin') {
      if ((session.user.email || '').toLowerCase() === 'structify.crm@gmail.com') {
        // Stocke le token pour que superadmin.html puisse l'utiliser direct
        localStorage.setItem('mb_session', JSON.stringify({
          access_token: session.access_token,
          refresh_token: session.refresh_token,
          expires_at: session.expires_at,
          user: { id: session.user.id, email: session.user.email }
        }));
        window.location.href = 'superadmin.html';
        return;
      }
      window.location.href = 'admin.html';
      return;
    }
    if (r.role === 'salarie') { window.location.href = 'salarie.html'; return; }
    if (r.role === 'client') {
      clientProfile = r.data;
      if (clientProfile.entreprise_id && CURRENT_BRANDING?.id !== clientProfile.entreprise_id) {
        await loadBranding({ id: clientProfile.entreprise_id });
      }
      await loadDash();
      return;
    }
    await sb.auth.signOut();
  }
  showPage('pLogin');
});
