// /.netlify/functions/admin-action
// Operations admin qui necessitent le service_role, executees UNIQUEMENT cote serveur.
// Le service_role n'est JAMAIS renvoye au navigateur.
//
// Securite : on verifie le access_token Supabase de l'appelant, son appartenance a
// admins_entreprise, puis CHAQUE operation est scopee a l'entreprise de l'appelant
// (sauf les actions "founder" reservees au super-admin).
//
// Variables d'environnement requises :
//   SUPABASE_URL              = URL du projet Supabase
//   SUPABASE_SERVICE_KEY      = service_role key

const SB_URL = process.env.SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_KEY;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
const json = (code, obj) => ({
  statusCode: code,
  headers: { ...cors, 'Content-Type': 'application/json' },
  body: JSON.stringify(obj)
});

function rest(path, opts = {}) {
  return fetch(`${SB_URL}/rest/v1/${path}`, {
    ...opts,
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}
async function pg(path, opts) {
  const r = await rest(path, opts);
  const t = await r.text();
  const d = t ? JSON.parse(t) : null;
  if (!r.ok) throw new Error((d && (d.message || d.hint || d.error)) || `db ${r.status}`);
  return d;
}
function authAdmin(path, opts = {}) {
  return fetch(`${SB_URL}/auth/v1/admin/${path}`, {
    ...opts,
    headers: { apikey: SVC, Authorization: `Bearer ${SVC}`, 'Content-Type': 'application/json', ...(opts.headers || {}) }
  });
}
async function createAuthUser({ email, password, type, nom, telephone, adresse, notes }) {
  const r = await authAdmin('users', {
    method: 'POST',
    body: JSON.stringify({ email, password, email_confirm: true, user_metadata: { type, nom, telephone, adresse, notes } })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d.msg || d.message || `auth create ${r.status}`);
  return d;
}
async function updateAuthUser(id, { email, password }) {
  const b = {};
  if (email) b.email = email;
  if (password) b.password = password;
  if (!Object.keys(b).length) return null;
  const r = await authAdmin(`users/${id}`, { method: 'PUT', body: JSON.stringify(b) });
  const d = await r.json();
  if (!r.ok) throw new Error(d.msg || d.message || `auth update ${r.status}`);
  return d;
}
async function deleteAuthUser(id) {
  const r = await authAdmin(`users/${id}`, { method: 'DELETE' });
  if (!r.ok && r.status !== 404) {
    const d = await r.json().catch(() => ({}));
    throw new Error(d.msg || d.message || `auth delete ${r.status}`);
  }
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return json(405, { error: 'Method Not Allowed' });
  if (!SB_URL || !SVC) return json(500, { error: 'Configuration Supabase incomplete' });

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return json(400, { error: 'Invalid JSON' }); }
  const { access_token, action, payload = {} } = body;
  if (!access_token || !action) return json(400, { error: 'access_token et action requis' });

  // 1) Verifier l'utilisateur appelant
  let user;
  try {
    const ur = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SVC, Authorization: `Bearer ${access_token}` } });
    if (!ur.ok) return json(401, { error: 'Session invalide' });
    user = await ur.json();
  } catch { return json(401, { error: 'Session invalide' }); }

  // 2) Verifier qu'il est admin + recuperer son entreprise + plan
  let ENT, isFounder;
  try {
    const admins = await pg(`admins_entreprise?user_id=eq.${user.id}&select=entreprise_id,entreprises(plan)`);
    if (!Array.isArray(admins) || !admins.length) return json(403, { error: 'Non autorise' });
    ENT = admins[0].entreprise_id;
    isFounder = ((admins[0].entreprises && admins[0].entreprises.plan) || 'standard') === 'founder';
  } catch (e) { return json(500, { error: 'Verif admin : ' + e.message }); }

  const minimal = { Prefer: 'return=minimal' };

  try {
    switch (action) {

      // ---------- Comptes (clientes / salariees) ----------
      case 'create_user': {
        const { email, password, type, nom, telephone, adresse, notes, nombre_portions } = payload;
        if (!email || !password || !type) return json(400, { error: 'email, password, type requis' });
        if (!['client', 'salarie'].includes(type)) return json(400, { error: 'type invalide' });
        const u = await createAuthUser({ email, password, type, nom, telephone, adresse, notes });
        await new Promise(r => setTimeout(r, 250)); // laisse le trigger creer la ligne profil
        const table = type === 'client' ? 'clients' : 'salaries';
        const patch = { entreprise_id: ENT };
        if (type === 'client' && nombre_portions != null) patch.nombre_portions = nombre_portions;
        await rest(`${table}?id=eq.${u.id}`, { method: 'PATCH', headers: minimal, body: JSON.stringify(patch) });
        const rows = await pg(`${table}?id=eq.${u.id}&select=*`);
        return json(200, { profile: Array.isArray(rows) ? rows[0] : null });
      }

      case 'update_user_auth': {
        const { id, email, password, type } = payload;
        if (!id) return json(400, { error: 'id requis' });
        // self = l'admin modifie son propre compte (il est dans admins_entreprise, pas clients/salaries)
        if (!isFounder && id !== user.id) {
          const table = type === 'salarie' ? 'salaries' : 'clients';
          const rows = await pg(`${table}?id=eq.${id}&entreprise_id=eq.${ENT}&select=id`);
          if (!Array.isArray(rows) || !rows.length) return json(403, { error: 'Cible hors entreprise' });
        }
        await updateAuthUser(id, { email, password });
        return json(200, { ok: true });
      }

      case 'delete_user': {
        const { id, type } = payload;
        if (!id || !type) return json(400, { error: 'id et type requis' });
        const table = type === 'salarie' ? 'salaries' : 'clients';
        if (!isFounder) {
          const rows = await pg(`${table}?id=eq.${id}&entreprise_id=eq.${ENT}&select=id`);
          if (!Array.isArray(rows) || !rows.length) return json(403, { error: 'Cible hors entreprise' });
        }
        if (type === 'client') {
          await rest(`favoris?client_id=eq.${id}`, { method: 'DELETE', headers: minimal });
          await rest(`commandes?client_id=eq.${id}`, { method: 'DELETE', headers: minimal });
          await rest(`clients?id=eq.${id}`, { method: 'DELETE', headers: minimal });
        } else {
          await rest(`commandes?assigne_a_id=eq.${id}`, { method: 'PATCH', headers: minimal, body: JSON.stringify({ assigne_a_id: null }) });
          await rest(`clients?assigne_a_id=eq.${id}`, { method: 'PATCH', headers: minimal, body: JSON.stringify({ assigne_a_id: null }) });
          await rest(`salaries?id=eq.${id}`, { method: 'DELETE', headers: minimal });
        }
        await deleteAuthUser(id);
        return json(200, { ok: true });
      }

      // ---------- Founder / super-admin uniquement ----------
      case 'list_entreprises': {
        if (!isFounder) return json(403, { error: 'Founder requis' });
        const filt = encodeURIComponent('*goût du lien*');
        const rows = await pg(`entreprises?nom_marque=not.ilike.${filt}&select=*&order=nom_marque.asc`);
        return json(200, { entreprises: rows || [] });
      }

      case 'platform_stats': {
        if (!isFounder) return json(403, { error: 'Founder requis' });
        const [clients, recettes, commandes] = await Promise.all([
          pg(`clients?select=entreprise_id`),
          pg(`recettes?select=entreprise_id`),
          pg(`commandes?select=entreprise_id,montant,semaine_du,statut`)
        ]);
        return json(200, { clients, recettes, commandes });
      }

      case 'save_entreprise': {
        if (!isFounder) return json(403, { error: 'Founder requis' });
        const { id, fields, email, password, contact, seed_from_slug } = payload;
        if (!fields) return json(400, { error: 'fields requis' });
        if (id) {
          if (email || password) {
            const links = await pg(`admins_entreprise?entreprise_id=eq.${id}&select=user_id`);
            const uid = Array.isArray(links) && links[0] ? links[0].user_id : null;
            if (uid) await updateAuthUser(uid, { email, password });
          }
          await rest(`entreprises?id=eq.${id}`, { method: 'PATCH', headers: minimal, body: JSON.stringify(fields) });
          const rows = await pg(`entreprises?id=eq.${id}&select=*`);
          return json(200, { entreprise: Array.isArray(rows) ? rows[0] : null });
        }
        // creation
        const created = await pg(`entreprises`, { method: 'POST', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ ...fields, active: true }) });
        const ent = Array.isArray(created) ? created[0] : created;
        let authUser;
        try { authUser = await createAuthUser({ email, password, type: 'admin', nom: contact }); }
        catch (e) { await rest(`entreprises?id=eq.${ent.id}`, { method: 'DELETE', headers: minimal }); throw new Error('Creation compte auth : ' + e.message); }
        await rest(`clients?id=eq.${authUser.id}`, { method: 'DELETE', headers: minimal });
        await rest(`salaries?id=eq.${authUser.id}`, { method: 'DELETE', headers: minimal });
        try {
          await pg(`admins_entreprise`, { method: 'POST', headers: minimal, body: JSON.stringify({ user_id: authUser.id, entreprise_id: ent.id, nom: contact }) });
        } catch (e) {
          await deleteAuthUser(authUser.id);
          await rest(`entreprises?id=eq.${ent.id}`, { method: 'DELETE', headers: minimal });
          throw e;
        }
        // Starter pack ingredients (non bloquant)
        try {
          if (seed_from_slug) {
            const src = await pg(`entreprises?slug=eq.${seed_from_slug}&select=id`);
            const srcId = Array.isArray(src) && src[0] ? src[0].id : null;
            if (srcId) {
              const ings = await pg(`ingredients?entreprise_id=eq.${srcId}&select=nom,unite_par_defaut,rayon`);
              if (Array.isArray(ings) && ings.length) {
                await rest(`ingredients`, { method: 'POST', headers: minimal, body: JSON.stringify(ings.map(i => ({ ...i, entreprise_id: ent.id }))) });
              }
            }
          }
        } catch (_) { /* silencieux */ }
        return json(200, { entreprise: ent });
      }

      case 'delete_entreprise': {
        if (!isFounder) return json(403, { error: 'Founder requis' });
        const { id } = payload;
        if (!id) return json(400, { error: 'id requis' });
        const links = await pg(`admins_entreprise?entreprise_id=eq.${id}&select=user_id`);
        await rest(`entreprises?id=eq.${id}`, { method: 'DELETE', headers: minimal });
        if (Array.isArray(links)) {
          for (const l of links) { if (l.user_id) await deleteAuthUser(l.user_id).catch(() => {}); }
        }
        return json(200, { ok: true });
      }

      default:
        return json(400, { error: 'Action inconnue : ' + action });
    }
  } catch (e) {
    return json(500, { error: e.message || String(e) });
  }
};
