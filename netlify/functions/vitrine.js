// /.netlify/functions/vitrine?slug=<slug>
// Endpoint PUBLIC pour la page vitrine d'une batchcookeuse : renvoie la marque,
// ses forfaits et quelques plats. Ne renvoie AUCUNE info privée (paiement, emails).
exports.handler = async (event) => {
  const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, OPTIONS' };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };

  const slug = (event.queryStringParameters?.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  if (!slug) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'slug requis' }) };

  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Config manquante' }) };
  const h = { apikey: key, Authorization: `Bearer ${key}` };

  try {
    const er = await fetch(`${url}/rest/v1/entreprises?slug=eq.${encodeURIComponent(slug)}&select=id,slug,nom_marque,nom_contact,admin_email,logo_url,cover_url,portrait_url,bio,ville,couleur_principale,couleur_secondaire,credit_impot_sap,vitrine_active,vitrine_offerte,vitrine_avis,cycle,plan,subscription_status,active`, { headers: h });
    const ed = await er.json();
    const ent = Array.isArray(ed) && ed[0];
    if (!ent) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'introuvable' }) };
    if (ent.active === false) return { statusCode: 403, headers: cors, body: JSON.stringify({ error: 'inactif' }) };

    // La vitrine est un avantage de la formule ANNUELLE (ou founder), OU offerte à une
    // cliente spéciale (vitrine_offerte). Abonnement valide + activable/désactivable
    // par la cuisinière (vitrine_active). Sinon : page inexistante.
    const aboActif = ['trialing', 'active', 'past_due'].includes(ent.subscription_status) || ent.plan === 'founder';
    const droitVitrine = ent.cycle === 'annuel' || ent.plan === 'founder' || ent.vitrine_offerte === true;
    const vitrineOk = droitVitrine && aboActif && ent.vitrine_active !== false;
    if (!vitrineOk) return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'introuvable' }) };

    const avisOn = ent.vitrine_avis !== false;
    const [fr, rr, ar] = await Promise.all([
      fetch(`${url}/rest/v1/forfaits?entreprise_id=eq.${ent.id}&salarie_id=is.null&active=eq.true&select=nom,prix,description,inclut_courses,nb_entrees,nb_plats,nb_desserts,nb_petit_plus&order=ordre.asc`, { headers: h }),
      fetch(`${url}/rest/v1/recettes?entreprise_id=eq.${ent.id}&active=eq.true&photo_url=not.is.null&select=nom_du_plat,photo_url&limit=8`, { headers: h }),
      avisOn ? fetch(`${url}/rest/v1/avis?entreprise_id=eq.${ent.id}&select=auteur,note,texte,created_at&order=created_at.desc&limit=12`, { headers: h }) : Promise.resolve(null)
    ]);
    const forfaits = await fr.json();
    const plats = await rr.json();
    const avis = ar ? await ar.json() : [];

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'public, max-age=60' },
      body: JSON.stringify({
        slug: ent.slug,
        nom_marque: ent.nom_marque || 'Batchcooking à domicile',
        nom_contact: ent.nom_contact || null,
        contactable: !!ent.admin_email,
        credit_impot: !!ent.credit_impot_sap,
        logo_url: ent.logo_url || null,
        cover_url: ent.cover_url || null,
        bio: ent.bio || null,
        ville: ent.ville || null,
        portrait_url: ent.portrait_url || null,
        couleur_principale: ent.couleur_principale || '#3d6b4f',
        couleur_secondaire: ent.couleur_secondaire || '#e8843d',
        forfaits: Array.isArray(forfaits) ? forfaits : [],
        plats: Array.isArray(plats) ? plats : [],
        avis: Array.isArray(avis) ? avis : []
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
