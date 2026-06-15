// One-shot setup function for the My Batch super-admin account.
// Creates auth user + entreprise + admins_entreprise link in a single transaction.
// PROTECT BY DELETING THIS FILE AFTER FIRST SUCCESSFUL CALL.

const { createClient } = require('@supabase/supabase-js');

exports.handler = async (event) => {
  const SECRET = process.env.SETUP_SECRET;
  const provided = event.queryStringParameters?.secret;
  if (!SECRET || provided !== SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized — set SETUP_SECRET env var and pass it as ?secret=' }) };
  }

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY env vars' }) };
  }

  const sb = createClient(url, key, { auth: { autoRefreshToken: false, persistSession: false } });

  const SUPERADMIN_EMAIL = 'structify.crm@gmail.com';
  const SUPERADMIN_PASSWORD = 'MyBatch!Super2026#Admin';

  try {
    // Step 0: Check if a user with this email already exists (to make this idempotent)
    const { data: existingUsers, error: listError } = await sb.auth.admin.listUsers({ page: 1, perPage: 1000 });
    if (listError) throw new Error(`listUsers failed: ${listError.message}`);
    const existing = existingUsers.users.find(u => u.email === SUPERADMIN_EMAIL);
    let userId;
    if (existing) {
      userId = existing.id;
    } else {
      // Step 1: Create the auth user
      const { data: created, error: createError } = await sb.auth.admin.createUser({
        email: SUPERADMIN_EMAIL,
        password: SUPERADMIN_PASSWORD,
        email_confirm: true,
        user_metadata: { role: 'superadmin' }
      });
      if (createError) throw new Error(`createUser failed: ${createError.message}`);
      userId = created.user.id;
    }

    // Step 2: Check if the entreprise already exists
    const { data: existingEnt } = await sb.from('entreprises').select('*').eq('admin_email', SUPERADMIN_EMAIL).maybeSingle();
    let entrepriseId;
    if (existingEnt) {
      entrepriseId = existingEnt.id;
    } else {
      const { data: ent, error: entError } = await sb.from('entreprises').insert({
        slug: 'mybatch-admin',
        nom_marque: 'My Batch (Super-Admin)',
        nom_contact: 'Super-Admin',
        admin_email: SUPERADMIN_EMAIL,
        admin_password: SUPERADMIN_PASSWORD,
        plan: 'founder',
        formule: 'premium',
        cycle: 'annuel',
        couleur_principale: '#E8843D',
        couleur_secondaire: '#3D6B4F',
        couleur_topbar: '#1A1A1A',
        active: true,
        subscription_status: 'active',
        montant_client_default: 0
      }).select().single();
      if (entError) throw new Error(`insert entreprise failed: ${entError.message}`);
      entrepriseId = ent.id;
    }

    // Step 3: Link them in admins_entreprise (skip if already linked)
    const { data: existingLink } = await sb.from('admins_entreprise').select('*').eq('user_id', userId).eq('entreprise_id', entrepriseId).maybeSingle();
    if (!existingLink) {
      const { error: linkError } = await sb.from('admins_entreprise').insert({
        user_id: userId,
        entreprise_id: entrepriseId,
        nom: 'Super-Admin'
      });
      if (linkError) throw new Error(`link admins_entreprise failed: ${linkError.message}`);
    }

    return {
      statusCode: 200,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        success: true,
        user_id: userId,
        entreprise_id: entrepriseId,
        email: SUPERADMIN_EMAIL,
        password: SUPERADMIN_PASSWORD,
        message: 'Super-admin actif. Login OK sur app.mybatch.cooking. SUPPRIME CE FICHIER netlify/functions/setup-superadmin.js APRES vérification.'
      }, null, 2)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message, stack: err.stack })
    };
  }
};
