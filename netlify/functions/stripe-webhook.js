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

// =============== MAIL DE BIENVENUE (non bloquant) ===============
// Envoie un mail de bienvenue via Resend a la nouvelle inscrite.
// Fail-safe : sans RESEND_API_KEY, on ignore silencieusement (l'inscription n'est jamais bloquee).
async function sendWelcomeEmail(email, nomMarque) {
  const key = process.env.BREVO_API_KEY;
  if (!key || !email) return;
  const senderEmail = process.env.BREVO_SENDER_EMAIL || 'contact@mybatch.cooking';
  const marque = nomMarque || 'votre espace';
  const html = `<!DOCTYPE html><html><body style="margin:0;background:#FAF6EE;font-family:Arial,Helvetica,sans-serif;color:#3a3a34">
    <div style="max-width:520px;margin:0 auto;padding:28px 22px">
      <div style="font-size:26px;font-weight:800;color:#1A1A1A;letter-spacing:-1px;text-align:center">my batch<span style="color:#E8843D">.</span></div>
      <div style="background:#fff;border-radius:16px;padding:26px 24px;margin-top:16px;box-shadow:0 6px 24px rgba(0,0,0,.06)">
        <h1 style="font-size:20px;color:#264935;margin:0 0 14px">Bienvenue, votre espace est prêt&nbsp;🎉</h1>
        <p style="line-height:1.6;margin:0 0 14px">Votre espace <b>${marque}</b> est bien créé et déjà actif. Vous pouvez vous connecter dès maintenant&nbsp;:</p>
        <div style="background:#EEF4F0;border-radius:12px;padding:16px 18px;margin:0 0 16px;line-height:1.7">
          <div>🔗 Adresse&nbsp;: <a href="https://app.mybatch.cooking" style="color:#C26821;font-weight:700;text-decoration:none">app.mybatch.cooking</a></div>
          <div>✉️ Identifiant&nbsp;: <b>${email}</b></div>
          <div>🔑 Mot de passe&nbsp;: celui que vous avez choisi lors de votre inscription.</div>
        </div>
        <p style="line-height:1.6;margin:0 0 14px">Une fois connectée, laissez-vous guider&nbsp;: personnalisez votre marque, créez vos forfaits et vos recettes, et votre espace est prêt à recevoir des commandes.</p>
        <p style="line-height:1.6;margin:0;color:#8a8578;font-size:13px">Mot de passe oublié ou une question&nbsp;? Répondez simplement à cet email, on s'en occupe tout de suite.</p>
      </div>
      <div style="text-align:center;color:#8a8578;font-size:12px;margin-top:16px">my batch — l'app des batchcookeuses · mybatch.cooking</div>
    </div>
  </body></html>`;
  try {
    await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': key, 'Content-Type': 'application/json', 'accept': 'application/json' },
      body: JSON.stringify({
        sender: { name: 'my batch', email: senderEmail },
        to: [{ email }],
        subject: 'Bienvenue sur my batch — votre espace est prêt',
        htmlContent: html
      })
    });
  } catch (e) { /* non bloquant */ }
}

// =============== SIGNUP : cree user + entreprise + lien ===============
async function createSignupAccount(sbUrl, sbKey, stripeKey, session) {
  const m = session.metadata || {};
  const email = m.signup_email;
  const password = m.signup_password;
  const nom_marque = m.signup_nom_marque;
  const slug = m.signup_slug;
  const plan = m.signup_plan; // mensuel | annuel | reseau_starter | reseau_pro
  const renonce = m.signup_renonce_retractation === 'true';
  const isReseau = plan === 'reseau_starter' || plan === 'reseau_pro' || plan === 'reseau_illimite';
  const formule = isReseau ? plan : 'standard';   // standard | reseau_starter | reseau_pro | reseau_illimite
  const cycle = isReseau ? 'mensuel' : plan;       // reseau = facturation mensuelle
  const nbCuis = parseInt(m.signup_nb_cuisinieres, 10); // quantite declaree (illimite)

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
    formule: formule, // standard | reseau_starter | reseau_pro
    cycle: cycle, // mensuel | annuel (reseau = mensuel)
    couleur_principale: '#3D6B4F',
    couleur_secondaire: '#5A8A6A',
    couleur_topbar: '#1A1A1A',
    active: true,
    subscription_status: 'trialing',
    stripe_customer_id: session.customer,
    stripe_subscription_id: session.subscription,
    montant_client_default: 0,
    guide_renonce: renonce // renonciation au delai de retractation -> acces guide immediat (sinon J+15)
  };
  // Illimite uniquement : on stocke le nb de cuisinieres declare (necessite la colonne entreprises.reseau_cuisinieres).
  // Ajoute SEULEMENT pour l'illimite -> aucune autre inscription n'est impactee si la colonne n'existe pas encore.
  if (plan === 'reseau_illimite' && Number.isFinite(nbCuis)) {
    entPayload.reseau_cuisinieres = nbCuis;
  }
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

  // 3bis. Starter pack : clone le modele "modele-mybatch" (30 recettes + ingredients). Non bloquant.
  try {
    await fetch(`${sbUrl}/rest/v1/rpc/seed_entreprise_from_template`, {
      method: 'POST',
      headers: adminH,
      body: JSON.stringify({ p_target: entrepriseId })
    });
  } catch (e) { /* non bloquant : le compte est cree meme si le seed echoue */ }

  // 3ter. Mail de bienvenue (non bloquant : ignore si Resend pas configure)
  try { await sendWelcomeEmail(email, nom_marque); } catch (e) { /* non bloquant */ }

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
        const upd = {
          stripe_subscription_id: sub.id,
          subscription_status: sub.status,
          trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
          current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          active: sub.status === 'active' || sub.status === 'trialing'
        };
        // Synchro auto de la formule quand la cliente change de plan (ex. via le portail Stripe)
        const PRICE_TO_FORMULE = {
          [process.env.STRIPE_PRICE_MENSUEL]: { formule: 'standard', cycle: 'mensuel' },
          [process.env.STRIPE_PRICE_ANNUEL]: { formule: 'standard', cycle: 'annuel' },
          [process.env.STRIPE_PRICE_RESEAU_STARTER]: { formule: 'reseau_starter', cycle: 'mensuel' },
          [process.env.STRIPE_PRICE_RESEAU_PRO]: { formule: 'reseau_pro', cycle: 'mensuel' },
          [process.env.STRIPE_PRICE_RESEAU_ILLIMITE]: { formule: 'reseau_illimite', cycle: 'mensuel' }
        };
        const item = sub.items && sub.items.data && sub.items.data[0];
        const priceId = item && item.price && item.price.id;
        const mapped = priceId ? PRICE_TO_FORMULE[priceId] : null;
        if (mapped) {
          upd.formule = mapped.formule;
          upd.cycle = mapped.cycle;
          // Illimité : la quantité de l'abonnement = nombre de cuisinières facturées
          if (mapped.formule === 'reseau_illimite' && Number.isFinite(item.quantity)) upd.reseau_cuisinieres = item.quantity;
        }
        await updateEntreprise(sbUrl, sbKey, entrepriseId, upd);
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
