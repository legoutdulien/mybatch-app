// app.js — Portail client Le Gout du Lien
// Backend: Supabase

const SUPABASE_URL = 'https://loiaubdlhkcnohtbwtxg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvaWF1YmRsaGtjbm9odGJ3dHhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMzU1NDAsImV4cCI6MjA5MjcxMTU0MH0.2S2xnnpFT-kcblTzSC_x2ybSUUipUi5jMPe_DbNBUcA';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Traduit n'importe quelle erreur technique en message clair (jamais de SQL brut)
function msgErr(e) {
  const m = String((e && (e.message || (e.error && e.error.message))) || e || '');
  const c = e && (e.code || (e.error && e.error.code));
  if (c === '23505' || /duplicate key|unique constraint|existe déjà/i.test(m)) return 'Ça existe déjà.';
  if (c === '23503' || /foreign key|violates foreign/i.test(m)) return 'Impossible : cet élément est encore utilisé ailleurs.';
  if (/row-level security|not authorized|permission denied|jwt|invalid token|\b401\b|\b403\b|session/i.test(m)) return 'Action refusée (session expirée ?). Reconnecte-toi et réessaie.';
  if (/failed to fetch|networkerror|network error|load failed|timeout|net::/i.test(m)) return 'Problème de connexion. Vérifie ta connexion et réessaie.';
  return "L'action n'a pas pu être effectuée. Recharge la page et réessaie.";
}

// Une écriture Supabase qui viole la RLS ou tombe sur une session expirée renvoie
// 0 ligne SANS erreur : l'app croit avoir enregistré alors que rien n'est écrit.
// writeVerified exige un .select() en fin de requête : si 0 ligne, il rafraîchit la
// session et réessaie 1x, sinon il lève une vraie erreur visible (plus de perte muette).
async function writeVerified(runQuery) {
  let res = await runQuery();
  if (!res.error && (!res.data || res.data.length === 0)) {
    try { await sb.auth.refreshSession(); } catch (_) {}
    res = await runQuery();
  }
  if (res.error) throw res.error;
  if (!res.data || res.data.length === 0) throw new Error('Action non prise en compte (session expirée ?). Reconnecte-toi et réessaie.');
  return res.data;
}

// Unité effective d'un lien recette-ingrédient : celle propre à la recette (ri.unite)
// si renseignée, sinon l'unité par défaut de l'ingrédient.
function riUnite(ri, ing) {
  const l = ri && ri.unite;
  if (l != null && l !== '' && l !== 'Unité par défaut') return l;
  const d = ing && ing.unite_par_defaut;
  return (d && d !== 'Unité par défaut') ? d : '';
}

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
let assignedSalarie = null; // reseau : la cuisiniere attribuee a la cliente (pour forfaits + paiement)

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
    try {
      await writeVerified(() => sb.from('favoris').delete().eq('client_id', clientProfile.id).eq('recette_id', recetteId).select('recette_id'));
    } catch (error) { showToast('⚠️ ' + msgErr(error), 'err'); return; }
    favoris.delete(recetteId);
    btn.textContent = '♡';
    btn.classList.remove('on');
  } else {
    const { error } = await sb.from('favoris').insert({ client_id: clientProfile.id, recette_id: recetteId });
    if (error) { showToast('⚠️ ' + msgErr(error), 'err'); return; }
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
    // Bloque les utilisateurs de Le Gout du Lien sur app.mybatch.cooking : ils doivent passer par app.legoutdulien.com
    const LGDL_ENTREPRISE_ID = '372c68d3-54a0-4d13-8ce5-8c516ac20d8f';
    if (r.data?.entreprise_id === LGDL_ENTREPRISE_ID) {
      await sb.auth.signOut();
      err.innerHTML = 'Ce compte appartient à <strong>Le Goût du Lien</strong>. Connectez-vous sur <a href="https://app.legoutdulien.com" style="color:var(--vert);text-decoration:underline;font-weight:600">app.legoutdulien.com</a>';
      err.style.display = 'block';
      hideLoad();
      return;
    }
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
      window.location.href = 'partenaire.html';
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
    err.textContent = msgErr(e); err.style.display = 'block';
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
  await Promise.all([loadFavoris(), loadNotifs(), loadForfaits(), loadAssignedSalarie()]);
  await chargerMesCommandes();
  setupRealtimeNotifs();
}

async function loadForfaits() {
  try {
    // Reseau : la cliente ne voit que les forfaits de SA cuisiniere. Vide = la tete de reseau.
    let q = sb.from('forfaits').select('*').eq('active', true);
    q = clientProfile?.assigne_a_id ? q.eq('salarie_id', clientProfile.assigne_a_id) : q.is('salarie_id', null);
    let { data, error } = await q.order('ordre', { ascending: true });
    if (error) {
      // Colonne salarie_id pas encore migree : fallback = tous les forfaits actifs (compat solo avant migration)
      const r = await sb.from('forfaits').select('*').eq('active', true).order('ordre', { ascending: true });
      data = r.data;
    }
    forfaits = data || [];
  } catch (e) {
    forfaits = [];
  }
}

// Reseau : charge la cuisiniere attribuee (pour afficher SES modalites de paiement au recap)
async function loadAssignedSalarie() {
  assignedSalarie = null;
  if (!clientProfile?.assigne_a_id) return;
  try {
    const { data } = await sb.from('salaries').select('nom, telephone, instructions_paiement').eq('id', clientProfile.assigne_a_id).maybeSingle();
    assignedSalarie = data || null;
  } catch (e) { assignedSalarie = null; }
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
      const platIds = cmdPlatIds(cmd);
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
    div.innerHTML = '<p style="color:var(--txl);padding:20px">⚠️ ' + escapeHtml(msgErr(e)) + '</p>';
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
    const platIds = cmdPlatIds(cmd);
    platsDetailCache = platIds.map(id => recettes.find(r => r.id === id)).filter(Boolean);
    const semLabel = cmd.semaine_du ? 'Semaine du ' + fmtDate(cmd.semaine_du) : '';
    // Detecte si la cliente a choisi un forfait avec courses incluses
    const f = forfaits.find(x => x.id === cmd.forfait_id);
    const forfaitInclutCourses = !!f?.inclut_courses;
    renderDetail({ nom: clientProfile.nom || '', semLabel, creneau: cmd.creneau || '', id: cmd.id, statut: cmd.statut || 'En attente de paiement', montant: cmd.montant ?? CURRENT_BRANDING?.montant_client_default ?? 60, forfaitInclutCourses });
  } catch (e) {
    showToast('⚠️ ' + msgErr(e), 'err');
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
    const _recF = recettes.find(r => r.id === pid);
    const _mult = (_recF && _recF.quantite_fixe) ? 1 : p; // recette à quantités fixes : pas de multiplication par les portions
    const ris = recettesIngredients.filter(ri => ri.recette_id === pid);
    ris.forEach(ri => {
      const ing = ingredients.find(i => i.id === ri.ingredient_id);
      if (!ing) return;
      const ray = ing.rayon || 'Autres';
      const u = riUnite(ri, ing);
      const qte = (ri.quantite_par_portion || 0) * _mult;
      if (!rayons[ray]) rayons[ray] = {};
      // Meme ingredient dans deux unites differentes (unite par recette) -> lignes separees
      let key = ing.nom;
      if (rayons[ray][key] && rayons[ray][key].u !== u) key = ing.nom + ' (' + u + ')';
      if (!rayons[ray][key]) rayons[ray][key] = { qte: 0, u };
      rayons[ray][key].qte += qte;
    });
  });
  return Object.entries(rayons).sort((a, b) => a[0].localeCompare(b[0]));
}

function loadCourses(platIds) {
  const sorted = buildCoursesData(platIds);
  const el = $('coursesDiv');
  if (!sorted.length) { el.innerHTML = '<p style="color:var(--txl);padding:20px">Aucun ingredient trouve.</p>'; return; }

  // Cases cochees : memorisees par commande. localStorage (instantane, par appareil)
  // + synchro serveur (table courses_cochees) pour PARTAGER entre appareils d'un meme
  // compte (ex. mari + femme sur 2 telephones) et conserver 10 jours.
  const storageKey = `courses-${currentCmdId || 'na'}`;
  const cmdId = currentCmdId;
  let current = new Set(JSON.parse(localStorage.getItem(storageKey) || '[]'));
  let userTouched = false;

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
        const checked = current.has(key);
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

  function saveChecked() {
    localStorage.setItem(storageKey, JSON.stringify([...current]));
    // synchro serveur (fire-and-forget) : partage entre appareils + conservation 10 jours
    if (cmdId) sb.from('courses_cochees').upsert({ commande_id: cmdId, coche: [...current] }, { onConflict: 'commande_id' }).then(() => {}, () => {});
  }
  function applyToUI() {
    el.querySelectorAll('label.course-line').forEach(label => {
      const ck = label.querySelector('.course-ck');
      const on = current.has(label.dataset.key);
      ck.checked = on;
      label.style.opacity = on ? '.45' : '1';
      const txt = label.querySelector('span:nth-child(2)');
      if (txt) txt.style.textDecoration = on ? 'line-through' : 'none';
    });
  }

  // Cochage
  el.querySelectorAll('label.course-line').forEach(label => {
    const ck = label.querySelector('.course-ck');
    label.addEventListener('click', (e) => {
      // Eviter double-click si clic direct sur la checkbox (laisser le comportement natif)
      if (e.target !== ck) { e.preventDefault(); ck.checked = !ck.checked; }
      userTouched = true;
      const key = label.dataset.key;
      if (ck.checked) current.add(key); else current.delete(key);
      label.style.opacity = ck.checked ? '.45' : '1';
      const txt = label.querySelector('span:nth-child(2)');
      if (txt) txt.style.textDecoration = ck.checked ? 'line-through' : 'none';
      saveChecked();
    });
  });

  // Charge l'etat serveur (partage entre appareils du meme compte). Si l'utilisateur
  // n'a pas encore touche aux cases, on applique l'etat serveur (< 10 jours). Sinon on
  // remonte les cases locales existantes au serveur (migration / premiere fois).
  if (cmdId) {
    (async () => {
      try {
        const { data } = await sb.from('courses_cochees').select('coche, updated_at').eq('commande_id', cmdId).maybeSingle();
        if (userTouched) return;
        const fresh = data && data.updated_at && (Date.now() - new Date(data.updated_at).getTime()) < 10 * 24 * 3600 * 1000;
        if (fresh && Array.isArray(data.coche)) {
          current = new Set(data.coche);
          localStorage.setItem(storageKey, JSON.stringify([...current]));
          applyToUI();
        } else if (!data && current.size) {
          saveChecked();
        }
      } catch (_) {}
    })();
  }
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
        const qte = (ri.quantite_par_portion || 0) * (plat.quantite_fixe ? 1 : portions);
        const u = riUnite(ri, ing);
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
    if (aVenirCatFilter !== 'all' && !catsOf(r).includes(aVenirCatFilter)) return false;
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
          <span style="display:flex;flex-wrap:wrap;gap:4px;width:100%">${(catsOf(rec).length ? catsOf(rec) : ['Plat']).map(c => `<span class="pcat ${catCls(c)}">${escapeHtml(c)}</span>`).join('')}${rec.au_four ? `<span class="pcat" style="background:#ffe8d6;color:#c1440e">🔥 Four</span>` : ''}</span>
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
  // Formule par defaut : la 1ere (ou la moins chere) ; elle definit les quotas par type
  if (!forfaitSel || !forfaits.find(f => f.id === forfaitSel.id)) forfaitSel = forfaits[0] || null;
  platTypeFilter = (activeTypes()[0] || { key: 'plat' }).key;
  showPage('pApp');
  affSemaines();
  if (!recettes.length) await loadRecettesData();
  renderFormuleChoix();
  renderPlats();
  majBarre();
}

// Selecteur de formule (avant de composer). 1 seul forfait -> affichage compact ; plusieurs -> choix.
function renderFormuleChoix() {
  const c = $('formuleChoix');
  if (!c) return;
  if (!forfaits.length) { c.innerHTML = ''; return; } // pas de forfait -> 5 plats classiques, rien a choisir
  const card = (f) => {
    const on = f.id === forfaitSel?.id;
    const q = forfaitQuotas(f);
    const compo = PLAT_TYPES.filter(t => q[t.key] > 0).map(t => `${q[t.key]} ${t.emoji}`).join(' + ');
    return `<label style="display:flex;align-items:center;gap:10px;padding:11px 13px;border:2px solid ${on ? 'var(--vert)' : 'var(--bgd)'};border-radius:11px;cursor:pointer;background:${on ? 'var(--vp)' : 'var(--wh)'}">
      <input type="radio" name="formuleRadio" value="${f.id}" ${on ? 'checked' : ''} style="flex-shrink:0">
      <div style="flex:1;min-width:0">
        <div style="font-weight:600;font-size:14px">${escapeHtml(f.nom)}${f.badge ? ` <span style="background:var(--vp);color:var(--vert);font-size:10px;padding:1px 7px;border-radius:8px">${escapeHtml(f.badge)}</span>` : ''}</div>
        <div style="font-size:11px;color:#6b6b6b">${escapeHtml(compo)}</div>
      </div>
      <span style="font-weight:700;color:var(--vert);white-space:nowrap">${f.prix}€</span>
    </label>`;
  };
  c.innerHTML = `<div class="ctit">📦 Votre formule</div>
    <div style="display:flex;flex-direction:column;gap:8px;margin-top:6px">${forfaits.map(card).join('')}</div>`;
  c.querySelectorAll('input[name="formuleRadio"]').forEach(r => {
    r.addEventListener('change', () => {
      forfaitSel = forfaits.find(f => f.id === r.value) || null;
      sel = []; // on repart a zero : les quotas changent
      platTypeFilter = (activeTypes()[0] || { key: 'plat' }).key;
      renderFormuleChoix();
      renderPlats();
      majBarre();
    });
  });
}

// recettes_ingredients peut depasser 1000 lignes (limite PostgREST) -> pagination pour tout charger
async function fetchAllRI() {
  const all = []; const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('recettes_ingredients').select('*').order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { data: all, error: null };
}

async function loadRecettesData() {
  showLoad('Chargement des plats...');
  try {
    const [recRes, riRes, ingRes, ctRes] = await Promise.all([
      sb.from('recettes').select('*').order('nom_du_plat'),
      fetchAllRI(),
      sb.from('ingredients').select('*'),
      // Reseau : la cliente ne voit que les creneaux de SA cuisiniere attribuee (assigne_a_id). Vide = la tete de reseau.
      (clientProfile?.assigne_a_id
        ? sb.from('creneaux_template').select('*').eq('salarie_id', clientProfile.assigne_a_id)
        : sb.from('creneaux_template').select('*').is('salarie_id', null))
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
  for (let i = 0; i < 6; i++) {
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
    // Les créneaux pris sont lus via une fonction sécurisée (creneaux_pris) :
    // la RLS empêche une cliente de voir les commandes des autres, donc un
    // simple select ne renverrait que ses propres réservations.
    const assigne = clientProfile?.assigne_a_id || null; // null = la tete de reseau
    const [cmdRes, crRes] = await Promise.all([
      sb.rpc('creneaux_pris', { p_entreprise: clientProfile.entreprise_id, p_semaine: sem.id, p_salarie: assigne }),
      (assigne
        ? sb.from('creneaux').select('*').eq('semaine', sem.id).eq('salarie_id', assigne)
        : sb.from('creneaux').select('*').eq('semaine', sem.id).is('salarie_id', null))
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
  const today0 = new Date(); today0.setHours(0, 0, 0, 0); // aujourd'hui à minuit : on n'accepte pas de commander pour un jour déjà passé
  const jours = JOURS_ORDER.filter(j => creneauxTemplate.some(t => t.jour === j));
  if (!jours.length) {
    c.innerHTML = '<div class="cph">Aucun creneau disponible cette semaine</div>';
    return;
  }
  jours.forEach(j => {
    const jd = new Date(y, mo - 1, d + JMAP_FULL[j]);
    const jl = jd.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const passe = jd < today0; // jour dans le passé -> non réservable
    getSlotsForJour(j).forEach(slot => {
      const h = fmtSlotLabel(slot.heure_debut, slot.heure_fin);
      const nomCren = (slot.nom_slot || '').trim();
      const lbl = `${jl}${nomCren ? ' · ' + nomCren : ''} · ${h}`;
      const slotKey = `${j}_${slot.nom_slot}`;
      const taken = pris.some(p => p.slot_key === slotKey || (p.creneau && p.creneau.trim() === lbl.trim()));
      const ferme = !isActif(j, slot.nom_slot);
      const el = document.createElement('div');
      el.className = 'citem' + ((taken || ferme || passe) ? ' cpris' : '');
      const tag = passe ? '<span class="cpris-tag">Passé</span>' : taken ? '<span class="cpris-tag">Indisponible</span>' : ferme ? '<span class="cpris-tag">Ferme</span>' : '';
      el.innerHTML = `<div class="cjour">${escapeHtml(jl)}</div><div style="display:flex;align-items:center;justify-content:space-between"><span>${nomCren ? escapeHtml(nomCren) + ' · ' : ''}${h}</span>${tag}</div>`;
      if (!taken && !ferme && !passe) {
        el.addEventListener('click', () => {
          document.querySelectorAll('.citem').forEach(x => x.classList.remove('on'));
          el.classList.add('on');
          crenSel = { lbl, slotKey, date: jd };
          majBarre();
        });
      }
      c.appendChild(el);
    });
  });
}

const CATS_FIXED = ['Viande', 'Poisson', 'Végé', 'Vegan', 'Poulet', 'Pâtes', 'Cuisine du monde', 'Post partum', 'Sans porc', 'Sans gluten', 'Sans lactose', 'Sucré', 'Tartes', 'Cakes'];
let platSearch = '';
let platCatFilter = 'all';
let platTypeFilter = null; // type courant du filtre (null = auto = 1er type de la formule)

// --- Types de plats (composition des formules) ---
const PLAT_TYPES = [
  { key: 'entree', label: 'Entrées', emoji: '🥗', sing: 'entrée' },
  { key: 'plat', label: 'Plats', emoji: '🍽️', sing: 'plat' },
  { key: 'dessert', label: 'Desserts', emoji: '🍰', sing: 'dessert' },
  { key: 'petit_plus', label: 'Petits plus', emoji: '➕', sing: 'petit plus' }
];
function typeOf(rec) { return (rec && rec.type_plat) ? rec.type_plat : 'plat'; }
// Quotas d'une formule ; défaut/fallback = 5 plats (comportement historique)
function forfaitQuotas(f) {
  if (!f) return { entree: 0, plat: 5, dessert: 0, petit_plus: 0 };
  const q = {
    entree: parseInt(f.nb_entrees, 10) || 0,
    plat: (f.nb_plats == null ? 5 : (parseInt(f.nb_plats, 10) || 0)),
    dessert: parseInt(f.nb_desserts, 10) || 0,
    petit_plus: parseInt(f.nb_petit_plus, 10) || 0
  };
  if (q.entree + q.plat + q.dessert + q.petit_plus === 0) return { entree: 0, plat: 5, dessert: 0, petit_plus: 0 };
  return q;
}
function currentQuotas() { return forfaitQuotas(forfaitSel); }
// Types optionnels d'une formule : la cliente peut en prendre de 0 à N (au lieu d'exactement N)
// Réseau : pour un forfait de cuisinière (salarie_id renseigné), les petits plus sont TOUJOURS
// obligatoires (inclus dans la formule), jamais proposés en option — contrairement à l'espace tête de réseau.
function forfaitOpt(f) { return f ? { entree: !!f.opt_entree, plat: !!f.opt_plat, dessert: !!f.opt_dessert, petit_plus: f.salarie_id ? false : !!f.opt_petit_plus } : { entree: false, plat: false, dessert: false, petit_plus: false }; }
function currentOpt() { return forfaitOpt(forfaitSel); }
// Nombre d'éléments encore requis (les types optionnels ne comptent pas)
function remainingRequired() { const q = currentQuotas(), o = currentOpt(); return PLAT_TYPES.reduce((a, t) => a + (o[t.key] ? 0 : Math.max(0, q[t.key] - selCountByType(t.key))), 0); }
function activeTypes() { const q = currentQuotas(); return PLAT_TYPES.filter(t => q[t.key] > 0); }
function isMultiType() { return activeTypes().length > 1; }
function selCountByType(k) { return sel.filter(s => s.type === k).length; }
function totalNeeded() { const q = currentQuotas(); return q.entree + q.plat + q.dessert + q.petit_plus; }
function isSelComplete() {
  const q = currentQuotas(), o = currentOpt();
  const ok = PLAT_TYPES.every(t => { const have = selCountByType(t.key); return o[t.key] ? have <= q[t.key] : have === q[t.key]; });
  return ok && sel.length >= 1; // au moins 1 élément (évite une commande vide si tout est optionnel)
}
// Elements d'une commande : nouveau format `items` (JSONB) sinon repli sur plat_1..5
function cmdPlatIds(cmd) {
  if (cmd && Array.isArray(cmd.items) && cmd.items.length) return cmd.items.map(it => it.recette_id).filter(Boolean);
  return [cmd.plat_1_id, cmd.plat_2_id, cmd.plat_3_id, cmd.plat_4_id, cmd.plat_5_id].filter(Boolean);
}

// Catégories d'une recette : tableau `categories`, repli sur l'ancien champ `categorie`.
function catsOf(rec) {
  if (rec && Array.isArray(rec.categories) && rec.categories.length) return rec.categories;
  return rec && rec.categorie ? [rec.categorie] : [];
}

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

// Filtre par type (affiche seulement si la formule a plusieurs types), avec compteur par type
function renderTypeChips(types) {
  const c = $('platTypeChips');
  if (!c) return;
  if (!types.length) { c.innerHTML = ''; return; }
  const q = currentQuotas();
  const o = currentOpt();
  c.innerHTML = types.map(t => {
    const on = platTypeFilter === t.key;
    const cnt = selCountByType(t.key);
    const isOpt = o[t.key];
    const done = isOpt || cnt >= q[t.key];
    return `<button class="type-chip" data-type="${t.key}" style="padding:7px 13px;border:1.5px solid ${on ? 'var(--vert)' : 'var(--bgd)'};border-radius:18px;font-size:12.5px;cursor:pointer;font-family:'DM Sans',sans-serif;background:${on ? 'var(--vp)' : 'var(--bg)'};color:${on ? 'var(--vert)' : 'var(--txl)'};font-weight:${on ? '600' : '500'}">${t.emoji} ${t.label} <b style="color:${done ? '#2e7d32' : 'inherit'}">${cnt}/${q[t.key]}</b>${isOpt ? ' <span style="font-weight:400;color:var(--txl);font-size:11px">(option)</span>' : ''}</button>`;
  }).join('');
  c.querySelectorAll('.type-chip').forEach(b => b.addEventListener('click', () => { platTypeFilter = b.dataset.type; renderPlats(); }));
}

function renderPlats() {
  const g = $('pgrid');
  g.innerHTML = '';
  const quotas = currentQuotas();
  const types = activeTypes();
  const multi = types.length > 1;
  renderTypeChips(multi ? types : []);
  renderPlatChips('platCatChips', platCatFilter, (c) => { platCatFilter = c; renderPlats(); }, true);
  const search = platSearch.toLowerCase().trim();
  const actifs = recettes.filter(r => {
    if (getEtat(r) !== 'actif') return false;
    const t = typeOf(r);
    if (!quotas[t]) return false; // type absent de la formule -> non affiche
    if (multi && platTypeFilter && t !== platTypeFilter) return false;
    if (platCatFilter === 'favoris' && !favoris.has(r.id)) return false;
    if (platCatFilter !== 'all' && platCatFilter !== 'favoris' && !catsOf(r).includes(platCatFilter)) return false;
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
    const t = typeOf(rec);
    const selected = sel.some(s => s.id === rec.id);
    const typeFull = selCountByType(t) >= quotas[t];
    const typeMeta = PLAT_TYPES.find(x => x.key === t);
    const card = document.createElement('div');
    card.className = 'pcard' + (selected ? ' on' : '') + ((!selected && typeFull) ? ' off' : '');
    card.dataset.id = rec.id;
    const isFav = favoris.has(rec.id);
    card.innerHTML = `
      <button class="fav-btn ${isFav ? 'on' : ''}" data-act="fav" data-id="${rec.id}" title="${isFav ? 'Retirer des favoris' : 'Ajouter aux favoris'}">${isFav ? '♥' : '♡'}</button>
      <div class="pchk"><svg viewBox="0 0 24 24"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg></div>
      ${rec.photo_url ? `<img class="pimg" src="${escapeHtml(rec.photo_url)}" alt="${escapeHtml(rec.nom_du_plat)}" loading="lazy">` : `<div class="pph">🍽️</div>`}
      <div class="pinfo">
        <div class="ptop">
          <span style="display:flex;flex-wrap:wrap;gap:4px;width:100%">${multi && typeMeta ? `<span class="pcat" style="background:#eef4f0;color:#3d6b4f">${typeMeta.emoji} ${escapeHtml(typeMeta.sing)}</span>` : ''}${(catsOf(rec).length ? catsOf(rec) : ['Plat']).map(c => `<span class="pcat ${catCls(c)}">${escapeHtml(c)}</span>`).join('')}${rec.au_four ? `<span class="pcat" style="background:#ffe8d6;color:#c1440e">🔥 Four</span>` : ''}</span>
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
  } else {
    const rec = recettes.find(r => r.id === id);
    if (!rec) return;
    const t = typeOf(rec);
    const quotas = currentQuotas();
    if (!quotas[t]) { showToast('Ce type n\'est pas dans votre formule.', 'err'); return; }
    if (selCountByType(t) >= quotas[t]) {
      const meta = PLAT_TYPES.find(x => x.key === t);
      const label = meta ? meta.sing : 'élément';
      showToast(`Vous avez déjà choisi vos ${quotas[t]} ${label}${quotas[t] > 1 ? 's' : ''}.`, 'err');
      return;
    }
    // Limite plats au four par commande (reglage entreprise ; vide = pas de limite)
    const maxFour = CURRENT_BRANDING?.max_four_commande;
    if (rec.au_four && maxFour != null && maxFour !== '') {
      const nbFour = sel.filter(p => { const r = recettes.find(x => x.id === p.id); return r && r.au_four; }).length;
      if (nbFour >= Number(maxFour)) {
        showToast(`Maximum ${maxFour} plat${Number(maxFour) > 1 ? 's' : ''} au four par commande 🔥`, 'err');
        return;
      }
    }
    sel.push({ id, type: t, nom: rec.nom_du_plat });
  }
  renderPlats(); // refresh compteurs + cartes desactivees
  majBarre();
}

function majBarre() {
  const quotas = currentQuotas();
  const types = activeTypes();
  const multi = types.length > 1;
  const total = totalNeeded();
  const n = sel.length;
  for (let i = 1; i <= 5; i++) { const d = $('d' + i); if (d) d.classList.toggle('on', i <= n); }
  let progress;
  if (multi) {
    const o = currentOpt();
    progress = types.map(t => `${t.emoji} ${selCountByType(t.key)}/${quotas[t.key]}${o[t.key] ? ' (opt)' : ''}`).join(' · ');
  } else {
    const k = (types[0] || { key: 'plat' }).key;
    const meta = PLAT_TYPES.find(x => x.key === k) || PLAT_TYPES[1];
    progress = `${n} / ${quotas[k]} ${meta.label.toLowerCase()}`;
  }
  const ctxt = $('ctxt'); if (ctxt) ctxt.textContent = progress;
  const btxt = $('btxt'); if (btxt) btxt.textContent = progress;
  $('barre').classList.toggle('show', n > 0);
  $('bcren').textContent = crenSel ? '📅 ' + crenSel.lbl : semSel ? 'Choisissez un creneau' : 'Choisissez une semaine et un creneau';
  const complete = isSelComplete();
  const ok = complete && semSel && crenSel;
  const bv = $('bval');
  bv.disabled = !ok;
  if (!complete) {
    const remaining = remainingRequired();
    if (remaining > 0) bv.textContent = `Encore ${remaining} à choisir`;
    else bv.textContent = n === 0 ? 'Choisissez au moins 1 plat' : 'Ajustez votre sélection';
  } else {
    bv.textContent = (semSel && crenSel) ? '✓ Valider ma semaine' : (semSel ? 'Choisissez un creneau' : 'Choisissez une semaine');
  }
  const h1 = document.querySelector('#pApp .banner h1');
  if (h1) h1.textContent = multi ? 'Composez votre formule' : `Choisissez vos ${quotas.plat || total} plats de la semaine`;
}

function voirIngSel(platId) {
  voirIngDetail(platId);
}

function valider() {
  if (!isSelComplete() || !semSel || !crenSel) return;
  // Garde-fou : jamais de commande pour un jour déjà passé (ex. page restée ouverte après minuit).
  const t0 = new Date(); t0.setHours(0, 0, 0, 0);
  if (crenSel.date && new Date(crenSel.date) < t0) {
    alert('Ce créneau est déjà passé. Merci de choisir une autre date.');
    crenSel = null; if (semSel) affCreneaux(semSel); majBarre();
    return;
  }
  afficherRecap();
}

function afficherRecap() {
  const pop = document.createElement('div');
  pop.id = 'recapPop';
  pop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:999;display:flex;align-items:center;justify-content:center;padding:20px';
  const semaine = semSel ? semSel.label : '';
  const creneau = crenSel ? crenSel.lbl : '';
  const instructionsPaiement = assignedSalarie?.instructions_paiement || CURRENT_BRANDING?.instructions_paiement || '';
  const cuisiniereName = CURRENT_BRANDING?.nom_contact || 'votre cuisiniere';

  // Initialise la selection forfait : par defaut le 1er actif (ou le moins cher)
  if (!forfaitSel || !forfaits.find(f => f.id === forfaitSel.id)) {
    forfaitSel = forfaits[0] || null;
  }
  const montantClient = forfaitSel?.prix ?? CURRENT_BRANDING?.montant_client_default ?? 60;
  // Mode SAP : la ligne "A votre charge" affiche le reste apres credit d'impot (~50%)
  const sapCI = !!CURRENT_BRANDING?.credit_impot_sap;
  const aCharge = (prix) => sapCI ? `≈ ${Math.round(Number(prix) / 2)}€` : `${prix}€`;
  const multiRecap = activeTypes().length > 1;
  const selTitle = multiRecap ? '🍽️ Votre sélection' : `🍽️ Vos ${sel.length} plat${sel.length > 1 ? 's' : ''}`;
  const platsHtml = multiRecap
    ? activeTypes().map(t => {
        const items = sel.filter(s => s.type === t.key);
        if (!items.length) return '';
        const rows = items.map(p => `<div style="display:flex;align-items:center;gap:8px;padding:5px 0">
          <span style="width:7px;height:7px;border-radius:50%;background:var(--vert);flex-shrink:0"></span>
          <span style="font-size:14px">${escapeHtml(p.nom)}</span></div>`).join('');
        return `<div style="margin-bottom:10px"><div style="font-size:12px;font-weight:600;color:var(--vert);margin-bottom:2px">${t.emoji} ${t.label}</div>${rows}</div>`;
      }).join('')
    : sel.map((p, i) => `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid #ede7db">
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
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b6b6b;margin-bottom:8px">${selTitle}</div>
        ${platsHtml}
      </div>
      ${forfaitSel ? `<div style="background:#f8f4ee;border-radius:12px;padding:14px 16px;margin-bottom:16px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:#6b6b6b;margin-bottom:6px">📦 Votre formule</div>
        <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap">
          <strong style="font-size:14px">${escapeHtml(forfaitSel.nom)}</strong>
          ${forfaitSel.badge ? `<span style="background:var(--vp);color:var(--vert);font-size:10px;padding:1px 7px;border-radius:8px;text-transform:uppercase;letter-spacing:.3px">${escapeHtml(forfaitSel.badge)}</span>` : ''}
        </div>
        ${forfaitSel.description ? `<div style="font-size:11px;color:#6b6b6b;line-height:1.4;margin-top:2px">${escapeHtml(forfaitSel.description)}</div>` : ''}
      </div>` : ''}
      ${sapCI ? `<div style="background:#f8f4ee;border-radius:12px;padding:11px 16px;margin-bottom:8px;display:flex;justify-content:space-between;align-items:center">
        <span style="font-size:14px;color:#6b6b6b">Prestation</span>
        <span id="recapPrestation" style="font-size:15px;font-weight:600">${montantClient}€</span>
      </div>` : ''}
      <div style="background:var(--vp);border-radius:12px;padding:12px 16px;margin-bottom:16px;display:flex;justify-content:space-between;align-items:center;gap:10px">
        <span style="font-size:15px;font-weight:500">À votre charge${sapCI ? `<span style="display:block;font-size:11px;color:#6b6b6b;font-weight:400">après crédit d'impôt −50%</span>` : ''}</span>
        <span id="recapMontant" style="font-size:20px;font-weight:700;color:var(--vert);white-space:nowrap">${aCharge(montantClient)}</span>
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
}

async function confirmerCommande(pop) {
  const btn = $('recapConfirm');
  btn.disabled = true;
  btn.textContent = 'Enregistrement...';
  btn.style.opacity = '0.6';
  btn.style.cursor = 'not-allowed';
  const instructionsPaiement = assignedSalarie?.instructions_paiement || CURRENT_BRANDING?.instructions_paiement || '';
  try {
    // Anti double-réservation : re-vérifie que le créneau est toujours libre
    // juste avant d'insérer (le rendu de la liste peut dater). On passe par la
    // fonction sécurisée creneaux_pris car la RLS masque les commandes des autres.
    if (crenSel.slotKey) {
      const { data: dejaPris } = await sb.rpc('creneaux_pris', {
        p_entreprise: clientProfile.entreprise_id,
        p_semaine: semSel.id,
        p_salarie: clientProfile?.assigne_a_id || null
      });
      if (dejaPris && dejaPris.some(p => p.slot_key === crenSel.slotKey)) {
        await creneauDejaPris(pop);
        return;
      }
    }
    const payload = {
      client_id: clientProfile.id,
      entreprise_id: clientProfile.entreprise_id,
      semaine_du: semSel.id,
      creneau: crenSel.lbl,
      slot_key: crenSel.slotKey || null,
      statut: 'En attente de paiement',
      plat_1_id: sel[0]?.id || null,
      plat_2_id: sel[1]?.id || null,
      plat_3_id: sel[2]?.id || null,
      plat_4_id: sel[3]?.id || null,
      plat_5_id: sel[4]?.id || null,
      items: sel.map((s, i) => ({ recette_id: s.id, type: s.type || 'plat', ordre: i })),
      nombre_portions: clientProfile?.nombre_portions || 4,
      assigne_a_id: clientProfile?.assigne_a_id || null, // routage auto : la commande part a la cuisiniere attribuee (vide = la tete)
      forfait_id: forfaitSel?.id || null,
      montant: forfaitSel?.prix ?? CURRENT_BRANDING?.montant_client_default ?? 60,
      message_client: $('recapMessage')?.value.trim() || null
    };
    // writeVerified : si la session a expiré, on rafraîchit + réessaie ; si 0 ligne
    // insérée sans erreur, on lève une erreur VISIBLE au lieu d'afficher un faux succès.
    await writeVerified(() => sb.from('commandes').insert(payload).select('id'));

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
    // Conflit de créneau : deux clientes ont validé le même slot quasi en même temps.
    // L'index unique en base (entreprise_id, semaine_du, slot_key) rejette le 2e insert.
    if (e?.code === '23505' || /duplicate key|uniq_commande_slot|créneau/i.test(msg)) {
      await creneauDejaPris(pop);
      return;
    }
    // Si le trigger DB rejette pour limite mensuelle, on affiche un message plus explicite
    if (/limite atteinte/i.test(msg) || /commandes\/mois/i.test(msg)) {
      const cuisiniere = CURRENT_BRANDING?.nom_contact || 'votre cuisiniere';
      showToast(`📦 Plafond mensuel atteint. Votre cuisinière a déjà accepté le maximum de commandes ce mois-ci. Contactez ${cuisiniere} ou réessayez le mois prochain.`, 'err');
    } else {
      showToast('⚠️ ' + msgErr(e), 'err');
    }
  }
}

// Le créneau choisi a été pris entre-temps : ferme le récap et recharge la
// liste des créneaux (le créneau apparaîtra alors en « Indisponible »),
// sans message popup.
async function creneauDejaPris(pop) {
  if (pop) pop.remove();
  crenSel = null;
  if (semSel) await affCreneaux(semSel);
  majBarre();
}

// --- branding dynamique selon le sous-domaine ---
// Renvoie le slug entreprise si on est sur un sous-domaine type
// <slug>.mybatch.cooking ou <slug>.netlify.app, sinon null pour le root.
function getSubdomainSlug() {
  const host = window.location.hostname;
  if (host === 'mybatch.cooking' || host === 'www.mybatch.cooking') return null;
  if (host === 'localhost' || host.startsWith('127.') || host.startsWith('192.168.')) return null;
  let m = host.match(/^([^.]+)\.mybatch\.cooking$/);
  if (m) return (m[1] === 'www' || m[1] === 'app') ? null : m[1];
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
let brandingEntLocked = false; // une entreprise a ete chargee -> ne plus ecraser avec le generique
async function loadBranding(opts = {}) {
  const explicit = !!(opts.id || opts.slug);
  const applyGeneric = () => {
    if (brandingEntLocked) return; // ne jamais ecraser un branding entreprise deja applique
    CURRENT_BRANDING = GENERIC_BRANDING;
    applyBranding(GENERIC_BRANDING);
  };
  try {
    let qs = null;
    if (opts.id) qs = `id=${encodeURIComponent(opts.id)}`;
    else if (opts.slug) qs = `slug=${encodeURIComponent(opts.slug)}`;
    else {
      const slug = getSubdomainSlug();
      if (slug) qs = `slug=${encodeURIComponent(slug)}`;
    }
    if (!qs) { applyGeneric(); return; }
    // Si la cliente est connectée, on passe son token : le serveur ne renvoie les
    // coordonnées de paiement qu'aux membres de l'entreprise (jamais en public).
    const fetchOpts = {};
    try { const { data: sess } = await sb.auth.getSession(); const t = sess?.session?.access_token; if (t) fetchOpts.headers = { Authorization: 'Bearer ' + t }; } catch (_) {}
    const r = await fetch(`/.netlify/functions/branding?${qs}`, fetchOpts);
    if (!r.ok) { applyGeneric(); return; }
    const b = await r.json();
    if (explicit) brandingEntLocked = true;
    else if (brandingEntLocked) return; // course : une entreprise a deja ete chargee
    CURRENT_BRANDING = b;
    applyBranding(b);
  } catch (e) {
    applyGeneric();
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
      if (b.slug) helpNote.innerHTML = `Problème de connexion ? Contactez <strong>${escapeHtml(b.nom_contact)}</strong>`;
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
  // Mot de passe oublie
  $('forgotLink')?.addEventListener('click', (e) => {
    e.preventDefault();
    const box = $('forgotBox');
    const show = box.style.display === 'none';
    box.style.display = show ? 'block' : 'none';
    if (show) { const fe = $('iForgotEmail'); if (fe && !fe.value) fe.value = $('iEmail')?.value || ''; fe?.focus(); }
  });
  $('btnForgot')?.addEventListener('click', async () => {
    const email = ($('iForgotEmail')?.value || '').trim();
    const m = $('forgotMsg');
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { m.style.color = '#c62828'; m.textContent = 'Entrez un email valide.'; return; }
    const btn = $('btnForgot'); btn.disabled = true; btn.textContent = 'Envoi...';
    try {
      await fetch('/.netlify/functions/forgot-password', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email }) });
    } catch (e) {}
    m.style.color = '#2e7d32';
    m.textContent = 'Si un compte existe avec cet email, un lien vient d\'être envoyé. Vérifiez votre boîte (et vos spams).';
    btn.textContent = 'Lien envoyé ✓';
  });
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
    // Redirige les comptes LGDL vers app.legoutdulien.com
    const LGDL_ENTREPRISE_ID = '372c68d3-54a0-4d13-8ce5-8c516ac20d8f';
    if (r.data?.entreprise_id === LGDL_ENTREPRISE_ID) {
      await sb.auth.signOut();
      window.location.href = 'https://app.legoutdulien.com';
      return;
    }
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
    if (r.role === 'salarie') { window.location.href = 'partenaire.html'; return; }
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
