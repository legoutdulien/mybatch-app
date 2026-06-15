// Recup les events Stripe (paiements recents) pour une entreprise.
// GET ?entreprise_id=X
// Auth : Bearer token super-admin

const SUPER_ADMIN_EMAIL = 'structify.crm@gmail.com';

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  if (!sbUrl || !sbKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Config Supabase manquante' }) };
  }

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Token manquant' }) };
  }

  const entId = event.queryStringParameters?.entreprise_id;
  if (!entId) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'entreprise_id requis' }) };
  }

  try {
    // Verifie super-admin
    const userRes = await fetch(`${sbUrl}/auth/v1/user`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${token}` }
    });
    if (!userRes.ok) return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Token invalide' }) };
    const u = await userRes.json();
    if (u.email?.toLowerCase() !== SUPER_ADMIN_EMAIL.toLowerCase()) {
      return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Accès refusé' }) };
    }

    // Recup le stripe_customer_id de l'entreprise
    const entRes = await fetch(`${sbUrl}/rest/v1/entreprises?id=eq.${encodeURIComponent(entId)}&select=stripe_customer_id,stripe_subscription_id`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }
    });
    const entData = await entRes.json();
    const stripeCustomerId = entData[0]?.stripe_customer_id;
    const stripeSubId = entData[0]?.stripe_subscription_id;

    if (!stripeCustomerId) {
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ invoices: [], charges: [], subscription: null, no_stripe: true })
      };
    }
    if (!stripeKey) {
      return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Stripe key manquante' }) };
    }

    // Recup invoices (10 dernieres) et charges (10 dernieres)
    const stripeHeaders = { 'Authorization': `Bearer ${stripeKey}` };
    const [invRes, chgRes, subRes] = await Promise.all([
      fetch(`https://api.stripe.com/v1/invoices?customer=${stripeCustomerId}&limit=10`, { headers: stripeHeaders }),
      fetch(`https://api.stripe.com/v1/charges?customer=${stripeCustomerId}&limit=10`, { headers: stripeHeaders }),
      stripeSubId ? fetch(`https://api.stripe.com/v1/subscriptions/${stripeSubId}`, { headers: stripeHeaders }) : Promise.resolve(null)
    ]);
    const invoices = invRes.ok ? (await invRes.json()).data || [] : [];
    const charges = chgRes.ok ? (await chgRes.json()).data || [] : [];
    const subscription = subRes && subRes.ok ? await subRes.json() : null;

    const safeDate = ts => {
      if (!ts || typeof ts !== 'number' || isNaN(ts)) return null;
      try { return new Date(ts * 1000).toISOString(); } catch { return null; }
    };

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customer_id: stripeCustomerId,
        subscription: subscription && !subscription.error ? {
          id: subscription.id,
          status: subscription.status,
          current_period_end: safeDate(subscription.current_period_end),
          cancel_at_period_end: subscription.cancel_at_period_end,
          trial_end: safeDate(subscription.trial_end)
        } : null,
        invoices: invoices.map(i => ({
          id: i.id,
          number: i.number,
          status: i.status,
          amount_paid: (i.amount_paid || 0) / 100,
          amount_due: (i.amount_due || 0) / 100,
          currency: i.currency,
          created: safeDate(i.created),
          paid_at: safeDate(i.status_transitions?.paid_at),
          hosted_invoice_url: i.hosted_invoice_url
        })),
        charges: charges.map(c => ({
          id: c.id,
          status: c.status,
          amount: (c.amount || 0) / 100,
          currency: c.currency,
          created: safeDate(c.created),
          paid: c.paid,
          refunded: c.refunded
        }))
      })
    };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message, stack: e.stack?.split('\n').slice(0, 3) }) };
  }
};
