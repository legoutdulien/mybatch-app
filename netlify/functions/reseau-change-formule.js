// /.netlify/functions/reseau-change-formule
// La tete de reseau change sa formule elle-meme (Starter / Pro / Illimite).
// Met a jour son abonnement Stripe (prix + quantite, avec prorata) puis la formule en base.
// Body : { access_token, formule, nb_cuisinieres }
//   formule = reseau_starter | reseau_pro | reseau_illimite
//   nb_cuisinieres = requis pour illimite (min 9)

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!stripeKey || !sbUrl || !sbKey) return json(cors, 500, { error: 'Config manquante' });

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch { return json(cors, 400, { error: 'Invalid JSON' }); }
  const token = body.access_token;
  const formule = body.formule;
  let quantity = parseInt(body.nb_cuisinieres, 10);
  if (!token) return json(cors, 400, { error: 'access_token requis' });

  const PRICE = {
    reseau_starter: process.env.STRIPE_PRICE_RESEAU_STARTER,
    reseau_pro: process.env.STRIPE_PRICE_RESEAU_PRO,
    reseau_illimite: process.env.STRIPE_PRICE_RESEAU_ILLIMITE
  };
  if (!PRICE[formule]) return json(cors, 400, { error: 'Formule invalide' });
  if (formule === 'reseau_illimite') {
    if (!Number.isFinite(quantity) || quantity < 9) quantity = 9;
    if (quantity > 200) quantity = 200;
  } else quantity = 1;

  // 1. Auth
  const userRes = await fetch(`${sbUrl}/auth/v1/user`, { headers: { apikey: sbKey, Authorization: `Bearer ${token}` } });
  if (!userRes.ok) return json(cors, 401, { error: 'Session invalide' });
  const user = await userRes.json();

  // 2. Entreprise + abonnement
  const linkRes = await fetch(`${sbUrl}/rest/v1/admins_entreprise?user_id=eq.${user.id}&select=entreprise_id,entreprises(stripe_subscription_id,plan)`, {
    headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }
  });
  const links = await linkRes.json();
  if (!Array.isArray(links) || !links[0]) return json(cors, 403, { error: 'Aucune entreprise associee' });
  const entrepriseId = links[0].entreprise_id;
  const ent = links[0].entreprises || {};
  if (ent.plan === 'founder') return json(cors, 400, { error: 'Compte founder — pas d abonnement Stripe' });
  if (!ent.stripe_subscription_id) return json(cors, 400, { error: 'Aucun abonnement Stripe actif' });

  try {
    // 3. Recup l'item courant de l'abonnement
    const subRes = await fetch(`https://api.stripe.com/v1/subscriptions/${ent.stripe_subscription_id}`, { headers: { Authorization: `Bearer ${stripeKey}` } });
    const sub = await subRes.json();
    if (!subRes.ok) return json(cors, 500, { error: sub.error?.message || 'Abonnement introuvable' });
    const itemId = sub.items && sub.items.data && sub.items.data[0] && sub.items.data[0].id;
    if (!itemId) return json(cors, 500, { error: 'Ligne d abonnement introuvable' });

    // 4. Bascule le prix + la quantite, avec prorata
    const p = new URLSearchParams();
    p.append('items[0][id]', itemId);
    p.append('items[0][price]', PRICE[formule]);
    p.append('items[0][quantity]', String(quantity));
    p.append('proration_behavior', 'create_prorations');
    const upRes = await fetch(`https://api.stripe.com/v1/subscriptions/${ent.stripe_subscription_id}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: p.toString()
    });
    const up = await upRes.json();
    if (!upRes.ok) return json(cors, 500, { error: up.error?.message || 'Mise a jour Stripe echec' });

    // 5. Synchro immediate en base (le webhook confirmera aussi). On verifie r.ok :
    // l'abonnement Stripe est deja modifie (facturation reelle), donc si la base ne suit
    // pas, on doit le signaler plutot que de renvoyer un faux ok.
    const syncRes = await fetch(`${sbUrl}/rest/v1/entreprises?id=eq.${entrepriseId}`, {
      method: 'PATCH',
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ formule, cycle: 'mensuel', reseau_cuisinieres: formule === 'reseau_illimite' ? quantity : null })
    });
    if (!syncRes.ok) return json(cors, 502, { error: 'Abonnement modifié chez Stripe, mais synchro base échouée — réessayez ou contactez le support.' });
    return json(cors, 200, { ok: true, formule, quantity });
  } catch (e) {
    return json(cors, 500, { error: 'Stripe API : ' + e.message });
  }
};

function json(cors, code, obj) {
  return { statusCode: code, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}
