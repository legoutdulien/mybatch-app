// /.netlify/functions/branding?slug=<slug>
// Endpoint public : renvoie le branding d'une entreprise (logo, nom, couleurs)
// pour personnaliser la page de login selon le sous-domaine.

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  const slug = (event.queryStringParameters?.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  const id = (event.queryStringParameters?.id || '').replace(/[^a-f0-9-]/g, '');
  if (!slug && !id) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'slug ou id requis' }) };
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Config manquante' }) };
  }

  try {
    const filter = id ? `id=eq.${id}` : `slug=eq.${encodeURIComponent(slug)}`;
    const r = await fetch(
      `${url}/rest/v1/entreprises?${filter}&select=id,slug,nom_marque,nom_contact,logo_url,couleur_principale,couleur_secondaire,instructions_paiement,montant_client_default,max_four_commande,credit_impot_sap,active`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const data = await r.json();
    if (!Array.isArray(data) || !data[0]) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Entreprise introuvable' }) };
    }
    const ent = data[0];
    if (ent.active === false) {
      return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Compte desactive' }) };
    }

    // Champs SENSIBLES (coordonnées de paiement, montant) : renvoyés UNIQUEMENT si l'appelant
    // présente un token valide et appartient à CETTE entreprise (cliente, cuisinière ou admin).
    // La page de login publique (sans token) ne reçoit que le branding visuel.
    let includePay = false;
    const auth = event.headers.authorization || event.headers.Authorization || '';
    const token = auth.replace(/^Bearer\s+/i, '');
    if (token) {
      try {
        const ur = await fetch(`${url}/auth/v1/user`, { headers: { apikey: key, Authorization: `Bearer ${token}` } });
        if (ur.ok) {
          const u = await ur.json();
          const h = { apikey: key, Authorization: `Bearer ${key}` };
          const [c, s, a] = await Promise.all([
            fetch(`${url}/rest/v1/clients?id=eq.${u.id}&entreprise_id=eq.${ent.id}&select=id`, { headers: h }),
            fetch(`${url}/rest/v1/salaries?id=eq.${u.id}&entreprise_id=eq.${ent.id}&select=id`, { headers: h }),
            fetch(`${url}/rest/v1/admins_entreprise?user_id=eq.${u.id}&entreprise_id=eq.${ent.id}&select=user_id`, { headers: h })
          ]);
          const nonEmpty = async (resp) => { try { const j = await resp.json(); return Array.isArray(j) && j.length > 0; } catch { return false; } };
          includePay = (await nonEmpty(c)) || (await nonEmpty(s)) || (await nonEmpty(a));
        }
      } catch (_) { /* token invalide : on reste en public */ }
    }

    const out = {
      id: ent.id,
      slug: ent.slug,
      nom_marque: ent.nom_marque,
      nom_contact: ent.nom_contact,
      logo_url: ent.logo_url,
      couleur_principale: ent.couleur_principale,
      couleur_secondaire: ent.couleur_secondaire,
      max_four_commande: ent.max_four_commande,
      credit_impot_sap: ent.credit_impot_sap
    };
    if (includePay) {
      out.instructions_paiement = ent.instructions_paiement;
      out.montant_client_default = ent.montant_client_default;
    }
    // Sans token on autorise un cache public court ; avec token (données perso) on ne cache pas.
    const cache = includePay ? 'no-store' : 'public, max-age=30';
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': cache },
      body: JSON.stringify(out)
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
};
