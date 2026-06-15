// Renvoie la data agregee pour le dashboard super-admin :
// - entreprises (avec counts clientes/recettes/commandes)
// - KPIs (MRR, active, trial, churn)
// - activite recente

const SUPER_ADMIN_EMAIL = 'structify.crm@gmail.com';
const LGDL_SLUG_TO_EXCLUDE = 'legoutdulien'; // LGDL gere via app.legoutdulien.com

// Prix abonnement standard mybatch (utilises pour calculer le MRR)
const PRICE_MENSUEL = 79;
const PRICE_ANNUEL_MOIS = 49;

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Configuration manquante' }) };
  }

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Token manquant' }) };
  }

  try {
    // Verifie le token + email
    const userRes = await fetch(`${sbUrl}/auth/v1/user`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${token}` }
    });
    if (!userRes.ok) {
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Token invalide' }) };
    }
    const user = await userRes.json();
    if (user.email?.toLowerCase() !== SUPER_ADMIN_EMAIL.toLowerCase()) {
      return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Accès refusé' }) };
    }

    // Fetch entreprises (avec service_role pour bypass RLS) en excluant LGDL et super-admin lui-meme
    const adminHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };
    const entRes = await fetch(
      `${sbUrl}/rest/v1/entreprises?select=*&slug=neq.${LGDL_SLUG_TO_EXCLUDE}&admin_email=neq.${encodeURIComponent(SUPER_ADMIN_EMAIL)}&order=created_at.desc`,
      { headers: adminHeaders }
    );
    if (!entRes.ok) {
      const t = await entRes.text();
      throw new Error('Fetch entreprises: ' + t);
    }
    const entreprises = await entRes.json();

    // Pour chaque entreprise, recup count clientes / recettes (en parallele, limite a 10 simultane)
    const enrichWith = async (e) => {
      try {
        const [cliR, recR, cmdR] = await Promise.all([
          fetch(`${sbUrl}/rest/v1/clients?select=count&entreprise_id=eq.${e.id}`, { headers: { ...adminHeaders, Prefer: 'count=exact' } }),
          fetch(`${sbUrl}/rest/v1/recettes?select=count&entreprise_id=eq.${e.id}`, { headers: { ...adminHeaders, Prefer: 'count=exact' } }),
          fetch(`${sbUrl}/rest/v1/commandes?select=count&entreprise_id=eq.${e.id}&semaine_du=gte.${thirtyDaysAgo()}`, { headers: { ...adminHeaders, Prefer: 'count=exact' } }),
        ]);
        e.clients_count = parseCountHeader(cliR);
        e.recettes_count = parseCountHeader(recR);
        e.recent_commandes_count = parseCountHeader(cmdR);
      } catch {
        e.clients_count = 0;
        e.recettes_count = 0;
        e.recent_commandes_count = 0;
      }
      return e;
    };

    await Promise.all(entreprises.map(enrichWith));

    // Calcul KPIs
    let mrr = 0;
    let active_count = 0;
    let trial_count = 0;
    let churn_count = 0;
    for (const e of entreprises) {
      const s = e.subscription_status;
      if (s === 'active') {
        active_count++;
        if (e.cycle === 'annuel') mrr += PRICE_ANNUEL_MOIS;
        else mrr += PRICE_MENSUEL;
      } else if (s === 'trialing') {
        trial_count++;
      } else if (['canceled', 'past_due', 'incomplete'].includes(s) || e.active === false) {
        churn_count++;
      }
    }

    // Activite recente
    const activity = [];
    // Derniers signups (entreprises creees dans les 7 derniers jours)
    const recentSignups = entreprises.filter(e => {
      if (!e.created_at) return false;
      return (Date.now() - new Date(e.created_at).getTime()) < 7 * 24 * 60 * 60 * 1000;
    });
    recentSignups.slice(0, 5).forEach(e => {
      activity.push({
        when: e.created_at,
        icon: '🆕',
        html: `Nouveau compte : <strong>${escapeHtml(e.nom_marque || e.admin_email)}</strong>`
      });
    });

    // Last logins (auth.users last_sign_in_at via admin API)
    try {
      const lsRes = await fetch(`${sbUrl}/auth/v1/admin/users?per_page=20`, { headers: adminHeaders });
      if (lsRes.ok) {
        const users = (await lsRes.json()).users || [];
        const recentLogins = users
          .filter(u => u.last_sign_in_at && u.email !== SUPER_ADMIN_EMAIL)
          .sort((a, b) => new Date(b.last_sign_in_at) - new Date(a.last_sign_in_at))
          .slice(0, 5);
        recentLogins.forEach(u => {
          activity.push({
            when: u.last_sign_in_at,
            icon: '🔑',
            html: `<strong>${escapeHtml(u.email)}</strong> s'est connectée`
          });
        });
      }
    } catch {}

    activity.sort((a, b) => new Date(b.when) - new Date(a.when));

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        entreprises,
        mrr,
        active_count,
        trial_count,
        churn_count,
        activity: activity.slice(0, 12)
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
};

function parseCountHeader(r) {
  const range = r.headers.get('content-range');
  if (!range) return 0;
  const m = range.match(/\/(\d+|\*)/);
  if (!m) return 0;
  return m[1] === '*' ? 0 : parseInt(m[1], 10);
}

function thirtyDaysAgo() {
  const d = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  return d.toISOString().slice(0, 10);
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c]));
}
