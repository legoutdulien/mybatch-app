// /.netlify/functions/annuaire-contact
// Endpoint public : recoit une demande de contact depuis l'annuaire (formulaire cote
// site vitrine, non authentifie) et l'envoie par email a la VRAIE cuisiniere concernee
// (admin_email en base, jamais expose au navigateur). Reply-To = email du prospect,
// pour qu'elle puisse repondre directement en un clic.

exports.handler = async (event) => {
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: corsHeaders, body: 'Method Not Allowed' };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const brevoKey = process.env.BREVO_API_KEY;
  if (!url || !key) return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: 'Config manquante' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'JSON invalide' }) }; }

  const entrepriseId = (body.entreprise_id || '').replace(/[^a-f0-9-]/gi, '');
  const nomProspect = String(body.nom || '').slice(0, 120).trim();
  const emailProspect = String(body.email || '').slice(0, 200).trim();
  const telProspect = String(body.telephone || '').slice(0, 40).trim();
  const message = String(body.message || '').slice(0, 2000).trim();

  if (!entrepriseId || !nomProspect || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailProspect)) {
    return { statusCode: 400, headers: corsHeaders, body: JSON.stringify({ error: 'Nom et email valides requis' }) };
  }

  try {
    const r = await fetch(
      `${url}/rest/v1/entreprises?id=eq.${entrepriseId}&visible_annuaire=eq.true&verifiee=eq.true&select=nom_marque,admin_email`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const rows = await r.json();
    const ent = Array.isArray(rows) ? rows[0] : null;
    if (!ent || !ent.admin_email) {
      return { statusCode: 404, headers: corsHeaders, body: JSON.stringify({ error: 'Batchcookeur·se introuvable' }) };
    }

    if (brevoKey) {
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: 'my batch — Annuaire', email: process.env.BREVO_SENDER_EMAIL || 'contact@mybatch.cooking' },
          to: [{ email: ent.admin_email, name: ent.nom_marque || 'Batchcookeur·se' }],
          replyTo: { email: emailProspect, name: nomProspect },
          subject: `Nouvelle demande via l'annuaire my batch — ${nomProspect}`,
          htmlContent: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
            <h2 style="color:#3D6B4F">Nouvelle demande depuis l'annuaire my batch</h2>
            <p><strong>${nomProspect}</strong> souhaite être recontacté·e.</p>
            <p>Email : <a href="mailto:${emailProspect}">${emailProspect}</a>${telProspect ? `<br>Téléphone : ${telProspect}` : ''}</p>
            ${message ? `<p style="background:#F4EEDB;padding:14px;border-radius:8px">${message.replace(/</g, '&lt;')}</p>` : ''}
            <p style="font-size:12px;color:#888">Répondez directement à cet email pour contacter ${nomProspect}.</p>
          </div>`
        })
      });
    }

    return { statusCode: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, headers: corsHeaders, body: JSON.stringify({ error: e.message }) };
  }
};
