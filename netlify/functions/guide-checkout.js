// guide-checkout.js
// Cree une Stripe Checkout Session en mode 'payment' (one-time) pour l'achat du guide a 149 EUR.
// Body : { nom, email, cgu, renonce_retractation }
// Pas de creation d'entreprise, juste l'envoi de la facture Stripe.

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const priceGuide = process.env.STRIPE_PRICE_GUIDE;
  if (!stripeKey || !priceGuide) {
    return jsonErr(corsHeaders, 500, 'Config Stripe manquante');
  }

  let body;
  try { body = JSON.parse(event.body || '{}'); }
  catch { return jsonErr(corsHeaders, 400, 'Invalid JSON'); }

  const { nom, email, cgu, renonce_retractation } = body;
  if (!nom || nom.length < 2) return jsonErr(corsHeaders, 400, 'Nom requis');
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return jsonErr(corsHeaders, 400, 'Email invalide');
  if (!cgu) return jsonErr(corsHeaders, 400, 'Acceptation des CGU/CGV requise');
  if (!renonce_retractation) return jsonErr(corsHeaders, 400, 'Renonciation a la retractation requise pour acces immediat');

  const baseMarketing = 'https://mybatch.cooking';

  const params = new URLSearchParams();
  params.append('mode', 'payment');
  params.append('line_items[0][price]', priceGuide);
  params.append('line_items[0][quantity]', '1');
  params.append('customer_email', email);
  params.append('billing_address_collection', 'required');
  params.append('locale', 'fr');
  params.append('invoice_creation[enabled]', 'true');
  params.append('metadata[product_type]', 'guide_unique');
  params.append('metadata[buyer_nom]', nom);
  params.append('metadata[buyer_email]', email);
  params.append('metadata[renonce_retractation]', 'true');
  params.append('metadata[purchase_at]', new Date().toISOString());
  params.append('success_url', `${baseMarketing}/guide-merci.html?session_id={CHECKOUT_SESSION_ID}`);
  params.append('cancel_url', `${baseMarketing}/guide-achat.html`);

  try {
    const r = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${stripeKey}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const session = await r.json();
    if (!r.ok) {
      return jsonErr(corsHeaders, 500, session.error?.message || 'Stripe error');
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
