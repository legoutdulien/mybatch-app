// Renvoie les donnees de facture pour une entreprise et un mois donne.
// GET ?entreprise_id=X&month=YYYY-MM (default = mois en cours)
// Auth : Bearer token super-admin

const SUPER_ADMIN_EMAIL = 'structify.crm@gmail.com';
const PRICE_MENSUEL = 79;
const PRICE_ANNUEL = 588;
const PRICE_ANNUEL_MOIS = 49;

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Config manquante' }) };
  }

  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token) {
    return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Token manquant' }) };
  }

  const entId = event.queryStringParameters?.entreprise_id;
  const monthParam = event.queryStringParameters?.month;
  if (!entId) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'entreprise_id requis' }) };
  }

  try {
    const adminHeaders = { apikey: sbKey, Authorization: `Bearer ${sbKey}` };

    // Verifie super-admin
    const userRes = await fetch(`${sbUrl}/auth/v1/user`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${token}` }
    });
    if (!userRes.ok) return { statusCode: 401, headers: corsHeaders, body: JSON.stringify({ error: 'Token invalide' }) };
    const user = await userRes.json();
    if (user.email?.toLowerCase() !== SUPER_ADMIN_EMAIL.toLowerCase()) {
      return { statusCode: 403, headers: corsHeaders, body: JSON.stringify({ error: 'Accès refusé' }) };
    }

    // Recup entreprise
    const entRes = await fetch(`${sbUrl}/rest/v1/entreprises?id=eq.${encodeURIComponent(entId)}&select=*`, { headers: adminHeaders });
    if (!entRes.ok) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Fetch entreprise échoué' }) };
    const ents = await entRes.json();
    if (!ents.length) return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Entreprise introuvable' }) };
    const e = ents[0];

    // Determine la periode
    const now = new Date();
    const [yy, mm] = (monthParam || `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`).split('-').map(Number);
    const periodStart = new Date(yy, mm - 1, 1);
    const periodEnd = new Date(yy, mm, 0); // dernier jour du mois
    const periodLabel = periodStart.toLocaleDateString('fr-FR', { month: 'long', year: 'numeric' });

    // Numero de facture stable : MB-YYYYMM-<8 premiers chars de entreprise_id>
    const idSuffix = (e.id || '').replace(/-/g, '').substring(0, 8).toUpperCase();
    const invoiceNumber = `MB-${yy}${String(mm).padStart(2, '0')}-${idSuffix}`;

    // Lignes selon plan/cycle
    let lines = [];
    let total = 0;

    if (e.plan === 'founder') {
      lines = [{
        desc: 'Plan Founder — Accès gratuit à vie',
        sub: 'Période : ' + periodStart.toLocaleDateString('fr-FR') + ' → ' + periodEnd.toLocaleDateString('fr-FR'),
        qty: 1,
        unit_price: 0,
        total: 0
      }];
      total = 0;
    } else if (e.cycle === 'annuel') {
      // Annuel : 1 facture/an de 588€ + mention guide inclus
      const isAnnualInvoiceMonth = e.current_period_end ? new Date(e.current_period_end).getMonth() === mm - 1 : true;
      if (isAnnualInvoiceMonth) {
        lines = [
          {
            desc: 'Abonnement Annuel my batch — Application',
            sub: '12 mois d\'accès à l\'application my batch',
            qty: 1,
            unit_price: 439,
            total: 439
          },
          {
            desc: 'Guide complet « Se lancer comme batchcookeuse »',
            sub: 'Accès illimité au contenu numérique (14 chapitres + modèles)',
            qty: 1,
            unit_price: 149,
            total: 149
          }
        ];
        total = 588;
      } else {
        lines = [{
          desc: 'Abonnement Annuel my batch',
          sub: 'Mois ' + (mm - new Date(e.current_period_end || periodStart).getMonth()) + ' sur 12 — facturation annuelle déjà effectuée',
          qty: 1,
          unit_price: 0,
          total: 0
        }];
        total = 0;
      }
    } else {
      // Mensuel
      lines = [{
        desc: 'Abonnement Mensuel my batch',
        sub: 'Période : ' + periodStart.toLocaleDateString('fr-FR') + ' → ' + periodEnd.toLocaleDateString('fr-FR'),
        qty: 1,
        unit_price: PRICE_MENSUEL,
        total: PRICE_MENSUEL
      }];
      total = PRICE_MENSUEL;
    }

    return {
      statusCode: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        invoice_number: invoiceNumber,
        issue_date: now.toISOString().slice(0, 10),
        period_label: periodLabel,
        period_start: periodStart.toISOString().slice(0, 10),
        period_end: periodEnd.toISOString().slice(0, 10),
        entreprise_id: e.id,
        entreprise_name: e.nom_marque,
        entreprise_email: e.admin_email,
        entreprise_slug: e.slug,
        plan: e.plan,
        cycle: e.cycle,
        lines,
        total
      })
    };
  } catch (err) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: err.message }) };
  }
};
