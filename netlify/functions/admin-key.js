// /.netlify/functions/admin-key
// Mode 1 (nouveau, multi-tenant) : verifie un access_token Supabase + appartenance a admins_entreprise
// Mode 2 (legacy) : verifie le mot de passe admin (ADMIN_PASSWORD env) -- conserve pour le super-admin
// Variables d'environnement requises :
//   SUPABASE_URL              = URL du projet Supabase
//   SUPABASE_SERVICE_KEY      = service_role key du projet Supabase
//   ADMIN_PASSWORD            = (optionnel) mot de passe legacy

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: corsHeaders, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !serviceKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Configuration Supabase incomplete' }) };
  }

  // Mode 1 : access_token Supabase (multi-tenant)
  if (body.access_token) {
    try {
      const userRes = await fetch(`${url}/auth/v1/user`, {
        headers: { apikey: serviceKey, Authorization: `Bearer ${body.access_token}` }
      });
      if (!userRes.ok) {
        return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Session invalide' }) };
      }
      const user = await userRes.json();

      const adminRes = await fetch(
        `${url}/rest/v1/admins_entreprise?user_id=eq.${user.id}&select=entreprise_id,nom,entreprises(plan,nom_marque,active,couleur_principale,couleur_secondaire,couleur_topbar,logo_url)`,
        { headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` } }
      );
      const admins = await adminRes.json();
      if (!Array.isArray(admins) || admins.length === 0) {
        return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: "Compte non autorise pour l'admin" }) };
      }
      const ent = admins[0].entreprises || {};
      if (ent.active === false) {
        return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Compte desactive — contactez le support' }) };
      }

      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url,
          entreprise_id: admins[0].entreprise_id,
          nom: admins[0].nom,
          plan: ent.plan || 'standard',
          nom_marque: ent.nom_marque || '',
          couleur_principale: ent.couleur_principale || null,
          couleur_secondaire: ent.couleur_secondaire || null,
          couleur_topbar: ent.couleur_topbar || null,
          logo_url: ent.logo_url || null,
          user_id: user.id,
          email: user.email
        })
      };
    } catch (e) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Verification echec : ' + e.message }) };
    }
  }

  // Mode 2 : password legacy (super-admin)
  const expected = process.env.ADMIN_PASSWORD;
  if (body.password && expected && body.password === expected) {
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, legacy: true })
    };
  }

  return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Authentification requise' }) };
};
