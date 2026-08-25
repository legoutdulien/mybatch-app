// /.netlify/functions/annuaire-list
// Endpoint public : renvoie la liste des entreprises visibles sur l'annuaire my batch
// (verifiee=true, visible_annuaire=true, active=true). Ne renvoie que des champs
// publics — jamais de service_role cote navigateur, jamais de champs sensibles
// (email, stripe, instructions de paiement).

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Config manquante' }) };
  }

  try {
    const r = await fetch(
      `${url}/rest/v1/entreprises?verifiee=eq.true&visible_annuaire=eq.true&active=eq.true&select=id,slug,nom_marque,ville,latitude,longitude,logo_url,couleur_principale,bio,tags,montant_client_default`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const data = await r.json();
    if (!Array.isArray(data)) {
      return { statusCode: 502, headers: corsHeaders, body: JSON.stringify({ error: 'Reponse inattendue de la base' }) };
    }
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
      body: JSON.stringify({ entreprises: data })
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
};
