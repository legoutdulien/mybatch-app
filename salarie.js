// salarie.js — Espace salarie
// Le Gout du Lien
// Backend: Supabase (auth + Postgres + Storage)

const SUPABASE_URL = 'https://loiaubdlhkcnohtbwtxg.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxvaWF1YmRsaGtjbm9odGJ3dHhnIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzcxMzU1NDAsImV4cCI6MjA5MjcxMTU0MH0.2S2xnnpFT-kcblTzSC_x2ybSUUipUi5jMPe_DbNBUcA';

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Ecriture RLS verifiee : sans .select(), un UPDATE/DELETE touchant 0 ligne (juste apres login,
// JWT pas encore propage -> auth.uid() NULL -> RLS filtre la ligne) renvoie error=null = faux succes
// silencieux. writeVerified execute la requete (qui DOIT finir par .select('id')) ; si 0 ligne il
// rafraichit la session et reessaie 1x, sinon il leve une vraie erreur visible.
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

// recettes_ingredients peut depasser 1000 lignes (limite PostgREST) -> pagination
async function fetchAllRI() {
  const all = []; const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb.from('recettes_ingredients').select('id, recette_id, ingredient_id, quantite_par_portion, ordre, unite').order('id', { ascending: true }).range(from, from + PAGE - 1);
    if (error) return { data: null, error };
    all.push(...(data || []));
    if (!data || data.length < PAGE) break;
  }
  return { data: all, error: null };
}

// Elements d'une commande : nouveau format `items` (JSONB) sinon repli sur plat_1..5
function cmdPlatIds(cmd) {
  if (cmd && Array.isArray(cmd.items) && cmd.items.length) return cmd.items.map(it => it.recette_id).filter(Boolean);
  return [cmd.plat_1_id, cmd.plat_2_id, cmd.plat_3_id, cmd.plat_4_id, cmd.plat_5_id].filter(Boolean);
}

let salarieProfile = null;
let recettes = [];
let ingredients = [];
let recettesIngredients = [];
let allCommandesAssignees = [];
let creneauxTemplate = [];
let curView = 'liste';

// --- helpers UI ---
const $ = (id) => document.getElementById(id);
const showLoad = () => $('lov').style.display = 'flex';
const hideLoad = () => $('lov').style.display = 'none';
const showErr = (msg) => { const e = $('lerr'); e.textContent = msg; e.style.display = 'block'; };
const hideErr = () => { $('lerr').style.display = 'none'; };

function showToast(msg, type) {
  const t = document.createElement('div');
  t.style.cssText = "position:fixed;bottom:30px;left:50%;transform:translateX(-50%);padding:12px 22px;border-radius:10px;font-size:14px;z-index:9999;box-shadow:0 4px 20px rgba(0,0,0,.25);color:#fff;font-family:'DM Sans',sans-serif;transition:opacity .3s;max-width:90vw;text-align:center";
  t.style.background = type === 'ok' ? '#3d6b4f' : type === 'err' ? '#c62828' : '#2c2c2c';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.style.opacity = '0', 3500);
  setTimeout(() => t.remove(), 4000);
}

// --- helpers semaines ---
function getLundis() {
  const res = [];
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth(), d = now.getDate();
  const dow = new Date(y, m, d).getDay();
  const nextMon = dow === 1 ? 0 : (8 - dow) % 7;
  for (let i = -2; i < 6; i++) {
    const l = new Date(y, m, d + nextMon + i * 7);
    const yy = l.getFullYear();
    const mm = String(l.getMonth() + 1).padStart(2, '0');
    const dd = String(l.getDate()).padStart(2, '0');
    res.push({ id: `${yy}-${mm}-${dd}`, label: l.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' }) });
  }
  return res;
}

// --- login / logout ---
async function login() {
  hideErr();
  const email = $('iEmail').value.trim();
  const mdp = $('iMdp').value.trim();
  if (!email || !mdp) return showErr('Remplissez tous les champs.');
  showLoad();
  try {
    const { data: auth, error: authErr } = await sb.auth.signInWithPassword({ email, password: mdp });
    if (authErr) throw new Error('Email ou mot de passe incorrect.');
    const { data: profile, error: pErr } = await sb.from('salaries').select('*').eq('id', auth.user.id).single();
    if (pErr || !profile) {
      await sb.auth.signOut();
      throw new Error("Ce compte n'est pas un compte salarie.");
    }
    salarieProfile = profile;
    await initSalarie();
  } catch (e) {
    showErr(msgErr(e));
  } finally {
    hideLoad();
  }
}

async function logout() {
  await sb.auth.signOut();
  window.location.href = '/';
}

// --- init dashboard ---
async function initSalarie() {
  // Garde-fou : sans profil valide, on repart au login (evite un portail casse)
  if (!salarieProfile || !salarieProfile.id) { window.location.href = '/'; return; }
  await loadBrandingPartner();
  const prenom = (salarieProfile.nom || '').split(' ')[0];
  $('welcomeTxt').textContent = `Bonjour ${prenom}`;
  const dateEl = $('welcomeDate');
  if (dateEl) dateEl.textContent = new Date().toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });

  const sel = $('semSelect');
  sel.innerHTML = '<option value="all" selected>📋 Toutes mes missions</option>';
  const lundis = getLundis();
  lundis.forEach((s) => {
    const opt = document.createElement('option');
    opt.value = s.id;
    opt.textContent = 'Semaine du ' + s.label;
    sel.appendChild(opt);
  });

  $('pLogin').style.display = 'none';
  $('pSalarie').style.display = 'block';

  showLoad();
  try {
    const [recRes, riRes, ingRes, cmdRes, ctRes] = await Promise.all([
      sb.from('recettes').select('id, nom_du_plat, instructions_preparation, photo_url'),
      fetchAllRI(),
      sb.from('ingredients').select('id, nom, unite_par_defaut, rayon'),
      sb.from('commandes')
        .select(`
          id, semaine_du, creneau, slot_key, statut,
          plat_1_id, plat_2_id, plat_3_id, plat_4_id, plat_5_id, items,
          nombre_portions, assigne_a_id,
          client:clients(id, nom, email, telephone, adresse, notes)
        `)
        .eq('assigne_a_id', salarieProfile.id)
        .order('semaine_du', { ascending: false }),
      sb.from('creneaux_template').select('*')
    ]);
    if (recRes.error) throw recRes.error;
    if (riRes.error) throw riRes.error;
    if (ingRes.error) throw ingRes.error;
    if (cmdRes.error) throw cmdRes.error;

    recettes = recRes.data || [];
    recettesIngredients = riRes.data || [];
    ingredients = ingRes.data || [];
    creneauxTemplate = ctRes.data || [];
    allCommandesAssignees = cmdRes.data || [];

    initCalSelects();
    chargerMissions();
    // Chaque module est isole : s'il echoue, il ne casse pas le reste du portail
    try { setupPartnerTabs(); } catch (e) { console.error('tabs', e); }
    try { await loadNotifs(); } catch (e) { console.error('notifs', e); }
    try { setupRealtimeNotifs(); } catch (e) { console.error('realtime', e); }
  } catch (e) {
    $('missionsDiv').innerHTML = `<p style="color:red;padding:20px">⚠️ ${msgErr(e)}</p>`;
  } finally {
    hideLoad();
  }
}

let realtimeChannel = null;
let notifsList = [];

async function loadNotifs() {
  if (!salarieProfile) return;
  const { data } = await sb.from('notifications')
    .select('*')
    .eq('recipient_id', salarieProfile.id)
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
  if (realtimeChannel || !salarieProfile) return;
  realtimeChannel = sb.channel(`partenaire-${salarieProfile.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `recipient_id=eq.${salarieProfile.id}` }, (payload) => {
      notifsList.unshift(payload.new);
      if (notifsList.length > 20) notifsList.pop();
      renderBell();
      showToast('🔔 ' + payload.new.title, 'ok');
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'commandes' }, async (payload) => {
      const old = payload.old || {}, neu = payload.new || {};
      if (neu.assigne_a_id === salarieProfile.id && old.assigne_a_id !== salarieProfile.id) {
        await refetchMissions();
      }
    })
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'commandes' }, async (payload) => {
      if (payload.new && payload.new.assigne_a_id === salarieProfile.id) {
        await refetchMissions();
      }
    })
    .subscribe();
}

async function refetchMissions() {
  if (!salarieProfile) return;
  const { data } = await sb.from('commandes')
    .select(`id, semaine_du, creneau, statut, plat_1_id, plat_2_id, plat_3_id, plat_4_id, plat_5_id, items, nombre_portions, assigne_a_id, client:clients(id, nom, email, telephone, adresse, notes)`)
    .eq('assigne_a_id', salarieProfile.id)
    .order('semaine_du', { ascending: false });
  allCommandesAssignees = data || [];
  chargerMissions();
}

// --- rendu missions ---
function getRecette(id) {
  return recettes.find(r => r.id === id) || null;
}
function getIngredient(id) {
  return ingredients.find(i => i.id === id) || null;
}
function getIngredientsForRecette(recetteId) {
  return recettesIngredients
    .filter(ri => ri.recette_id === recetteId)
    .sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
}

let currentMissions = [];

function chargerMissions() {
  const semId = $('semSelect').value;
  const mesMissions = (semId === 'all' || !semId)
    ? [...allCommandesAssignees]
    : allCommandesAssignees.filter(c => (c.semaine_du || '').startsWith(semId));
  currentMissions = mesMissions;
  const confirmees = mesMissions.filter(c => c.statut === 'Confirmée').length;
  const totalPortions = mesMissions.reduce((a, c) => a + (c.nombre_portions || 4) * 5, 0);

  $('statsRow').innerHTML = `
    <div class="stat-card"><div class="stat-num">${mesMissions.length}</div><div class="stat-lbl">Mission${mesMissions.length > 1 ? 's' : ''}</div></div>
    <div class="stat-card"><div class="stat-num">${mesMissions.length * 5}</div><div class="stat-lbl">Plats a preparer</div></div>
    <div class="stat-card"><div class="stat-num">${confirmees}</div><div class="stat-lbl">Confirmee${confirmees > 1 ? 's' : ''}</div></div>
    <div class="stat-card"><div class="stat-num">${totalPortions}</div><div class="stat-lbl">Portions totales</div></div>`;

  if (mesMissions.length === 0) {
    $('missionsDiv').innerHTML = `<div class="empty"><div class="empty-icon">🗓️</div><p>Aucune mission assignee pour cette semaine.</p></div>`;
    return;
  }

  $('missionsDiv').innerHTML = mesMissions.map((cmd, idx) => {
    const platIds = cmdPlatIds(cmd);
    const plats = platIds.map(getRecette).filter(Boolean);
    const cl = cmd.client || {};
    const crenParts = (cmd.creneau || '').split('·');
    const crenJour = (crenParts[0] || '').trim();
    const crenHeure = (crenParts[1] || '').trim();
    const ok = cmd.statut === 'Confirmée';

    return `<div class="mission-card" data-idx="${idx}" style="cursor:pointer;background:var(--wh);border:1.5px solid var(--bgd);border-radius:14px;padding:14px 16px;margin-bottom:12px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px;flex-wrap:wrap">
        <div style="font-size:16px;font-weight:600">👤 ${escapeHtml(cl.nom || '–')}</div>
        <span style="background:${ok ? '#e8f5e9' : '#fff8e1'};color:${ok ? '#2e7d32' : '#f57f17'};padding:4px 12px;border-radius:20px;font-size:12px;font-weight:600">${ok ? '✓ Confirmée' : '⏳ À confirmer'}</span>
      </div>
      <div style="display:flex;flex-wrap:wrap;gap:10px;font-size:12px;color:var(--txl);margin-bottom:8px">
        <span>📅 ${escapeHtml(cmd.creneau || '–')}</span>
        <span>🍽️ ${cmd.nombre_portions || 4} portions</span>
      </div>
      ${cl.adresse ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(cl.adresse)}" target="_blank" rel="noopener" data-stop="1" style="display:block;font-size:13px;color:var(--vert);text-decoration:none;margin-bottom:3px">📍 ${escapeHtml(cl.adresse)}</a>` : ''}
      ${cl.telephone ? `<a href="tel:${escapeAttr((cl.telephone || '').replace(/\s/g, ''))}" data-stop="1" style="display:block;font-size:13px;color:var(--vert);text-decoration:none;margin-bottom:8px">📞 ${escapeHtml(cl.telephone)}</a>` : ''}
      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px">${plats.map(p => `<span style="background:var(--vp);color:var(--vert);padding:3px 9px;border-radius:12px;font-size:12px">${escapeHtml(p.nom_du_plat)}</span>`).join('') || '<span style="font-size:12px;color:var(--txl)">Aucun plat</span>'}</div>
      ${cmd.message_client ? `<div style="background:#fff3cd;border-left:3px solid #f6c343;border-radius:8px;padding:8px 10px;font-size:12px;color:#6b5818;margin-bottom:8px">💬 ${escapeHtml(cmd.message_client)}</div>` : ''}
      <div style="text-align:right;font-size:13px;color:var(--vert);font-weight:600">Voir le détail &amp; photos ›</div>
    </div>`;
  }).join('');

  $('missionsDiv').querySelectorAll('.mission-card').forEach(el => {
    el.querySelectorAll('[data-stop]').forEach(a => a.addEventListener('click', e => e.stopPropagation()));
    el.addEventListener('click', () => voirMissionComplete(parseInt(el.dataset.idx, 10)));
  });
}

function voirMissionComplete(idx) {
  const cmd = currentMissions[idx]; if (!cmd) return;
  const platIds = cmdPlatIds(cmd);
  const plats = platIds.map(getRecette).filter(Boolean);
  const cl = cmd.client || {};
  const crenParts = (cmd.creneau || '').split('·');
  const crenJour = (crenParts[0] || '').trim();
  const crenHeure = (crenParts[1] || '').trim();
  const portions = cmd.nombre_portions || 4;
  const ok = cmd.statut === 'Confirmée';

  let mbg = document.getElementById('missionMbg');
  if (!mbg) {
    mbg = document.createElement('div');
    mbg.id = 'missionMbg';
    mbg.className = 'mbg';
    mbg.innerHTML = '<div class="mbox" id="missionMbox" style="padding:0;overflow:hidden;max-width:600px"></div>';
    document.body.appendChild(mbg);
    mbg.addEventListener('click', (e) => { if (e.target === mbg) mbg.classList.remove('show'); });
  }
  document.getElementById('missionMbox').innerHTML = `
    <div style="background:linear-gradient(135deg,var(--vert),var(--vc));color:#fff;padding:24px 26px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:14px">
        <div>
          <div style="font-size:13px;font-weight:600;margin-bottom:2px">${escapeHtml(crenJour)}</div>
          <div style="font-family:'Cormorant Garamond',serif;font-size:24px;font-weight:600">🕐 ${escapeHtml(crenHeure)}</div>
        </div>
        <span style="background:rgba(255,255,255,.2);color:#fff;padding:5px 14px;border-radius:20px;font-size:12px;font-weight:500;white-space:nowrap">${ok ? '✓ Confirmee' : '⏳ En attente'}</span>
      </div>
    </div>
    <div style="padding:22px;max-height:75vh;overflow-y:auto">
      <div style="background:var(--bg);border-radius:12px;padding:14px 16px;margin-bottom:18px">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--txl);margin-bottom:6px">Cliente</div>
        <div style="font-size:17px;font-weight:600;margin-bottom:6px">👤 ${escapeHtml(cl.nom || '–')}</div>
        ${cl.telephone ? `<div style="font-size:14px;margin-bottom:4px">📞 <a href="tel:${encodeURIComponent(cl.telephone)}" style="color:var(--vert);font-weight:500;text-decoration:none">${escapeHtml(cl.telephone)}</a></div>` : ''}
        ${cl.adresse ? `<div style="font-size:14px"><a href="https://maps.google.com?q=${encodeURIComponent(cl.adresse)}" target="_blank" rel="noopener" style="color:var(--vert);text-decoration:none">📍 ${escapeHtml(cl.adresse)} (Google Maps)</a></div>` : ''}
        ${cl.notes ? `<div style="font-size:12px;color:var(--txl);margin-top:8px;padding-top:8px;border-top:1px solid var(--bgd);font-style:italic">📝 ${escapeHtml(cl.notes)}</div>` : ''}
      </div>
      <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--txl);margin-bottom:10px;font-weight:600">${plats.length} plats à préparer (${portions} portions chacun)</div>
      ${plats.map(rec => renderPlatComplet(rec, portions)).join('')}
      <div style="margin:6px 0 16px;padding-top:12px;border-top:1px solid var(--bgd)">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--txl);margin-bottom:8px;font-weight:600">📷 Photos des plats préparés <span style="font-weight:400;text-transform:none">· gardées 14 jours, visibles par ${escapeHtml(entrepriseNom)}</span></div>
        <div id="missionPhotosList" style="display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px"><span style="font-size:12px;color:var(--txl)">Chargement…</span></div>
        <label id="missionPhotoLbl" style="display:inline-block;padding:9px 14px;background:var(--vp);color:var(--vert);border:1.5px solid var(--vert);border-radius:9px;font-size:13px;font-weight:600;cursor:pointer">➕ Ajouter une photo<input id="missionPhotoInput" type="file" accept="image/*" capture="environment" style="display:none"></label>
      </div>
      ${!ok ? `<button id="missionConfirmBtn" style="width:100%;padding:13px;background:var(--vert);color:#fff;border:none;border-radius:10px;font-family:'DM Sans',sans-serif;font-size:14px;font-weight:600;cursor:pointer;margin-bottom:8px">✓ Confirmer cette commande</button>` : ''}
      <button class="mclose" id="missionMboxClose" style="margin-top:6px">Fermer</button>
    </div>`;
  mbg.classList.add('show');
  document.getElementById('missionMboxClose').addEventListener('click', () => mbg.classList.remove('show'));
  { const cbtn = document.getElementById('missionConfirmBtn'); if (cbtn) cbtn.addEventListener('click', () => confirmerCommandePartner(cmd.id, mbg)); }
  refreshMissionPhotos(cmd.id);
  { const pin = document.getElementById('missionPhotoInput'), plbl = document.getElementById('missionPhotoLbl');
    if (pin) pin.addEventListener('change', async (ev) => { const f = ev.target.files && ev.target.files[0]; if (f) await uploadMissionPhoto(f, cmd.id, plbl); ev.target.value = ''; }); }
}

async function confirmerCommandePartner(id, mbg) {
  try {
    await writeVerified(() => sb.from('commandes').update({ statut: 'Confirmée' }).eq('id', id).select('id'));
    const c = allCommandesAssignees.find(x => x.id === id);
    if (c) c.statut = 'Confirmée';
    if (mbg) mbg.classList.remove('show');
    chargerMissions();
    alert('✅ Commande confirmée');
  } catch (e) { alert('⚠️ ' + msgErr(e)); }
}

function renderPlatComplet(rec, portions) {
  const ings = getIngredientsForRecette(rec.id);
  const prep = rec.instructions_preparation || '';
  return `<div style="background:var(--wh);border:1.5px solid var(--bgd);border-radius:12px;overflow:hidden;margin-bottom:14px">
    ${rec.photo_url ? `<img src="${escapeAttr(rec.photo_url)}" alt="${escapeAttr(rec.nom_du_plat)}" style="width:100%;height:140px;object-fit:cover;display:block">` : ''}
    <div style="padding:14px 16px">
      <div style="font-family:'Cormorant Garamond',serif;font-size:18px;font-weight:600;color:var(--vert);margin-bottom:10px">🍽️ ${escapeHtml(rec.nom_du_plat)}</div>
      ${prep ? `<div style="background:#fff8e7;border-left:3px solid #f9c74f;border-radius:8px;padding:10px 12px;margin-bottom:12px"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#8a7a3a;font-weight:600;margin-bottom:4px">👩‍🍳 Préparation</div><div style="font-size:12px;line-height:1.6;white-space:pre-line">${escapeHtml(prep)}</div></div>` : ''}
      ${ings.length ? `<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--txl);margin-bottom:6px;font-weight:600">🥕 Ingrédients (${portions} portions)</div>
      ${ings.map(ri => {
        const ing = getIngredient(ri.ingredient_id); if (!ing) return '';
        const qte = (ri.quantite_par_portion || 0) * (rec.quantite_fixe ? 1 : portions);
        const u = riUnite(ri, ing);
        return `<div style="display:flex;justify-content:space-between;padding:5px 0;border-bottom:1px solid var(--bgd);font-size:13px"><span>${escapeHtml(ing.nom)}${ing.rayon ? ` <span style="font-size:10px;color:var(--txl)">(${escapeHtml(ing.rayon)})</span>` : ''}</span><span style="color:var(--vert);font-weight:600">${qte > 0 ? (Number.isInteger(qte) ? qte : qte.toFixed(2)) + (u ? ' ' + u : '') : '–'}</span></div>`;
      }).join('')}` : '<p style="color:var(--txl);font-size:12px">Pas d\'ingredients renseignes</p>'}
      ${rec.instructions_rechauffage ? `<div style="background:var(--vp);border-radius:8px;padding:8px 11px;margin-top:10px;font-size:12px"><strong style="color:var(--vert)">🔥 Réchauffage :</strong> ${escapeHtml(rec.instructions_rechauffage)}</div>` : ''}
      ${rec.frigo_en_jours ? `<div style="font-size:11px;color:var(--txl);margin-top:6px">❄️ ${rec.frigo_en_jours} jours au réfrigérateur</div>` : ''}
    </div>
  </div>`;
}

function voirPlatDetailModal(recetteId, portions) {
  const rec = getRecette(recetteId); if (!rec) return;
  const ings = getIngredientsForRecette(recetteId);
  const prep = rec.instructions_preparation || '';
  let mbg = document.getElementById('salPlatMbg');
  if (!mbg) {
    mbg = document.createElement('div');
    mbg.id = 'salPlatMbg';
    mbg.className = 'mbg';
    mbg.innerHTML = '<div class="mbox" id="salPlatMbox" style="padding:0;overflow:hidden"></div>';
    document.body.appendChild(mbg);
    mbg.addEventListener('click', (e) => { if (e.target === mbg) mbg.classList.remove('show'); });
  }
  document.getElementById('salPlatMbox').innerHTML = `
    ${rec.photo_url ? `<img src="${escapeAttr(rec.photo_url)}" alt="${escapeAttr(rec.nom_du_plat)}" style="width:100%;height:180px;object-fit:cover;display:block">` : '<div style="height:80px;background:linear-gradient(135deg,var(--bgd),var(--vp))"></div>'}
    <div style="padding:22px">
      <div style="font-family:'Cormorant Garamond',serif;font-size:22px;font-weight:600;margin-bottom:6px;color:var(--vert)">${escapeHtml(rec.nom_du_plat)}</div>
      <div style="font-size:12px;color:var(--txl);margin-bottom:14px">Pour ${portions} portions</div>
      ${prep ? `<div style="background:#fff8e7;border-left:3px solid #f9c74f;border-radius:8px;padding:12px 14px;margin-bottom:14px">
        <div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#8a7a3a;font-weight:600;margin-bottom:6px">👩‍🍳 Preparation</div>
        <div style="font-size:13px;line-height:1.6;white-space:pre-line">${escapeHtml(prep)}</div>
      </div>` : ''}
      ${ings.length ? `<div style="font-size:11px;text-transform:uppercase;letter-spacing:.5px;color:var(--txl);margin-bottom:8px;font-weight:600">🥕 Ingredients (pour ${portions} portions)</div>
      <div style="display:flex;flex-direction:column;gap:0;margin-bottom:14px">
        ${ings.map(ri => {
          const ing = getIngredient(ri.ingredient_id); if (!ing) return '';
          const qte = (ri.quantite_par_portion || 0) * (rec.quantite_fixe ? 1 : portions);
          const u = riUnite(ri, ing);
          return `<div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px solid var(--bgd);font-size:13px"><span>${escapeHtml(ing.nom)}${ing.rayon ? ` <span style="font-size:10px;color:var(--txl)">(${escapeHtml(ing.rayon)})</span>` : ''}</span><span style="color:var(--vert);font-weight:600">${qte > 0 ? (Number.isInteger(qte) ? qte : qte.toFixed(2)) + (u ? ' ' + u : '') : '–'}</span></div>`;
        }).join('')}
      </div>` : '<p style="color:var(--txl);font-size:13px;margin-bottom:14px">Pas d\'ingredients renseignes</p>'}
      ${rec.instructions_rechauffage ? `<div style="background:var(--vp);border-radius:8px;padding:10px 12px;margin-bottom:8px;font-size:12px"><strong style="color:var(--vert)">🔥 Rechauffage :</strong> ${escapeHtml(rec.instructions_rechauffage)}</div>` : ''}
      ${rec.frigo_en_jours ? `<div style="font-size:12px;color:var(--txl);margin-bottom:14px">❄️ Conservation : ${rec.frigo_en_jours} jours au refrigerateur</div>` : ''}
      <button class="mclose" id="salPlatClose">Fermer</button>
    </div>`;
  mbg.classList.add('show');
  document.getElementById('salPlatClose').addEventListener('click', () => mbg.classList.remove('show'));
}

function renderPlat(recette, mIdx, pIdx, portions) {
  const ings = getIngredientsForRecette(recette.id);
  const img = recette.photo_url || '';
  const prep = recette.instructions_preparation || '';
  return `<div class="plat-item">
    ${img ? `<img src="${escapeAttr(img)}" style="width:100%;height:90px;object-fit:cover;border-radius:8px 8px 0 0;display:block" onerror="this.style.display='none'">` : ''}
    <div class="plat-header" data-target="ing-${mIdx}-${pIdx}">
      <span>🍽️ ${escapeHtml(recette.nom_du_plat)}</span>
      <span class="plat-arrow" id="arr-${mIdx}-${pIdx}">▼</span>
    </div>
    <div class="plat-ings" id="ing-${mIdx}-${pIdx}">
      ${prep ? `<div style="background:#fff8e7;border-left:3px solid #f9c74f;border-radius:8px;padding:10px 12px;margin-bottom:10px"><div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#6b6b6b;margin-bottom:4px">👩‍🍳 Preparation</div><div style="font-size:12px;line-height:1.6">${escapeHtml(prep)}</div></div>` : ''}
      ${ings.map(ri => {
        const ing = getIngredient(ri.ingredient_id);
        if (!ing) return '';
        const qte = (ri.quantite_par_portion || 0) * (recette.quantite_fixe ? 1 : portions);
        const uFinal = riUnite(ri, ing);
        const rayon = ing.rayon || '';
        return `<div class="ing-line">
          <span>${escapeHtml(ing.nom)}${rayon ? ` <span style="font-size:10px;color:var(--txl)">(${escapeHtml(rayon)})</span>` : ''}</span>
          <span class="ing-qte">${qte > 0 ? (Number.isInteger(qte) ? qte : qte.toFixed(2)) + (uFinal ? ' ' + uFinal : '') : '–'}</span>
        </div>`;
      }).join('')}
    </div>
  </div>`;
}

function toggleIng(targetId) {
  const div = document.getElementById(targetId);
  if (!div) return;
  const arrId = targetId.replace('ing-', 'arr-');
  const arr = document.getElementById(arrId);
  const open = div.classList.toggle('open');
  if (arr) arr.textContent = open ? '▲' : '▼';
}

// --- views switcher ---
function setView(v) {
  curView = v;
  const btns = { liste: $('btnListe'), semaine: $('btnSem'), mois: $('btnMois') };
  Object.entries(btns).forEach(([k, btn]) => {
    if (!btn) return;
    btn.style.background = k === v ? 'var(--vert)' : 'var(--bgd)';
    btn.style.color = k === v ? '#fff' : 'var(--tx)';
  });
  $('missionsDiv').style.display = v === 'liste' ? 'block' : 'none';
  $('listeTitre').style.display = v === 'liste' ? 'block' : 'none';
  $('calContainer').style.display = v !== 'liste' ? 'block' : 'none';
  $('calSemDiv').style.display = v === 'semaine' ? 'block' : 'none';
  $('calMoisDiv').style.display = v === 'mois' ? 'block' : 'none';
  if (v === 'semaine') renderCalSem();
  if (v === 'mois') renderCalMois();
}

function initCalSelects() {
  const selS = $('calSemSelect');
  if (selS && !selS.options.length) {
    const lundis = getLundis();
    lundis.forEach((s, i) => {
      const opt = document.createElement('option');
      opt.value = s.id;
      opt.textContent = 'Semaine du ' + s.label;
      if (i === 2) opt.selected = true;
      selS.appendChild(opt);
    });
  }
  const selM = $('calMoisSelect');
  if (selM && !selM.options.length) {
    const now = new Date();
    for (let i = -2; i < 6; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
      const opt = document.createElement('option');
      opt.value = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
      opt.textContent = d.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });
      if (i === 2) opt.selected = true;
      selM.appendChild(opt);
    }
  }
}

function renderCalSem() {
  initCalSelects();
  const semId = $('calSemSelect').value;
  const [y, m, d] = semId.split('-').map(Number);
  const JOURS_ALL = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
  const JMAP_ALL = { Lundi: 0, Mardi: 1, Mercredi: 2, Jeudi: 3, Vendredi: 4, Samedi: 5, Dimanche: 6 };
  const jours = JOURS_ALL.filter(j => creneauxTemplate.some(t => t.jour === j));
  const cmdSem = allCommandesAssignees.filter(c => (c.semaine_du || '').startsWith(semId));

  $('calContainer').innerHTML = `<div class="cal-semaine">${jours.map(j => {
    const jd = new Date(y, m - 1, d + JMAP_ALL[j]);
    const jl = jd.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
    const slots = creneauxTemplate.filter(t => t.jour === j).sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
    return `<div class="cal-jour">
      <div class="cal-jour-header">${j}<span>${jd.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' })}</span></div>
      ${slots.map(slot => {
        const h = `${parseInt(slot.heure_debut.split(':')[0], 10)}h${slot.heure_debut.split(':')[1]} - ${parseInt(slot.heure_fin.split(':')[0], 10)}h${slot.heure_fin.split(':')[1]}`;
        const slotKey = `${j}_${slot.nom_slot}`;
        const lbl = `${jl} · ${h}`;
        const cmd = cmdSem.find(c => c.slot_key === slotKey || (c.creneau || '').trim() === lbl.trim());
        if (cmd) {
          const cName = cmd.client ? cmd.client.nom : '?';
          return `<div class="cal-slot moi">
            <div class="cal-slot-heure">${h}</div>
            <div style="font-size:11px;font-weight:500">${escapeHtml(cName)}</div>
          </div>`;
        }
        return `<div class="cal-slot vide">${h}<br>–</div>`;
      }).join('')}
    </div>`;
  }).join('')}</div>`;
}

function renderCalMois() {
  initCalSelects();
  const val = $('calMoisSelect').value;
  const [y, m] = val.split('-').map(Number);
  const premier = new Date(y, m - 1, 1);
  const dernier = new Date(y, m, 0);
  const today = new Date();
  let dow = premier.getDay(); if (dow === 0) dow = 7;
  const jours = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
  let html = `<div class="cal-mois">`;
  jours.forEach(j => { html += `<div class="cmh">${j}</div>`; });
  for (let i = 1; i < dow; i++) html += `<div class="cmd autre"></div>`;
  for (let dd = 1; dd <= dernier.getDate(); dd++) {
    const isToday = today.getFullYear() === y && today.getMonth() === m - 1 && today.getDate() === dd;
    const cmdsJour = allCommandesAssignees.filter(c => {
      const cren = c.creneau || '';
      const semaine = c.semaine_du || '';
      if (!semaine) return false;
      const [sy, sm, sd] = semaine.split('-').map(Number);
      for (let i = 0; i < 5; i++) {
        const jd = new Date(sy, sm - 1, sd + i);
        if (jd.getFullYear() === y && jd.getMonth() === m - 1 && jd.getDate() === dd) {
          const jl = jd.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long' });
          return cren.startsWith(jl);
        }
      }
      return false;
    });
    html += `<div class="cmd ${isToday ? 'today' : ''}">
      <div class="cmd-num">${dd}</div>
      ${cmdsJour.map(c => `<div class="cmd-ev">${escapeHtml(c.client ? c.client.nom : '?')}</div>`).join('')}
    </div>`;
  }
  html += `</div>`;
  $('calContainer').innerHTML = html;
}

// --- helpers escape ---
function escapeHtml(s) {
  if (s == null) return '';
  return String(s).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}
function escapeAttr(s) { return escapeHtml(s); }

// --- Branding : applique le logo + les couleurs de l'entreprise (comme cote cliente) ---
let entrepriseNom = 'la responsable';
async function loadBrandingPartner() {
  try {
    const { data: ent } = await sb.from('entreprises')
      .select('nom_marque, logo_url, couleur_principale, couleur_secondaire')
      .eq('id', salarieProfile.entreprise_id).maybeSingle();
    if (!ent) return;
    if (ent.nom_marque) entrepriseNom = ent.nom_marque;
    const root = document.documentElement.style;
    if (ent.couleur_principale) root.setProperty('--vert', ent.couleur_principale);
    if (ent.couleur_secondaire) root.setProperty('--vc', ent.couleur_secondaire);
    const logoEl = document.querySelector('#pSalarie .logo');
    if (logoEl) {
      if (ent.logo_url) logoEl.innerHTML = `<img src="${escapeAttr(ent.logo_url)}" alt="${escapeAttr(ent.nom_marque || '')}" style="height:34px;display:block">`;
      else if (ent.nom_marque) logoEl.textContent = ent.nom_marque;
    }
    if (ent.nom_marque) document.title = ent.nom_marque + ' — Espace Partenaire';
  } catch (e) { console.error('branding', e); }
}

// --- Onglets du portail partenaire (planning / creneaux / recettes / forfaits / paiement) ---
function setupPartnerTabs() {
  document.querySelectorAll('.ptab').forEach(b => b.addEventListener('click', () => showPartnerTab(b.dataset.ptab)));
}
function showPartnerTab(name) {
  document.querySelectorAll('.ptab').forEach(b => b.classList.toggle('active', b.dataset.ptab === name));
  document.querySelectorAll('.ptab-panel').forEach(p => { p.style.display = 'none'; });
  const panel = document.getElementById('panel' + name.charAt(0).toUpperCase() + name.slice(1));
  if (panel) panel.style.display = 'block';
  try {
    if (name === 'creneaux') renderMesCreneauxWeek();
    else if (name === 'recettes') renderMesRecettes();
    else if (name === 'forfaits') renderMesForfaits();
    else if (name === 'paiement') renderMonPaiement();
    else if (name === 'clientes') renderMesClientes();
  } catch (e) { console.error('tab render', e); }
}

// --- MES CLIENTES (celles attribuées à cette cuisinière) : voir + modifier ---
let mesClientesData = [];
async function renderMesClientes() {
  const box = document.getElementById('mesClientesBody'); if (!box) return;
  box.innerHTML = '<p style="color:var(--txl);font-size:13px">Chargement…</p>';
  try {
    const { data, error } = await sb.from('clients').select('*').order('nom');
    if (error) throw error;
    mesClientesData = data || [];
  } catch (e) { box.innerHTML = `<p style="color:var(--txl);font-size:13px">${escapeHtml(msgErr(e))}</p>`; return; }
  if (!mesClientesData.length) {
    box.innerHTML = '<p style="color:var(--txl);font-size:13px">Aucune cliente attribuée pour le moment. C\'est ta responsable qui attribue les clientes.</p>';
    return;
  }
  box.innerHTML = mesClientesData.map(c => `
    <div style="background:var(--wh);border:1.5px solid var(--bgd);border-radius:12px;padding:12px 14px;margin-bottom:10px">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap">
        <div style="font-size:15px;font-weight:600">👤 ${escapeHtml(c.nom || '–')}</div>
        <button data-edit-cli="${c.id}" style="background:var(--vp);color:var(--vert);border:1px solid var(--vert);border-radius:8px;padding:5px 12px;font-size:12px;font-weight:600;cursor:pointer">✏️ Modifier</button>
      </div>
      <div style="font-size:12px;color:var(--txl);margin-top:6px;display:flex;flex-direction:column;gap:2px">
        ${c.telephone ? `<a href="tel:${escapeAttr((c.telephone || '').replace(/\s/g, ''))}" style="color:var(--vert);text-decoration:none">📞 ${escapeHtml(c.telephone)}</a>` : ''}
        ${c.adresse ? `<a href="https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(c.adresse)}" target="_blank" rel="noopener" style="color:var(--vert);text-decoration:none">📍 ${escapeHtml(c.adresse)}</a>` : ''}
        <span>🍽️ ${c.nombre_portions || 4} portions par défaut</span>
        ${c.notes ? `<span>📝 ${escapeHtml(c.notes)}</span>` : ''}
      </div>
    </div>`).join('');
  box.querySelectorAll('[data-edit-cli]').forEach(b => b.addEventListener('click', () => editerCliente(b.dataset.editCli)));
}
function editerCliente(id) {
  const c = mesClientesData.find(x => x.id === id); if (!c) return;
  const pop = document.createElement('div');
  pop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.5);display:flex;align-items:center;justify-content:center;z-index:600;padding:16px';
  pop.innerHTML = `<div style="background:var(--wh,#fff);border-radius:16px;max-width:440px;width:100%;max-height:88vh;overflow-y:auto;padding:22px">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px"><div style="font-size:17px;font-weight:600;color:var(--vert)">✏️ Modifier la cliente</div><button id="ecClose" style="background:none;border:none;font-size:20px;cursor:pointer;color:var(--txl)">✕</button></div>
    <label style="font-size:12px;font-weight:600">Nom</label>
    <input id="ecNom" value="${escapeAttr(c.nom || '')}" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 10px;box-sizing:border-box">
    <label style="font-size:12px;font-weight:600">Téléphone</label>
    <input id="ecTel" value="${escapeAttr(c.telephone || '')}" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 10px;box-sizing:border-box">
    <label style="font-size:12px;font-weight:600">Adresse</label>
    <input id="ecAdr" value="${escapeAttr(c.adresse || '')}" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 10px;box-sizing:border-box">
    <label style="font-size:12px;font-weight:600">Portions par défaut</label>
    <input id="ecPort" type="number" min="1" value="${c.nombre_portions || 4}" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 10px;box-sizing:border-box">
    <label style="font-size:12px;font-weight:600">Notes</label>
    <textarea id="ecNotes" rows="3" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 14px;box-sizing:border-box">${escapeHtml(c.notes || '')}</textarea>
    <button id="ecSave" style="width:100%;padding:12px;background:var(--vert);color:#fff;border:none;border-radius:9px;font-weight:600;cursor:pointer">Enregistrer</button>
  </div>`;
  document.body.appendChild(pop);
  const close = () => pop.remove();
  pop.querySelector('#ecClose').addEventListener('click', close);
  pop.addEventListener('click', e => { if (e.target === pop) close(); });
  pop.querySelector('#ecSave').addEventListener('click', async () => {
    const nom = pop.querySelector('#ecNom').value.trim();
    if (!nom) { alert('Le nom est obligatoire'); return; }
    const payload = {
      nom,
      telephone: pop.querySelector('#ecTel').value.trim() || null,
      adresse: pop.querySelector('#ecAdr').value.trim() || null,
      nombre_portions: parseInt(pop.querySelector('#ecPort').value, 10) || 4,
      notes: pop.querySelector('#ecNotes').value.trim() || null
    };
    const btn = pop.querySelector('#ecSave'); btn.disabled = true; btn.textContent = 'Enregistrement…';
    try {
      await writeVerified(() => sb.from('clients').update(payload).eq('id', id).select('id'));
      Object.assign(c, payload);
      close();
      renderMesClientes();
    } catch (e) { btn.disabled = false; btn.textContent = 'Enregistrer'; alert('⚠️ ' + msgErr(e)); }
  });
}

// --- MES CRENEAUX (chaque cuisiniere gere ses propres creneaux) ---
const JOURS_CREN = ['Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi', 'Dimanche'];
function fmtHeureCren(d, f) {
  const c = x => (x || '').slice(0, 5).replace(':', 'h');
  return d && f ? `${c(d)} - ${c(f)}` : (c(d) || '');
}
function mesSlots() {
  return creneauxTemplate
    .filter(t => t.salarie_id === salarieProfile.id)
    .sort((a, b) => (a.ordre || 0) - (b.ordre || 0));
}
// Helpers semaine (comme le compte normal)
const JMAP_PART = { Lundi: 0, Mardi: 1, Mercredi: 2, Jeudi: 3, Vendredi: 4, Samedi: 5, Dimanche: 6 };
function getMondayDatePart(off = 0) {
  const d = new Date(), dy = d.getDay();
  const diff = d.getDate() - dy + (dy === 0 ? -6 : 1) + off * 7;
  const m = new Date(d); m.setDate(diff); return m;
}
function getMondayPart(off = 0) {
  const m = getMondayDatePart(off);
  return `${m.getFullYear()}-${String(m.getMonth() + 1).padStart(2, '0')}-${String(m.getDate()).padStart(2, '0')}`;
}
function semLabelPart(off = 0) {
  const mon = getMondayDatePart(off);
  const fri = new Date(mon); fri.setDate(fri.getDate() + 4);
  const o = { day: 'numeric', month: 'long' };
  return `${mon.toLocaleDateString('fr-FR', o)} – ${fri.toLocaleDateString('fr-FR', o)}`;
}

let mesCreneaux = null; // ouvertures/fermetures par semaine (table creneaux)
let partCrenOff = 0;

// Vue hebdo : chaque créneau du template peut être ouvert/fermé pour la semaine affichée
async function renderMesCreneauxWeek() {
  const body = $('mesCreneauxBody');
  if (mesCreneaux === null) {
    body.innerHTML = '<div style="padding:20px;text-align:center;color:var(--txl)">Chargement…</div>';
    const { data } = await sb.from('creneaux').select('*').eq('salarie_id', salarieProfile.id);
    mesCreneaux = data || [];
  }
  const sem = getMondayPart(partCrenOff);
  const isPasse = sem < getMondayPart(0);
  const [yy, mm, dd] = sem.split('-').map(Number);
  const jours = JOURS_CREN.filter(j => mesSlots().some(s => s.jour === j));
  const grid = jours.length === 0
    ? `<div style="text-align:center;color:var(--txl);padding:22px 0">Aucun créneau configuré.<br>Touchez <strong>⚙️ Mes créneaux récurrents</strong> pour en ajouter.</div>`
    : jours.map(jour => {
        const jd = new Date(yy, mm - 1, dd + JMAP_PART[jour]);
        const dateLabel = jd.toLocaleDateString('fr-FR', { day: 'numeric', month: 'short' });
        const slotsHtml = mesSlots().filter(s => s.jour === jour).map(s => {
          const k = `${jour}_${s.nom_slot}`;
          const actif = crActifPart(sem, k);
          return `<div style="display:flex;justify-content:space-between;align-items:center;padding:7px 0;border-top:1px solid var(--bgd)">
            <div><div style="font-size:13px;font-weight:500;text-transform:capitalize">${escapeHtml(s.nom_slot)}</div><div style="font-size:11px;color:var(--txl)">${escapeHtml(fmtHeureCren(s.heure_debut, s.heure_fin))}</div></div>
            ${isPasse ? '<span style="font-size:11px;color:var(--txl)">passé</span>'
              : `<button data-tgl="${k}" data-actif="${actif}" style="border:none;cursor:pointer;border-radius:16px;padding:5px 12px;font-size:12px;font-weight:600;background:${actif ? '#e8f5e9' : '#ffebee'};color:${actif ? '#2e7d32' : '#c62828'}">${actif ? '✓ Ouvert' : '✕ Fermé'}</button>`}
          </div>`;
        }).join('');
        return `<div style="background:var(--wh);border:1px solid var(--bgd);border-radius:12px;padding:12px 14px;margin-bottom:10px">
          <div style="font-weight:600;color:var(--vert);text-transform:capitalize">${jour} <span style="font-size:12px;color:var(--txl);font-weight:400">${dateLabel}</span></div>
          ${slotsHtml}
        </div>`;
      }).join('');
  body.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:14px">
      <button id="crenPrev" style="background:var(--bgd);border:none;border-radius:8px;width:38px;height:38px;font-size:16px;cursor:pointer">◀</button>
      <div style="flex:1;text-align:center;font-size:13px;font-weight:600">${semLabelPart(partCrenOff)}</div>
      <button id="crenNext" style="background:var(--bgd);border:none;border-radius:8px;width:38px;height:38px;font-size:16px;cursor:pointer">▶</button>
    </div>
    <button id="btnTplCren" style="width:100%;background:var(--vert);color:#fff;border:none;border-radius:9px;padding:11px;font-size:13px;font-weight:600;cursor:pointer;margin-bottom:14px">⚙️ Mes créneaux récurrents</button>
    ${isPasse ? '<div style="font-size:12px;color:#c62828;background:#fff5f5;border-radius:9px;padding:9px 12px;margin-bottom:12px">Semaine passée — non modifiable</div>' : ''}
    ${grid}
    <p style="font-size:11px;color:var(--txl);margin-top:10px">Un créneau fermé n'apparaît pas chez vos clientes cette semaine-là.</p>`;
  $('crenPrev').addEventListener('click', () => { partCrenOff--; renderMesCreneauxWeek(); });
  $('crenNext').addEventListener('click', () => { partCrenOff++; renderMesCreneauxWeek(); });
  $('btnTplCren').addEventListener('click', openTemplateEditor);
  body.querySelectorAll('[data-tgl]').forEach(b => b.addEventListener('click', () => toggleCrenPart(sem, b.dataset.tgl, b.dataset.actif === 'true')));
}
function crActifPart(sem, k) {
  const f = (mesCreneaux || []).find(c => c.semaine === sem && c.slot === k);
  return f ? !!f.actif : true;
}
async function toggleCrenPart(sem, k, currentActif) {
  const newVal = !currentActif;
  const existing = (mesCreneaux || []).find(c => c.semaine === sem && c.slot === k);
  try {
    if (existing) {
      await writeVerified(() => sb.from('creneaux').update({ actif: newVal }).eq('id', existing.id).select('id'));
      existing.actif = newVal;
    } else {
      const { data, error } = await sb.from('creneaux').insert({ semaine: sem, slot: k, actif: newVal, entreprise_id: salarieProfile.entreprise_id, salarie_id: salarieProfile.id }).select().single();
      if (error) throw error;
      mesCreneaux.push(data);
    }
    renderMesCreneauxWeek();
  } catch (e) { alert('⚠️ ' + msgErr(e)); }
}

// Éditeur des créneaux récurrents (le template) dans une modale
let _tplPop = null;
function openTemplateEditor() {
  const pop = document.createElement('div');
  _tplPop = pop;
  pop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;z-index:900;padding:20px;overflow:auto';
  pop.innerHTML = `<div style="background:#fff;border-radius:14px;padding:20px;max-width:480px;width:100%;margin:auto">
    <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
      <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:var(--vert)">Mes créneaux récurrents</div>
      <button id="tplClose" style="background:var(--bgd);border:none;border-radius:8px;padding:8px 12px;cursor:pointer">Fermer</button>
    </div>
    <div style="font-size:12px;color:var(--txl);margin-bottom:12px">Vos jours et horaires habituels. Ensuite, vous ouvrez/fermez chaque semaine dans la vue principale.</div>
    <div id="tplBody"></div>
  </div>`;
  document.body.appendChild(pop);
  const close = () => { pop.remove(); _tplPop = null; renderMesCreneauxWeek(); };
  pop.querySelector('#tplClose').addEventListener('click', close);
  pop.addEventListener('click', e => { if (e.target === pop) close(); });
  renderTemplateList();
}
function renderTemplateList() {
  const body = _tplPop ? _tplPop.querySelector('#tplBody') : null;
  if (!body) return;
  body.innerHTML = JOURS_CREN.map(jour => {
    const slots = mesSlots().filter(s => s.jour === jour);
    return `<div style="border:1px solid var(--bgd);border-radius:10px;padding:12px;margin-bottom:8px;background:${slots.length ? 'var(--vp)' : '#fafafa'}">
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:${slots.length ? '8px' : '0'}">
        <div style="text-transform:capitalize;font-weight:600;color:var(--vert)">${jour}</div>
        <button data-cren-add="${jour}" style="background:none;border:1px solid var(--vert);color:var(--vert);border-radius:7px;padding:5px 10px;font-size:12px;cursor:pointer">+ Ajouter</button>
      </div>
      ${slots.map(s => `<div style="display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--bgd);font-size:13px">
        <div style="flex:1"><div style="font-weight:500;text-transform:capitalize">${escapeHtml(s.nom_slot)}</div><div style="font-size:11px;color:var(--txl)">${escapeHtml(fmtHeureCren(s.heure_debut, s.heure_fin))}</div></div>
        <button data-cren-edit="${s.id}" style="background:none;border:none;cursor:pointer;font-size:15px">✏️</button>
        <button data-cren-del="${s.id}" style="background:none;border:none;cursor:pointer;font-size:15px">🗑️</button>
      </div>`).join('')}
    </div>`;
  }).join('');
  body.querySelectorAll('[data-cren-add]').forEach(b => b.addEventListener('click', () => editCreneau(null, b.getAttribute('data-cren-add'))));
  body.querySelectorAll('[data-cren-edit]').forEach(b => b.addEventListener('click', () => editCreneau(b.getAttribute('data-cren-edit'))));
  body.querySelectorAll('[data-cren-del]').forEach(b => b.addEventListener('click', () => deleteCreneau(b.getAttribute('data-cren-del'))));
}
function editCreneau(id, defaultJour) {
  const slot = id ? creneauxTemplate.find(s => s.id === id) : null;
  const jour = slot ? slot.jour : (defaultJour || 'Lundi');
  const nom = slot ? slot.nom_slot : '';
  const debut = slot ? (slot.heure_debut || '').slice(0, 5) : '09:00';
  const fin = slot ? (slot.heure_fin || '').slice(0, 5) : '12:00';
  const pop = document.createElement('div');
  pop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:900;padding:20px';
  pop.innerHTML = `<div style="background:#fff;border-radius:14px;padding:20px;max-width:400px;width:100%">
    <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:var(--vert);margin-bottom:14px">${id ? 'Modifier le créneau' : 'Nouveau créneau'}</div>
    <label style="font-size:12px;font-weight:600">Jour</label>
    <select id="crenJour" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 12px;text-transform:capitalize">${JOURS_CREN.map(j => `<option value="${j}" ${j === jour ? 'selected' : ''}>${j}</option>`).join('')}</select>
    <label style="font-size:12px;font-weight:600">Nom du créneau</label>
    <input id="crenNom" value="${escapeAttr(nom)}" placeholder="ex: matin, apres-midi, soir" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 12px">
    <div style="display:flex;gap:10px">
      <div style="flex:1"><label style="font-size:12px;font-weight:600">Début</label><input type="time" id="crenDebut" value="${debut}" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin-top:4px"></div>
      <div style="flex:1"><label style="font-size:12px;font-weight:600">Fin</label><input type="time" id="crenFin" value="${fin}" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin-top:4px"></div>
    </div>
    <div style="display:flex;gap:10px;margin-top:18px">
      <button id="crenSave" style="flex:1;padding:11px;background:var(--vert);color:#fff;border:none;border-radius:9px;font-weight:600;cursor:pointer">💾 Enregistrer</button>
      <button id="crenCancel" style="padding:11px 16px;background:var(--bgd);border:none;border-radius:9px;cursor:pointer">Annuler</button>
    </div>
  </div>`;
  document.body.appendChild(pop);
  pop.querySelector('#crenCancel').addEventListener('click', () => pop.remove());
  pop.addEventListener('click', e => { if (e.target === pop) pop.remove(); });
  pop.querySelector('#crenSave').addEventListener('click', async () => {
    const nJour = $('crenJour').value;
    const nNom = $('crenNom').value.trim().toLowerCase();
    const nDebut = $('crenDebut').value, nFin = $('crenFin').value;
    if (!nNom) return alert('Donnez un nom au créneau (matin, soir...)');
    if (!nDebut || !nFin) return alert('Renseignez les heures de début et de fin');
    if (nDebut >= nFin) return alert("L'heure de fin doit être après l'heure de début");
    const dup = mesSlots().find(s => s.jour === nJour && s.nom_slot === nNom && s.id !== id);
    if (dup) return alert('Un créneau "' + nNom + '" existe déjà pour ' + nJour);
    try {
      const ordreMax = mesSlots().filter(s => s.jour === nJour).reduce((a, s) => Math.max(a, s.ordre || 0), 0);
      if (id) {
        await writeVerified(() => sb.from('creneaux_template').update({ jour: nJour, nom_slot: nNom, heure_debut: nDebut, heure_fin: nFin }).eq('id', id).select('id'));
        const t = creneauxTemplate.find(s => s.id === id);
        if (t) Object.assign(t, { jour: nJour, nom_slot: nNom, heure_debut: nDebut, heure_fin: nFin });
      } else {
        const { data, error } = await sb.from('creneaux_template').insert({ jour: nJour, nom_slot: nNom, heure_debut: nDebut, heure_fin: nFin, ordre: ordreMax + 1, entreprise_id: salarieProfile.entreprise_id, salarie_id: salarieProfile.id }).select().single();
        if (error) throw error;
        creneauxTemplate.push(data);
      }
      pop.remove();
      renderTemplateList();
    } catch (e) { alert('⚠️ ' + msgErr(e)); }
  });
}
async function deleteCreneau(id) {
  const slot = creneauxTemplate.find(s => s.id === id);
  if (!slot) return;
  if (!confirm(`Supprimer le créneau "${slot.nom_slot}" du ${slot.jour} ?`)) return;
  try {
    await writeVerified(() => sb.from('creneaux_template').delete().eq('id', id).select('id'));
    creneauxTemplate = creneauxTemplate.filter(s => s.id !== id);
    renderTemplateList();
  } catch (e) { alert('⚠️ ' + msgErr(e)); }
}

// --- MES RECETTES (proposition -> validation par la tete de reseau) ---
const CATS_SAL = ['Viande', 'Poisson', 'Végé', 'Poulet', 'Pâtes', 'Cuisine du monde', 'Post partum', 'Sans porc', 'Sans gluten', 'Sans lactose', 'Sucré', 'Tartes', 'Cakes'];
let mesRecettesData = [];
function setupMesRecettes() {
  const t = $('mesRecettesToggle'); if (!t) return;
  t.addEventListener('click', async () => {
    const b = $('mesRecettesBody');
    const open = b.style.display !== 'none';
    b.style.display = open ? 'none' : 'block';
    $('mesRecettesChevron').textContent = open ? 'Afficher ▾' : 'Masquer ▴';
    if (!open) await renderMesRecettes();
  });
}
async function renderMesRecettes() {
  const { data } = await sb.from('recettes').select('id, nom_du_plat, categorie, etat').eq('cree_par_salarie_id', salarieProfile.id).order('nom_du_plat');
  mesRecettesData = data || [];
  const badge = e => e === 'actif' ? '<span style="background:#e8f5e9;color:#2e7d32;padding:2px 8px;border-radius:10px;font-size:11px">✓ Validée</span>'
    : e === 'inactif' ? '<span style="background:#ffebee;color:#c62828;padding:2px 8px;border-radius:10px;font-size:11px">✕ Refusée</span>'
    : '<span style="background:#fff3e0;color:#e65100;padding:2px 8px;border-radius:10px;font-size:11px">⏳ En attente</span>';
  const rows = mesRecettesData.map(r => `<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:8px 0;border-top:1px solid var(--bgd)">
    <div style="flex:1"><div style="font-weight:500">${escapeHtml(r.nom_du_plat)}</div><div style="font-size:11px;color:var(--txl)">${escapeHtml(r.categorie || '–')}</div></div>${badge(r.etat)}
  </div>`).join('');
  $('mesRecettesBody').innerHTML = `<div style="font-size:12px;color:var(--txl);margin-bottom:10px">Proposez vos recettes complètes (photo + ingrédients) : elles seront <strong>validées par ${escapeHtml(entrepriseNom)}</strong> avant d'apparaître chez vos clientes.</div>
    <button id="btnProposerRec" style="background:var(--vert);color:#fff;border:none;border-radius:8px;padding:9px 14px;font-size:13px;cursor:pointer;margin-bottom:6px">+ Proposer une recette</button>
    ${rows || '<div style="font-size:12px;color:var(--txl);padding:10px 0">Aucune recette proposée pour le moment.</div>'}`;
  $('btnProposerRec').addEventListener('click', proposerRecette);
}

const RAYONS_SAL = ['Fruits & Légumes', 'Boucherie', 'Charcuterie', 'Poissonnerie', 'Crémerie', 'Épicerie', 'Épices', 'Boulangerie', 'Produits frais', 'Surgelés', 'Autres'];

function loadHeicLib() {
  if (window.heic2any) return Promise.resolve();
  return new Promise((resolve) => {
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
    s.onload = () => resolve(); s.onerror = () => resolve();
    document.head.appendChild(s);
  });
}
async function fileToJpegBlob(file) {
  let src = file;
  const isHeic = /heic|heif/i.test(file.type || '') || /\.hei[cf]$/i.test(file.name || '');
  if (isHeic) { try { await loadHeicLib(); if (window.heic2any) { const o = await window.heic2any({ blob: file, toType: 'image/jpeg', quality: 0.9 }); src = Array.isArray(o) ? o[0] : o; } } catch (e) {} }
  const dataUrl = await new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(r.result); r.onerror = rej; r.readAsDataURL(src); });
  const img = await new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = dataUrl; });
  const maxW = 1100; const scale = Math.min(1, maxW / (img.width || maxW));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round((img.width || maxW) * scale); canvas.height = Math.round((img.height || maxW) * scale);
  canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
  return await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.85));
}
async function uploadRecettePhoto(file) {
  const blob = await fileToJpegBlob(file);
  const fn = `${salarieProfile.entreprise_id}/prop-${salarieProfile.id}-${Date.now()}.jpg`;
  const { error } = await sb.storage.from('photos-recettes').upload(fn, blob, { upsert: false, contentType: 'image/jpeg' });
  if (error) throw error;
  const { data: pub } = sb.storage.from('photos-recettes').getPublicUrl(fn);
  return pub.publicUrl;
}

// --- Photos de mission (plat préparé) : la cuisinière les ajoute, l'admin les récupère, purge auto à 14 jours ---
async function loadMissionPhotos(commandeId) {
  const { data } = await sb.from('mission_photos').select('*').eq('commande_id', commandeId).order('created_at', { ascending: false });
  return data || [];
}
async function refreshMissionPhotos(commandeId) {
  const box = document.getElementById('missionPhotosList'); if (!box) return;
  const photos = await loadMissionPhotos(commandeId);
  box.innerHTML = photos.length
    ? photos.map(p => `<a href="${escapeAttr(p.url)}" target="_blank" rel="noopener" style="display:block"><img src="${escapeAttr(p.url)}" style="width:70px;height:70px;object-fit:cover;border-radius:8px;border:1px solid var(--bgd)"></a>`).join('')
    : '<span style="font-size:12px;color:var(--txl)">Aucune photo pour l\'instant.</span>';
}
async function uploadMissionPhoto(file, commandeId, labelEl) {
  const prev = labelEl ? labelEl.innerHTML : '';
  if (labelEl) labelEl.innerHTML = '⏳ Envoi…';
  try {
    const blob = await fileToJpegBlob(file);
    const path = `${salarieProfile.entreprise_id}/mission-${commandeId}-${Date.now()}.jpg`;
    const { error: upErr } = await sb.storage.from('photos-recettes').upload(path, blob, { upsert: false, contentType: 'image/jpeg' });
    if (upErr) throw upErr;
    const { data: pub } = sb.storage.from('photos-recettes').getPublicUrl(path);
    // writeVerified : si la ligne DB n'est pas écrite (RLS/session), on ne laisse pas
    // une photo orpheline dans le bucket -> on la retire et on remonte l'erreur.
    try {
      await writeVerified(() => sb.from('mission_photos').insert({ entreprise_id: salarieProfile.entreprise_id, commande_id: commandeId, salarie_id: salarieProfile.id, url: pub.publicUrl, path }).select('id'));
    } catch (insErr) {
      try { await sb.storage.from('photos-recettes').remove([path]); } catch (_) {}
      throw insErr;
    }
    await refreshMissionPhotos(commandeId);
  } catch (e) { alert('⚠️ ' + msgErr(e)); }
  if (labelEl) labelEl.innerHTML = prev;
}
// Unité effective d'un lien recette-ingrédient : celle propre à la recette (ri.unite)
// si renseignée, sinon l'unité par défaut de l'ingrédient.
function riUnite(ri, ing) {
  const l = ri && ri.unite;
  if (l != null && l !== '' && l !== 'Unité par défaut') return l;
  const d = ing && ing.unite_par_defaut;
  return (d && d !== 'Unité par défaut') ? d : '';
}
function addIngRow(container, ing) {
  const row = document.createElement('div');
  row.className = 'rec-ing-row';
  row.style.cssText = 'display:flex;gap:6px;margin-bottom:6px;align-items:center';
  row.innerHTML = `
    <input class="ri-nom" list="ingNamesList" placeholder="Ingrédient" value="${ing ? escapeAttr(ing.nom) : ''}" style="flex:2;min-width:0;padding:8px;border:1px solid var(--bgd);border-radius:7px;font-size:13px">
    <input class="ri-qte" type="number" step="0.01" min="0" placeholder="Qté" value="${ing ? (ing.qte || '') : ''}" style="width:60px;padding:8px;border:1px solid var(--bgd);border-radius:7px;font-size:13px">
    <input class="ri-unite" placeholder="unité" value="${ing ? escapeAttr(ing.unite || '') : ''}" style="width:60px;padding:8px;border:1px solid var(--bgd);border-radius:7px;font-size:13px">
    <select class="ri-rayon" style="width:104px;padding:8px;border:1px solid var(--bgd);border-radius:7px;font-size:12px">${RAYONS_SAL.map(r => `<option ${ing && ing.rayon === r ? 'selected' : ''}>${r}</option>`).join('')}</select>
    <button type="button" class="ri-del" style="background:none;border:none;cursor:pointer;font-size:15px;flex-shrink:0">✕</button>`;
  row.querySelector('.ri-del').addEventListener('click', () => row.remove());
  row.querySelector('.ri-nom').addEventListener('change', (e) => {
    const found = ingredients.find(x => (x.nom || '').toLowerCase() === e.target.value.trim().toLowerCase());
    if (found) {
      if (found.unite_par_defaut && found.unite_par_defaut !== 'Unité par défaut') row.querySelector('.ri-unite').value = found.unite_par_defaut;
      if (found.rayon) row.querySelector('.ri-rayon').value = found.rayon;
    }
  });
  container.appendChild(row);
}
function proposerRecette() {
  let photoFile = null;
  const pop = document.createElement('div');
  pop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-start;justify-content:center;z-index:900;padding:20px;overflow:auto';
  pop.innerHTML = `<div style="background:#fff;border-radius:14px;padding:20px;max-width:520px;width:100%;margin:auto">
    <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:var(--vert);margin-bottom:14px">Proposer une recette</div>
    <datalist id="ingNamesList">${ingredients.map(i => `<option value="${escapeAttr(i.nom)}">`).join('')}</datalist>
    <div id="recPhotoPreview" style="width:100%;height:150px;border-radius:10px;background:var(--bg);display:flex;align-items:center;justify-content:center;font-size:40px;overflow:hidden;margin-bottom:8px">🍽️</div>
    <input type="file" id="recPhotoFile" accept="image/*" style="display:none">
    <button type="button" id="recPhotoBtn" style="width:100%;padding:9px;background:var(--bgd);border:none;border-radius:8px;cursor:pointer;font-size:13px;margin-bottom:12px">📷 Ajouter une photo</button>
    <label style="font-size:12px;font-weight:600">Nom du plat *</label>
    <input id="recNom" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 12px;box-sizing:border-box">
    <label style="font-size:12px;font-weight:600">Catégorie</label>
    <select id="recCat" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 12px;box-sizing:border-box">${CATS_SAL.map(c => `<option>${c}</option>`).join('')}</select>
    <label style="font-size:12px;font-weight:600">Type</label>
    <select id="recType" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 12px;box-sizing:border-box"><option value="entree">Entrée</option><option value="plat" selected>Plat</option><option value="dessert">Dessert</option><option value="petit_plus">Petit plus</option></select>
    <label style="font-size:12px;font-weight:600">Préparation</label>
    <textarea id="recPrep" rows="3" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 12px;box-sizing:border-box" placeholder="Étapes de préparation..."></textarea>
    <div style="font-size:12px;font-weight:600;margin-bottom:6px">Ingrédients (quantité par portion)</div>
    <div id="recIngs"></div>
    <button type="button" id="recAddIng" style="background:none;border:1px solid var(--vert);color:var(--vert);border-radius:7px;padding:6px 12px;font-size:12px;cursor:pointer;margin-bottom:14px">+ Ajouter un ingrédient</button>
    <div style="display:flex;gap:10px">
      <div style="flex:1"><label style="font-size:12px;font-weight:600">Frigo (jours)</label><input type="number" id="recFrigo" value="4" min="1" max="10" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin-top:4px;box-sizing:border-box"></div>
      <div style="flex:2"><label style="font-size:12px;font-weight:600">Congélation</label><input id="recCongel" placeholder="ex: 1 mois" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin-top:4px;box-sizing:border-box"></div>
    </div>
    <label style="font-size:12px;font-weight:600;margin-top:12px;display:block">Réchauffage</label>
    <input id="recRech" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 14px;box-sizing:border-box" placeholder="ex: 3 min au micro-ondes">
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;font-size:13px;margin-bottom:14px"><input type="checkbox" id="recFour" style="width:auto;margin:0"> 🔥 Ce plat va au four</label>
    <label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;font-size:13px;margin-bottom:14px"><input type="checkbox" id="recQtyFixe" style="width:auto;margin:2px 0 0"> <span>⚖️ Quantités fixes <span style="color:var(--txl)">(les quantités ne sont pas multipliées par le nombre de portions — pour gâteaux, tartes, cakes…)</span></span></label>
    <div style="display:flex;gap:10px">
      <button id="recSave" style="flex:1;padding:12px;background:var(--vert);color:#fff;border:none;border-radius:9px;font-weight:600;cursor:pointer">Envoyer à la validation</button>
      <button id="recCancel" style="padding:12px 16px;background:var(--bgd);border:none;border-radius:9px;cursor:pointer">Annuler</button>
    </div>
  </div>`;
  document.body.appendChild(pop);
  const ingsBox = pop.querySelector('#recIngs');
  addIngRow(ingsBox); addIngRow(ingsBox);
  pop.querySelector('#recAddIng').addEventListener('click', () => addIngRow(ingsBox));
  pop.querySelector('#recCancel').addEventListener('click', () => pop.remove());
  pop.querySelector('#recPhotoBtn').addEventListener('click', () => pop.querySelector('#recPhotoFile').click());
  pop.querySelector('#recPhotoFile').addEventListener('change', (e) => {
    photoFile = e.target.files[0] || null;
    if (photoFile) pop.querySelector('#recPhotoPreview').innerHTML = `<img src="${URL.createObjectURL(photoFile)}" style="width:100%;height:100%;object-fit:cover">`;
  });
  pop.querySelector('#recSave').addEventListener('click', async () => {
    const nom = pop.querySelector('#recNom').value.trim();
    if (!nom) return alert('Donnez un nom au plat');
    const saveBtn = pop.querySelector('#recSave'); saveBtn.disabled = true; saveBtn.textContent = 'Envoi…';
    try {
      let photo_url = null;
      if (photoFile) photo_url = await uploadRecettePhoto(photoFile);
      const { data: rec, error } = await sb.from('recettes').insert({
        nom_du_plat: nom, categorie: pop.querySelector('#recCat').value,
        type_plat: pop.querySelector('#recType').value,
        instructions_preparation: pop.querySelector('#recPrep').value.trim() || null,
        instructions_rechauffage: pop.querySelector('#recRech').value.trim() || null,
        congelation: pop.querySelector('#recCongel').value.trim() || null,
        frigo_en_jours: parseInt(pop.querySelector('#recFrigo').value, 10) || null,
        au_four: pop.querySelector('#recFour').checked,
        quantite_fixe: pop.querySelector('#recQtyFixe') ? pop.querySelector('#recQtyFixe').checked : false,
        photo_url, etat: 'en_attente', active: false,
        cree_par_salarie_id: salarieProfile.id, entreprise_id: salarieProfile.entreprise_id
      }).select().single();
      if (error) throw error;
      let ordre = 0;
      for (const row of pop.querySelectorAll('.rec-ing-row')) {
        const inom = row.querySelector('.ri-nom').value.trim();
        if (!inom) continue;
        const qte = parseFloat(row.querySelector('.ri-qte').value) || 0;
        const unite = row.querySelector('.ri-unite').value.trim() || null;
        const rayon = row.querySelector('.ri-rayon').value;
        let ing = ingredients.find(x => (x.nom || '').toLowerCase() === inom.toLowerCase());
        if (!ing) {
          const { data: newIng, error: eIng } = await sb.from('ingredients').insert({ nom: inom, unite_par_defaut: unite, rayon, entreprise_id: salarieProfile.entreprise_id }).select().single();
          if (eIng) throw eIng;
          ingredients.push(newIng); ing = newIng;
        }
        await writeVerified(() => sb.from('recettes_ingredients').insert({ recette_id: rec.id, ingredient_id: ing.id, quantite_par_portion: qte, ordre: ordre++, unite: unite || null, entreprise_id: salarieProfile.entreprise_id }).select('id'));
      }
      pop.remove();
      await renderMesRecettes();
      alert(`✅ Recette envoyée ! ${entrepriseNom} la validera bientôt.`);
    } catch (e) {
      saveBtn.disabled = false; saveBtn.textContent = 'Envoyer à la validation';
      alert('⚠️ ' + msgErr(e));
    }
  });
}

// --- MES FORFAITS (chaque cuisiniere ses forfaits) ---
let mesForfaitsData = [];
function setupMesForfaits() {
  const t = $('mesForfaitsToggle'); if (!t) return;
  t.addEventListener('click', async () => {
    const b = $('mesForfaitsBody');
    const open = b.style.display !== 'none';
    b.style.display = open ? 'none' : 'block';
    $('mesForfaitsChevron').textContent = open ? 'Afficher ▾' : 'Masquer ▴';
    if (!open) await renderMesForfaits();
  });
}
async function renderMesForfaits() {
  const { data } = await sb.from('forfaits').select('*').eq('salarie_id', salarieProfile.id).order('ordre');
  mesForfaitsData = data || [];
  const rows = mesForfaitsData.map(f => `<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid var(--bgd)">
    <div style="flex:1"><div style="font-weight:500">${escapeHtml(f.nom)} — ${Number(f.prix)}€${f.inclut_courses ? ' <span style="font-size:10px;color:var(--vert)">🛒 courses incluses</span>' : ''}</div>${f.description ? `<div style="font-size:11px;color:var(--txl)">${escapeHtml(f.description)}</div>` : ''}</div>
    <button data-forf-edit="${f.id}" style="background:none;border:none;cursor:pointer;font-size:15px">✏️</button>
    <button data-forf-del="${f.id}" style="background:none;border:none;cursor:pointer;font-size:15px">🗑️</button>
  </div>`).join('');
  const body = $('mesForfaitsBody');
  body.innerHTML = `<div style="font-size:12px;color:var(--txl);margin-bottom:10px">Vos formules et tarifs. Vos clientes choisiront parmi <strong>vos</strong> forfaits au moment de commander.</div>
    <button id="btnNewForfait" style="background:var(--vert);color:#fff;border:none;border-radius:8px;padding:9px 14px;font-size:13px;cursor:pointer;margin-bottom:6px">+ Ajouter un forfait</button>${rows}`;
  body.querySelector('#btnNewForfait').addEventListener('click', () => editForfait(null));
  body.querySelectorAll('[data-forf-edit]').forEach(b => b.addEventListener('click', () => editForfait(b.getAttribute('data-forf-edit'))));
  body.querySelectorAll('[data-forf-del]').forEach(b => b.addEventListener('click', () => deleteForfait(b.getAttribute('data-forf-del'))));
}
function editForfait(id) {
  const f = id ? mesForfaitsData.find(x => x.id === id) : null;
  const pop = document.createElement('div');
  pop.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;z-index:900;padding:20px';
  pop.innerHTML = `<div style="background:#fff;border-radius:14px;padding:20px;max-width:400px;width:100%">
    <div style="font-family:'Cormorant Garamond',serif;font-size:20px;font-weight:600;color:var(--vert);margin-bottom:14px">${id ? 'Modifier le forfait' : 'Nouveau forfait'}</div>
    <label style="font-size:12px;font-weight:600">Nom *</label>
    <input id="fNom" value="${escapeAttr(f ? f.nom : '')}" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 12px" placeholder="ex: Formule 5 plats">
    <label style="font-size:12px;font-weight:600">Prix (€) *</label>
    <input id="fPrix" type="number" value="${f ? Number(f.prix) : ''}" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 12px">
    <label style="font-size:12px;font-weight:600">Description</label>
    <input id="fDesc" value="${escapeAttr(f ? (f.description || '') : '')}" style="width:100%;padding:9px;border:1px solid var(--bgd);border-radius:8px;margin:4px 0 12px">
    <label style="display:flex;align-items:center;gap:8px;font-size:13px;margin-bottom:12px"><input type="checkbox" id="fCourses" ${f && f.inclut_courses ? 'checked' : ''}> Courses incluses (je fais les courses)</label>
    <label style="font-size:12px;font-weight:600">Composition (nombre par type)</label>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:6px;margin:4px 0 12px">
      <div><div style="font-size:10px;color:var(--txl)">🥗 Entrées</div><input id="fNbEntrees" type="number" min="0" step="1" value="${f?.nb_entrees ?? 0}" style="width:100%;padding:7px;border:1px solid var(--bgd);border-radius:8px"></div>
      <div><div style="font-size:10px;color:var(--txl)">🍽️ Plats</div><input id="fNbPlats" type="number" min="0" step="1" value="${f?.nb_plats ?? 5}" style="width:100%;padding:7px;border:1px solid var(--bgd);border-radius:8px"></div>
      <div><div style="font-size:10px;color:var(--txl)">🍰 Desserts</div><input id="fNbDesserts" type="number" min="0" step="1" value="${f?.nb_desserts ?? 0}" style="width:100%;padding:7px;border:1px solid var(--bgd);border-radius:8px"></div>
      <div><div style="font-size:10px;color:var(--txl)">➕ Plus</div><input id="fNbPetitPlus" type="number" min="0" step="1" value="${f?.nb_petit_plus ?? 0}" style="width:100%;padding:7px;border:1px solid var(--bgd);border-radius:8px"></div>
    </div>
    <div style="display:flex;gap:10px">
      <button id="fSave" style="flex:1;padding:11px;background:var(--vert);color:#fff;border:none;border-radius:9px;font-weight:600;cursor:pointer">💾 Enregistrer</button>
      <button id="fCancel" style="padding:11px 16px;background:var(--bgd);border:none;border-radius:9px;cursor:pointer">Annuler</button>
    </div>
  </div>`;
  document.body.appendChild(pop);
  pop.querySelector('#fCancel').addEventListener('click', () => pop.remove());
  pop.addEventListener('click', e => { if (e.target === pop) pop.remove(); });
  pop.querySelector('#fSave').addEventListener('click', async () => {
    const nom = $('fNom').value.trim();
    const prix = parseFloat($('fPrix').value);
    if (!nom) return alert('Donnez un nom au forfait');
    if (!Number.isFinite(prix) || prix < 0) return alert('Prix invalide');
    const nb_entrees = parseInt($('fNbEntrees').value, 10) || 0;
    const nb_plats = parseInt($('fNbPlats').value, 10) || 0;
    const nb_desserts = parseInt($('fNbDesserts').value, 10) || 0;
    const nb_petit_plus = parseInt($('fNbPetitPlus').value, 10) || 0;
    if (nb_entrees + nb_plats + nb_desserts + nb_petit_plus < 1) return alert('La formule doit contenir au moins 1 élément.');
    const payload = { nom, prix, description: $('fDesc').value.trim() || null, inclut_courses: $('fCourses').checked, nb_entrees, nb_plats, nb_desserts, nb_petit_plus };
    try {
      if (id) {
        await writeVerified(() => sb.from('forfaits').update(payload).eq('id', id).select('id'));
      } else {
        const ordreMax = mesForfaitsData.reduce((a, x) => Math.max(a, x.ordre || 0), 0);
        await writeVerified(() => sb.from('forfaits').insert({ ...payload, active: true, ordre: ordreMax + 1, salarie_id: salarieProfile.id, entreprise_id: salarieProfile.entreprise_id }).select('id'));
      }
      pop.remove();
      await renderMesForfaits();
    } catch (e) { alert('⚠️ ' + msgErr(e)); }
  });
}
async function deleteForfait(id) {
  if (!confirm('Supprimer ce forfait ?')) return;
  try {
    await writeVerified(() => sb.from('forfaits').delete().eq('id', id).select('id'));
    await renderMesForfaits();
  } catch (e) { alert('⚠️ ' + msgErr(e)); }
}

// --- MES MODALITES DE PAIEMENT ---
function setupMonPaiement() {
  const t = $('monPaiementToggle'); if (!t) return;
  t.addEventListener('click', () => {
    const b = $('monPaiementBody');
    const open = b.style.display !== 'none';
    b.style.display = open ? 'none' : 'block';
    $('monPaiementChevron').textContent = open ? 'Afficher ▾' : 'Masquer ▴';
    if (!open) renderMonPaiement();
  });
}
function renderMonPaiement() {
  const val = salarieProfile.instructions_paiement || '';
  $('monPaiementBody').innerHTML = `<div style="font-size:12px;color:var(--txl);margin-bottom:10px">Ces informations s'afficheront à vos clientes après leur commande (RIB, PayPal, chèque, espèces...).</div>
    <textarea id="paiementTxt" rows="4" style="width:100%;padding:10px;border:1px solid var(--bgd);border-radius:8px;font-family:inherit;box-sizing:border-box" placeholder="ex: Virement IBAN FR76... / PayPal mon@email.fr / Chèque à l'ordre de...">${escapeHtml(val)}</textarea>
    <button id="btnSavePaiement" style="background:var(--vert);color:#fff;border:none;border-radius:8px;padding:9px 16px;font-size:13px;cursor:pointer;margin-top:8px">💾 Enregistrer</button>`;
  $('btnSavePaiement').addEventListener('click', async () => {
    const txt = $('paiementTxt').value.trim();
    try {
      await writeVerified(() => sb.from('salaries').update({ instructions_paiement: txt || null }).eq('id', salarieProfile.id).select('id'));
      salarieProfile.instructions_paiement = txt;
      alert('✅ Modalités de paiement enregistrées');
    } catch (e) { alert('⚠️ ' + msgErr(e)); }
  });
}

// --- bind events ---
document.addEventListener('DOMContentLoaded', async () => {
  $('btnLogin').addEventListener('click', login);
  $('btnLogout').addEventListener('click', logout);
  $('iEmail').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('iMdp').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
  $('semSelect').addEventListener('change', chargerMissions);
  $('calSemSelect').addEventListener('change', renderCalSem);
  $('calMoisSelect').addEventListener('change', renderCalMois);
  $('btnListe').addEventListener('click', () => setView('liste'));
  $('btnSem').addEventListener('click', () => setView('semaine'));
  $('btnMois').addEventListener('click', () => setView('mois'));
  document.body.addEventListener('click', (e) => {
    const t = e.target.closest('.plat-header');
    if (t && t.dataset.target) toggleIng(t.dataset.target);
  });
  // Cloche notifs
  const bell = $('notifBell');
  if (bell) bell.addEventListener('click', (e) => { e.stopPropagation(); $('notifPanel').classList.toggle('show'); });
  document.addEventListener('click', (e) => {
    const panel = $('notifPanel');
    if (panel && panel.classList.contains('show') && !e.target.closest('#notifPanel') && !e.target.closest('#notifBell')) {
      panel.classList.remove('show');
    }
  });

  // Auto-login si session existe — sinon redirige vers le login unifie
  const { data: { session } } = await sb.auth.getSession();
  if (session) {
    const { data: profile } = await sb.from('salaries').select('*').eq('id', session.user.id).single();
    if (profile) {
      salarieProfile = profile;
      await initSalarie();
      return;
    }
    await sb.auth.signOut();
  }
  window.location.href = '/';
});
