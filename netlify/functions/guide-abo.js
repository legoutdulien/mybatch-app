// /.netlify/functions/guide-abo
// Livre le guide PDF aux ABONNÉES ANNUELLES (guide offert avec l'abonnement annuel).
// Auth : Bearer <access_token Supabase de l'admin connectée>.
// Règles : cycle = 'annuel' + abonnement actif/essai + délai de rétractation
//   -> accès immédiat si guide_renonce = true, sinon à J+15 (fin du délai légal).
// Le PDF vient du bucket privé Supabase (jamais exposé publiquement).
const SB_URL = process.env.SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_KEY;
const DELAI_JOURS = 14;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS'
};
function json(code, obj) {
  return { statusCode: code, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (!SB_URL || !SVC) return json(500, { error: 'Configuration serveur incomplète.' });

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) return json(401, { error: 'Connexion requise.' });

  try {
    // 1) Identifier l'utilisatrice via son token
    const userRes = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SVC, Authorization: `Bearer ${token}` } });
    if (!userRes.ok) return json(401, { error: 'Session invalide, reconnecte-toi.' });
    const user = await userRes.json();

    // 2) Récupérer son entreprise
    const adminH = { apikey: SVC, Authorization: `Bearer ${SVC}` };
    const aeRes = await fetch(`${SB_URL}/rest/v1/admins_entreprise?user_id=eq.${user.id}&select=entreprise_id,entreprises(cycle,plan,subscription_status,guide_renonce,created_at)`, { headers: adminH });
    const ae = await aeRes.json();
    const ent = Array.isArray(ae) && ae[0] ? ae[0].entreprises : null;
    if (!ent) return json(403, { error: 'Compte non autorisé.' });

    // 3) Vérifier que c'est une abonnée annuelle avec un abonnement valide
    const actif = ['trialing', 'active', 'past_due'].includes(ent.subscription_status) || ent.plan === 'founder';
    if (ent.cycle !== 'annuel' || !actif) {
      return json(403, { error: "Le guide est inclus avec l'abonnement annuel. Il n'est pas disponible sur cette formule." });
    }

    // 4) Délai de rétractation : immédiat si renonciation, sinon à J+15
    if (!ent.guide_renonce) {
      const start = ent.created_at ? new Date(ent.created_at).getTime() : Date.now();
      const dispoLe = start + DELAI_JOURS * 24 * 60 * 60 * 1000;
      if (Date.now() < dispoLe) {
        const d = new Date(dispoLe).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
        return json(403, { error: `Votre guide sera disponible le ${d} (fin du délai légal de rétractation de 14 jours).` });
      }
    }

    // 5) Servir le PDF depuis le bucket privé
    const pdfRes = await fetch(`${SB_URL}/storage/v1/object/guides/guide-my-batch.pdf`, { headers: { apikey: SVC, Authorization: `Bearer ${SVC}` } });
    if (!pdfRes.ok) return json(500, { error: 'Fichier du guide momentanément indisponible.' });
    const ab = await pdfRes.arrayBuffer();
    const pdfB64 = Buffer.from(ab).toString('base64');

    return {
      statusCode: 200,
      headers: {
        ...cors,
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'attachment; filename="Guide-my-batch.pdf"',
        'Cache-Control': 'no-store'
      },
      isBase64Encoded: true,
      body: pdfB64
    };
  } catch (e) {
    return json(500, { error: 'Erreur : ' + (e.message || e) });
  }
};
