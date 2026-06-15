// One-shot setup function for the My Batch super-admin account.
// Creates auth user + entreprise + admins_entreprise link using fetch (no npm deps).
// DELETE THIS FILE AFTER FIRST SUCCESSFUL CALL.

const SETUP_SECRET = 'mb-setup-onetime-2026-06-15-x7k9q2';
const SUPERADMIN_EMAIL = 'structify.crm@gmail.com';
const SUPERADMIN_PASSWORD = 'MyBatch!Super2026#Admin';

exports.handler = async (event) => {
  const provided = event.queryStringParameters?.secret;
  if (provided !== SETUP_SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return { statusCode: 500, body: JSON.stringify({ error: 'Missing SUPABASE_URL or SUPABASE_SERVICE_KEY' }) };
  }

  const authHeaders = {
    'apikey': sbKey,
    'Authorization': `Bearer ${sbKey}`,
    'Content-Type': 'application/json'
  };

  try {
    // ============= STEP 1 : Get or create auth user =============
    let userId;
    // List users and check if email exists
    const listRes = await fetch(`${sbUrl}/auth/v1/admin/users?per_page=200`, { headers: authHeaders });
    if (!listRes.ok) {
      const txt = await listRes.text();
      throw new Error(`listUsers HTTP ${listRes.status}: ${txt}`);
    }
    const listJson = await listRes.json();
    const existing = (listJson.users || []).find(u => u.email === SUPERADMIN_EMAIL);

    if (existing) {
      userId = existing.id;
    } else {
      const createRes = await fetch(`${sbUrl}/auth/v1/admin/users`, {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          email: SUPERADMIN_EMAIL,
          password: SUPERADMIN_PASSWORD,
          email_confirm: true,
          user_metadata: { role: 'superadmin' }
        })
      });
      if (!createRes.ok) {
        const txt = await createRes.text();
        throw new Error(`createUser HTTP ${createRes.status}: ${txt}`);
      }
      const created = await createRes.json();
      userId = created.id;
    }

    // ============= STEP 2 : Get or create entreprise =============
    let entrepriseId;
    const entCheck = await fetch(`${sbUrl}/rest/v1/entreprises?admin_email=eq.${encodeURIComponent(SUPERADMIN_EMAIL)}&select=id`, { headers: authHeaders });
    if (!entCheck.ok) {
      const txt = await entCheck.text();
      throw new Error(`entreprise check HTTP ${entCheck.status}: ${txt}`);
    }
    const entCheckData = await entCheck.json();

    if (entCheckData && entCheckData.length > 0) {
      entrepriseId = entCheckData[0].id;
    } else {
      const entInsert = await fetch(`${sbUrl}/rest/v1/entreprises`, {
        method: 'POST',
        headers: { ...authHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify({
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
        })
      });
      if (!entInsert.ok) {
        const txt = await entInsert.text();
        throw new Error(`insert entreprise HTTP ${entInsert.status}: ${txt}`);
      }
      const entCreated = await entInsert.json();
      entrepriseId = Array.isArray(entCreated) ? entCreated[0].id : entCreated.id;
    }

    // ============= STEP 3 : Link user to entreprise =============
    const linkCheck = await fetch(`${sbUrl}/rest/v1/admins_entreprise?user_id=eq.${encodeURIComponent(userId)}&entreprise_id=eq.${encodeURIComponent(entrepriseId)}&select=id`, { headers: authHeaders });
    if (!linkCheck.ok) {
      const txt = await linkCheck.text();
      throw new Error(`link check HTTP ${linkCheck.status}: ${txt}`);
    }
    const linkData = await linkCheck.json();

    if (!linkData || linkData.length === 0) {
      const linkInsert = await fetch(`${sbUrl}/rest/v1/admins_entreprise`, {
        method: 'POST',
        headers: { ...authHeaders, 'Prefer': 'return=representation' },
        body: JSON.stringify({
          user_id: userId,
          entreprise_id: entrepriseId,
          nom: 'Super-Admin'
        })
      });
      if (!linkInsert.ok) {
        const txt = await linkInsert.text();
        throw new Error(`link insert HTTP ${linkInsert.status}: ${txt}`);
      }
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
        next_steps: [
          '1. Login sur https://app.mybatch.cooking avec ' + SUPERADMIN_EMAIL,
          '2. Verifier que tu vois bien tous les onglets super-admin dont "Entreprises"',
          '3. Verifier que "Le Gout du Lien" est ABSENT de la liste',
          '4. SUPPRIMER le fichier netlify/functions/setup-superadmin.js et repousser le repo'
        ]
      }, null, 2)
    };
  } catch (err) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: err.message })
    };
  }
};
