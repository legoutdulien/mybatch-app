// signup-checkout.js
// Genere une Stripe Checkout Session pour une NOUVELLE inscription (pas encore d'entreprise dans Supabase).
// Le webhook stripe-webhook.js cree l'entreprise + l'auth user a 'checkout.session.completed'.
// Body : { plan, nom_marque, slug, email, password, cgu, renonce_retractation }

const FORBIDDEN_SLUGS = new Set([
  'admin','www','api','app','blog','help','support','contact','login','signup',
  'mybatch','mybatch-admin','superadmin','legoutdulien','lgdl','test','demo'
]);

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
  const baseUrl = process.env.PUBLIC_BASE_URL || 'https://app.mybatch.cooking';
  if (!stripeKey || !sbUrl || !sbKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Config manquante' }) };
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Invalid JSON' }) }; }

  const { plan, nom_marque, slug, email, password, cgu, renonce_retractation } = body;

  // Validations
  if (!['mensuel','annuel'].includes(plan)) return jsonErr(corsHeaders, 400, 'Plan invalide');
  if (!nom_marque || nom_marque.length < 2) return jsonErr(corsHeaders, 400, 'Nom de marque requis');
  if (!slug || !/^[a-z0-9-]{3,50}$/.test(slug)) return jsonErr(corsHeaders, 400, 'Slug invalide');
  if (FORBIDDEN_SLUGS.has(slug)) return jsonErr(corsHeaders, 400, 'Ce slug est reserve, choisissez-en un autre');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonErr(corsHeaders, 400, 'Email invalide');
  if (!password || password.length < 8) return jsonErr(corsHeaders, 400, 'Mot de passe : 8 caracteres minimum');
  if (!cgu) return jsonErr(corsHeaders, 400, 'Acceptation des CGU/CGV requise');

  // Verifie que slug et email sont libres
  const adminHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };
  try {
    const slugCheck = await fetch(`${sbUrl}/rest/v1/entreprises?slug=eq.${encodeURIComponent(slug)}&select=id`, { headers: adminHeaders });
    const slugData = await slugCheck.json();
    if (Array.isArray(slugData) && slugData.length > 0) {
      return jsonErr(corsHeaders, 409, `Slug "${slug}" deja utilise, choisissez-en un autre`);
    }
  } catch (e) {
    return jsonErr(corsHeaders, 500, 'Verification slug echec : ' + e.message);
  }

  try {
    const userList = await fetch(`${sbUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, { headers: adminHeaders });
    if (userList.ok) {
      const ud = await userList.json();
      const existing = (ud.users || []).find(u => u.email?.toLowerCase() === email.toLowerCase());
      if (existing) return jsonErr(corsHeaders, 409, 'Un compte existe deja avec cet email');
    }
  } catch (e) {
    // Non bloquant : on continue
  }

  // Choix du price_id
  const priceId = plan === 'annuel'
    ? process.env.STRIPE_PRICE_ANNUEL
    : process.env.STRIPE_PRICE_MENSUEL;
  if (!priceId) return jsonErr(corsHeaders, 500, `Price ID manquant pour ${plan}`);

  // Cree la Checkout Session
  const params = new URLSearchParams();
  params.append('mode', 'subscription');
  params.append('line_items[0][price]', priceId);
  params.append('line_items[0][quantity]', '1');
  params.append('subscription_data[trial_period_days]', '7');
  params.append('customer_email', email);
  params.append('billing_address_collection', 'required');
  params.append('allow_promotion_codes', 'true');
  params.append('locale', 'fr');
  // Metadata pour le webhook : il creera l'entreprise + l'auth user a partir de ca
  params.append('metadata[signup_email]', email);
  params.append('metadata[signup_password]', password); // sera consume par webhook puis ignore
  params.append('metadata[signup_nom_marque]', nom_marque);
  params.append('metadata[signup_slug]', slug);
  params.append('metadata[signup_plan]', plan);
  params.append('metadata[signup_renonce_retractation]', renonce_retractation ? 'true' : 'false');
  params.append('metadata[signup_cgu_accepted_at]', new Date().toISOString());
  params.append('subscription_data[metadata][signup_slug]', slug);
  params.append('subscription_data[metadata][signup_email]', email);
  // success/cancel
  params.append('success_url', `${baseUrl}/abonnement-confirme.html?session_id={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${baseUrl}/abonnement-annule.html`);

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const session = await r.json();
    if (!r.ok) {
      return jsonErr(corsHeaders, 500, session.error?.message || 'Stripe checkout echec');
    }
    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: session.url, session_id: session.id })
    };
  } catch (e) {
    return jsonErr(corsHeaders, 500, 'Stripe API : ' + e.message);
  }
};

function jsonErr(corsHeaders, code, msg) {
  return {
    statusCode: code,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify({ error: msg })
  };
}
