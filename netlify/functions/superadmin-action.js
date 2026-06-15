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

    let payload;
    if (action === 'suspend') {
      payload = { active: false };
    } else if (action === 'reactivate') {
      payload = { active: true };
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

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ success: true, entreprise: updated[0] })
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
};
