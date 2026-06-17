// /.netlify/functions/stripe-webhook
// Recoit les events Stripe et met a jour entreprises.subscription_status, stripe_*, current_period_end, trial_ends_at.
// Variables d'environnement requises :
//   STRIPE_SECRET_KEY            = sk_test_... ou sk_live_...
//   STRIPE_WEBHOOK_SECRET        = whsec_... (cree dans Stripe Dashboard > Developpeurs > Webhooks)
//   SUPABASE_URL                 = ...
//   SUPABASE_SERVICE_KEY         = service_role

const crypto = require('crypto');

function verifyStripeSignature(payload, sigHeader, secret) {
  if (!sigHeader || !secret) return false;
  const parts = sigHeader.split(',').reduce((acc, p) => {
    const [k, v] = p.split('=');
    acc[k] = v;
    return acc;
  }, {});
  if (!parts.t || !parts.v1) return false;
  const signed = `${parts.t}.${payload}`;
  const expected = crypto.createHmac('sha256', secret).update(signed, 'utf8').digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(parts.v1));
  } catch (_) {
    return false;
  }
}

async function updateEntreprise(sbUrl, sbKey, entrepriseId, fields) {
  const r = await fetch(`${sbUrl}/rest/v1/entreprises?id=eq.${encodeURIComponent(entrepriseId)}`, {
    method: 'PATCH',
    headers: {
      apikey: sbKey,
      Authorization: `Bearer ${sbKey}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal'
    },
    body: JSON.stringify(fields)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`Supabase update failed (${r.status}): ${t}`);
  }
}

async function fetchSubscription(stripeKey, subId) {
  const r = await fetch(`https://api.stripe.com/v1/subscriptions/${subId}`, {
    headers: { Authorization: `Bearer ${stripeKey}` }
  });
  return r.ok ? r.json() : null;
}

async function findEntrepriseBySubscription(sbUrl, sbKey, subId) {
  const r = await fetch(`${sbUrl}/rest/v1/entreprises?stripe_subscription_id=eq.${encodeURIComponent(subId)}&select=id`, {
    headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }
  });
  const d = await r.json();
  return Array.isArray(d) && d[0] ? d[0].id : null;
}

// =============== SIGNUP : cree user + entreprise + lien ===============
async function createSignupAccount(sbUrl, sbKey, stripeKey, session) {
  const m = session.metadata || {};
  const email = m.signup_email;
  const password = m.signup_password;
  const nom_marque = m.signup_nom_marque;
  const slug = m.signup_slug;
  const plan = m.signup_plan; // mensuel | annuel
  const renonce = m.signup_renonce_retractation === 'true';

  if (!email || !password || !slug || !nom_marque) {
    throw new Error('Signup metadata incomplete : ' + JSON.stringify({email,slug,nom_marque,hasPwd:!!password}));
  }

  const adminH = { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' };

  // Idempotence : si une entreprise existe deja avec ce slug, on bail
  const slugCheck = await fetch(`${sbUrl}/rest/v1/entreprises?slug=eq.${encodeURIComponent(slug)}&select=id`, { headers: adminH });
  const slugData = await slugCheck.json();
  if (Array.isArray(slugData) && slugData.length > 0) {
    // Deja cree (replay de webhook), on update juste le stripe info
    return await linkStripeToEntreprise(sbUrl, sbKey, stripeKey, slugData[0].id, session);
  }

  // 1. Cree le user dans auth.users
  let userId;
  const listRes = await fetch(`${sbUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, { headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` } });
  if (listRes.ok) {
    const ud = await listRes.json();
    const existing = (ud.users || []).find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (existing) {
      userId = existing.id;
    }
  }
  if (!userId) {
    const createRes = await fetch(`${sbUrl}/auth/v1/admin/users`, {
      method: 'POST',
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email,
        password,
        email_confirm: true,
        user_metadata: { nom_marque, source: 'signup_stripe' }
      })
    });
    if (!createRes.ok) {
      const t = await createRes.text();
      throw new Error('Create auth user failed : ' + t);
    }
    const created = await createRes.json();
    userId = created.id;
  }

  // 2. Cree l'entreprise
  const trialEnd = session.expires_at ? null : null; // sera mis a jour par fetchSubscription ci-apres
  const entPayload = {
    slug,
    nom_marque,
    nom_contact: nom_marque,
    admin_email: email,
    plan: 'standard',
    formule: 'standard',
    cycle: plan, // mensuel | annuel
    couleur_principale: '#3D6B4F',
    couleur_secondaire: '#5A8A6A',
    couleur_topbar: '#1A1A1A',
    active: true,
    subscription_status: 'trialing',
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription,
    montant_client_default: 0
    // Note : renonce_retractation est gardée dans les metadata Stripe (session.metadata.signup_renonce_retractation)
    // jusqu'à ce qu'on ajoute la colonne dans entreprises. Sans colonne, la creation echouerait.
  };
  const entRes = await fetch(`${sbUrl}/rest/v1/entreprises`, {
    method: 'POST',
    headers: { ...adminH, Prefer: 'return=representation' },
    body: JSON.stringify(entPayload)
  });
  if (!entRes.ok) {
    const t = await entRes.text();
    throw new Error('Create entreprise failed : ' + t);
  }
  const entCreated = await entRes.json();
  const entrepriseId = Array.isArray(entCreated) ? entCreated[0].id : entCreated.id;

  // 3. Lien admins_entreprise
  const linkRes = await fetch(`${sbUrl}/rest/v1/admins_entreprise`, {
    method: 'POST',
    headers: adminH,
    body: JSON.stringify({ user_id: userId, entreprise_id: entrepriseId, nom: nom_marque })
  });
  if (!linkRes.ok) {
    const t = await linkRes.text();
    throw new Error('Link admins_entreprise failed : ' + t);
  }

  // 4. Recup sub Stripe pour avoir les vraies dates trial_end, current_period_end
  if (session.subscription) {
    const sub = await fetchSubscription(stripeKey, session.subscription);
    if (sub) {
      await updateEntreprise(sbUrl, sbKey, entrepriseId, {
        subscription_status: sub.status,
        trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
        current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
      });
    }
  }

  return entrepriseId;
}

async function linkStripeToEntreprise(sbUrl, sbKey, stripeKey, entrepriseId, session) {
  const sub = session.subscription ? await fetchSubscription(stripeKey, session.subscription) : null;
  await updateEntreprise(sbUrl, sbKey, entrepriseId, {
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription,
    subscription_status: sub?.status || 'trialing',
    trial_ends_at: sub?.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    current_period_end: sub?.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null
  });
  return entrepriseId;
}

exports.handler = async (event) => {
  const stripeKey = process.env.STRIPE_SECRET_KEY;
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!stripeKey || !whSecret || !sbUrl || !sbKey) {
    return { statusCode: 500, body: 'Configuration manquante' };
  }

  const sig = event.headers['stripe-signature'] || event.headers['Stripe-Signature'];
  const payload = event.body || '';

  if (!verifyStripeSignature(payload, sig, whSecret)) {
    return { statusCode: 400, body: 'Invalid signature' };
  }

  let evt;
  try { evt = JSON.parse(payload); }
  catch { return { statusCode: 400, body: 'Invalid JSON' }; }

  try {
    switch (evt.type) {
      case 'checkout.session.completed': {
        const session = evt.data.object;
        // Cas 1 : SIGNUP — pas d'entreprise existante, on la cree
        if (session.metadata?.signup_email && !session.client_reference_id) {
          await createSignupAccount(sbUrl, sbKey, stripeKey, session);
          break;
        }
        // Cas 2 : UPGRADE/RENEW d'une entreprise existante
        const entrepriseId = session.client_reference_id || session.metadata?.entreprise_id;
        if (!entrepriseId || !session.subscription) break;
        const sub = await fetchSubscription(stripeKey, session.subscription);
        if (!sub) break;
        await updateEntreprise(sbUrl, sbKey, entrepriseId, {
          stripe_customer_id: session.customer,
          stripe_subscription_id: session.subscription,
          subscription_status: sub.status,
          trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          active: sub.status === 'active' || sub.status === 'trialing'
        });
        break;
      }
      case 'customer.subscription.created':
      case 'customer.subscription.updated': {
        const sub = evt.data.object;
        const entrepriseId = sub.metadata?.entreprise_id || (await findEntrepriseBySubscription(sbUrl, sbKey, sub.id));
        if (!entrepriseId) break;
        await updateEntreprise(sbUrl, sbKey, entrepriseId, {
          stripe_subscription_id: sub.id,
          subscription_status: sub.status,
          trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          active: sub.status === 'active' || sub.status === 'trialing'
        });
        break;
      }
      case 'customer.subscription.deleted': {
        const sub = evt.data.object;
        const entrepriseId = sub.metadata?.entreprise_id || (await findEntrepriseBySubscription(sbUrl, sbKey, sub.id));
        if (!entrepriseId) break;
        await updateEntreprise(sbUrl, sbKey, entrepriseId, {
          subscription_status: 'canceled',
          active: false
        });
        break;
      }
      case 'invoice.payment_failed': {
        const inv = evt.data.object;
        if (!inv.subscription) break;
        const entrepriseId = await findEntrepriseBySubscription(sbUrl, sbKey, inv.subscription);
        if (!entrepriseId) break;
        await updateEntreprise(sbUrl, sbKey, entrepriseId, {
          subscription_status: 'past_due'
        });
        break;
      }
      default:
        // Ignored event
        break;
    }
    return { statusCode: 200, body: JSON.stringify({ received: true }) };
  } catch (e) {
    return { statusCode: 500, body: 'Handler error : ' + e.message };
  }
};
