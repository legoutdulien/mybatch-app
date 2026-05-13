// /.netlify/functions/stripe-checkout
// Genere une Checkout Session Stripe pour une entreprise donnee.
// Body : { entreprise_id }
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY                = sk_test_... ou sk_live_...
//   STRIPE_PRICE_STANDARD_MENSUEL    = price_...
//   STRIPE_PRICE_STANDARD_ANNUEL     = price_...
//   STRIPE_PRICE_PREMIUM_MENSUEL     = price_...
//   STRIPE_PRICE_PREMIUM_ANNUEL      = price_...
//   SUPABASE_URL                     = ...
//   SUPABASE_SERVICE_KEY             = service_role
//   PUBLIC_BASE_URL                  = https://mybatch.cooking (sans slash final)

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://mybatch.cooking';
  if (!stripeKey || !sbUrl || !sbKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Configuration manquante (STRIPE/SUPABASE env vars)' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  const entrepriseId = body.entreprise_id;
  const accessToken = body.access_token;
  if (!entrepriseId) return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'entreprise_id requis' }) };
  if (!accessToken) return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'access_token requis' }) };

  // Verifie le token Supabase
  let user;
  try {
    const userRes = await fetch(`${sbUrl}/auth/v1/user`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${accessToken}` }
    });
    if (!userRes.ok) return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Session invalide' }) };
    user = await userRes.json();
  } catch (e) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Verification token echec' }) };
  }

  // Verifie que le caller est admin de l'entreprise OU founder
  try {
    const adminRes = await fetch(`${sbUrl}/rest/v1/admins_entreprise?user_id=eq.${user.id}&select=entreprise_id,entreprises(plan)`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }
    });
    const adminLinks = await adminRes.json();
    if (!Array.isArray(adminLinks) || adminLinks.length === 0) {
      return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Acces refuse — pas admin' }) };
    }
    const isFounder = adminLinks.some(l => l.entreprises?.plan === 'founder');
    const ownsEntreprise = adminLinks.some(l => l.entreprise_id === entrepriseId);
    if (!isFounder && !ownsEntreprise) {
      return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Acces refuse — entreprise non rattachee' }) };
    }
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Verification autorisation echec : ' + e.message }) };
  }

  // Lit l'entreprise depuis Supabase
  let ent;
  try {
    const r = await fetch(`${sbUrl}/rest/v1/entreprises?id=eq.${encodeURIComponent(entrepriseId)}&select=id,slug,nom_marque,nom_contact,admin_email,formule,cycle,plan,stripe_customer_id`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }
    });
    const data = await r.json();
    if (!Array.isArray(data) || !data[0]) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Entreprise introuvable' }) };
    }
    ent = data[0];
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Lecture entreprise echec : ' + e.message }) };
  }

  if (ent.plan === 'founder') {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Le plan Founder ne necessite pas de paiement' }) };
  }

  // Premium n'existe qu'en mensuel
  const formule = ent.formule || 'standard';
  const cycle = formule === 'premium' ? 'mensuel' : (ent.cycle || 'mensuel');

  const priceMap = {
    'standard|mensuel': process.env.STRIPE_PRICE_STANDARD_MENSUEL,
    'standard|annuel': process.env.STRIPE_PRICE_STANDARD_ANNUEL,
    'premium|mensuel': process.env.STRIPE_PRICE_PREMIUM_MENSUEL
  };
  const key = `${formule}|${cycle}`;
  const priceId = priceMap[key];
  if (!priceId) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: `Price ID manquant pour ${key}. Verifie les env vars STRIPE_PRICE_*.` }) };
  }

  // Cree la Checkout Session
  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  params.append('subscription_data[trial_period_days]', '7');
  params.append('subscription_data[metadata][entreprise_id]', ent.id);
  params.append('subscription_data[metadata][slug]', ent.slug);
  params.append('client_reference_id', ent.id);
  params.append('metadata[entreprise_id]', ent.id);
  if (ent.stripe_customer_id) {
    params.append('customer', ent.stripe_customer_id);
  } else if (ent.admin_email) {
    params.append('customer_email', ent.admin_email);
  }
  params.append('success_url', `${baseUrl}/abonnement-confirme.html?session_id={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${baseUrl}/abonnement-annule.html`);
  params.append('allow_promotion_codes', 'true');
  params.append('billing_address_collection', 'required');

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${stripeKey}`,
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: params.toString()
    });
    const session = await r.json();
    if (!r.ok) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: session.error?.message || 'Stripe error' }) };
    }
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url, session_id: session.id })
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Stripe API echec : ' + e.message }) };
  }
};
