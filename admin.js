// admin.js — Dashboard Admin Le Gout du Lien
// Auth via Supabase + admins_entreprise (multi-tenant). Le service_role est
// recupere via /.netlify/functions/admin-key apres validation de la session.

const SB_PUBLIC_URL = 'https://loiaubdlhkcnohtbwtxg.supabase.co';
const SB_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvaWF1YmRsaGtjbm9odGJ3dHhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMzU1NDAsImV4cCI6MjA5MjcxMTU0MH0.2S2xnnpFT-kcblTzSC_x2ybSUUipUi5jMPe_DbNBUcA';
const sbAuth = window.supabase.createClient(SB_PUBLIC_URL, SB_ANON_KEY);

let SB_URL = '';
let SB_SERVICE_KEY = '';
let sb = null;
let CURRENT_ENTREPRISE_ID = null;
let CURRENT_ADMIN_NOM = '';
let CURRENT_ADMIN_USER_ID = null;
let CURRENT_PLAN = 'standard';
const isFounder = () => CURRENT_PLAN === 'founder';

const PLAN_LIMITS = { recettes: 200, clientes: 30, commandes_mois: 80, photos_mb: 800 };

async function checkPlanLimit(kind, label) {
  if (isFounder()) return true;
  const max = PLAN_LIMITS[kind];
  let q;
  if (kind === 'recettes') q = sb.from('recettes').select('*', { count: 'exact', head: true }).eq('entreprise_id', CURRENT_ENTREPRISE_ID);
  else if (kind === 'clientes') q = sb.from('clients').select('*', { count: 'exact', head: true }).eq('entreprise_id', CURRENT_ENTREPRISE_ID);
  else if (kind === 'commandes_mois') {
    const ym = new Date().toISOString().slice(0, 7);
    q = sb.from('commandes').select('*', { count: 'exact', head: true }).eq('entreprise_id', CURRENT_ENTREPRISE_ID).gte('semaine_du', ym + '-01');
  }
  if (!q) return true;
  const { count, error } = await q;
  if (error) return true;
  if (count >= max) {
    alert(`Limite atteinte : ${count}/${max} ${label}.\n\nTon plan ne permet pas d'ajouter de nouvelle ${label.replace(/s$/, '')}. Contacte support@mybatch.cooking pour passer a un plan superieur.`);
    return false;
  }
  if (count >= max * 0.9) {
    toast(`Tu approches de la limite : ${count}/${max} ${label}.`);
  }
  return true;
}

const STORAGE_BUCKET = 'photos-recettes';

const DATA = { commandes: [], recettes: [], ri: [], clients: [], salaries: [], ingredients: [], creneaux: [], creneauxTemplate: [], entreprises: [], forfaits: [] };
const JOURS_ORDER = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
const JMAP_FULL = { Lundi: 0, Mardi: 1, Mercredi: 2, Jeudi: 3, Vendredi: 4, Samedi: 5, Dimanche: 6 };

function fmtHeure(t) { if (!t) return ''; const [h, m] = t.split(':'); return `${parseInt(h, 10)}h${m}`; }
function fmtSlotLabel(start, end) { return `${fmtHeure(start)} - ${fmtHeure(end)}`; }
function getTemplateSorted() {
  return [...DATA.creneauxTemplate].sort((a, b) => {
    const ja = JOURS_ORDER.indexOf(a.jour), jb = JOURS_ORDER.indexOf(b.jour);
    if (ja !== jb) return ja - jb;
    return (a.ordre || 0) - (b.ordre || 0);
  });
}
function getSlotsForJour(jour) {
  return DATA.creneauxTemplate.filter(t => t.jour === jour).sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
}
let curOffset = 0, crenOffset = 0;
let calYear, calMonth;
let ariaConv = [], ariaSys = '', ariaBusy = false;
let recognition = null, isRec = false;
let ingBuffer = [];
const synth = window.speechSynthesis;

const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
const escapeAttr = escapeHtml;
function toast(msg) {
  const t = $('toast'); t.textContent = msg; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}
function openModal(id) { $(id).classList.add('open'); }
function closeModal(id) { $(id).classList.remove('open'); }

// --- AUTH ---
// Le login se fait sur la page d'accueil (login unifie). admin.html ne fait
// qu'un check de session : si la session correspond a un admin valide on
// charge l'app, sinon on renvoie sur /.
async function loadAdminFromSession() {
  const err = $('lerr');
  if (err) err.style.display = 'none';
  try {
    const { data: { session } } = await sbAuth.auth.getSession();
    if (!session) {
      window.location.href = '/';
      return;
    }
    const r = await fetch('/.netlify/functions/admin-key', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: session.access_token })
    });
    if (!r.ok) {
      // 401 = session morte (signOut), 403 = pas admin (juste rediriger)
      if (r.status === 401) await sbAuth.auth.signOut();
      window.location.href = '/';
      return;
    }
    const cfg = await r.json();
    SB_URL = cfg.url;
    SB_SERVICE_KEY = cfg.key;
    CURRENT_ENTREPRISE_ID = cfg.entreprise_id;
    CURRENT_ADMIN_NOM = cfg.nom || '';
    CURRENT_ADMIN_USER_ID = cfg.user_id || null;
    CURRENT_PLAN = cfg.plan || 'standard';
    document.body.classList.toggle('plan-founder', isFounder());
    document.body.classList.toggle('plan-standard', !isFounder());
    // Branding immediat (titre + nom + couleurs + logo) avant le full load
    if (cfg.nom_marque) {
      document.title = cfg.nom_marque + ' · Admin';
      const sTit = $('splashTitle'); if (sTit) sTit.textContent = cfg.nom_marque;
      const tNom = $('topbarBrandName'); if (tNom) tNom.textContent = cfg.nom_marque;
    }
    if (cfg.couleur_principale) document.documentElement.style.setProperty('--brand-primary', cfg.couleur_principale);
    if (cfg.couleur_secondaire) document.documentElement.style.setProperty('--brand-secondary', cfg.couleur_secondaire);
    if (cfg.logo_url) {
      const sImg = $('splashLogoImg');
      if (sImg) { sImg.src = cfg.logo_url; sImg.style.display = 'block'; }
      const tImg = $('topbarLogoImg');
      const tBox = $('topbarLogoBox');
      if (tImg) { tImg.src = cfg.logo_url; }
      if (tBox) tBox.style.display = 'flex';
    }
    if (cfg.couleur_topbar) document.documentElement.style.setProperty('--topbar-bg', cfg.couleur_topbar);
    sb = window.supabase.createClient(SB_URL, SB_SERVICE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    $('pLogin').style.display = 'none';
    $('pApp').style.display = 'flex';
    chargerTout();
  } catch (e) {
    if (err) { err.textContent = 'Erreur : ' + e.message; err.style.display = 'block'; }
    setTimeout(() => { window.location.href = '/'; }, 2000);
  }
}

async function logout() {
  await sbAuth.auth.signOut();
  window.location.href = '/';
}

// --- DATA LOAD ---
// Helper : applique le filtre entreprise_id si pas founder. Founder voit tout.
function scoped(q) {
  return CURRENT_ENTREPRISE_ID ? q.eq('entreprise_id', CURRENT_ENTREPRISE_ID) : q;
}

async function chargerTout() {
  try {
    const [cmdR, recR, cliR, salR, ingR, crenR, ctR, entR, forfR] = await Promise.all([
      scoped(sb.from('commandes').select('*')).order('semaine_du', { ascending: false }),
      scoped(sb.from('recettes').select('*')).order('nom_du_plat', { ascending: true }),
      scoped(sb.from('clients').select('*')).order('nom', { ascending: true }),
      scoped(sb.from('salaries').select('*')).order('nom', { ascending: true }),
      scoped(sb.from('ingredients').select('*')).order('nom', { ascending: true }),
      scoped(sb.from('creneaux').select('*')),
      scoped(sb.from('creneaux_template').select('*')),
      // Founder voit toutes les entreprises (super-admin) SAUF LGDL (qui est gere via app.legoutdulien.com)
      // Le filtre nom_marque ILIKE exclut "Le Gout du Lien" sans avoir besoin de son UUID
      isFounder()
        ? sb.from('entreprises').select('*').not('nom_marque', 'ilike', '%goût du lien%').order('nom_marque', { ascending: true })
        : sb.from('entreprises').select('*').eq('id', CURRENT_ENTREPRISE_ID),
      scoped(sb.from('forfaits').select('*')).order('ordre', { ascending: true })
    ]);
    if (cmdR.error) throw cmdR.error;
    if (recR.error) throw recR.error;
    if (cliR.error) throw cliR.error;
    if (salR.error) throw salR.error;
    if (ingR.error) throw ingR.error;
    if (crenR.error) throw crenR.error;

    DATA.commandes = cmdR.data || [];
    DATA.recettes = recR.data || [];
    DATA.clients = cliR.data || [];
    DATA.salaries = salR.data || [];
    DATA.ingredients = ingR.data || [];
    DATA.creneaux = crenR.data || [];
    DATA.creneauxTemplate = ctR.data || [];
    DATA.entreprises = entR.data || [];
    DATA.forfaits = (forfR && forfR.data) || [];

    // recettes_ingredients : pas de colonne entreprise_id, on filtre via les recettes chargees
    const recIds = new Set(DATA.recettes.map(r => r.id));
    const riR = DATA.recettes.length
      ? await sb.from('recettes_ingredients').select('*')
          .in('recette_id', [...recIds])
          .order('ordre', { ascending: true })
      : { data: [], error: null };
    if (riR.error) throw riR.error;
    DATA.ri = riR.data || [];

    populateUnitDatalist();
    setupRealtimeNotifs();
    applyEntrepriseBranding();
    $('ariaFab').style.display = 'flex';
    const actifs = DATA.recettes.filter(r => r.active).length;
    $('topStat').textContent = `${DATA.commandes.length} commandes · ${actifs} plats actifs`;
    renderPlanning();
    buildAriaSys();
    $('ariaLoad').style.display = 'none';
    $('ariaChat').style.display = 'flex';
    $('aSend').disabled = false;
    $('ariaSt').textContent = `${actifs} plats · ${DATA.clients.length} clients`;
    addAriaMsg('bot', `**Bonjour !** 🌿\n\nToutes vos donnees sont chargees. Disponible en texte ou a la voix 🎤`);
  } catch (e) {
    $('content').innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-txt">Erreur : ${escapeHtml(e.message || String(e))}</div></div>`;
  }
}

// --- HELPERS ---
function getMonday(off = 0) {
  const d = new Date(), dy = d.getDay();
  const diff = d.getDate() - dy + (dy === 0 ? -6 : 1) + off * 7;
  const m = new Date(d); m.setDate(diff);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(m.getDate()).padStart(2, '0')}`;
}
function getMondayDate(off = 0) {
  const d = new Date(), dy = d.getDay();
  const diff = d.getDate() - dy + (dy === 0 ? -6 : 1) + off * 7;
  const m = new Date(d); m.setDate(diff); return m;
}
function semLabel(off = 0) {
  const mon = getMondayDate(off);
  const fri = new Date(mon); fri.setDate(fri.getDate() + 4);
  const o = { day: 'numeric', month: 'long' };
  return `${mon.toLocaleDateString('fr-FR', o)} – ${fri.toLocaleDateString('fr-FR', o)}`;
}
function getRecette(id) { return DATA.recettes.find(r => r.id === id); }
function getEtat(r) { return (r && r.etat) ? r.etat : (r && r.active ? 'actif' : 'inactif'); }
function getClient(id) { return DATA.clients.find(c => c.id === id); }
function getSalarie(id) { return DATA.salaries.find(s => s.id === id); }
function platsOfCommande(c) {
  return [c.plat_1_id, c.plat_2_id, c.plat_3_id, c.plat_4_id, c.plat_5_id]
    .map(id => id ? getRecette(id) : null)
    .filter(Boolean);
}
function showContent(html) { $('content').innerHTML = html; }
function showTab(tab) {
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  ({
    planning: renderPlanning,
    stats: renderStats,
    recettes: renderRecettes,
    clients: renderClients,
    salaries: renderSalaries,
    creneaux: renderCreneaux,
    parametres: renderParametres,
    entreprises: renderEntreprises
  })[tab]?.();
}

const PRIX_PRESTATION = 120; // CA reel par commande (60€ client + 60€ URSSAF)

const RAYONS_LIST = ['Fruits & Légumes', 'Boucherie', 'Charcuterie', 'Poissonnerie', 'Crémerie', 'Épicerie', 'Épices', 'Boulangerie', 'Produits frais', 'Surgelés', 'Autres'];

function populateUnitDatalist() {
  const dl = $('dlUnites');
  if (!dl) return;
  const units = [...new Set(DATA.ingredients.map(i => i.unite_par_defaut).filter(u => u && u !== 'Unité par défaut'))].sort();
  dl.innerHTML = units.map(u => `<option value="${escapeHtml(u)}">`).join('');
}

let adminRealtimeChannel = null;
function setupRealtimeNotifs() {
  if (adminRealtimeChannel) return;
  adminRealtimeChannel = sb.channel('admin-orders')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'commandes', filter: `entreprise_id=eq.${CURRENT_ENTREPRISE_ID}` }, async (payload) => {
      // Recharge les donnees pour avoir la nouvelle commande dans DATA (scope par entreprise)
      const { data } = await scoped(sb.from('commandes').select('*')).order('semaine_du', { ascending: false });
      if (data) DATA.commandes = data;
      const cli = payload.new && payload.new.client_id ? getClient(payload.new.client_id) : null;
      const nom = cli ? cli.nom : 'un client';
      toast(`🔔 Nouvelle commande de ${nom} !`);
      // Re-render selon onglet courant
      const activeTab = document.querySelector('.tab.active')?.dataset.tab;
      if (activeTab === 'planning') renderPlanning();
      if (activeTab === 'stats') renderStats();
    })
    .subscribe();
}

// Vue active dans l'onglet Planning : 'liste' (hebdo) ou 'mois' (calendrier)
let planningView = 'liste';
function renderPlanning() {
  if (planningView === 'mois') return renderPlanningMois();
  return renderPlanningListe();
}
function planningSwitcher() {
  const sel = (v) => v === planningView ? 'btn-primary' : 'btn-ghost';
  return `<div style="display:flex;gap:6px;margin-bottom:16px;flex-wrap:wrap">
    <button id="vPlanListe" class="btn ${sel('liste')} btn-sm">📋 Liste hebdo</button>
    <button id="vPlanMois" class="btn ${sel('mois')} btn-sm">🗓️ Calendrier mensuel</button>
  </div>`;
}
function bindPlanningSwitcher() {
  $('vPlanListe')?.addEventListener('click', () => { planningView = 'liste'; renderPlanning(); });
  $('vPlanMois')?.addEventListener('click', () => { planningView = 'mois'; renderPlanning(); });
}

// --- PLANNING : VUE LISTE (hebdo) ---
function renderPlanningListe() {
  const semaine = getMonday(curOffset);
  const cmdSem = DATA.commandes.filter(c => (c.semaine_du || '').startsWith(semaine));
  const salOpts = `<option value="">Non assigne</option>` +
    DATA.salaries.map(s => `<option value="${s.id}">${escapeHtml(s.nom || '–')}</option>`).join('');

  const stats = `<div class="stats-row">
    <div class="stat-card"><div class="stat-val">${cmdSem.length}</div><div class="stat-lbl">Commandes</div></div>
    <div class="stat-card"><div class="stat-val">${new Set(cmdSem.map(c => c.client_id).filter(Boolean)).size}</div><div class="stat-lbl">Clients uniques</div></div>
    <div class="stat-card"><div class="stat-val">${cmdSem.filter(c => c.statut === 'Confirmée').length}</div><div class="stat-lbl">Confirmees</div></div>
    <div class="stat-card"><div class="stat-val">${cmdSem.reduce((a, c) => a + (c.nombre_portions || 4), 0)}</div><div class="stat-lbl">Portions totales</div></div>
  </div>`;

  const cmdsHtml = cmdSem.length ? cmdSem.map(c => {
    const cli = getClient(c.client_id) || {};
    const plats = platsOfCommande(c);
    const statut = c.statut || 'En attente de paiement';
    const bc = statut === 'Confirmée' ? 'b-ok' : 'b-en';
    return `<div class="cmd-card">
      <div class="cmd-top">
        <div class="cmd-info">
          <div class="cmd-client">${escapeHtml(cli.nom || '–')} <span class="badge ${bc}">${escapeHtml(statut)}</span>${(() => { const f = DATA.forfaits.find(x => x.id === c.forfait_id); const needs = f?.inclut_courses || cli.courses_par_cuisiniere; return needs ? ' <span class="badge" style="background:#fff3cd;color:#8a6a1a;border:1px solid #f6e0a3">🛒 Courses à faire</span>' : ''; })()}</div>
          <div class="cmd-meta">
            <span class="cmd-meta-item">📅 ${escapeHtml(c.creneau || '–')}</span>
            <span class="cmd-meta-item">🍽️ ${c.nombre_portions || 4} portions</span>
            ${(() => { const f = DATA.forfaits.find(x => x.id === c.forfait_id); return f ? `<span class="cmd-meta-item" style="background:var(--vp);color:var(--v2);padding:2px 8px;border-radius:8px;font-weight:600">📦 ${escapeHtml(f.nom)} · ${f.prix}€</span>` : (c.montant ? `<span class="cmd-meta-item">💶 ${c.montant}€</span>` : ''); })()}
            ${cli.adresse ? `<a class="cmd-meta-item" href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cli.adresse)}" target="_blank" rel="noopener" style="color:inherit;text-decoration:none;border-bottom:1px dashed var(--bgd)">📍 ${escapeHtml(cli.adresse)}</a>` : ''}
            ${cli.telephone ? `<a class="cmd-meta-item" href="tel:${escapeAttr(cli.telephone.replace(/\s/g, ''))}" style="color:inherit;text-decoration:none;border-bottom:1px dashed var(--bgd)">📞 ${escapeHtml(cli.telephone)}</a>` : ''}
          </div>
        </div>
        <div class="cmd-actions">
          <button class="btn btn-ghost btn-sm" data-act="see-courses" data-id="${c.id}" title="Liste de courses">🛒</button>
          <button class="btn btn-ghost btn-sm" data-act="edit-cmd" data-id="${c.id}">✏️ Modifier</button>
          <button class="btn btn-danger btn-sm" data-act="del-cmd" data-id="${c.id}">🗑️</button>
        </div>
      </div>
      <div class="cmd-plats">${plats.map(p => `<span class="plat-chip" data-act="see-ing" data-id="${p.id}" data-portions="${c.nombre_portions || 4}">${escapeHtml(p.nom_du_plat)}</span>`).join('') || '<span style="font-size:12px;color:var(--txl)">Aucun plat selectionne</span>'}</div>
      ${c.message_client ? `<div style="background:#fff3cd;border-left:3px solid #f6c343;border-radius:8px;padding:10px 12px;margin-top:10px;font-size:12px;color:#6b5818"><strong style="color:#8a6a1a">💬 Message de ${escapeHtml(cli.nom || 'la cliente')} :</strong><div style="margin-top:4px;white-space:pre-wrap">${escapeHtml(c.message_client)}</div></div>` : ''}
      <div class="cmd-footer">
        <span style="font-size:12px;color:var(--txl)">Assigne a :</span>
        <select class="assign-sel" data-act="assign" data-id="${c.id}">${salOpts}</select>
      </div>
    </div>`;
  }).join('') : `<div class="empty"><div class="empty-icon">📭</div><div class="empty-txt">Aucune commande cette semaine</div></div>`;

  showContent(`<div class="card">
    ${planningSwitcher()}
    <div class="card-head">
      <div class="card-tit">📅 Planning <span>${cmdSem.length} commande(s)</span></div>
    </div>
    <div class="snav">
      <button class="snav-btn" id="prevSem">◀</button>
      <div class="snav-label">${semLabel(curOffset)}</div>
      <button class="snav-btn" id="nextSem">▶</button>
      ${curOffset !== 0 ? `<button class="snav-today" id="todaySem">Aujourd'hui</button>` : ''}
    </div>
    ${stats}
    <div class="cmd-grid">${cmdsHtml}</div>
  </div>`);

  cmdSem.forEach(c => {
    const sel = $('content').querySelector(`select[data-id="${c.id}"]`);
    if (sel && c.assigne_a_id) sel.value = c.assigne_a_id;
  });

  bindPlanningSwitcher();
  $('prevSem')?.addEventListener('click', () => { curOffset--; renderPlanning(); });
  $('nextSem')?.addEventListener('click', () => { curOffset++; renderPlanning(); });
  $('todaySem')?.addEventListener('click', () => { curOffset = 0; renderPlanning(); });

  $('content').querySelectorAll('[data-act="edit-cmd"]').forEach(b => b.addEventListener('click', () => editerCommande(b.dataset.id)));
  $('content').querySelectorAll('[data-act="del-cmd"]').forEach(b => b.addEventListener('click', () => supprimerCommande(b.dataset.id)));
  $('content').querySelectorAll('[data-act="see-ing"]').forEach(b => b.addEventListener('click', () => voirIngredients(b.dataset.id, parseInt(b.dataset.portions, 10) || 4)));
  $('content').querySelectorAll('[data-act="assign"]').forEach(s => s.addEventListener('change', (e) => assignerSalarie(s.dataset.id, e.target.value)));
  $('content').querySelectorAll('[data-act="see-courses"]').forEach(b => b.addEventListener('click', () => voirCoursesCommande(b.dataset.id)));
}

// === LISTE DE COURSES PAR COMMANDE (admin) ===
function fmtN(n) { return n % 1 === 0 ? n : parseFloat(n.toFixed(2)); }

function buildCoursesAdmin(platIds, portions) {
  const p = portions || 4;
  const rayons = {};
  platIds.forEach(pid => {
    const ris = DATA.ri.filter(ri => ri.recette_id === pid);
    ris.forEach(ri => {
      const ing = DATA.ingredients.find(i => i.id === ri.ingredient_id);
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

function voirCoursesCommande(cmdId) {
  const cmd = DATA.commandes.find(c => c.id === cmdId);
  if (!cmd) return;
  const cli = getClient(cmd.client_id) || {};
  const platIds = [cmd.plat_1_id, cmd.plat_2_id, cmd.plat_3_id, cmd.plat_4_id, cmd.plat_5_id].filter(Boolean);
  const portions = cmd.nombre_portions || 4;
  const sorted = buildCoursesAdmin(platIds, portions);
  const semLabel = cmd.semaine_du ? new Date(cmd.semaine_du + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';
  const storageKey = `admin-courses-${cmdId}`;
  const checkedSet = new Set(JSON.parse(localStorage.getItem(storageKey) || '[]'));

  const pop = document.createElement('div');
  pop.id = 'popCourses';
  pop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:999;display:flex;align-items:center;justify-content:center;padding:20px';
  pop.innerHTML = `<div style="background:var(--wh);border-radius:18px;max-width:560px;width:100%;max-height:90vh;display:flex;flex-direction:column;overflow:hidden">
    <div style="padding:20px 24px;border-bottom:1px solid var(--bgd);display:flex;align-items:center;justify-content:space-between;gap:14px">
      <div>
        <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:var(--v2)">🛒 Liste de courses</div>
        <div style="font-size:12px;color:var(--txl);margin-top:2px">${escapeHtml(cli.nom || '')} · semaine du ${semLabel} · ${portions} portions</div>
      </div>
      <button class="btn btn-ghost btn-sm" id="popCoursesClose">✕</button>
    </div>
    <div style="flex:1;overflow-y:auto;padding:16px 22px" id="popCoursesBody">
      ${!sorted.length ? '<p style="color:var(--txl);padding:18px;text-align:center">Aucun ingredient trouve.</p>' : sorted.map(([ray, ings]) => `
        <div style="background:var(--bgc);border-radius:12px;padding:12px 14px;margin-bottom:10px">
          <div style="font-weight:600;font-size:13px;color:var(--v2);margin-bottom:8px">${escapeHtml(ray)}</div>
          ${Object.entries(ings).map(([nom, d]) => {
            const key = ray + '::' + nom;
            const checked = checkedSet.has(key);
            return `<label style="display:flex;align-items:center;gap:10px;padding:5px 0;font-size:13px;cursor:pointer;${checked ? 'opacity:.5;text-decoration:line-through' : ''}" data-key="${escapeAttr(key)}">
              <input type="checkbox" ${checked ? 'checked' : ''} style="width:16px;height:16px;cursor:pointer;flex-shrink:0">
              <span style="flex:1">${escapeHtml(nom)}</span>
              <span style="color:var(--v2);font-weight:600;font-size:12px;white-space:nowrap">${fmtN(d.qte)} ${escapeHtml(d.u)}</span>
            </label>`;
          }).join('')}
        </div>`).join('')}
    </div>
    <div style="padding:14px 22px;border-top:1px solid var(--bgd);display:flex;gap:10px;justify-content:flex-end">
      <button class="btn btn-ghost" id="popCoursesReset">Décocher tout</button>
      <button class="btn btn-pri" id="popCoursesPrint">🖨️ Imprimer</button>
    </div>
  </div>`;
  document.body.appendChild(pop);

  $('popCoursesClose').addEventListener('click', () => pop.remove());
  pop.addEventListener('click', (e) => { if (e.target === pop) pop.remove(); });

  $('popCoursesBody').querySelectorAll('label[data-key]').forEach(lab => {
    const cb = lab.querySelector('input');
    cb.addEventListener('change', () => {
      const k = lab.dataset.key;
      if (cb.checked) checkedSet.add(k); else checkedSet.delete(k);
      localStorage.setItem(storageKey, JSON.stringify([...checkedSet]));
      lab.style.opacity = cb.checked ? '.5' : '1';
      lab.style.textDecoration = cb.checked ? 'line-through' : 'none';
    });
  });

  $('popCoursesReset').addEventListener('click', () => {
    checkedSet.clear();
    localStorage.removeItem(storageKey);
    pop.remove();
    voirCoursesCommande(cmdId);
  });

  $('popCoursesPrint').addEventListener('click', () => imprimerCoursesAdmin(cmd, sorted, portions));
}

function imprimerCoursesAdmin(cmd, sorted, portions) {
  const cli = getClient(cmd.client_id) || {};
  const ent = getCurrentEntreprise();
  const brandColor = ent.couleur_principale || '#3d6b4f';
  const brandName = ent.nom_marque || 'Mon espace Batchcooking';
  const semLabel = cmd.semaine_du ? new Date(cmd.semaine_du + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) : '';

  const win = window.open('', '_blank');
  win.document.write(`<!DOCTYPE html><html><head>
    <meta charset="UTF-8">
    <title>Liste de courses - ${escapeHtml(cli.nom || '')} - ${brandName}</title>
    <style>
      *{box-sizing:border-box}
      body{font-family:'Helvetica Neue',Arial,sans-serif;max-width:520px;margin:24px auto;padding:0 20px;color:#222;font-size:12px;line-height:1.4}
      h1{font-size:17px;margin:0 0 2px;color:${brandColor};font-weight:700}
      .sub{font-size:10px;color:#777;margin-bottom:14px;text-transform:uppercase;letter-spacing:.5px}
      .r{margin-bottom:10px;break-inside:avoid;page-break-inside:avoid}
      .r h2{font-size:12px;font-weight:600;border-bottom:1.5px solid #ddd;padding-bottom:2px;margin:0 0 4px;color:#333}
      .i{display:flex;align-items:center;gap:7px;padding:2px 0;font-size:11px;line-height:1.3}
      .i .ck{display:inline-block;width:10px;height:10px;border:1px solid #555;border-radius:2px;flex-shrink:0}
      .i .nm{flex:1}
      .i .qt{color:${brandColor};font-weight:600;font-size:10px;white-space:nowrap}
      .foot{margin-top:18px;font-size:9px;color:#bbb;text-align:center;border-top:1px solid #eee;padding-top:8px}
      @page{margin:10mm}
      @media print{body{margin:0;max-width:100%;padding:0 10mm}}
    </style>
  </head><body>
    <h1>Liste de courses · ${escapeHtml(cli.nom || '')}</h1>
    <div class="sub">Semaine du ${semLabel} · ${portions} portions</div>
    ${sorted.map(([ray, ings]) => `<div class="r">
      <h2>${escapeHtml(ray)}</h2>
      ${Object.entries(ings).map(([nom, d]) => `<div class="i"><span class="ck"></span><span class="nm">${escapeHtml(nom)}</span><span class="qt">${fmtN(d.qte)} ${escapeHtml(d.u)}</span></div>`).join('')}
    </div>`).join('')}
    <div class="foot">Imprime depuis ${escapeHtml(brandName)}</div>
    <script>setTimeout(()=>window.print(),300)<\/script>
  </body></html>`);
  win.document.close();
}

async function supprimerCommande(id) {
  if (!confirm('Supprimer cette commande ?')) return;
  const { error } = await sb.from('commandes').delete().eq('id', id);
  if (error) { toast('Erreur: ' + error.message); return; }
  DATA.commandes = DATA.commandes.filter(c => c.id !== id);
  toast('🗑️ Commande supprimee'); renderPlanning();
}

async function assignerSalarie(cmdId, salId) {
  const cmd = DATA.commandes.find(x => x.id === cmdId);
  const oldSalId = cmd?.assigne_a_id;
  const payload = { assigne_a_id: salId || null };
  const { error } = await sb.from('commandes').update(payload).eq('id', cmdId);
  if (error) { toast('Erreur: ' + error.message); return; }
  if (cmd) cmd.assigne_a_id = salId || null;
  // Notif partenaire si nouvelle assignation
  if (salId && salId !== oldSalId) {
    const cli = cmd ? getClient(cmd.client_id) : null;
    try {
      await sb.from('notifications').insert({
        recipient_id: salId,
        title: '🔔 Nouvelle mission assignée',
        body: `${cli ? cli.nom : 'Une cliente'} · ${cmd?.creneau || ''}`
      });
    } catch (e) { /* silent */ }
  }
  toast('✅ Assignation enregistree');
}

// --- MODIFIER COMMANDE ---
function editerCommande(id) {
  const cmd = DATA.commandes.find(c => c.id === id); if (!cmd) return;
  $('cmdId').value = id;
  const cli = getClient(cmd.client_id);
  $('modalCmdTit').textContent = 'Modifier · ' + (cli ? cli.nom : 'Commande');

  const cliSel = $('cmdClient');
  cliSel.innerHTML = DATA.clients.map(c => `<option value="${c.id}">${escapeHtml(c.nom)}</option>`).join('');
  cliSel.value = cmd.client_id || '';

  $('cmdSemaine').value = cmd.semaine_du || getMonday(0);
  $('cmdSemaine').onchange = () => majSelectCreneau();
  majSelectCreneau(cmd.creneau || '');

  const salSel = $('cmdSalarie');
  salSel.innerHTML = `<option value="">Non assigne</option>` +
    DATA.salaries.map(s => `<option value="${s.id}">${escapeHtml(s.nom)}</option>`).join('');
  salSel.value = cmd.assigne_a_id || '';

  $('cmdPortions').value = cmd.nombre_portions || 4;
  $('cmdStatut').value = cmd.statut || 'En attente de paiement';

  const selPlatIds = [cmd.plat_1_id, cmd.plat_2_id, cmd.plat_3_id, cmd.plat_4_id, cmd.plat_5_id].filter(Boolean);
  const platsActifs = DATA.recettes.filter(r => getEtat(r) === 'actif');
  $('platSelectGrid').innerHTML = platsActifs.map(r => {
    const sel = selPlatIds.includes(r.id) ? ' sel' : '';
    return `<div class="plat-opt${sel}" data-id="${r.id}">${escapeHtml(r.nom_du_plat)}</div>`;
  }).join('');
  $('platSelectGrid').querySelectorAll('.plat-opt').forEach(el => {
    el.addEventListener('click', () => {
      if (el.classList.contains('sel')) { el.classList.remove('sel'); }
      else {
        if ($('platSelectGrid').querySelectorAll('.plat-opt.sel').length >= 5) {
          toast('⚠️ Maximum 5 plats'); return;
        }
        el.classList.add('sel');
      }
    });
  });
  openModal('modalCommande');
}

function majSelectCreneau(valActuelle = '') {
  const semaine = $('cmdSemaine').value;
  const sel = $('cmdCreneau');
  sel.innerHTML = '';
  if (!semaine) return;
  const [y, mo, d] = semaine.split('-').map(Number);
  const jours = JOURS_ORDER.filter(j => DATA.creneauxTemplate.some(t => t.jour === j));
  jours.forEach(j => {
    const jd = new Date(y, mo - 1, d + JMAP_FULL[j]);
    const jl = jd.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    getSlotsForJour(j).forEach(slot => {
      const h = fmtSlotLabel(slot.heure_debut, slot.heure_fin);
      const lbl = `${jl} · ${h}`;
      const opt = document.createElement('option');
      opt.value = lbl;
      opt.dataset.slotKey = `${j}_${slot.nom_slot}`;
      opt.textContent = lbl + (crActif(semaine, `${j}_${slot.nom_slot}`) ? '' : ' (ferme)');
      sel.appendChild(opt);
    });
  });
  if (valActuelle) sel.value = valActuelle;
}

async function saveCommande() {
  const id = $('cmdId').value; if (!id) return;
  const oldCmd = DATA.commandes.find(x => x.id === id);
  const oldStatut = oldCmd?.statut;
  const oldSalId = oldCmd?.assigne_a_id;
  const selIds = [...$('platSelectGrid').querySelectorAll('.plat-opt.sel')].map(e => e.dataset.id);
  const payload = {
    client_id: $('cmdClient').value || null,
    semaine_du: $('cmdSemaine').value || getMonday(0),
    creneau: $('cmdCreneau').value,
    assigne_a_id: $('cmdSalarie').value || null,
    nombre_portions: parseInt($('cmdPortions').value, 10) || 4,
    statut: $('cmdStatut').value,
    plat_1_id: selIds[0] || null,
    plat_2_id: selIds[1] || null,
    plat_3_id: selIds[2] || null,
    plat_4_id: selIds[3] || null,
    plat_5_id: selIds[4] || null
  };
  const { error } = await sb.from('commandes').update(payload).eq('id', id);
  if (error) { toast('Erreur: ' + error.message); return; }
  if (oldCmd) Object.assign(oldCmd, payload);

  // Notif client si confirmation
  if (oldStatut !== 'Confirmée' && payload.statut === 'Confirmée' && payload.client_id) {
    try {
      const dt = payload.semaine_du ? new Date(payload.semaine_du + 'T00:00:00').toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' }) : '';
      await sb.from('notifications').insert({
        recipient_id: payload.client_id,
        title: 'Commande confirmée 🎉',
        body: `Votre commande de la semaine du ${dt} est validée par ${getCurrentEntreprise().nom_contact || 'votre cuisinière'}.`
      });
    } catch (e) { /* silent */ }
  }
  // Notif partenaire si nouvelle assignation
  if (payload.assigne_a_id && payload.assigne_a_id !== oldSalId) {
    const cli = getClient(payload.client_id);
    try {
      await sb.from('notifications').insert({
        recipient_id: payload.assigne_a_id,
        title: '🔔 Nouvelle mission assignée',
        body: `${cli ? cli.nom : 'Une cliente'} · ${payload.creneau || ''}`
      });
    } catch (e) { /* silent */ }
  }
  toast('✅ Commande modifiee'); closeModal('modalCommande'); renderPlanning();
}

// --- VOIR INGREDIENTS ---
function voirIngredients(recetteId, portions) {
  const rec = getRecette(recetteId); if (!rec) return;
  const ings = DATA.ri.filter(r => r.recette_id === recetteId).sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  const ingsHtml = ings.length ? `<div style="display:flex;flex-direction:column;gap:0">${ings.map(ri => {
    const ing = DATA.ingredients.find(i => i.id === ri.ingredient_id);
    if (!ing) return '';
    const u = ing.unite_par_defaut && ing.unite_par_defaut !== 'Unité par défaut' ? ing.unite_par_defaut : '';
    const q = (ri.quantite_par_portion || 0) * portions;
    const total = Math.round(q * 10) / 10;
    return `<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px solid var(--bgd);font-size:13px;align-items:center">
      <span style="color:var(--tx)">${escapeHtml(ing.nom)}</span>
      <span style="font-weight:600;color:var(--v2);font-size:14px">${total} <span style="font-size:11px;font-weight:400;color:var(--txl)">${escapeHtml(u)}</span></span>
    </div>`;
  }).join('')}</div>` : `<p style="color:var(--txl);font-size:13px;padding:12px 0">Aucun ingredient renseigne pour ce plat.</p>`;

  $('modalIngTit').textContent = rec.nom_du_plat;
  $('modalIngBody').innerHTML = `
    ${rec.photo_url ? `<img src="${escapeHtml(rec.photo_url)}" style="width:100%;height:180px;object-fit:cover;border-radius:12px;margin-bottom:16px">` : ''}
    <p style="font-size:12px;color:var(--txl);margin-bottom:14px">Quantites pour <strong>${portions} portions</strong></p>
    ${rec.instructions_preparation ? `<div style="background:#fff8e7;border-left:3px solid #f9c74f;border-radius:12px;padding:14px 16px;margin-bottom:16px">
      <div style="font-size:10px;text-transform:uppercase;letter-spacing:.6px;color:#8a7a3a;font-weight:600;margin-bottom:6px">👩‍🍳 Preparation</div>
      <div style="font-size:13px;line-height:1.6;color:var(--tx)">${escapeHtml(rec.instructions_preparation)}</div></div>` : ''}
    ${ingsHtml}
    ${rec.instructions_rechauffage ? `<div style="margin-top:14px;padding:12px 14px;background:var(--vp);border-radius:10px;font-size:13px"><strong style="color:var(--v2)">🔥 Rechauffage :</strong> ${escapeHtml(rec.instructions_rechauffage)}</div>` : ''}
    ${rec.frigo_en_jours ? `<div style="margin-top:8px;font-size:12px;color:var(--txl)">❄️ Conservation : ${rec.frigo_en_jours} jours au refrigerateur</div>` : ''}
    ${rec.congelation ? `<div style="margin-top:4px;font-size:12px;color:var(--txl)">🧊 Congelation : ${escapeHtml(rec.congelation)}</div>` : ''}`;
  openModal('modalIng');
}

// --- PLANNING : VUE MOIS (calendrier) ---
function renderPlanningMois() {
  const now = new Date();
  if (calYear === undefined) { calYear = now.getFullYear(); calMonth = now.getMonth(); }
  const y = calYear, m = calMonth;
  const first = new Date(y, m, 1), last = new Date(y, m + 1, 0);
  const startDay = (first.getDay() + 6) % 7;
  const todayStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  const moisNoms = ['Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin', 'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre'];
  const jours = ['Lun', 'Mar', 'Mer', 'Jeu', 'Ven', 'Sam', 'Dim'];
  let cells = [];
  for (let i = 0; i < startDay; i++) {
    cells.push({ date: new Date(y, m, 1 - startDay + i), otherMonth: true });
  }
  for (let d = 1; d <= last.getDate(); d++) cells.push({ date: new Date(y, m, d), otherMonth: false });
  while (cells.length < 42) {
    cells.push({ date: new Date(y, m + 1, cells.length - startDay - last.getDate() + 1), otherMonth: true });
  }
  function getCmdsForDate(dateObj) {
    const dowFr = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'][dateObj.getDay()];
    const dy = dateObj.getDay();
    const mond = new Date(dateObj); mond.setDate(dateObj.getDate() - ((dy + 6) % 7));
    const mondayStr = `${mond.getFullYear()}-${String(mond.getMonth() + 1).padStart(2, '0')}-${String(mond.getDate()).padStart(2, '0')}`;
    return DATA.commandes.filter(c => {
      return (c.semaine_du || '').startsWith(mondayStr) && (c.creneau || '').toLowerCase().includes(dowFr.toLowerCase());
    });
  }
  const grid = cells.map(({ date, otherMonth }) => {
    const iso = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
    const cmds = getCmdsForDate(date);
    const isToday = iso === todayStr;
    return `<div class="cal-day${cmds.length ? ' has-cmd' : ''}${isToday ? ' today' : ''}${otherMonth ? ' other-month' : ''}" data-iso="${iso}" data-dow="${date.getDay()}">
      <div class="cal-num">${date.getDate()}</div>
      ${cmds.slice(0, 3).map(c => {
        const cli = getClient(c.client_id);
        return `<div class="cal-evt">${escapeHtml((cli && cli.nom) || '–')}</div>`;
      }).join('')}
      ${cmds.length > 3 ? `<div style="font-size:9px;color:var(--txl);text-align:right">+${cmds.length - 3}</div>` : ''}
    </div>`;
  }).join('');
  showContent(`<div class="card">
    ${planningSwitcher()}
    <div class="card-head">
      <div class="card-tit">🗓️ ${moisNoms[m]} ${y}</div>
      <div style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-sm" id="prevMois">◀ Mois prec.</button>
        <button class="btn btn-ghost btn-sm" id="todayMois">Aujourd'hui</button>
        <button class="btn btn-ghost btn-sm" id="nextMois">Mois suiv. ▶</button>
      </div>
    </div>
    <div class="cal-wrap">
      <div class="cal-head">${jours.map(j => `<div class="cal-dh">${j}</div>`).join('')}</div>
      <div class="cal-grid">${grid}</div>
    </div>
  </div>`);
  bindPlanningSwitcher();
  $('prevMois').addEventListener('click', () => { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderPlanningMois(); });
  $('nextMois').addEventListener('click', () => { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderPlanningMois(); });
  $('todayMois').addEventListener('click', () => { const n = new Date(); calYear = n.getFullYear(); calMonth = n.getMonth(); renderPlanningMois(); });
  $('content').querySelectorAll('.cal-day.has-cmd').forEach(d => d.addEventListener('click', () => voirJourCal(d.dataset.iso, parseInt(d.dataset.dow, 10))));
}

function voirJourCal(iso, dow) {
  const dowFr = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'][dow];
  const dateObj = new Date(iso);
  const dy = dateObj.getDay();
  const mond = new Date(dateObj); mond.setDate(dateObj.getDate() - ((dy + 6) % 7));
  const mondayStr = `${mond.getFullYear()}-${String(mond.getMonth() + 1).padStart(2, '0')}-${String(mond.getDate()).padStart(2, '0')}`;
  const cmds = DATA.commandes.filter(c => (c.semaine_du || '').startsWith(mondayStr) && (c.creneau || '').toLowerCase().includes(dowFr.toLowerCase()));
  const dateLabel = dateObj.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
  $('modalCalTit').textContent = dateLabel.charAt(0).toUpperCase() + dateLabel.slice(1);
  $('modalCalBody').innerHTML = cmds.length ? cmds.map(c => {
    const cli = getClient(c.client_id);
    const sal = getSalarie(c.assigne_a_id);
    const plats = platsOfCommande(c);
    return `<div style="background:var(--bgc);border-radius:12px;padding:14px;margin-bottom:10px;border:1.5px solid var(--bgd)">
      <div style="font-weight:600;margin-bottom:4px">${escapeHtml((cli && cli.nom) || '–')}${(() => { const f = DATA.forfaits.find(x => x.id === c.forfait_id); const needs = f?.inclut_courses || (cli && cli.courses_par_cuisiniere); return needs ? ' <span style="background:#fff3cd;color:#8a6a1a;border:1px solid #f6e0a3;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:500">🛒 Courses</span>' : ''; })()}</div>
      <div style="font-size:12px;color:var(--txl);margin-bottom:8px">📅 ${escapeHtml(c.creneau || '–')} · ${c.nombre_portions || 4} portions · ${escapeHtml(c.statut || 'En attente')}${(() => { const f = DATA.forfaits.find(x => x.id === c.forfait_id); return f ? ` · 📦 ${escapeHtml(f.nom)} (${f.prix}€)` : (c.montant ? ` · 💶 ${c.montant}€` : ''); })()}</div>
      <div style="display:flex;flex-wrap:wrap;gap:5px">${plats.map(p => `<span class="plat-chip">${escapeHtml(p.nom_du_plat)}</span>`).join('')}</div>
      ${sal ? `<div style="font-size:12px;color:var(--txl);margin-top:8px">👷 ${escapeHtml(sal.nom)}</div>` : ''}
    </div>`;
  }).join('') : `<p style="color:var(--txl);text-align:center;padding:20px">Aucune commande ce jour</p>`;
  openModal('modalCalJour');
}

// --- STATS / DASHBOARD ---
function renderStats() {
  const now = new Date();
  const thisMonthIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const prevMonthDate = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const prevMonthIso = `${prevMonthDate.getFullYear()}-${String(prevMonthDate.getMonth() + 1).padStart(2, '0')}`;
  const thisMon = getMonday(0);
  const nextMon = getMonday(1);

  const inMonth = (cmd, ym) => (cmd.semaine_du || '').startsWith(ym);
  const isConfirme = (cmd) => cmd.statut === 'Confirmée';
  const isAttente = (cmd) => cmd.statut === 'En attente de paiement';

  // KPIs
  const cmdConfMois = DATA.commandes.filter(c => inMonth(c, thisMonthIso) && isConfirme(c));
  const cmdConfPrev = DATA.commandes.filter(c => inMonth(c, prevMonthIso) && isConfirme(c));
  const sumMontant = (cmds) => cmds.reduce((sum, c) => sum + Number(c.montant ?? PRIX_PRESTATION), 0);
  const caMois = sumMontant(cmdConfMois);
  const caPrev = sumMontant(cmdConfPrev);
  let deltaPct = 0, deltaSym = '→';
  if (caPrev > 0) {
    deltaPct = Math.round((caMois - caPrev) / caPrev * 100);
    deltaSym = deltaPct > 0 ? '↗' : deltaPct < 0 ? '↘' : '→';
  } else if (caMois > 0) {
    deltaPct = 100; deltaSym = '↗';
  }
  const deltaColor = deltaPct > 0 ? '#2e7d32' : deltaPct < 0 ? '#c62828' : 'var(--txl)';

  const cmdMois = DATA.commandes.filter(c => inMonth(c, thisMonthIso));
  const cmdAFacturer = DATA.commandes.filter(isAttente);
  const cmdSemaine = DATA.commandes.filter(c => (c.semaine_du || '').startsWith(thisMon));
  const cmdSemaineProchaine = DATA.commandes.filter(c => (c.semaine_du || '').startsWith(nextMon));
  const portionsSemaine = cmdSemaine.reduce((a, c) => a + (c.nombre_portions || 4) * 5, 0);
  const portionsSemaineProchaine = cmdSemaineProchaine.reduce((a, c) => a + (c.nombre_portions || 4) * 5, 0);

  // Top 5 plats
  const platCount = {};
  DATA.commandes.forEach(c => {
    [c.plat_1_id, c.plat_2_id, c.plat_3_id, c.plat_4_id, c.plat_5_id].forEach(id => {
      if (!id) return;
      platCount[id] = (platCount[id] || 0) + 1;
    });
  });
  const topPlats = Object.entries(platCount).sort((a, b) => b[1] - a[1]).slice(0, 5)
    .map(([id, n]) => ({ rec: getRecette(id), n }))
    .filter(x => x.rec);

  // Top 3 clientes (toutes commandes confondues) — count + ca
  const clientStats = {};
  DATA.commandes.forEach(c => {
    if (!c.client_id) return;
    if (!clientStats[c.client_id]) clientStats[c.client_id] = { n: 0, ca: 0 };
    clientStats[c.client_id].n += 1;
    clientStats[c.client_id].ca += Number(c.montant ?? PRIX_PRESTATION);
  });
  const topClients = Object.entries(clientStats).sort((a, b) => b[1].n - a[1].n).slice(0, 3)
    .map(([id, s]) => ({ cli: getClient(id), n: s.n, ca: s.ca }))
    .filter(x => x.cli);

  // Mini bar chart CA 6 derniers mois
  const monthsBars = [];
  for (let i = 5; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const ym = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
    const ca = sumMontant(DATA.commandes.filter(c => inMonth(c, ym) && isConfirme(c)));
    monthsBars.push({ label: d.toLocaleDateString('fr-FR', { month: 'short' }), ca });
  }
  const maxCa = Math.max(1, ...monthsBars.map(m => m.ca));

  showContent(`<div class="card">
    <div class="card-head">
      <div class="card-tit">📊 Tableau de bord</div>
    </div>

    <div class="stats-row" style="margin-bottom:18px">
      <div class="stat-card">
        <div class="stat-val">${caMois}€</div>
        <div class="stat-lbl">CA ${now.toLocaleDateString('fr-FR', { month: 'long' })}</div>
        <div style="margin-top:4px;font-size:12px;color:${deltaColor};font-weight:500">${deltaSym} ${deltaPct >= 0 ? '+' : ''}${deltaPct}% vs mois precedent</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${cmdMois.length}</div>
        <div class="stat-lbl">Commandes ce mois</div>
        <div style="margin-top:4px;font-size:12px;color:var(--txl)">${cmdConfMois.length} confirmee${cmdConfMois.length > 1 ? 's' : ''}</div>
      </div>
      <div class="stat-card">
        <div class="stat-val" style="color:${cmdAFacturer.length > 0 ? 'var(--or)' : 'var(--v2)'}">${cmdAFacturer.length}</div>
        <div class="stat-lbl">A facturer</div>
        <div style="margin-top:4px;font-size:12px;color:var(--txl)">${sumMontant(cmdAFacturer)}€ en attente</div>
      </div>
      <div class="stat-card">
        <div class="stat-val">${cmdSemaine.length}</div>
        <div class="stat-lbl">Commandes cette semaine</div>
        <div style="margin-top:4px;font-size:12px;color:var(--txl)">${portionsSemaine} portions a preparer</div>
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-bottom:18px">
      <div style="background:var(--bgc);border-radius:14px;padding:18px">
        <div style="font-family:'Cormorant Garamond',serif;font-size:17px;font-weight:600;color:var(--v2);margin-bottom:14px">🏆 Top 5 plats commandes</div>
        ${topPlats.length ? topPlats.map((p, i) => `
          <div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-bottom:1px solid var(--bgd);font-size:13px">
            <span style="background:var(--vp);color:var(--v2);width:22px;height:22px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:600;flex-shrink:0">${i + 1}</span>
            <span style="flex:1">${escapeHtml(p.rec.nom_du_plat)}</span>
            <span style="background:var(--vp);color:var(--v2);padding:2px 9px;border-radius:12px;font-size:11px;font-weight:600">${p.n}x</span>
          </div>`).join('') : '<p style="color:var(--txl);font-size:12px">Aucune commande pour l instant</p>'}
      </div>
      <div style="background:var(--bgc);border-radius:14px;padding:18px">
        <div style="font-family:'Cormorant Garamond',serif;font-size:17px;font-weight:600;color:var(--v2);margin-bottom:14px">⭐ Top 3 clientes fideles</div>
        ${topClients.length ? topClients.map((c, i) => `
          <div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid var(--bgd);font-size:13px">
            <span style="background:linear-gradient(135deg,var(--v2),var(--v3));color:#fff;width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:600;flex-shrink:0">${i + 1}</span>
            <div style="flex:1">
              <div style="font-weight:600">${escapeHtml(c.cli.nom)}</div>
              <div style="font-size:11px;color:var(--txl)">${c.n} commande${c.n > 1 ? 's' : ''} · ${c.ca}€ CA</div>
            </div>
          </div>`).join('') : '<p style="color:var(--txl);font-size:12px">Aucune cliente fidele pour l instant</p>'}
      </div>
    </div>

    <div id="stats-six-month" style="background:var(--bgc);border-radius:14px;padding:18px;margin-bottom:18px">
      <div style="font-family:'Cormorant Garamond',serif;font-size:17px;font-weight:600;color:var(--v2);margin-bottom:14px">📈 Evolution CA - 6 derniers mois</div>
      <div style="display:flex;align-items:flex-end;gap:8px;height:140px">
        ${monthsBars.map(m => {
          const h = Math.round(m.ca / maxCa * 100);
          return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
            <div style="font-size:10px;color:var(--txl);font-weight:600">${m.ca}€</div>
            <div style="width:100%;background:linear-gradient(180deg,var(--v3),var(--v2));border-radius:6px 6px 2px 2px;height:${h}%;min-height:4px;transition:height .3s"></div>
            <div style="font-size:11px;color:var(--txl);text-transform:capitalize">${m.label}</div>
          </div>`;
        }).join('')}
      </div>
    </div>

    <div id="stats-charge-prev" style="background:var(--vp);border-radius:14px;padding:18px;border-left:4px solid var(--v3)">
      <div style="font-family:'Cormorant Garamond',serif;font-size:17px;font-weight:600;color:var(--v2);margin-bottom:10px">🍳 Charge previsionnelle</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;font-size:13px">
        <div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--txl);margin-bottom:4px">Cette semaine</div>
          <div style="font-size:18px;font-weight:600;color:var(--v2)">${cmdSemaine.length} commande${cmdSemaine.length > 1 ? 's' : ''}</div>
          <div style="color:var(--txm)">${portionsSemaine} portions au total · ${cmdSemaine.length * 5} plats a cuisiner</div>
        </div>
        <div>
          <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--txl);margin-bottom:4px">Semaine prochaine</div>
          <div style="font-size:18px;font-weight:600;color:var(--v2)">${cmdSemaineProchaine.length} commande${cmdSemaineProchaine.length > 1 ? 's' : ''}</div>
          <div style="color:var(--txm)">${portionsSemaineProchaine} portions au total · ${cmdSemaineProchaine.length * 5} plats a cuisiner</div>
        </div>
      </div>
    </div>
  </div>`);
}

// --- RECETTES ---
const CATS_FIXED = ['Viande', 'Poisson', 'Végé', 'Poulet', 'Pâtes', 'Cuisine du monde', 'Post partum', 'Sans porc'];
let recetteSearch = '';
let recetteCatFilter = 'all';
let recetteEtatFilter = 'all';

// Catégories d'une recette : tableau `categories`, avec repli sur l'ancien
// champ texte `categorie` pour les recettes pas encore migrées.
function catsOf(rec) {
  if (rec && Array.isArray(rec.categories) && rec.categories.length) return rec.categories;
  return rec && rec.categorie ? [rec.categorie] : [];
}
function recetteMatchCat(rec, cat) {
  if (cat === 'all') return true;
  return catsOf(rec).includes(cat);
}
// Remplit le bloc de cases à cocher des catégories dans le formulaire recette.
function renderRCats(selected = []) {
  const c = $('rCats'); if (!c) return;
  const sel = new Set(selected);
  c.innerHTML = CATS_FIXED.map(cat => {
    const on = sel.has(cat);
    return `<label style="display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border:1.5px solid ${on ? 'var(--v2)' : 'var(--bgd)'};border-radius:16px;font-size:13px;cursor:pointer;background:${on ? 'var(--vp)' : 'var(--wh)'};color:${on ? 'var(--v2)' : 'var(--tx)'};font-weight:${on ? '600' : '400'}">
      <input type="checkbox" class="rcat-cb" value="${escapeAttr(cat)}" ${on ? 'checked' : ''} style="cursor:pointer">${escapeHtml(cat)}</label>`;
  }).join('');
  // Reflète l'état coché sur le style du label (sans re-render)
  c.querySelectorAll('.rcat-cb').forEach(cb => cb.addEventListener('change', () => {
    const lab = cb.closest('label'); const on = cb.checked;
    lab.style.borderColor = on ? 'var(--v2)' : 'var(--bgd)';
    lab.style.background = on ? 'var(--vp)' : 'var(--wh)';
    lab.style.color = on ? 'var(--v2)' : 'var(--tx)';
    lab.style.fontWeight = on ? '600' : '400';
  }));
}
function getRCats() {
  return Array.from(document.querySelectorAll('#rCats .rcat-cb:checked')).map(cb => cb.value);
}

function renderRecettes() {
  const search = recetteSearch.toLowerCase().trim();
  const filtered = DATA.recettes.filter(r => {
    if (!recetteMatchCat(r, recetteCatFilter)) return false;
    if (recetteEtatFilter !== 'all' && getEtat(r) !== recetteEtatFilter) return false;
    if (search && !(r.nom_du_plat || '').toLowerCase().includes(search)) return false;
    return true;
  });
  const recGrid = filtered.map(r => {
    const nbIngs = DATA.ri.filter(x => x.recette_id === r.id).length;
    const etat = getEtat(r);
    const badgeStyle = etat === 'actif' ? 'background:#e8f5e9;color:#2e7d32'
                     : etat === 'a_venir' ? 'background:#fff8e1;color:#f57f17'
                     : etat === 'en_stock' ? 'background:#e8eaf6;color:#3949ab'
                     : 'background:#ffebee;color:#c62828';
    const badgeTxt = etat === 'actif' ? '✓ Actif' : etat === 'a_venir' ? '⏳ A venir' : etat === 'en_stock' ? '📦 En stock' : '✗ Inactif';
    return `<div class="rec-card${etat === 'actif' ? '' : ' inactif'}" data-id="${r.id}">
      ${r.photo_url ? `<img src="${escapeHtml(r.photo_url)}" style="width:100%;height:130px;object-fit:cover;display:block">` : `<div class="rec-img">🍽️</div>`}
      <div class="rec-body">
        <div class="rec-nom">${escapeHtml(r.nom_du_plat)}</div>
        <div class="rec-cat">${escapeHtml(catsOf(r).join(', ') || '–')} · ${nbIngs} ingr. · ${r.frigo_en_jours || '?'}j frigo</div>
        <div class="rec-footer">
          <button data-act="cycle-rec" data-id="${r.id}" data-etat="${etat}" title="Clic pour changer le statut" style="padding:4px 10px;border-radius:16px;font-size:11px;font-weight:500;cursor:pointer;border:none;font-family:'DM Sans',sans-serif;${badgeStyle}">${badgeTxt}</button>
          <button class="btn btn-ghost btn-sm" data-act="dup-rec" data-id="${r.id}" title="Dupliquer">📋</button>
          <button class="btn btn-danger btn-sm" data-act="del-rec" data-id="${r.id}">🗑️</button>
        </div>
      </div>
    </div>`;
  }).join('');

  const chipCss = (active) => active
    ? 'background:var(--vp);border-color:var(--v3);color:var(--v2);font-weight:600'
    : 'background:var(--bgc);border-color:var(--bgd);color:var(--txm)';
  const catChips = ['all', ...CATS_FIXED].map(c => `<button class="rec-cat-chip" data-cat="${escapeHtml(c)}" style="padding:5px 12px;border:1.5px solid;border-radius:16px;font-size:12px;cursor:pointer;font-family:'DM Sans',sans-serif;transition:.15s;${chipCss(c === recetteCatFilter)}">${c === 'all' ? 'Toutes' : escapeHtml(c)}</button>`).join('');
  const allChips = [['all', 'Tous statuts'], ['actif', '✓ Actif'], ['a_venir', '⏳ À venir'], ['en_stock', '📦 En stock'], ['inactif', '✗ Inactif']];
  const etatChips = (isFounder() ? allChips : allChips.filter(([k]) => k === 'all' || k === 'actif' || k === 'inactif'))
    .map(([v, l]) => `<button class="rec-etat-chip" data-etat="${v}" style="padding:5px 12px;border:1.5px solid;border-radius:16px;font-size:12px;cursor:pointer;font-family:'DM Sans',sans-serif;transition:.15s;${chipCss(v === recetteEtatFilter)}">${escapeHtml(l)}</button>`).join('');

  showContent(`<div class="card">
    <div class="card-head">
      <div class="card-tit">🍽️ Recettes <span>${filtered.length} / ${DATA.recettes.length}</span></div>
      <button class="btn btn-primary" id="btnNewRec">+ Nouvelle recette</button>
    </div>
    <div style="display:flex;flex-direction:column;gap:10px;margin-bottom:18px">
      <input type="text" id="recSearch" placeholder="🔍 Rechercher un plat..." value="${escapeAttr(recetteSearch)}" style="padding:9px 14px;border:1.5px solid var(--bgd);border-radius:10px;font-family:'DM Sans',sans-serif;font-size:13px;outline:none;background:var(--wh);color:var(--tx);width:100%">
      <div style="display:flex;flex-wrap:wrap;gap:6px">${catChips}</div>
      <div style="display:flex;flex-wrap:wrap;gap:6px">${etatChips}</div>
    </div>
    <div class="rec-grid">${recGrid || '<div class="empty"><div class="empty-icon">🍽️</div><div class="empty-txt">Aucune recette ne correspond aux filtres</div></div>'}</div>
  </div>`);

  $('recSearch').addEventListener('input', (e) => {
    recetteSearch = e.target.value;
    // re-render uniquement la grille pour ne pas perdre le focus
    const filtered2 = DATA.recettes.filter(r => {
      const s = recetteSearch.toLowerCase().trim();
      if (!recetteMatchCat(r, recetteCatFilter)) return false;
      if (recetteEtatFilter !== 'all' && getEtat(r) !== recetteEtatFilter) return false;
      if (s && !(r.nom_du_plat || '').toLowerCase().includes(s)) return false;
      return true;
    });
    // simple : re-render full
    renderRecettes();
    setTimeout(() => { const inp = $('recSearch'); if (inp) { inp.focus(); inp.setSelectionRange(inp.value.length, inp.value.length); } }, 0);
  });
  $('content').querySelectorAll('.rec-cat-chip').forEach(c => c.addEventListener('click', () => { recetteCatFilter = c.dataset.cat; renderRecettes(); }));
  $('content').querySelectorAll('.rec-etat-chip').forEach(c => c.addEventListener('click', () => { recetteEtatFilter = c.dataset.etat; renderRecettes(); }));
  $('btnNewRec').addEventListener('click', nouvelleRecette);
  $('content').querySelectorAll('.rec-card').forEach(c => {
    c.addEventListener('click', (e) => {
      if (e.target.closest('[data-act]')) return;
      editerRecette(c.dataset.id);
    });
  });
  $('content').querySelectorAll('[data-act="cycle-rec"]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    cycleEtatRecette(b.dataset.id, b.dataset.etat);
  }));
  $('content').querySelectorAll('[data-act="del-rec"]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    supprimerRecette(b.dataset.id);
  }));
  $('content').querySelectorAll('[data-act="dup-rec"]').forEach(b => b.addEventListener('click', (e) => {
    e.stopPropagation();
    dupliquerRecette(b.dataset.id);
  }));
}

function dupliquerRecette(id) {
  const rec = getRecette(id); if (!rec) return;
  $('rId').value = '';
  $('rNom').value = (rec.nom_du_plat || '') + ' (copie)';
  renderRCats(catsOf(rec));
  $('rFrigo').value = rec.frigo_en_jours || 5;
  $('rPrep').value = rec.instructions_preparation || '';
  $('rRechauffage').value = rec.instructions_rechauffage || '';
  $('rCongelation').value = rec.congelation || '';
  $('rEtat').value = 'actif';
  $('rPhoto').value = rec.photo_url || '';
  $('rPhotoPreview').innerHTML = rec.photo_url ? `<img src="${escapeHtml(rec.photo_url)}" style="width:100%;height:100%;object-fit:cover">` : '🍽️';
  $('rPhotoNom').textContent = rec.photo_url ? 'Photo dupliquee — modifiable' : 'Aucune photo';
  $('btnUpload').textContent = rec.photo_url ? '📷 Changer la photo' : '📷 Choisir une photo';
  $('modalRecTit').textContent = 'Nouvelle recette (copie de ' + rec.nom_du_plat + ')';

  ingBuffer = DATA.ri.filter(r => r.recette_id === id).sort((a, b) => (a.ordre || 0) - (b.ordre || 0)).map(r => {
    const ing = DATA.ingredients.find(i => i.id === r.ingredient_id);
    return {
      id: null,
      ingId: r.ingredient_id || null,
      nom: ing ? ing.nom : '',
      qte: r.quantite_par_portion || 0,
      unite: ing && ing.unite_par_defaut !== 'Unité par défaut' ? (ing.unite_par_defaut || '') : '',
      isNew: true,
      toDelete: false
    };
  });
  renderIngRows();
  openModal('modalRecette');
}

// Mini-modal qui demande le rayon pour chaque nouvel ingredient cree.
// Resolves Map<nom, rayon> ou null si annule.
function promptRayonsPourNouveauxIngredients(newIngs) {
  return new Promise((resolve) => {
    const pop = document.createElement('div');
    pop.className = 'overlay open';
    pop.style.zIndex = '500';
    pop.innerHTML = `<div class="modal" style="max-width:520px">
      <div class="modal-head">
        <div class="modal-tit">Nouveaux ingredients</div>
      </div>
      <p style="font-size:13px;color:var(--txm);margin-bottom:14px">Choisissez un rayon pour chaque nouvel ingredient (utilise dans la liste de courses des clientes) :</p>
      <div>
        ${newIngs.map((ing, i) => `<div style="display:grid;grid-template-columns:1fr 200px;gap:10px;align-items:center;padding:10px 0;border-bottom:1px solid var(--bgd)">
          <div style="font-size:13px;font-weight:500">${escapeHtml(ing.nom)}</div>
          <select class="ing-rayon-sel" data-i="${i}" style="padding:8px 10px;border:1.5px solid var(--bgd);border-radius:8px;font-family:'DM Sans',sans-serif;font-size:13px;background:var(--wh);outline:none">
            ${RAYONS_LIST.map(r => `<option value="${escapeHtml(r)}">${escapeHtml(r)}</option>`).join('')}
          </select>
        </div>`).join('')}
      </div>
      <div style="display:flex;gap:10px;margin-top:18px">
        <button id="rayonsOk" class="btn btn-primary" style="flex:1">✓ Confirmer</button>
        <button id="rayonsCancel" class="btn btn-ghost">Annuler</button>
      </div>
    </div>`;
    document.body.appendChild(pop);
    pop.querySelector('#rayonsOk').addEventListener('click', () => {
      const map = new Map();
      pop.querySelectorAll('.ing-rayon-sel').forEach(sel => {
        const ing = newIngs[+sel.dataset.i];
        map.set(ing.nom.toLowerCase().trim(), sel.value);
      });
      pop.remove();
      resolve(map);
    });
    pop.querySelector('#rayonsCancel').addEventListener('click', () => {
      pop.remove();
      resolve(null);
    });
  });
}

async function cycleEtatRecette(id, currentEtat) {
  const cycle = isFounder()
    ? { actif: 'a_venir', a_venir: 'en_stock', en_stock: 'inactif', inactif: 'actif' }
    : { actif: 'inactif', inactif: 'actif', a_venir: 'actif', en_stock: 'actif' };
  const next = cycle[currentEtat] || 'actif';
  const { error } = await sb.from('recettes').update({ etat: next, active: next === 'actif' }).eq('id', id);
  if (error) { toast('Erreur: ' + error.message); return; }
  const r = getRecette(id); if (r) { r.etat = next; r.active = (next === 'actif'); }
  const label = next === 'actif' ? '✓ Actif' : next === 'a_venir' ? '⏳ A venir' : next === 'en_stock' ? '📦 En stock' : '✗ Inactif';
  toast(`Statut: ${label}`);
  renderRecettes();
}

async function supprimerRecette(id) {
  if (!confirm('Supprimer ce plat ? Cette action est irreversible.')) return;
  const { error } = await sb.from('recettes').delete().eq('id', id);
  if (error) { toast('Erreur: ' + error.message); return; }
  DATA.recettes = DATA.recettes.filter(r => r.id !== id);
  DATA.ri = DATA.ri.filter(r => r.recette_id !== id);
  toast('🗑️ Plat supprime'); renderRecettes();
}

// --- INGREDIENTS BUFFER (modal recette) ---
function renderIngRows() {
  const cont = $('ingRows');
  const visible = ingBuffer.filter(i => !i.toDelete);
  if (!visible.length) { cont.innerHTML = `<div style="text-align:center;padding:12px;font-size:12px;color:var(--txl)">Aucun ingredient. Cliquez sur "+ Ajouter".</div>`; return; }
  cont.innerHTML = visible.map((ing) => {
    const bi = ingBuffer.indexOf(ing);
    return `<div class="ing-cols">
      <div class="ing-wrap">
        <input class="ing-inp" type="text" placeholder="Rechercher un ingredient..." value="${escapeHtml(ing.nom)}" data-bi="${bi}" data-role="ing-nom">
        <div class="ing-dropdown" id="ingDrop${bi}"></div>
      </div>
      <input class="ing-inp" type="number" placeholder="Qte" value="${ing.qte || ''}" step="0.1" min="0" data-bi="${bi}" data-role="ing-qte">
      <input class="ing-inp" type="text" placeholder="g, mL..." value="${escapeHtml(ing.unite || '')}" data-bi="${bi}" data-role="ing-unite" list="dlUnites">
      <button class="ing-del" data-bi="${bi}" data-role="ing-del">✕</button>
    </div>`;
  }).join('');
  cont.querySelectorAll('[data-role="ing-nom"]').forEach(el => {
    el.addEventListener('input', () => { ingBuffer[+el.dataset.bi].nom = el.value; showIngDropdown(el, +el.dataset.bi); });
    el.addEventListener('focus', () => showIngDropdown(el, +el.dataset.bi));
    el.addEventListener('blur', () => setTimeout(() => hideIngDropdown(+el.dataset.bi), 180));
  });
  cont.querySelectorAll('[data-role="ing-qte"]').forEach(el => el.addEventListener('input', () => ingBuffer[+el.dataset.bi].qte = parseFloat(el.value) || 0));
  cont.querySelectorAll('[data-role="ing-unite"]').forEach(el => el.addEventListener('input', () => ingBuffer[+el.dataset.bi].unite = el.value));
  cont.querySelectorAll('[data-role="ing-del"]').forEach(el => el.addEventListener('click', () => supprimerIngRow(+el.dataset.bi)));
}

function showIngDropdown(input, bi) {
  const q = (input.value || '').toLowerCase().trim();
  const drop = $(`ingDrop${bi}`); if (!drop) return;
  const matches = DATA.ingredients.filter(i => (i.nom || '').toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length) { drop.classList.remove('show'); return; }
  drop.innerHTML = matches.map(i => `<div class="ing-opt" data-bi="${bi}" data-id="${i.id}" data-nom="${escapeHtml(i.nom)}" data-u="${escapeHtml(i.unite_par_defaut || '')}">${escapeHtml(i.nom)} <span style="color:var(--txl);font-size:11px">${escapeHtml(i.unite_par_defaut || '')}</span></div>`).join('');
  drop.classList.add('show');
  drop.querySelectorAll('.ing-opt').forEach(opt => {
    opt.addEventListener('mousedown', () => {
      const ix = +opt.dataset.bi;
      ingBuffer[ix].nom = opt.dataset.nom;
      ingBuffer[ix].unite = opt.dataset.u;
      ingBuffer[ix].ingId = opt.dataset.id;
      renderIngRows();
    });
  });
}
function hideIngDropdown(bi) { $(`ingDrop${bi}`)?.classList.remove('show'); }

function ajouterIngRow() {
  ingBuffer.push({ id: null, ingId: null, nom: '', qte: 0, unite: '', isNew: true, toDelete: false });
  renderIngRows();
}
function supprimerIngRow(bi) {
  if (ingBuffer[bi].id) ingBuffer[bi].toDelete = true;
  else ingBuffer.splice(bi, 1);
  renderIngRows();
}

function nouvelleRecette() {
  $('rId').value = '';
  ['rNom', 'rPrep', 'rRechauffage', 'rCongelation', 'rPhoto'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  $('rPhotoPreview').innerHTML = '🍽️';
  $('rPhotoNom').textContent = 'Aucune photo selectionnee';
  $('btnUpload').textContent = '📷 Choisir une photo'; $('btnUpload').disabled = false;
  renderRCats([]);
  $('rFrigo').value = '5';
  $('rEtat').value = 'actif';
  $('modalRecTit').textContent = 'Nouvelle recette';
  ingBuffer = []; renderIngRows(); openModal('modalRecette');
}

function editerRecette(id) {
  const rec = getRecette(id); if (!rec) return;
  $('rId').value = id;
  $('rNom').value = rec.nom_du_plat || '';
  renderRCats(catsOf(rec));
  $('rFrigo').value = rec.frigo_en_jours || 5;
  $('rPrep').value = rec.instructions_preparation || '';
  $('rRechauffage').value = rec.instructions_rechauffage || '';
  $('rCongelation').value = rec.congelation || '';
  $('rEtat').value = getEtat(rec);
  $('modalRecTit').textContent = 'Modifier · ' + (rec.nom_du_plat || 'recette');
  $('rPhoto').value = rec.photo_url || '';
  $('rPhotoPreview').innerHTML = rec.photo_url ? `<img src="${escapeHtml(rec.photo_url)}" style="width:100%;height:100%;object-fit:cover">` : '🍽️';
  $('rPhotoNom').textContent = rec.photo_url ? 'Photo existante — cliquer pour changer' : 'Aucune photo selectionnee';
  $('btnUpload').textContent = rec.photo_url ? '📷 Changer la photo' : '📷 Choisir une photo';

  ingBuffer = DATA.ri.filter(r => r.recette_id === id).sort((a, b) => (a.ordre || 0) - (b.ordre || 0)).map(r => {
    const ing = DATA.ingredients.find(i => i.id === r.ingredient_id);
    return {
      id: r.id, ingId: r.ingredient_id || null,
      nom: ing ? ing.nom : '',
      qte: r.quantite_par_portion || 0,
      unite: ing && ing.unite_par_defaut !== 'Unité par défaut' ? (ing.unite_par_defaut || '') : '',
      isNew: false, toDelete: false
    };
  });
  renderIngRows(); openModal('modalRecette');
}

function uploadPhoto() { $('rPhotoFile').click(); }

// Compresse une image : max 1200px de large, qualite JPEG 82%.
// Retourne un Blob compresse, ou null si on ne peut pas / pas la peine de compresser.
async function compressImage(file, maxWidth = 1200, quality = 0.82) {
  if (!file.type || !file.type.startsWith('image/')) return null;
  // HEIC/HEIF: la plupart des navigateurs ne savent pas les decoder via <img>
  if (/heic|heif/i.test(file.type)) return null;
  // Deja petit ? pas la peine
  if (file.size < 200 * 1024) return null;

  try {
    const url = URL.createObjectURL(file);
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('decode-fail'));
      i.src = url;
    });
    let w = img.naturalWidth, h = img.naturalHeight;
    if (w > maxWidth) { h = Math.round(h * maxWidth / w); w = maxWidth; }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    canvas.getContext('2d').drawImage(img, 0, 0, w, h);
    URL.revokeObjectURL(url);
    return await new Promise((resolve) => canvas.toBlob(b => resolve(b), 'image/jpeg', quality));
  } catch (e) {
    return null;
  }
}

async function handlePhotoFile(input) {
  const file = input.files[0]; if (!file) return;
  const btn = $('btnUpload'), nom = $('rPhotoNom'), preview = $('rPhotoPreview');
  btn.textContent = '⏳ Compression...'; btn.disabled = true;
  nom.textContent = 'Compression en cours...';
  try {
    const compressed = await compressImage(file);
    const blob = compressed || file;
    const isJpeg = !!compressed;
    const ext = isJpeg ? 'jpg' : ((file.name.split('.').pop() || 'jpg').toLowerCase());
    const ctype = isJpeg ? 'image/jpeg' : (file.type || 'application/octet-stream');
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

    btn.textContent = '⏳ Upload...';
    nom.textContent = `Envoi (${(blob.size / 1024).toFixed(0)} KB)...`;

    const { error } = await sb.storage.from(STORAGE_BUCKET).upload(filename, blob, { upsert: false, contentType: ctype });
    if (error) throw error;
    const { data: pub } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(filename);
    $('rPhoto').value = pub.publicUrl;
    preview.innerHTML = `<img src="${escapeHtml(pub.publicUrl)}" style="width:100%;height:100%;object-fit:cover">`;

    if (compressed) {
      const ratio = Math.round((1 - compressed.size / file.size) * 100);
      const fromKB = (file.size / 1024).toFixed(0);
      const toKB = (compressed.size / 1024).toFixed(0);
      nom.textContent = `${file.name} (${fromKB}→${toKB} KB)`;
      toast(`✅ Photo compressee -${ratio}% (${fromKB}→${toKB} KB)`);
    } else {
      nom.textContent = file.name;
      toast('✅ Photo uploadee');
    }
  } catch (e) {
    toast('Erreur upload: ' + (e.message || e));
    nom.textContent = 'Erreur';
  }
  btn.textContent = '📷 Changer la photo'; btn.disabled = false;
}

async function saveRecette() {
  const btn = $('btnSaveRec');
  const id = $('rId').value;
  const nom = $('rNom').value.trim();

  // === Validation ===
  if (!nom) { toast('⚠️ Le nom du plat est obligatoire'); return; }
  if (getRCats().length === 0) { toast('⚠️ Choisissez au moins une catégorie'); return; }
  if (!id && !(await checkPlanLimit('recettes', 'recettes'))) return;

  // Doublon de nom (uniquement a la creation)
  if (!id) {
    const dup = DATA.recettes.find(r => (r.nom_du_plat || '').toLowerCase().trim() === nom.toLowerCase().trim());
    if (dup) {
      if (!confirm(`Une recette s'appelle deja "${dup.nom_du_plat}". Creer quand meme ?`)) return;
    }
  }

  // Ingredients : nom non vide ET qte > 0
  const ingsActifs = ingBuffer.filter(i => !i.toDelete);
  for (const ing of ingsActifs) {
    if (!ing.nom.trim()) {
      toast('⚠️ Un ingredient n\'a pas de nom');
      return;
    }
    if (!ing.qte || ing.qte <= 0) {
      if (!confirm(`L'ingredient "${ing.nom}" a une quantite a 0 ou negative. Continuer quand meme ?`)) return;
      break;
    }
  }

  // === Detection des nouveaux ingredients pour demander leur rayon ===
  const newIngs = [];
  for (const ing of ingsActifs) {
    if (ing.ingId) continue;
    if (!ing.nom.trim()) continue;
    const exist = DATA.ingredients.find(i => i.nom.toLowerCase().trim() === ing.nom.toLowerCase().trim());
    if (exist) continue;
    if (newIngs.find(x => x.nom.toLowerCase().trim() === ing.nom.toLowerCase().trim())) continue;
    newIngs.push({ nom: ing.nom.trim(), unite: ing.unite });
  }
  let rayonsMap = new Map();
  if (newIngs.length > 0) {
    const map = await promptRayonsPourNouveauxIngredients(newIngs);
    if (!map) return; // annule
    rayonsMap = map;
  }

  // === Sauvegarde (avec bouton grise) ===
  btn.disabled = true;
  const originalBtnText = btn.textContent;
  btn.textContent = '⏳ Enregistrement...';
  btn.style.opacity = '0.6';
  btn.style.cursor = 'not-allowed';

  try {
    const photoUrl = ($('rPhoto').value || '').trim();
    const etat = $('rEtat').value;
    const cats = getRCats();
    const payload = {
      nom_du_plat: nom,
      categories: cats,
      categorie: cats[0] || null,
      frigo_en_jours: parseInt($('rFrigo').value, 10) || 5,
      instructions_preparation: $('rPrep').value,
      instructions_rechauffage: $('rRechauffage').value,
      congelation: $('rCongelation').value,
      photo_url: photoUrl || null,
      etat,
      active: etat === 'actif'
    };
    let recId = id;
    if (id) {
      const { error } = await sb.from('recettes').update(payload).eq('id', id);
      if (error) throw error;
      const r = getRecette(id); if (r) Object.assign(r, payload);
    } else {
      const { data, error } = await sb.from('recettes').insert({ ...payload, entreprise_id: CURRENT_ENTREPRISE_ID }).select().single();
      if (error) throw error;
      DATA.recettes.push(data);
      recId = data.id;
    }

    // Sync ingredients
    let ordre = 0;
    for (const ing of ingBuffer) {
      ordre++;
      if (ing.toDelete && ing.id) {
        await sb.from('recettes_ingredients').delete().eq('id', ing.id);
        DATA.ri = DATA.ri.filter(r => r.id !== ing.id);
        continue;
      }
      if (ing.toDelete) continue;
      let ingId = ing.ingId;
      if (!ingId && ing.nom.trim()) {
        const found = DATA.ingredients.find(i => i.nom.toLowerCase().trim() === ing.nom.toLowerCase().trim());
        if (found) ingId = found.id;
        else {
          const rayon = rayonsMap.get(ing.nom.toLowerCase().trim()) || null;
          const { data, error } = await sb.from('ingredients').insert({ nom: ing.nom.trim(), unite_par_defaut: ing.unite || null, rayon, entreprise_id: CURRENT_ENTREPRISE_ID }).select().single();
          if (!error && data) { DATA.ingredients.push(data); ingId = data.id; }
        }
      }
      if (!ingId) continue;
      if (ing.isNew) {
        const { data, error } = await sb.from('recettes_ingredients').insert({ recette_id: recId, ingredient_id: ingId, quantite_par_portion: ing.qte || 0, ordre }).select().single();
        if (!error && data) DATA.ri.push(data);
      } else if (ing.id) {
        const { error } = await sb.from('recettes_ingredients').update({ ingredient_id: ingId, quantite_par_portion: ing.qte || 0, ordre }).eq('id', ing.id);
        if (!error) {
          const r = DATA.ri.find(x => x.id === ing.id);
          if (r) Object.assign(r, { ingredient_id: ingId, quantite_par_portion: ing.qte || 0, ordre });
        }
      }
    }
    populateUnitDatalist(); // mise a jour du datalist si nouvelles unites
    if (newIngs.length > 0) toast(`✅ Recette enregistree (+${newIngs.length} nouvel${newIngs.length > 1 ? 's' : ''} ingredient${newIngs.length > 1 ? 's' : ''} cree${newIngs.length > 1 ? 's' : ''})`);
    else toast('✅ Recette enregistree');
    closeModal('modalRecette');
    renderRecettes();
  } catch (e) {
    toast('Erreur: ' + (e.message || e));
  } finally {
    btn.disabled = false;
    btn.textContent = originalBtnText;
    btn.style.opacity = '1';
    btn.style.cursor = 'pointer';
  }
}

// --- CLIENTS ---
function renderClients() {
  const rows = DATA.clients.map(c => {
    const initials = (c.nom || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:10px"><div class="tbl-avatar">${escapeHtml(initials)}</div><div><div style="font-weight:600">${escapeHtml(c.nom || '–')}</div><div style="font-size:11px;color:var(--txl)">${escapeHtml(c.email || '')}</div></div></div></td>
      <td>${escapeHtml(c.telephone || '–')}</td>
      <td style="max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${escapeHtml(c.adresse || '–')}</td>
      <td>${escapeHtml(c.notes || '–')}</td>
      <td style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" data-act="edit-cli" data-id="${c.id}">✏️ Modifier</button><button class="btn btn-danger btn-sm" data-act="del-cli" data-id="${c.id}">🗑️</button></td>
    </tr>`;
  }).join('');
  showContent(`<div class="card">
    <div class="card-head">
      <div class="card-tit">👥 Clients <span>${DATA.clients.length}</span></div>
      <button class="btn btn-primary" id="btnNewCli">+ Nouveau client</button>
    </div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Client</th><th>Telephone</th><th>Adresse</th><th>Notes</th><th>Action</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="empty">Aucun client</td></tr>'}</tbody>
    </table></div>
  </div>`);
  $('btnNewCli').addEventListener('click', nouveauClient);
  $('content').querySelectorAll('[data-act="edit-cli"]').forEach(b => b.addEventListener('click', () => editerClient(b.dataset.id)));
  $('content').querySelectorAll('[data-act="del-cli"]').forEach(b => b.addEventListener('click', () => supprimerClient(b.dataset.id)));
}

function nouveauClient() {
  ['cId', 'cNom', 'cEmail', 'cTel', 'cMdp', 'cAdresse', 'cNotes'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  $('cPortions').value = 4;
  $('modalCliTit').textContent = 'Nouveau client'; openModal('modalClient');
}
function editerClient(id) {
  const c = getClient(id); if (!c) return;
  $('cId').value = id;
  $('cNom').value = c.nom || '';
  $('cEmail').value = c.email || '';
  $('cTel').value = c.telephone || '';
  $('cMdp').value = '';
  $('cPortions').value = c.nombre_portions || 4;
  $('cAdresse').value = c.adresse || '';
  $('cNotes').value = c.notes || '';
  $('modalCliTit').textContent = 'Modifier · ' + (c.nom || 'client');
  openModal('modalClient');
}

async function adminCreateAuthUser({ email, password, type, nom, telephone, adresse, notes }) {
  const r = await fetch(`${SB_URL}/auth/v1/admin/users`, {
    method: 'POST',
    headers: {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      email, password, email_confirm: true,
      user_metadata: { type, nom, telephone, adresse, notes }
    })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.msg || d.message || `${r.status}`);
  return d;
}

async function adminUpdateAuthUser(id, { email, password }) {
  const body = {};
  if (email) body.email = email;
  if (password) body.password = password;
  if (Object.keys(body).length === 0) return null;
  const r = await fetch(`${SB_URL}/auth/v1/admin/users/${id}`, {
    method: 'PUT',
    headers: {
      apikey: SB_SERVICE_KEY,
      Authorization: `Bearer ${SB_SERVICE_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(body)
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.msg || d.message || `${r.status}`);
  return d;
}

async function adminDeleteAuthUser(id) {
  const r = await fetch(`${SB_URL}/auth/v1/admin/users/${id}`, {
    method: 'DELETE',
    headers: { apikey: SB_SERVICE_KEY, Authorization: `Bearer ${SB_SERVICE_KEY}` }
  });
  if (!r.ok && r.status !== 404) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.msg || d.message || `${r.status}`);
  }
}

async function saveClient() {
  const id = $('cId').value;
  const nom = $('cNom').value.trim();
  const email = $('cEmail').value.trim();
  const telephone = $('cTel').value.trim();
  const mdp = $('cMdp').value.trim();
  const portions = parseInt($('cPortions').value, 10) || 4;
  const adresse = $('cAdresse').value.trim();
  const notes = $('cNotes').value.trim();
  if (!nom || !email) { toast('⚠️ Nom et email obligatoires'); return; }
  if (portions < 1 || portions > 20) { toast('⚠️ Nb portions entre 1 et 20'); return; }
  if (!id && !(await checkPlanLimit('clientes', 'clientes'))) return;

  try {
    if (id) {
      if (mdp || email !== (getClient(id).email)) {
        await adminUpdateAuthUser(id, { email: email !== getClient(id).email ? email : undefined, password: mdp || undefined });
      }
      const payload = { nom, email, telephone: telephone || null, adresse: adresse || null, notes: notes || null, nombre_portions: portions };
      const { error } = await sb.from('clients').update(payload).eq('id', id);
      if (error) throw error;
      const c = getClient(id); if (c) Object.assign(c, payload);
      toast('✅ Client modifie');
    } else {
      if (!mdp) { toast('⚠️ Mot de passe obligatoire pour creation'); return; }
      const u = await adminCreateAuthUser({ email, password: mdp, type: 'client', nom, telephone, adresse, notes });
      await new Promise(r => setTimeout(r, 200));
      // Update le profil avec nombre_portions + entreprise_id (le trigger ne les set pas)
      await sb.from('clients').update({ nombre_portions: portions, entreprise_id: CURRENT_ENTREPRISE_ID }).eq('id', u.id);
      const { data, error } = await sb.from('clients').select('*').eq('id', u.id).single();
      if (!error && data) DATA.clients.push(data);
      toast('✅ Client cree');
    }
    closeModal('modalClient'); renderClients();
  } catch (e) {
    toast('Erreur: ' + (e.message || e));
  }
}

async function supprimerClient(id) {
  if (!confirm('Supprimer ce client et toutes ses donnees (commandes, favoris, compte) ?')) return;
  try {
    await sb.from('favoris').delete().eq('client_id', id);
    await sb.from('commandes').delete().eq('client_id', id);
    await sb.from('clients').delete().eq('id', id);
    await adminDeleteAuthUser(id);
    const [{ data: cliData }, { data: cmdData }] = await Promise.all([
      scoped(sb.from('clients').select('*')),
      scoped(sb.from('commandes').select('*'))
    ]);
    if (cliData) DATA.clients = cliData;
    if (cmdData) DATA.commandes = cmdData;
    toast('🗑️ Client et toutes ses donnees supprimes');
    const tab = document.querySelector('.tab.active')?.dataset.tab;
    showTab(tab || 'clients');
  } catch (e) {
    toast('Erreur: ' + (e.message || e));
  }
}

// --- SALARIES ---
function renderSalaries() {
  const rows = DATA.salaries.map(s => {
    const initials = (s.nom || '?').split(' ').map(w => w[0]).join('').toUpperCase().slice(0, 2);
    const nbCmds = DATA.commandes.filter(c => c.assigne_a_id === s.id).length;
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:10px"><div class="tbl-avatar">${escapeHtml(initials)}</div><div style="font-weight:600">${escapeHtml(s.nom || '–')}</div></div></td>
      <td>${escapeHtml(s.email || '–')}</td>
      <td>${escapeHtml(s.telephone || '–')}</td>
      <td><span class="badge b-ok">${nbCmds} commande(s)</span></td>
      <td style="display:flex;gap:6px"><button class="btn btn-ghost btn-sm" data-act="edit-sal" data-id="${s.id}">✏️ Modifier</button><button class="btn btn-danger btn-sm" data-act="del-sal" data-id="${s.id}">🗑️</button></td>
    </tr>`;
  }).join('');
  showContent(`<div class="card">
    <div class="card-head">
      <div class="card-tit">🤝 Partenaires <span>${DATA.salaries.length}</span></div>
      <button class="btn btn-primary" id="btnNewSal">+ Nouveau partenaire</button>
    </div>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Partenaire</th><th>Email</th><th>Telephone</th><th>Activite</th><th>Action</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="5" class="empty">Aucun partenaire</td></tr>'}</tbody>
    </table></div>
  </div>`);
  $('btnNewSal').addEventListener('click', nouveauSalarie);
  $('content').querySelectorAll('[data-act="edit-sal"]').forEach(b => b.addEventListener('click', () => editerSalarie(b.dataset.id)));
  $('content').querySelectorAll('[data-act="del-sal"]').forEach(b => b.addEventListener('click', () => supprimerSalarie(b.dataset.id)));
}

function nouveauSalarie() {
  ['sId', 'sNom', 'sEmail', 'sTel', 'sMdp'].forEach(id => $(id).value = '');
  $('modalSalTit').textContent = 'Nouveau partenaire'; openModal('modalSalarie');
}
function editerSalarie(id) {
  const s = getSalarie(id); if (!s) return;
  $('sId').value = id;
  $('sNom').value = s.nom || '';
  $('sEmail').value = s.email || '';
  $('sTel').value = s.telephone || '';
  $('sMdp').value = '';
  $('modalSalTit').textContent = 'Modifier · ' + (s.nom || 'partenaire');
  openModal('modalSalarie');
}
async function saveSalarie() {
  const id = $('sId').value;
  const nom = $('sNom').value.trim();
  const email = $('sEmail').value.trim();
  const telephone = $('sTel').value.trim();
  const mdp = $('sMdp').value.trim();
  if (!nom || !email) { toast('⚠️ Nom et email obligatoires'); return; }

  try {
    if (id) {
      if (mdp || email !== getSalarie(id).email) {
        await adminUpdateAuthUser(id, { email: email !== getSalarie(id).email ? email : undefined, password: mdp || undefined });
      }
      const payload = { nom, email, telephone: telephone || null };
      const { error } = await sb.from('salaries').update(payload).eq('id', id);
      if (error) throw error;
      const s = getSalarie(id); if (s) Object.assign(s, payload);
      toast('✅ Partenaire modifie');
    } else {
      if (!mdp) { toast('⚠️ Mot de passe obligatoire pour creation'); return; }
      const u = await adminCreateAuthUser({ email, password: mdp, type: 'salarie', nom, telephone });
      await new Promise(r => setTimeout(r, 200));
      await sb.from('salaries').update({ entreprise_id: CURRENT_ENTREPRISE_ID }).eq('id', u.id);
      const { data, error } = await sb.from('salaries').select('*').eq('id', u.id).single();
      if (!error && data) DATA.salaries.push(data);
      toast('✅ Partenaire cree');
    }
    closeModal('modalSalarie'); renderSalaries();
  } catch (e) {
    toast('Erreur: ' + (e.message || e));
  }
}
async function supprimerSalarie(id) {
  if (!confirm('Supprimer ce partenaire (les commandes assignees seront desassignees) ?')) return;
  try {
    await sb.from('commandes').update({ assigne_a_id: null }).eq('assigne_a_id', id);
    await sb.from('salaries').delete().eq('id', id);
    await adminDeleteAuthUser(id);
    // Refetch frais depuis la DB pour eviter toute trace locale (scope par entreprise)
    const [{ data: salData }, { data: cmdData }] = await Promise.all([
      scoped(sb.from('salaries').select('*')),
      scoped(sb.from('commandes').select('*'))
    ]);
    if (salData) DATA.salaries = salData;
    if (cmdData) DATA.commandes = cmdData;
    toast('🗑️ Partenaire supprime');
    // Re-render le tab courant pour rafraichir les dropdowns d'assignation
    const tab = document.querySelector('.tab.active')?.dataset.tab;
    showTab(tab || 'salaries');
  } catch (e) {
    toast('Erreur: ' + (e.message || e));
  }
}

// --- CRENEAUX ---
function crActif(sem, slotKey) {
  const found = DATA.creneaux.find(c => c.semaine === sem && c.slot === slotKey);
  return found ? !!found.actif : true;
}
async function toggleCren(sem, slotKey, currentActif) {
  const newVal = !currentActif;
  const existing = DATA.creneaux.find(c => c.semaine === sem && c.slot === slotKey);
  try {
    if (existing) {
      const { error } = await sb.from('creneaux').update({ actif: newVal }).eq('id', existing.id);
      if (error) throw error;
      existing.actif = newVal;
    } else {
      const { data, error } = await sb.from('creneaux').insert({ semaine: sem, slot: slotKey, actif: newVal, entreprise_id: CURRENT_ENTREPRISE_ID }).select().single();
      if (error) throw error;
      DATA.creneaux.push(data);
    }
    toast(newVal ? '✅ Creneau ouvert' : 'Creneau ferme'); renderCreneaux();
  } catch (e) { toast('Erreur: ' + (e.message || e)); }
}

function renderCreneaux() {
  const semaine = getMonday(crenOffset);
  const todayMon = getMonday(0);
  const isPasse = semaine < todayMon;
  const [yy, mm, dd] = semaine.split('-').map(Number);
  // Jours actifs = ceux qui ont au moins un slot dans le template
  const jours = JOURS_ORDER.filter(j => DATA.creneauxTemplate.some(t => t.jour === j));
  const joursHtml = jours.length === 0
    ? '<div class="empty" style="grid-column:1/-1"><div class="empty-icon">⚙️</div><div class="empty-txt">Aucun créneau configuré.<br>Cliquez sur ⚙️ Paramètres pour en ajouter.</div></div>'
    : jours.map(jour => {
      const jd = new Date(yy, mm - 1, dd + JMAP_FULL[jour]);
      const dateLabel = jd.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
      const cmdJ = DATA.commandes.filter(c => (c.semaine_du || '').startsWith(semaine) && (c.creneau || '').toLowerCase().includes(jour.toLowerCase()));
      const slotsForJour = getSlotsForJour(jour);
      const slotsHtml = slotsForJour.map(s => {
        const k = `${jour}_${s.nom_slot}`;
        const actif = crActif(semaine, k);
        const cmdS = cmdJ.filter(c => c.slot_key === k || (c.creneau || '').toLowerCase().includes(fmtHeure(s.heure_debut).toLowerCase()));
        return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 0;border-top:1px solid var(--bgd)">
          <div>
            <div style="font-size:12px;font-weight:500;color:var(--tx);text-transform:capitalize">${escapeHtml(s.nom_slot)}</div>
            <div style="font-size:11px;color:var(--txl)">${escapeHtml(fmtSlotLabel(s.heure_debut, s.heure_fin))} · ${cmdS.length} cmd</div>
          </div>
          ${isPasse ? `<span style="font-size:10px;color:var(--txl)">passe</span>` : `<button class="cren-btn ${actif ? 'on' : 'off'}" style="width:auto;padding:4px 10px" data-act="toggle-cren" data-sem="${semaine}" data-slot="${k}" data-actif="${actif}">${actif ? '✓' : '✗'}</button>`}
        </div>`;
      }).join('');
      return `<div class="cren-card${isPasse ? ' past' : ''}">
        <div class="cren-jour">${jour}</div>
        <div style="font-size:11px;color:var(--txl);margin-top:-2px;margin-bottom:6px;text-transform:capitalize">${dateLabel}</div>
        ${slotsHtml || '<div style="font-size:11px;color:var(--txl);padding:8px 0;text-align:center">Aucun creneau</div>'}
      </div>`;
    }).join('');
  showContent(`<div class="card">
    <div class="card-head">
      <div class="card-tit">🕐 Creneaux</div>
      <button class="btn btn-ghost" id="btnParamCreneaux">⚙️ Paramètres</button>
    </div>
    <div class="snav">
      <button class="snav-btn" id="prevCren">◀</button>
      <div class="snav-label">${semLabel(crenOffset)}</div>
      <button class="snav-btn" id="nextCren">▶</button>
      ${crenOffset !== 0 ? `<button class="snav-today" id="todayCren">Semaine en cours</button>` : ''}
    </div>
    ${isPasse ? `<div style="font-size:12px;color:var(--cr);padding:10px 14px;background:#fff5f5;border-radius:10px;margin-bottom:14px">⚠️ Semaine passee — modification desactivee</div>` : ''}
    <div class="cren-grid">${joursHtml}</div>
    <p style="font-size:12px;color:var(--txl);margin-top:14px">Les creneaux fermes n'apparaissent pas dans le portail client.</p>
  </div>`);
  $('prevCren').addEventListener('click', () => { crenOffset--; renderCreneaux(); });
  $('nextCren').addEventListener('click', () => { crenOffset++; renderCreneaux(); });
  $('todayCren')?.addEventListener('click', () => { crenOffset = 0; renderCreneaux(); });
  $('content').querySelectorAll('[data-act="toggle-cren"]').forEach(b => b.addEventListener('click', () => toggleCren(b.dataset.sem, b.dataset.slot, b.dataset.actif === 'true')));
  $('btnParamCreneaux').addEventListener('click', ouvrirParametresCreneaux);
}

// === PARAMETRES (branding par entreprise) ===
function getCurrentEntreprise() {
  return DATA.entreprises.find(e => e.id === CURRENT_ENTREPRISE_ID) || {};
}

// Applique logo + nom + couleurs de l'entreprise sur le dashboard admin
function applyEntrepriseBranding() {
  const e = getCurrentEntreprise();
  if (!e) return;
  if (e.nom_marque) {
    document.title = e.nom_marque + ' · Admin';
    const tNom = $('topbarBrandName'); if (tNom) tNom.textContent = e.nom_marque;
    const sTit = $('splashTitle'); if (sTit) sTit.textContent = e.nom_marque;
  }
  const tBox = $('topbarLogoBox');
  if (e.logo_url) {
    const tImg = $('topbarLogoImg');
    if (tImg) tImg.src = e.logo_url;
    if (tBox) tBox.style.display = 'flex';
    const sImg = $('splashLogoImg');
    if (sImg) { sImg.src = e.logo_url; sImg.style.display = 'block'; }
  } else {
    if (tBox) tBox.style.display = 'none';
    const sImg = $('splashLogoImg');
    if (sImg) sImg.style.display = 'none';
  }
  if (e.couleur_principale) document.documentElement.style.setProperty('--brand-primary', e.couleur_principale);
  if (e.couleur_secondaire) document.documentElement.style.setProperty('--brand-secondary', e.couleur_secondaire);
  if (e.couleur_topbar) document.documentElement.style.setProperty('--topbar-bg', e.couleur_topbar);
}

async function renderParametres() {
  const e = getCurrentEntreprise();
  showContent(`<div class="card">
    <div class="card-head">
      <div class="card-tit">⚙️ Paramètres de mon espace</div>
      <span style="font-size:12px;color:var(--txl)">${escapeHtml(CURRENT_ADMIN_NOM)} · plan ${escapeHtml(CURRENT_PLAN)}</span>
    </div>
    <p style="color:var(--txm);margin-bottom:18px;font-size:13px">Personnalise ton espace : ces infos apparaissent sur ton login, ton portail client et tes communications.</p>

    <div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-bottom:18px">
      <div class="fg">
        <label>Nom de ta marque *</label>
        <input id="prmNom" type="text" value="${escapeAttr(e.nom_marque || '')}" placeholder="Ex: Le Goût du Lien">
      </div>
      <div class="fg">
        <label>Email admin (login)</label>
        <input id="prmEmail" type="email" value="${escapeAttr(e.admin_email || '')}" placeholder="ton@email.fr">
      </div>
    </div>

    <div class="fg" style="margin-bottom:18px">
      <label>Nouveau mot de passe (laisser vide pour ne pas changer)</label>
      <input id="prmNewPwd" type="password" placeholder="••••••••" autocomplete="new-password">
      <div style="font-size:11px;color:var(--txl);margin-top:4px">Min 8 caractères. Tu seras déconnectée après changement et devras te reconnecter.</div>
    </div>

    <div class="fg" style="margin-bottom:18px">
      <label>Logo</label>
      <div style="display:flex;gap:14px;align-items:center;padding:14px;border:1.5px dashed var(--bgd);border-radius:12px">
        <div id="prmLogoPreview" style="width:80px;height:80px;border-radius:14px;background:var(--bgc);display:flex;align-items:center;justify-content:center;font-size:32px;overflow:hidden">${e.logo_url ? `<img src="${escapeAttr(e.logo_url)}" style="width:100%;height:100%;object-fit:cover">` : '🍳'}</div>
        <div style="flex:1">
          <button class="btn btn-ghost" id="prmBtnUpload">📷 Changer le logo</button>
          <div style="font-size:11px;color:var(--txl);margin-top:6px" id="prmLogoNom">Format carré recommandé. Max 2 MB.</div>
        </div>
        <input type="file" id="prmFile" accept="image/*" style="display:none">
        <input type="hidden" id="prmLogoUrl" value="${escapeAttr(e.logo_url || '')}">
      </div>
    </div>

    <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:14px;margin-bottom:18px">
      <div class="fg">
        <label>Couleur principale</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input id="prmCol1" type="color" value="${escapeAttr(e.couleur_principale || '#3d6b4f')}" style="width:46px;height:38px;border:1.5px solid var(--bgd);border-radius:8px;cursor:pointer;padding:2px;background:var(--wh);flex-shrink:0">
          <input id="prmCol1Hex" type="text" value="${escapeAttr(e.couleur_principale || '#3d6b4f')}" style="flex:1;min-width:0" maxlength="7">
        </div>
      </div>
      <div class="fg">
        <label>Couleur secondaire</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input id="prmCol2" type="color" value="${escapeAttr(e.couleur_secondaire || '#5a8a6a')}" style="width:46px;height:38px;border:1.5px solid var(--bgd);border-radius:8px;cursor:pointer;padding:2px;background:var(--wh);flex-shrink:0">
          <input id="prmCol2Hex" type="text" value="${escapeAttr(e.couleur_secondaire || '#5a8a6a')}" style="flex:1;min-width:0" maxlength="7">
        </div>
      </div>
      <div class="fg">
        <label>Barre du haut</label>
        <div style="display:flex;align-items:center;gap:8px">
          <input id="prmCol3" type="color" value="${escapeAttr(e.couleur_topbar || '#0a0a08')}" style="width:46px;height:38px;border:1.5px solid var(--bgd);border-radius:8px;cursor:pointer;padding:2px;background:var(--wh);flex-shrink:0">
          <input id="prmCol3Hex" type="text" value="${escapeAttr(e.couleur_topbar || '#0a0a08')}" style="flex:1;min-width:0" maxlength="7">
        </div>
      </div>
    </div>

    <div class="fg" style="margin-bottom:18px">
      <label>Montant client par défaut (€ par commande)</label>
      <input id="prmMontant" type="number" min="0" step="1" value="${escapeAttr(String(e.montant_client_default ?? 60))}" style="max-width:200px">
      <div style="font-size:11px;color:var(--txl);margin-top:4px">Combien tu factures à chaque cliente par commande. Utilisé sur le portail client et les stats.</div>
    </div>

    <div class="fg" style="margin-bottom:18px">
      <label>Instructions de paiement (affichées à tes clientes)</label>
      <textarea id="prmPaiement" rows="5" placeholder="Ex: Virement sur RIB FR76... | Lien Abby URSSAF | Espèces à la livraison | CESU déclaratif | Sumeria...">${escapeHtml(e.instructions_paiement || '')}</textarea>
      <div style="font-size:11px;color:var(--txl);margin-top:4px">Texte libre — décris ton mode de paiement comme tu le veux. C'est ce que verra ta cliente après commande.</div>
    </div>

    <div style="display:flex;gap:12px;margin-top:24px;padding-bottom:24px;border-bottom:1px solid var(--bgd);flex-wrap:wrap">
      <button class="btn btn-pri" id="prmSave">💾 Enregistrer mes paramètres</button>
      ${e.plan !== 'founder' ? `<button class="btn btn-ghost" id="prmManageSub">💳 Gérer mon abonnement</button>` : ''}
      <span id="prmStatus" style="font-size:13px;color:var(--txl);align-self:center"></span>
    </div>

    <div style="margin-top:32px">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <h3 style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:var(--v2)">📦 Mes forfaits</h3>
        <button class="btn btn-pri btn-sm" id="prmAddForfait">+ Ajouter un forfait</button>
      </div>
      <p style="color:var(--txm);font-size:13px;margin-bottom:18px">Définis tes offres : tes clientes choisiront un forfait au moment de leur commande, et le prix de la commande dérive du forfait choisi.</p>
      <div id="prmForfaitsList"></div>
      <div id="prmForfaitForm" style="display:none"></div>
    </div>
  </div>`);
  renderForfaitsList();

  // Bind events
  $('prmBtnUpload').addEventListener('click', () => $('prmFile').click());
  $('prmFile').addEventListener('change', async (ev) => {
    const file = ev.target.files?.[0]; if (!file) return;
    await uploadParametresLogo(file);
  });
  // Sync color picker <-> hex
  ['prmCol1', 'prmCol2', 'prmCol3'].forEach(id => {
    $(id).addEventListener('input', e => { $(id + 'Hex').value = e.target.value; });
    $(id + 'Hex').addEventListener('input', e => { if (/^#[0-9a-f]{6}$/i.test(e.target.value)) $(id).value = e.target.value; });
  });
  $('prmSave').addEventListener('click', saveParametres);
  $('prmAddForfait').addEventListener('click', () => openForfaitForm(null));
  $('prmManageSub')?.addEventListener('click', ouvrirPortailStripe);
}

async function ouvrirPortailStripe() {
  try {
    const { data: { session } } = await sbAuth.auth.getSession();
    if (!session) { toast('Session perdue, reconnecte-toi'); return; }
    const r = await fetch('/.netlify/functions/stripe-portal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ access_token: session.access_token })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Erreur ouverture portail');
    window.location.href = data.url;
  } catch (e) {
    toast('Erreur : ' + (e.message || e));
  }
}

function renderForfaitsList() {
  const list = $('prmForfaitsList');
  if (!list) return;
  const forfaits = [...DATA.forfaits].sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
  if (!forfaits.length) {
    list.innerHTML = `<div style="background:var(--bgc);border:1.5px dashed var(--bgd);border-radius:14px;padding:24px;text-align:center;color:var(--txl);font-size:13px">Aucun forfait pour le moment. Crée ton premier pour que tes clientes puissent commander.</div>`;
    return;
  }
  list.innerHTML = forfaits.map(f => `
    <div style="background:var(--wh);border:1.5px solid var(--bgd);border-radius:14px;padding:16px 18px;margin-bottom:10px;display:flex;align-items:center;gap:14px;${!f.active ? 'opacity:.5' : ''}">
      <div style="flex:1;min-width:0">
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px">
          <strong style="font-size:15px;color:var(--tx)">${escapeHtml(f.nom)}</strong>
          ${f.badge ? `<span style="background:var(--vp);color:var(--v2);font-size:10px;padding:2px 8px;border-radius:10px;text-transform:uppercase;letter-spacing:.3px">${escapeHtml(f.badge)}</span>` : ''}
          ${!f.active ? `<span style="background:var(--bgd);color:var(--txl);font-size:10px;padding:2px 8px;border-radius:10px">Inactif</span>` : ''}
        </div>
        ${f.description ? `<div style="font-size:12px;color:var(--txm);line-height:1.4">${escapeHtml(f.description)}</div>` : ''}
      </div>
      <div style="font-size:18px;font-weight:600;color:var(--v2);white-space:nowrap">${f.prix}€</div>
      <div style="display:flex;gap:6px">
        <button class="btn btn-ghost btn-sm" data-act="edit-forf" data-id="${f.id}">✏️</button>
        <button class="btn btn-danger btn-sm" data-act="del-forf" data-id="${f.id}">🗑️</button>
      </div>
    </div>
  `).join('');
  list.querySelectorAll('[data-act="edit-forf"]').forEach(b => b.addEventListener('click', () => openForfaitForm(b.dataset.id)));
  list.querySelectorAll('[data-act="del-forf"]').forEach(b => b.addEventListener('click', () => supprimerForfait(b.dataset.id)));
}

function openForfaitForm(id) {
  const f = id ? DATA.forfaits.find(x => x.id === id) : null;
  const form = $('prmForfaitForm');
  form.style.display = 'block';
  form.innerHTML = `
    <div style="background:var(--bgc);border:1.5px solid var(--vl);border-radius:14px;padding:18px;margin-top:10px">
      <div style="font-weight:600;margin-bottom:14px;color:var(--v2)">${id ? '✏️ Modifier le forfait' : '+ Nouveau forfait'}</div>
      <div style="display:grid;grid-template-columns:2fr 1fr;gap:12px;margin-bottom:12px">
        <div class="fg"><label>Nom *</label><input id="forfNom" type="text" placeholder="Ex: Découverte, Semaine, Mensuel" value="${escapeAttr(f?.nom || '')}"></div>
        <div class="fg"><label>Prix (€) *</label><input id="forfPrix" type="number" min="0" step="0.01" placeholder="60" value="${escapeAttr(String(f?.prix ?? ''))}"></div>
      </div>
      <div class="fg" style="margin-bottom:12px"><label>Description (optionnel — visible client)</label><textarea id="forfDesc" rows="2" placeholder="Ex: 5 plats batch cookés, 4 portions, liste de courses 48h avant">${escapeHtml(f?.description || '')}</textarea></div>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:14px">
        <div class="fg"><label>Badge (optionnel)</label><input id="forfBadge" type="text" placeholder="Ex: Bienvenue, Meilleure offre" value="${escapeAttr(f?.badge || '')}"></div>
        <div class="fg"><label>Ordre d'affichage</label><input id="forfOrdre" type="number" min="0" step="1" value="${f?.ordre ?? 0}"></div>
        <div class="fg"><label>Statut</label><select id="forfActive"><option value="true" ${f?.active !== false ? 'selected' : ''}>✓ Actif</option><option value="false" ${f?.active === false ? 'selected' : ''}>✗ Inactif</option></select></div>
      </div>
      <div class="fg" style="margin-bottom:14px">
        <label style="display:flex;align-items:center;gap:10px;cursor:pointer;font-weight:500;color:var(--tx)">
          <input id="forfIncCourses" type="checkbox" style="width:18px;height:18px;cursor:pointer" ${f?.inclut_courses ? 'checked' : ''}>
          <span>🛒 Ce forfait inclut les courses (je fais les courses)</span>
        </label>
        <div style="font-size:11px;color:var(--txl);margin-top:4px;margin-left:28px">Si coché : à la commande, la liste de courses sera cachée du portail de cette cliente (c'est toi qui shop). Affiche un badge "Courses à faire" sur ton planning.</div>
      </div>
      <div style="display:flex;gap:10px">
        <button class="btn btn-pri" id="forfSave">💾 ${id ? 'Enregistrer' : 'Créer'}</button>
        <button class="btn btn-ghost" id="forfCancel">Annuler</button>
      </div>
    </div>
  `;
  $('forfSave').addEventListener('click', () => saveForfait(id));
  $('forfCancel').addEventListener('click', () => { form.style.display = 'none'; form.innerHTML = ''; });
}

async function saveForfait(id) {
  const nom = $('forfNom').value.trim();
  const prix = parseFloat($('forfPrix').value);
  const description = $('forfDesc').value.trim();
  const badge = $('forfBadge').value.trim();
  const ordre = parseInt($('forfOrdre').value, 10) || 0;
  const active = $('forfActive').value === 'true';
  if (!nom) { toast('⚠️ Nom du forfait obligatoire'); return; }
  if (isNaN(prix) || prix < 0) { toast('⚠️ Prix invalide'); return; }

  const inclutCourses = $('forfIncCourses')?.checked || false;
  const payload = { nom, prix, description: description || null, badge: badge || null, ordre, active, inclut_courses: inclutCourses };
  try {
    if (id) {
      const { error } = await sb.from('forfaits').update(payload).eq('id', id);
      if (error) throw error;
      const f = DATA.forfaits.find(x => x.id === id); if (f) Object.assign(f, payload);
      toast('✅ Forfait modifié');
    } else {
      const { data, error } = await sb.from('forfaits').insert({ ...payload, entreprise_id: CURRENT_ENTREPRISE_ID }).select().single();
      if (error) throw error;
      DATA.forfaits.push(data);
      toast('✅ Forfait créé');
    }
    $('prmForfaitForm').style.display = 'none';
    $('prmForfaitForm').innerHTML = '';
    renderForfaitsList();
  } catch (e) {
    toast('Erreur : ' + (e.message || e));
  }
}

async function supprimerForfait(id) {
  const f = DATA.forfaits.find(x => x.id === id); if (!f) return;
  if (!confirm(`Supprimer le forfait "${f.nom}" ?\nLes commandes existantes ne sont pas affectées (le prix reste figé sur la commande).`)) return;
  try {
    const { error } = await sb.from('forfaits').delete().eq('id', id);
    if (error) throw error;
    DATA.forfaits = DATA.forfaits.filter(x => x.id !== id);
    toast('🗑️ Forfait supprimé');
    renderForfaitsList();
  } catch (e) {
    toast('Erreur : ' + (e.message || e));
  }
}

async function uploadParametresLogo(file) {
  if (file.size > 2 * 1024 * 1024) { toast('⚠️ Logo trop lourd (max 2 MB)'); return; }
  $('prmLogoNom').textContent = '⏳ Upload...';
  try {
    const compressed = await compressImage(file, 600, 0.85);
    const blob = compressed || file;
    const ext = compressed ? 'jpg' : ((file.name.split('.').pop() || 'jpg').toLowerCase());
    const ctype = compressed ? 'image/jpeg' : (file.type || 'image/jpeg');
    const filename = `logos/${CURRENT_ENTREPRISE_ID}-${Date.now()}.${ext}`;
    const { error } = await sb.storage.from(STORAGE_BUCKET).upload(filename, blob, { upsert: true, contentType: ctype });
    if (error) throw error;
    const { data: pub } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(filename);
    $('prmLogoUrl').value = pub.publicUrl;
    $('prmLogoPreview').innerHTML = `<img src="${escapeAttr(pub.publicUrl)}" style="width:100%;height:100%;object-fit:cover">`;
    $('prmLogoNom').textContent = '✅ Logo uploadé — clique Enregistrer';
  } catch (e) {
    $('prmLogoNom').textContent = 'Erreur : ' + (e.message || e);
  }
}

async function saveParametres() {
  const nom = $('prmNom').value.trim();
  const email = $('prmEmail').value.trim();
  const newPwd = $('prmNewPwd').value;
  const col1 = $('prmCol1Hex').value.trim();
  const col2 = $('prmCol2Hex').value.trim();
  const col3 = $('prmCol3Hex').value.trim();
  const montant = parseInt($('prmMontant').value, 10);
  const paiement = $('prmPaiement').value.trim();
  const logo = $('prmLogoUrl').value.trim();
  if (!nom) { toast('⚠️ Le nom de la marque est obligatoire'); return; }
  if (![col1, col2, col3].every(c => /^#[0-9a-f]{6}$/i.test(c))) { toast('⚠️ Couleurs invalides'); return; }
  if (isNaN(montant) || montant < 0) { toast('⚠️ Montant invalide'); return; }
  if (newPwd && newPwd.length < 8) { toast('⚠️ Le mot de passe doit faire au moins 8 caractères'); return; }

  const oldEnt = getCurrentEntreprise();
  const oldEmail = oldEnt.admin_email || '';
  const emailChanged = email && email !== oldEmail;

  const payload = {
    nom_marque: nom,
    admin_email: email || null,
    couleur_principale: col1,
    couleur_secondaire: col2,
    couleur_topbar: col3,
    montant_client_default: montant,
    instructions_paiement: paiement || null,
    logo_url: logo || null
  };
  // Note : password gere uniquement via Supabase Auth, plus stocke dans entreprises

  $('prmStatus').textContent = '⏳ Enregistrement...';
  try {
    // Sync Supabase auth en premier (email / password)
    if (emailChanged || newPwd) {
      const authUpdate = {};
      if (emailChanged) authUpdate.email = email;
      if (newPwd) authUpdate.password = newPwd;
      try {
        let uid = CURRENT_ADMIN_USER_ID;
        if (!uid) {
          const { data: sessionData } = await sbAuth.auth.getUser();
          uid = sessionData?.user?.id;
        }
        if (!uid) throw new Error('Session perdue');
        await adminUpdateAuthUser(uid, authUpdate);
      } catch (eAuth) {
        $('prmStatus').textContent = '❌ Auth : ' + (eAuth.message || eAuth);
        return;
      }
    }

    const { error } = await sb.from('entreprises').update(payload).eq('id', CURRENT_ENTREPRISE_ID);
    if (error) throw error;
    Object.assign(oldEnt, payload);
    applyEntrepriseBranding();
    $('prmNewPwd').value = '';

    if (emailChanged || newPwd) {
      $('prmStatus').textContent = '✅ Mis à jour — reconnecte-toi';
      toast('🔐 Identifiants modifiés. Reconnexion nécessaire.');
      setTimeout(async () => { await sbAuth.auth.signOut(); window.location.href = '/'; }, 1500);
    } else {
      $('prmStatus').textContent = '✅ Enregistré';
      toast('✅ Paramètres mis à jour');
      setTimeout(() => { $('prmStatus').textContent = ''; }, 3000);
    }
  } catch (e) {
    $('prmStatus').textContent = '❌ Erreur : ' + (e.message || e);
  }
}

// === ENTREPRISES (super-admin) ===
// Calcule le MRR (revenu mensuel recurrent) d'une entreprise selon sa formule/cycle/status
function calculateMRR(e) {
  if (!e || e.plan === 'founder') return 0;
  if (e.subscription_status !== 'active') return 0; // trialing = pas encore facturé
  if (e.formule === 'premium' && e.cycle === 'mensuel') return 579;
  if (e.formule === 'standard' && e.cycle === 'mensuel') return 79;
  if (e.formule === 'standard' && e.cycle === 'annuel') return 758 / 12;
  return 0;
}

async function loadPlatformStats() {
  // Fetches un-scoped (service_role donc bypass RLS) pour avoir les stats de TOUTES les entreprises
  try {
    const ymThis = new Date().toISOString().slice(0, 7);
    const ymPrev = (() => { const d = new Date(); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();
    const [cliR, recR, cmdR] = await Promise.all([
      sb.from('clients').select('entreprise_id'),
      sb.from('recettes').select('entreprise_id'),
      sb.from('commandes').select('entreprise_id, montant, semaine_du, statut')
    ]);
    const stats = {};
    DATA.entreprises.forEach(e => {
      stats[e.id] = { clients: 0, recettes: 0, commandes: 0, cmdMois: 0, caMois: 0, lastCmd: null };
    });
    (cliR.data || []).forEach(c => { if (stats[c.entreprise_id]) stats[c.entreprise_id].clients++; });
    (recR.data || []).forEach(r => { if (stats[r.entreprise_id]) stats[r.entreprise_id].recettes++; });
    (cmdR.data || []).forEach(c => {
      const s = stats[c.entreprise_id]; if (!s) return;
      s.commandes++;
      const isMois = (c.semaine_du || '').startsWith(ymThis);
      if (isMois) {
        s.cmdMois++;
        if (c.statut === 'Confirmée') s.caMois += Number(c.montant || 0);
      }
      if (!s.lastCmd || c.semaine_du > s.lastCmd) s.lastCmd = c.semaine_du;
    });
    DATA.platformStats = stats;
    return stats;
  } catch (e) {
    return DATA.platformStats || {};
  }
}

// Genere une barre de progression compacte usage / max avec couleur selon %
function usageBar(used, max, label) {
  const pct = max > 0 ? Math.min(100, Math.round(used / max * 100)) : 0;
  const color = pct >= 90 ? '#c62828' : pct >= 70 ? '#e67e22' : pct >= 40 ? '#2980b9' : '#2e7d32';
  return `<div style="display:flex;flex-direction:column;gap:2px">
    <div style="display:flex;justify-content:space-between;font-size:10px"><span>${escapeHtml(label)}</span><span style="color:${color};font-weight:600">${used}/${max}</span></div>
    <div style="height:4px;background:var(--bgd);border-radius:2px;overflow:hidden"><div style="width:${pct}%;height:100%;background:${color};transition:width .3s"></div></div>
  </div>`;
}

function renderEntreprises() {
  const ents = DATA.entreprises;
  const stats = DATA.platformStats || {};
  // Si pas de stats encore, on les charge en async puis on re-render
  if (!DATA.platformStats) {
    loadPlatformStats().then(() => renderEntreprises());
  }

  const rows = ents.map(e => {
    const s = stats[e.id] || { clients: 0, recettes: 0, commandes: 0 };
    const planBadge = e.plan === 'founder'
      ? '<span class="badge b-att" style="background:#e8f0e9;color:#2d5a3d">👑 Founder</span>'
      : '<span class="badge b-ok">💼 Standard</span>';
    const activeBadge = e.active
      ? '<span class="badge b-ok">✓ Actif</span>'
      : '<span class="badge" style="background:#fdecea;color:#c62828">⏸️ Suspendu</span>';
    const subBadge = subscriptionStatusBadge(e);
    const formuleStr = e.plan === 'founder'
      ? '🎁 Founder'
      : `${e.formule === 'premium' ? '💎 Premium' : '📦 Standard'} · ${e.cycle === 'annuel' ? 'Annuel' : 'Mensuel'}`;
    return `<tr>
      <td><div style="display:flex;align-items:center;gap:10px">
        ${e.logo_url ? `<img src="${escapeHtml(e.logo_url)}" style="width:36px;height:36px;border-radius:8px;object-fit:cover">` : `<div style="width:36px;height:36px;border-radius:8px;background:${escapeHtml(e.couleur_principale || '#3d6b4f')};display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700;font-size:16px">${escapeHtml((e.nom_marque || '?').charAt(0).toUpperCase())}</div>`}
        <div>
          <div style="font-weight:600">${escapeHtml(e.nom_marque)}</div>
          <div style="font-size:11px;color:var(--txl)">${escapeHtml(e.slug)}.mybatch.cooking</div>
        </div>
      </div></td>
      <td>${escapeHtml(e.nom_contact || '–')}</td>
      <td><div style="font-size:12px">${formuleStr}</div>${subBadge}</td>
      <td>${activeBadge}</td>
      <td style="min-width:240px">
        ${e.plan === 'founder'
          ? `<div style="font-size:11px;color:var(--txl)">${s.clients} clientes · ${s.recettes} recettes · ${s.cmdMois} cmd ce mois</div>`
          : `<div style="display:flex;flex-direction:column;gap:5px">
              ${usageBar(s.clients, PLAN_LIMITS.clientes, 'Clientes')}
              ${usageBar(s.recettes, PLAN_LIMITS.recettes, 'Recettes')}
              ${usageBar(s.cmdMois, PLAN_LIMITS.commandes_mois, 'Cmd/mois')}
            </div>`}
      </td>
      <td>${escapeHtml(e.admin_email || '–')}</td>
      <td style="display:flex;gap:6px;flex-wrap:wrap">
        ${e.plan !== 'founder' ? `<button class="btn btn-ghost btn-sm" data-act="pay-link" data-id="${e.id}" title="Générer le lien de paiement Stripe">💳 Lien</button>` : ''}
        <button class="btn btn-ghost btn-sm" data-act="edit-ent" data-id="${e.id}">✏️</button>
        ${e.plan !== 'founder' ? `<button class="btn btn-danger btn-sm" data-act="del-ent" data-id="${e.id}">🗑️</button>` : ''}
      </td>
    </tr>`;
  }).join('');

  // Agrege les usages pour les entreprises non-founder uniquement
  const paying = ents.filter(e => e.plan !== 'founder');
  const aggUsage = paying.reduce((acc, e) => {
    const s = stats[e.id] || {};
    acc.cli += (s.clients || 0);
    acc.rec += (s.recettes || 0);
    acc.cmd += (s.cmdMois || 0);
    return acc;
  }, { cli: 0, rec: 0, cmd: 0 });
  const nb = paying.length || 1;
  const avgCliPct = Math.round((aggUsage.cli / nb) / PLAN_LIMITS.clientes * 100);
  const avgRecPct = Math.round((aggUsage.rec / nb) / PLAN_LIMITS.recettes * 100);
  const avgCmdPct = Math.round((aggUsage.cmd / nb) / PLAN_LIMITS.commandes_mois * 100);

  // Compte par statut subscription
  const byStatus = { trialing: 0, active: 0, past_due: 0, canceled: 0, pending: 0 };
  paying.forEach(e => { if (byStatus[e.subscription_status] !== undefined) byStatus[e.subscription_status]++; });

  const heavyUsers = paying.filter(e => {
    const s = stats[e.id] || {};
    return (s.clients / PLAN_LIMITS.clientes) >= 0.8
      || (s.recettes / PLAN_LIMITS.recettes) >= 0.8
      || (s.cmdMois / PLAN_LIMITS.commandes_mois) >= 0.8;
  });

  showContent(`<div class="card" style="margin-bottom:18px">
    <div class="card-head"><div class="card-tit">📊 Vue plateforme</div></div>
    <div class="stats-row" style="margin-bottom:14px">
      <div class="stat-card">
        <div class="stat-val">${paying.length}</div>
        <div class="stat-lbl">Cuisinières payantes</div>
        <div style="font-size:11px;color:var(--txl);margin-top:4px">${byStatus.trialing} essai · ${byStatus.active} actives · ${byStatus.past_due} en retard</div>
      </div>
      <div class="stat-card">
        <div class="stat-val" style="color:${avgCliPct >= 80 ? '#c62828' : avgCliPct >= 50 ? '#e67e22' : '#2e7d32'}">${avgCliPct}%</div>
        <div class="stat-lbl">Usage moyen clientes</div>
        <div style="font-size:11px;color:var(--txl);margin-top:4px">${Math.round(aggUsage.cli / nb)} sur ${PLAN_LIMITS.clientes} max</div>
      </div>
      <div class="stat-card">
        <div class="stat-val" style="color:${avgRecPct >= 80 ? '#c62828' : avgRecPct >= 50 ? '#e67e22' : '#2e7d32'}">${avgRecPct}%</div>
        <div class="stat-lbl">Usage moyen recettes</div>
        <div style="font-size:11px;color:var(--txl);margin-top:4px">${Math.round(aggUsage.rec / nb)} sur ${PLAN_LIMITS.recettes} max</div>
      </div>
      <div class="stat-card">
        <div class="stat-val" style="color:${avgCmdPct >= 80 ? '#c62828' : avgCmdPct >= 50 ? '#e67e22' : '#2e7d32'}">${avgCmdPct}%</div>
        <div class="stat-lbl">Usage moyen cmd/mois</div>
        <div style="font-size:11px;color:var(--txl);margin-top:4px">${Math.round(aggUsage.cmd / nb)} sur ${PLAN_LIMITS.commandes_mois} max</div>
      </div>
    </div>
    ${heavyUsers.length ? `<div style="background:#fff3cd;border-left:4px solid #f6c343;border-radius:10px;padding:12px 16px;font-size:13px;color:#8a6a1a">
      ⚠️ <strong>${heavyUsers.length} cuisinière${heavyUsers.length > 1 ? 's' : ''} à >80% d'usage</strong> sur au moins une limite : ${heavyUsers.map(e => escapeHtml(e.nom_marque)).join(', ')}. Envisager un upgrade Premium ou ajuster les plafonds.
    </div>` : `<div style="background:#e8f5e9;border-left:4px solid #2e7d32;border-radius:10px;padding:12px 16px;font-size:13px;color:#2e7d32">
      ✓ Aucune cuisinière n'approche ses limites. Plafonds confortables.
    </div>`}
  </div>

  <div class="card">
    <div class="card-head">
      <div class="card-tit">🏢 Entreprises <span>${ents.length}</span></div>
      <button class="btn btn-primary" id="btnNewEnt">+ Nouvelle cuisinière</button>
    </div>
    <p style="font-size:13px;color:var(--txm);margin-bottom:14px">Crée un compte pour onboarder une nouvelle cuisinière. La colonne "Usage" montre où chaque cuisinière en est par rapport aux limites du plan.</p>
    <div class="tbl-wrap"><table class="tbl">
      <thead><tr><th>Cuisinière</th><th>Contact</th><th>Formule</th><th>Statut</th><th>Usage</th><th>Email</th><th>Actions</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="empty">Aucune cuisinière</td></tr>'}</tbody>
    </table></div>
  </div>`);

  $('btnNewEnt').addEventListener('click', nouvelleEntreprise);
  $('content').querySelectorAll('[data-act="edit-ent"]').forEach(b => b.addEventListener('click', () => editerEntreprise(b.dataset.id)));
  $('content').querySelectorAll('[data-act="del-ent"]').forEach(b => b.addEventListener('click', () => supprimerEntreprise(b.dataset.id)));
  $('content').querySelectorAll('[data-act="pay-link"]').forEach(b => b.addEventListener('click', () => genererLienPaiement(b.dataset.id)));
}

function subscriptionStatusBadge(e) {
  if (e.plan === 'founder') return '<span class="badge b-ok" style="font-size:10px;margin-top:4px;display:inline-block">∞ Gratuit</span>';
  const map = {
    pending: { c: '#8a6a1a', bg: '#fff3cd', l: '⏳ En attente paiement' },
    trialing: { c: '#1565c0', bg: '#e3f2fd', l: '🆓 Essai 7j' },
    active: { c: '#2e7d32', bg: '#e8f5e9', l: '✓ Abo actif' },
    past_due: { c: '#c62828', bg: '#fdecea', l: '⚠️ Paiement échoué' },
    canceled: { c: '#6b6b6b', bg: '#f0f0f0', l: '✗ Annulé' },
    incomplete: { c: '#8a6a1a', bg: '#fff3cd', l: '⚠️ Incomplet' }
  };
  const s = map[e.subscription_status] || map.pending;
  return `<span class="badge" style="background:${s.bg};color:${s.c};font-size:10px;margin-top:4px;display:inline-block">${s.l}</span>`;
}

async function genererLienPaiement(entrepriseId) {
  const e = DATA.entreprises.find(x => x.id === entrepriseId);
  if (!e) return;
  toast('⏳ Génération du lien de paiement...');
  try {
    const { data: { session } } = await sbAuth.auth.getSession();
    if (!session) throw new Error('Session perdue, reconnecte-toi');
    const r = await fetch('/.netlify/functions/stripe-checkout', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ entreprise_id: entrepriseId, access_token: session.access_token })
    });
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || 'Erreur génération lien');
    // Copie l'URL et affiche un dialog
    const txt = `Lien de paiement Stripe pour ${e.nom_marque} :\n\n${data.url}\n\n7 jours d'essai gratuit, puis ${e.formule === 'premium' ? '579€' : '79€'}/${e.cycle === 'annuel' ? 'an' : 'mois'}${e.cycle === 'annuel' ? ' (-20%)' : ''}.\n\nLe lien a été copié dans ton presse-papier.`;
    try { await navigator.clipboard.writeText(data.url); } catch (_) {}
    alert(txt);
  } catch (err) {
    toast('Erreur : ' + (err.message || err));
  }
}

function genererMotDePasse() {
  const adj = ['Belle', 'Douce', 'Verte', 'Soleil', 'Chef', 'Cuisine', 'Recette'];
  const a = adj[Math.floor(Math.random() * adj.length)];
  const n = Math.floor(1000 + Math.random() * 9000);
  return `${a}${n}!`;
}

function togglePlanFields() {
  const isFnd = $('entPlan').value === 'founder';
  $('entFormuleWrap').style.display = isFnd ? 'none' : '';
  $('entCycleWrap').style.display = isFnd ? 'none' : '';
  // Premium n'a que le cycle mensuel
  const cycleSel = $('entCycle');
  if ($('entFormule')?.value === 'premium') {
    cycleSel.value = 'mensuel';
    cycleSel.querySelectorAll('option').forEach(o => { o.disabled = o.value === 'annuel'; });
  } else {
    cycleSel.querySelectorAll('option').forEach(o => { o.disabled = false; });
  }
}

function nouvelleEntreprise() {
  ['entId', 'entContact', 'entNom', 'entSlug', 'entEmail', 'entPwd'].forEach(id => { const el = $(id); if (el) el.value = ''; });
  $('entPlan').value = 'standard';
  $('entFormule').value = 'standard';
  $('entCycle').value = 'mensuel';
  $('entActive').value = 'true';
  $('entActiveWrap').style.display = 'none';
  $('entPwd').value = genererMotDePasse();
  $('modalEntTit').textContent = 'Nouvelle cuisinière';
  $('btnSaveEnt').textContent = '💾 Créer le compte';
  togglePlanFields();
  openModal('modalEntreprise');
}

function editerEntreprise(id) {
  const e = DATA.entreprises.find(x => x.id === id); if (!e) return;
  $('entId').value = id;
  $('entContact').value = e.nom_contact || '';
  $('entNom').value = e.nom_marque || '';
  $('entSlug').value = e.slug || '';
  $('entEmail').value = e.admin_email || '';
  $('entPlan').value = e.plan || 'standard';
  $('entFormule').value = e.formule || 'standard';
  $('entCycle').value = e.cycle || 'mensuel';
  $('entActive').value = e.active ? 'true' : 'false';
  $('entActiveWrap').style.display = '';
  $('entPwd').value = '';
  $('entPwd').placeholder = '(laisser vide pour ne pas changer)';
  $('modalEntTit').textContent = 'Modifier · ' + (e.nom_marque || 'cuisinière');
  $('btnSaveEnt').textContent = '💾 Enregistrer';
  togglePlanFields();
  openModal('modalEntreprise');
}

async function saveEntreprise() {
  const id = $('entId').value;
  const contact = $('entContact').value.trim();
  const nom = $('entNom').value.trim();
  const slug = $('entSlug').value.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const email = $('entEmail').value.trim();
  const pwd = $('entPwd').value.trim();
  if (!contact || !nom || !slug || !email) { toast('⚠️ Tous les champs obligatoires'); return; }
  if (!id && !pwd) { toast('⚠️ Mot de passe obligatoire à la création'); return; }
  // Doublon slug
  const dup = DATA.entreprises.find(e => e.slug === slug && e.id !== id);
  if (dup) { toast('⚠️ Le slug "' + slug + '" est déjà pris'); return; }

  const plan = $('entPlan').value;
  const payload = {
    nom_contact: contact,
    nom_marque: nom,
    slug,
    admin_email: email,
    plan
  };
  if (plan === 'founder') {
    payload.formule = 'standard';
    payload.cycle = 'mensuel';
    payload.subscription_status = 'active';
  } else {
    payload.formule = $('entFormule').value;
    payload.cycle = $('entCycle').value;
    if (!id) payload.subscription_status = 'pending';
  }
  // Note : on ne stocke plus le password en clair dans entreprises (Supabase Auth gere)
  if (id) payload.active = $('entActive').value === 'true';

  try {
    if (id) {
      // Modification : on capture l'ancien email AVANT toute mutation pour
      // pouvoir detecter un changement d'email
      const oldEnt = DATA.entreprises.find(x => x.id === id);
      const oldEmail = oldEnt?.admin_email || '';

      // Si email ou password change, on met a jour le compte Supabase auth associe
      const { data: link } = await sb.from('admins_entreprise')
        .select('user_id').eq('entreprise_id', id).maybeSingle();
      if (link && link.user_id) {
        const authUpdate = {};
        if (email && email !== oldEmail) authUpdate.email = email;
        if (pwd) authUpdate.password = pwd;
        if (Object.keys(authUpdate).length) {
          await adminUpdateAuthUser(link.user_id, authUpdate);
        }
      }

      // Puis on met a jour la ligne entreprises
      const { error } = await sb.from('entreprises').update(payload).eq('id', id);
      if (error) throw error;
      if (oldEnt) Object.assign(oldEnt, payload);
      toast('✅ Cuisinière modifiée');
    } else {
      // Creation : 1) entreprise, 2) compte auth, 3) lien admins_entreprise
      const { data: ent, error } = await sb.from('entreprises').insert({ ...payload, active: true }).select().single();
      if (error) throw error;

      let authUser;
      try {
        authUser = await adminCreateAuthUser({ email, password: pwd, type: 'admin', nom: contact });
      } catch (eAuth) {
        // Rollback : on supprime l'entreprise pour ne pas laisser un orphelin
        await sb.from('entreprises').delete().eq('id', ent.id);
        throw new Error('Creation compte auth echouee : ' + eAuth.message);
      }

      // Le trigger Postgres cree une ligne clients par defaut a chaque user auth.
      // Pour un admin d'entreprise on supprime ces lignes parasites avant de lier.
      await sb.from('clients').delete().eq('id', authUser.id);
      await sb.from('salaries').delete().eq('id', authUser.id);

      const { error: linkErr } = await sb.from('admins_entreprise').insert({
        user_id: authUser.id,
        entreprise_id: ent.id,
        nom: contact
      });
      if (linkErr) {
        // Rollback complet
        await adminDeleteAuthUser(authUser.id);
        await sb.from('entreprises').delete().eq('id', ent.id);
        throw linkErr;
      }

      // Starter pack : copie les ingredients de Le Gout du Lien comme base
      // La nouvelle entreprise peut completer / modifier / supprimer chez elle
      // sans impacter les donnees source. Non bloquant si echec.
      try {
        const lgl = DATA.entreprises.find(x => x.slug === 'legoutdulien');
        if (lgl) {
          const { data: ingsTpl } = await sb.from('ingredients')
            .select('nom, unite_par_defaut, rayon')
            .eq('entreprise_id', lgl.id);
          if (Array.isArray(ingsTpl) && ingsTpl.length) {
            const seed = ingsTpl.map(i => ({ ...i, entreprise_id: ent.id }));
            await sb.from('ingredients').insert(seed);
          }
        }
      } catch (eSeed) { /* silent */ }

      DATA.entreprises.push(ent);
      const url = slug + '.mybatch.cooking';
      const isFounder = plan === 'founder';
      const formuleLabel = payload.formule === 'premium' ? 'Premium' : 'Standard';
      const cycleLabel = payload.cycle === 'annuel' ? 'Annuel (-20%)' : 'Mensuel';
      const billingLine = isFounder
        ? '🎁 Plan : Founder (gratuit à vie)'
        : `💳 Formule : ${formuleLabel} · ${cycleLabel}\n⏳ Statut : compte créé en attente de paiement\n\n👉 Clique ensuite sur "💳 Lien de paiement" sur sa ligne pour générer son lien Stripe (essai 7 jours).`;
      alert(`✅ Compte créé !\n\nÀ communiquer à ${contact} :\n\n📧 Email : ${email}\n🔑 Mot de passe : ${pwd}\n🔗 URL : ${url}\n\n${billingLine}`);
    }
    closeModal('modalEntreprise');
    renderEntreprises();
  } catch (e) {
    toast('Erreur: ' + (e.message || e));
  }
}

async function supprimerEntreprise(id) {
  const e = DATA.entreprises.find(x => x.id === id); if (!e) return;
  if (!confirm(`⚠️ Supprimer "${e.nom_marque}" ?\nTOUTES ses données (clients, recettes, commandes) seront supprimées définitivement.`)) return;
  try {
    // Recupere l'admin auth associe pour le supprimer apres l'entreprise
    const { data: links } = await sb.from('admins_entreprise')
      .select('user_id').eq('entreprise_id', id);

    const { error } = await sb.from('entreprises').delete().eq('id', id);
    if (error) throw error;

    // Supprime les comptes auth admin de cette entreprise
    if (Array.isArray(links)) {
      for (const l of links) {
        if (l.user_id) await adminDeleteAuthUser(l.user_id).catch(() => {});
      }
    }

    DATA.entreprises = DATA.entreprises.filter(x => x.id !== id);
    toast('🗑️ Entreprise supprimée');
    renderEntreprises();
  } catch (e) {
    toast('Erreur: ' + (e.message || e));
  }
}

// Upload logo entreprise
async function uploadEntLogo(file) {
  const btn = $('entBtnUpload'), nom = $('entLogoNom'), preview = $('entLogoPreview');
  btn.textContent = '⏳ Upload...'; btn.disabled = true;
  try {
    const compressed = await compressImage(file, 600, 0.85);
    const blob = compressed || file;
    const ext = compressed ? 'jpg' : ((file.name.split('.').pop() || 'jpg').toLowerCase());
    const ctype = compressed ? 'image/jpeg' : (file.type || 'image/jpeg');
    const filename = `logos/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const { error } = await sb.storage.from(STORAGE_BUCKET).upload(filename, blob, { upsert: false, contentType: ctype });
    if (error) throw error;
    const { data: pub } = sb.storage.from(STORAGE_BUCKET).getPublicUrl(filename);
    $('entLogo').value = pub.publicUrl;
    preview.innerHTML = `<img src="${escapeHtml(pub.publicUrl)}" style="width:100%;height:100%;object-fit:cover">`;
    nom.textContent = file.name;
    toast('✅ Logo uploadé');
  } catch (e) {
    toast('Erreur upload : ' + (e.message || e));
  }
  btn.textContent = '📷 Changer le logo'; btn.disabled = false;
}

// === PARAMETRES CRENEAUX ===
function ouvrirParametresCreneaux() {
  renderParamCreneauxBody();
  openModal('modalParamCreneaux');
}

function renderParamCreneauxBody() {
  const html = JOURS_ORDER.map(jour => {
    const slots = getSlotsForJour(jour);
    return `<div style="border:1.5px solid var(--bgd);border-radius:12px;padding:14px;margin-bottom:10px;background:${slots.length ? 'var(--vp)' : 'var(--bgc)'}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${slots.length ? '10px' : '0'}">
        <div style="font-family:'Cormorant Garamond',serif;font-size:17px;font-weight:600;color:var(--v2)">${jour}</div>
        <button class="btn btn-ghost btn-sm" data-act="add-slot" data-jour="${jour}">+ Ajouter un créneau</button>
      </div>
      ${slots.map(s => `<div style="display:flex;align-items:center;gap:10px;padding:8px 0;border-top:1px solid var(--bgd);font-size:13px">
        <div style="flex:1">
          <div style="font-weight:500;text-transform:capitalize">${escapeHtml(s.nom_slot)}</div>
          <div style="font-size:11px;color:var(--txm)">${escapeHtml(fmtSlotLabel(s.heure_debut, s.heure_fin))}</div>
        </div>
        <button class="btn btn-ghost btn-sm" data-act="edit-slot" data-id="${s.id}">✏️</button>
        <button class="btn btn-danger btn-sm" data-act="del-slot" data-id="${s.id}">🗑️</button>
      </div>`).join('')}
    </div>`;
  }).join('');
  $('paramCreneauxBody').innerHTML = html;
  $('paramCreneauxBody').querySelectorAll('[data-act="add-slot"]').forEach(b => b.addEventListener('click', () => editerSlot(null, b.dataset.jour)));
  $('paramCreneauxBody').querySelectorAll('[data-act="edit-slot"]').forEach(b => b.addEventListener('click', () => editerSlot(b.dataset.id)));
  $('paramCreneauxBody').querySelectorAll('[data-act="del-slot"]').forEach(b => b.addEventListener('click', () => supprimerSlot(b.dataset.id)));
}

function editerSlot(id, defaultJour) {
  const slot = id ? DATA.creneauxTemplate.find(s => s.id === id) : null;
  const jour = slot ? slot.jour : defaultJour;
  const nom = slot ? slot.nom_slot : '';
  const debut = slot ? slot.heure_debut : '09:00';
  const fin = slot ? slot.heure_fin : '12:00';

  const pop = document.createElement('div');
  pop.id = 'slotEditPop';
  pop.className = 'overlay open';
  pop.style.zIndex = '500';
  pop.innerHTML = `<div class="modal" style="max-width:440px">
    <div class="modal-head">
      <div class="modal-tit">${id ? 'Modifier le créneau' : 'Nouveau créneau'}</div>
    </div>
    <div class="form-grid">
      <div class="fg" style="grid-column:1/-1"><label>Jour</label>
        <select id="slotJour">
          ${JOURS_ORDER.map(j => `<option value="${j}" ${j === jour ? 'selected' : ''}>${j}</option>`).join('')}
        </select>
      </div>
      <div class="fg" style="grid-column:1/-1"><label>Nom du créneau</label>
        <input type="text" id="slotNom" value="${escapeAttr(nom)}" placeholder="ex: matin, apmidi, soir...">
      </div>
      <div class="fg"><label>Heure de début</label><input type="time" id="slotDebut" value="${escapeAttr(debut)}"></div>
      <div class="fg"><label>Heure de fin</label><input type="time" id="slotFin" value="${escapeAttr(fin)}"></div>
    </div>
    <div style="margin-top:18px;display:flex;gap:10px">
      <button class="btn btn-primary" id="slotSave" style="flex:1">💾 Enregistrer</button>
      <button class="btn btn-ghost" id="slotCancel">Annuler</button>
    </div>
  </div>`;
  document.body.appendChild(pop);
  pop.querySelector('#slotCancel').addEventListener('click', () => pop.remove());
  pop.querySelector('#slotSave').addEventListener('click', async () => {
    const newJour = $('slotJour').value;
    const newNom = $('slotNom').value.trim().toLowerCase();
    const newDebut = $('slotDebut').value;
    const newFin = $('slotFin').value;
    if (!newNom) { toast('⚠️ Donne un nom au créneau (matin, apmidi, soir...)'); return; }
    if (!newDebut || !newFin) { toast('⚠️ Renseigne les heures'); return; }
    if (newDebut >= newFin) { toast('⚠️ Heure de fin doit être après heure de début'); return; }
    // Check doublon
    const dup = DATA.creneauxTemplate.find(s => s.jour === newJour && s.nom_slot === newNom && s.id !== id);
    if (dup) { toast('⚠️ Un créneau "' + newNom + '" existe déjà pour ' + newJour); return; }
    try {
      const ordreMax = DATA.creneauxTemplate.filter(s => s.jour === newJour).reduce((a, s) => Math.max(a, s.ordre || 0), 0);
      if (id) {
        const { error } = await sb.from('creneaux_template').update({
          jour: newJour, nom_slot: newNom, heure_debut: newDebut, heure_fin: newFin
        }).eq('id', id);
        if (error) throw error;
        const t = DATA.creneauxTemplate.find(s => s.id === id);
        if (t) { t.jour = newJour; t.nom_slot = newNom; t.heure_debut = newDebut; t.heure_fin = newFin; }
      } else {
        const { data, error } = await sb.from('creneaux_template').insert({
          jour: newJour, nom_slot: newNom, heure_debut: newDebut, heure_fin: newFin, ordre: ordreMax + 1, entreprise_id: CURRENT_ENTREPRISE_ID
        }).select().single();
        if (error) throw error;
        DATA.creneauxTemplate.push(data);
      }
      toast('✅ Créneau enregistré');
      pop.remove();
      renderParamCreneauxBody();
      renderCreneaux();
    } catch (e) { toast('Erreur: ' + (e.message || e)); }
  });
}

async function supprimerSlot(id) {
  const slot = DATA.creneauxTemplate.find(s => s.id === id);
  if (!slot) return;
  if (!confirm(`Supprimer le créneau "${slot.nom_slot}" du ${slot.jour} ?`)) return;
  try {
    const { error } = await sb.from('creneaux_template').delete().eq('id', id);
    if (error) throw error;
    DATA.creneauxTemplate = DATA.creneauxTemplate.filter(s => s.id !== id);
    toast('🗑️ Créneau supprimé');
    renderParamCreneauxBody();
    renderCreneaux();
  } catch (e) { toast('Erreur: ' + (e.message || e)); }
}

// --- ARIA ---
function toggleAria() {
  const p = $('ariaPanel'); p.classList.toggle('open');
  if (p.classList.contains('open')) {
    setTimeout(() => $('aInput').focus(), 350);
  } else {
    // Fermeture du panneau : stoppe la voix si elle parlait
    stopAriaSpeech();
  }
}
function buildAriaSys() {
  const now = new Date();
  const semaine = getMonday(0);
  const cmdSem = DATA.commandes.filter(c => (c.semaine_du || '').startsWith(semaine));
  const recFmt = DATA.recettes.map(r => {
    const ings = DATA.ri.filter(x => x.recette_id === r.id).map(x => {
      const ing = DATA.ingredients.find(i => i.id === x.ingredient_id);
      const u = ing && ing.unite_par_defaut !== 'Unité par défaut' ? (ing.unite_par_defaut || '') : '';
      return `${ing ? ing.nom : '?'}${x.quantite_par_portion ? ` (${x.quantite_par_portion}${u ? ' ' + u : ''})` : ''}`;
    });
    return { nom: r.nom_du_plat, cat: catsOf(r).join(', '), actif: r.active, frigo: r.frigo_en_jours, prep: r.instructions_preparation || '', rech: r.instructions_rechauffage || '', cong: r.congelation || '', ings };
  });
  const cmdParSem = {};
  DATA.commandes.forEach(c => {
    const sem = c.semaine_du || '?';
    if (!cmdParSem[sem]) cmdParSem[sem] = [];
    cmdParSem[sem].push(c);
  });
  const cmdSemHtml = Object.entries(cmdParSem).sort((a, b) => b[0].localeCompare(a[0])).map(([sem, cmds]) => {
    return `SEMAINE ${sem} (${cmds.length} cmd):\n` + cmds.map(c => {
      const cli = getClient(c.client_id);
      const sal = getSalarie(c.assigne_a_id);
      const plats = platsOfCommande(c).map(p => p.nom_du_plat);
      return `  - ${cli ? cli.nom : '?'} | ${c.creneau || '?'} | ${plats.join(', ')} | ${c.statut} | Assigne: ${sal ? sal.nom : '–'} | Portions: ${c.nombre_portions || 4}`;
    }).join('\n');
  }).join('\n\n');

  const crenHtml = DATA.creneaux.map(cr => `${cr.semaine}_${cr.slot}: ${cr.actif ? 'ouvert' : 'FERME'}`).join(' | ') || 'aucun configure';
  const clientsHtml = DATA.clients.map(c => `${c.nom || ''} | ${c.email || ''} | ${c.telephone || ''} | ${c.adresse || ''}`).join('\n');
  const salHtml = DATA.salaries.map(s => `${s.nom || ''} | ${s.email || ''}`).join('\n');
  const ingHtml = DATA.ingredients.map(i => `${i.nom} (${i.unite_par_defaut || ''})`).join(', ');

  ariaSys = `Tu es ARIA, assistante intelligente d'Alizee, gerante de "Le Gout du Lien" (batch cooking, 60 euros/sem, 5 plats, 4 portions). Reponds en francais, concis, chaleureux. **Gras** pour les infos cles. Tu as acces a TOUTES les donnees Supabase en temps reel.

AUJOURD'HUI: ${now.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })}
SEMAINE EN COURS: ${semaine}

--- TOUTES LES COMMANDES (${DATA.commandes.length} total) ---
${cmdSemHtml || 'Aucune commande'}

--- RECETTES COMPLETES (${recFmt.length} total) ---
${recFmt.map(r => `- ${r.nom} [${r.cat}] ${r.actif ? '✓ ACTIF' : '✗ INACTIF'}
  Conservation: ${r.frigo}j frigo | Preparation: ${r.prep || '–'}
  Rechauffage: ${r.rech || '–'}
  Ingredients/portion: ${r.ings.join(', ') || '–'}`).join('\n\n')}

--- CLIENTS (${DATA.clients.length}) ---
${clientsHtml || 'Aucun'}

--- SALARIES (${DATA.salaries.length}) ---
${salHtml || 'Aucun'}

--- INGREDIENTS (${DATA.ingredients.length}) ---
${ingHtml || 'Aucun'}

--- CRENEAUX ---
${crenHtml}`;
}

async function reloadAriaData() {
  $('ariaSt').textContent = 'Actualisation...';
  await chargerTout();
  $('ariaSt').textContent = `${DATA.recettes.filter(r => r.active).length} plats · donnees fraiches`;
  addAriaMsg('bot', '🔄 **Donnees actualisees !**');
}

function addAriaMsg(type, text) {
  const div = $('aMsgs');
  const m = document.createElement('div');
  m.className = 'a-msg ' + type;
  const html = escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
  m.innerHTML = `<div class="a-av">${type === 'bot' ? '🌿' : '👤'}</div><div class="a-bub">${html}</div>`;
  div.appendChild(m); div.scrollTop = div.scrollHeight;
}
function addTypingAria() {
  const t = document.createElement('div'); t.className = 'a-msg bot'; t.id = 'atyping';
  t.innerHTML = '<div class="a-av">🌿</div><div class="a-bub"><div class="typing"><span></span><span></span><span></span></div></div>';
  $('aMsgs').appendChild(t); $('aMsgs').scrollTop = $('aMsgs').scrollHeight;
}
function removeTypingAria() { document.getElementById('atyping')?.remove(); }

async function sendAria() {
  const inp = $('aInput'); const msg = inp.value.trim();
  if (!msg || ariaBusy) return;
  inp.value = ''; ariaBusy = true; $('aSend').disabled = true;
  addAriaMsg('user', msg); ariaConv.push({ role: 'user', content: msg }); addTypingAria();
  try {
    const r = await fetch('/.netlify/functions/claude', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-haiku-4-5-20251001', max_tokens: 900, system: ariaSys, messages: ariaConv })
    });
    const d = await r.json();
    removeTypingAria();
    const reply = d.content?.[0]?.text || (d.error ? 'Erreur: ' + d.error.message : 'Pas de reponse.');
    addAriaMsg('bot', reply); ariaConv.push({ role: 'assistant', content: reply });
    if (ariaConv.length > 20) ariaConv = ariaConv.slice(-20);
    speak(reply);
  } catch (e) {
    removeTypingAria(); addAriaMsg('bot', 'Erreur de connexion.');
  }
  ariaBusy = false; $('aSend').disabled = false; inp.focus();
}

function resetAriaConv() {
  ariaConv = []; $('aMsgs').innerHTML = '';
  addAriaMsg('bot', 'Conversation reinitialisee 🌿 Comment puis-je vous aider ?');
}

// Etat de la voix : prefere persiste dans localStorage. Par defaut OFF.
let voiceEnabled = localStorage.getItem('aria-voice-enabled') === '1';
let ariaSpeaking = false;

function updateVoiceBtn() {
  const btn = $('aVoice');
  if (!btn) return;
  btn.classList.remove('on', 'speaking');
  if (ariaSpeaking) {
    btn.classList.add('speaking');
    btn.textContent = '⏹️';
    btn.title = 'ARIA est en train de parler — clic pour stopper';
  } else if (voiceEnabled) {
    btn.classList.add('on');
    btn.textContent = '🔊';
    btn.title = 'Voix activee — clic pour couper';
  } else {
    btn.textContent = '🔇';
    btn.title = 'Voix coupee — clic pour activer';
  }
}

function setVoiceEnabled(on) {
  voiceEnabled = on;
  localStorage.setItem('aria-voice-enabled', on ? '1' : '0');
  updateVoiceBtn();
}

function toggleVoice() {
  // Si ARIA parle, on stoppe la voix immediatement
  if (ariaSpeaking) {
    if (synth) synth.cancel();
    ariaSpeaking = false;
    updateVoiceBtn();
    return;
  }
  setVoiceEnabled(!voiceEnabled);
}

function stopAriaSpeech() {
  if (synth && ariaSpeaking) synth.cancel();
  ariaSpeaking = false;
  updateVoiceBtn();
}

function speak(text) {
  if (!voiceEnabled) return;
  if (!synth) return;
  synth.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/\*\*/g, '').replace(/\n/g, ' '));
  u.lang = 'fr-FR'; u.rate = 1.0;
  const fr = synth.getVoices().find(v => v.lang.startsWith('fr')); if (fr) u.voice = fr;
  u.onstart = () => { ariaSpeaking = true; updateVoiceBtn(); };
  u.onend = () => { ariaSpeaking = false; updateVoiceBtn(); };
  u.onerror = () => { ariaSpeaking = false; updateVoiceBtn(); };
  synth.speak(u);
}
function toggleMic() {
  if (isRec) { stopMic(); return; }
  if (!('webkitSpeechRecognition' in window || 'SpeechRecognition' in window)) {
    addAriaMsg('bot', 'Reconnaissance vocale disponible sur Chrome.'); return;
  }
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  recognition = new SR(); recognition.lang = 'fr-FR'; recognition.continuous = false; recognition.interimResults = false;
  recognition.onstart = () => { isRec = true; $('aMic').classList.add('rec'); $('aMic').textContent = '⏹️'; };
  recognition.onresult = e => {
    // Si l'utilisateur parle, on active automatiquement la voix de sortie
    if (!voiceEnabled) setVoiceEnabled(true);
    $('aInput').value = e.results[0][0].transcript;
    stopMic();
    sendAria();
  };
  recognition.onerror = recognition.onend = () => stopMic();
  recognition.start();
}
function stopMic() { isRec = false; $('aMic').classList.remove('rec'); $('aMic').textContent = '🎤'; recognition?.stop(); }

// --- BIND EVENTS ---
document.addEventListener('DOMContentLoaded', () => {
  $('btnLogout').addEventListener('click', logout);

  document.querySelectorAll('.tab').forEach(t => t.addEventListener('click', () => showTab(t.dataset.tab)));
  document.querySelectorAll('[data-close]').forEach(b => b.addEventListener('click', () => closeModal(b.dataset.close)));

  $('btnSaveRec').addEventListener('click', saveRecette);
  $('btnSaveCli').addEventListener('click', saveClient);
  $('btnSaveSal').addEventListener('click', saveSalarie);
  $('btnSaveCmd').addEventListener('click', saveCommande);
  $('btnSaveEnt').addEventListener('click', saveEntreprise);
  $('entPwdGen')?.addEventListener('click', () => { $('entPwd').value = genererMotDePasse(); });
  $('entPlan')?.addEventListener('change', togglePlanFields);
  $('entFormule')?.addEventListener('change', togglePlanFields);
  $('btnAddIng').addEventListener('click', ajouterIngRow);
  $('btnUpload').addEventListener('click', uploadPhoto);
  $('rPhotoFile').addEventListener('change', (e) => handlePhotoFile(e.target));
  // Drag & drop sur la zone photo
  const dz = $('photoDropzone');
  if (dz) {
    ['dragenter', 'dragover'].forEach(evt => dz.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.style.borderColor = 'var(--v3)';
      dz.style.background = 'var(--vp)';
    }));
    ['dragleave', 'dragend'].forEach(evt => dz.addEventListener(evt, (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.style.borderColor = 'var(--bgd)';
      dz.style.background = '';
    }));
    dz.addEventListener('drop', (e) => {
      e.preventDefault(); e.stopPropagation();
      dz.style.borderColor = 'var(--bgd)';
      dz.style.background = '';
      const file = e.dataTransfer?.files?.[0];
      if (!file) return;
      if (!file.type.startsWith('image/')) { toast('⚠️ Glissez une image'); return; }
      const input = $('rPhotoFile');
      const dt = new DataTransfer();
      dt.items.add(file);
      input.files = dt.files;
      handlePhotoFile(input);
    });
  }

  $('ariaFab').addEventListener('click', toggleAria);
  $('ariaClose').addEventListener('click', toggleAria);
  $('ariaReload').addEventListener('click', reloadAriaData);
  $('aReload2').addEventListener('click', reloadAriaData);
  $('ariaReset').addEventListener('click', resetAriaConv);
  $('aSend').addEventListener('click', sendAria);
  $('aMic').addEventListener('click', toggleMic);
  $('aVoice').addEventListener('click', toggleVoice);
  updateVoiceBtn();
  $('aInput').addEventListener('keydown', e => { if (e.key === 'Enter') sendAria(); });
  $('aSugs').querySelectorAll('.a-sug').forEach(b => b.addEventListener('click', () => { $('aInput').value = b.textContent.trim(); sendAria(); }));

  // Verification de session admin -> charge le dashboard ou redirige vers /
  loadAdminFromSession();
});
