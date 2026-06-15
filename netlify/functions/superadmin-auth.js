// Auth endpoint pour le super-admin my batch.
// POST { email, password } -> { access_token, user }
// Verifie email = structify.crm@gmail.com AVANT de renvoyer la session.

const SUPER_ADMIN_EMAIL = 'structify.crm@gmail.com';

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { email, password, refresh_token } = body;

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Configuration manquante' }) };
  }

  // Cas refresh_token : pas besoin d'email/password
  if (refresh_token) {
    try {
      const r = await fetch(`${sbUrl}/auth/v1/token?grant_type=refresh_token`, {
        method: 'POST',
        headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token })
      });
      const data = await r.json();
      if (!r.ok) return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: data.error_description || 'Refresh failed' }) };
      if ((data.user?.email || '').toLowerCase() !== SUPER_ADMIN_EMAIL.toLowerCase()) {
        return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Accès réservé.' }) };
      }
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          access_token: data.access_token,
          refresh_token: data.refresh_token,
          expires_at: data.expires_at,
          user: { id: data.user.id, email: data.user.email }
        })
      };
    } catch (e) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
    }
  }

  if (!email || !password) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Email et mot de passe requis' }) };
  }
  if (email.toLowerCase() !== SUPER_ADMIN_EMAIL.toLowerCase()) {
    return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Accès réservé au super-admin.' }) };
  }

  try {
    const r = await fetch(`${sbUrl}/auth/v1/token?grant_type=password`, {
      method: 'POST',
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });

    const data = await r.json();
    if (!r.ok) {
      return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: data.error_description || data.msg || 'Identifiants invalides' }) };
    }

    // Double-check : email retourne == super-admin
    if (data.user?.email?.toLowerCase() !== SUPER_ADMIN_EMAIL.toLowerCase()) {
      return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Accès réservé.' }) };
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        access_token: data.access_token,
        refresh_token: data.refresh_token,
        expires_at: data.expires_at,
        user: {
          id: data.user.id,
          email: data.user.email
        }
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
};
