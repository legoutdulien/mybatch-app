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
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=30' },
      body: JSON.stringify({
        id: ent.id,
        slug: ent.slug,
        nom_marque: ent.nom_marque,
        nom_contact: ent.nom_contact,
        logo_url: ent.logo_url,
        couleur_principale: ent.couleur_principale,
        couleur_secondaire: ent.couleur_secondaire,
        instructions_paiement: ent.instructions_paiement,
        montant_client_default: ent.montant_client_default,
        max_four_commande: ent.max_four_commande,
        credit_impot_sap: ent.credit_impot_sap
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
};
