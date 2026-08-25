// Actions super-admin : suspend/reactivate une entreprise.
// POST { action, entreprise_id } avec Bearer token super-admin.

const SUPER_ADMIN_EMAIL = 'structify.crm@gmail.com';

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

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

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { action, entreprise_id } = body;
  if (!action || !entreprise_id) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'action et entreprise_id requis' }) };
  }

  try {
    // Verifie super-admin
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

    const adminHeaders = {
      apikey: sbKey,
      Authorization: `Bearer ${sbKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation'
    };

    // Suppression definitive : appel de la fonction SQL atomique (supprime entreprise + donnees + comptes auth lies)
    if (action === 'delete') {
      const delRes = await fetch(`${sbUrl}/rest/v1/rpc/superadmin_delete_entreprise`, {
        method: 'POST',
        headers: adminHeaders,
        body: JSON.stringify({ p_entreprise_id: entreprise_id })
      });
      if (!delRes.ok) {
        const t = await delRes.text();
        throw new Error('Suppression: ' + t);
      }
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ success: true, deleted: entreprise_id })
      };
    }

    let payload;
    if (action === 'suspend') {
      payload = { active: false };
    } else if (action === 'reactivate') {
      payload = { active: true };
    } else if (action === 'trial_extend') {
      // Etend l'essai de 7 jours a partir d'aujourd'hui (ou de la trial_ends_at existante)
      const days = parseInt(body.days, 10) || 7;
      // Recup l'entreprise courante pour calculer le nouveau trial_ends_at
      const entRes = await fetch(`${sbUrl}/rest/v1/entreprises?id=eq.${encodeURIComponent(entreprise_id)}&select=trial_ends_at,subscription_status`, {
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }
      });
      const entData = await entRes.json();
      if (!entRes.ok || !Array.isArray(entData) || !entData.length) {
        throw new Error("Entreprise introuvable pour prolonger l'essai");
      }
      const current = entData[0];
      const now = Date.now();
      const baseTime = current?.trial_ends_at ? Math.max(now, new Date(current.trial_ends_at).getTime()) : now;
      const newTrialEnd = new Date(baseTime + days * 24 * 60 * 60 * 1000);
      payload = {
        trial_ends_at: newTrialEnd.toISOString(),
        subscription_status: 'trialing'
      };
    } else if (action === 'change_plan') {
      const newPlan = body.plan;
      if (!['founder', 'standard'].includes(newPlan)) {
        return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Plan invalide' }) };
      }
      payload = { plan: newPlan };
    } else {
      return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Action inconnue' }) };
    }

    const r = await fetch(`${sbUrl}/rest/v1/entreprises?id=eq.${encodeURIComponent(entreprise_id)}`, {
      method: 'PATCH',
      headers: adminHeaders,
      body: JSON.stringify(payload)
    });
    if (!r.ok) {
      const t = await r.text();
      throw new Error('Update entreprise: ' + t);
    }
    const updated = await r.json();
    // 0 ligne modifiee = entreprise introuvable / deja a jour : ne pas renvoyer un faux succes
    if (!Array.isArray(updated) || updated.length === 0) {
      return {
        statusCode: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Aucune entreprise modifiée (introuvable ?).' })
      };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, entreprise: updated[0] })
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
};
