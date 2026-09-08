// /.netlify/functions/vitrine-contact
// Endpoint PUBLIC : reçoit une demande de contact depuis la page vitrine d'une
// batchcookeuse (formulaire non authentifié) et l'envoie par email à la vraie
// cuisinière (admin_email en base, JAMAIS exposé au navigateur).
// Reply-To = email du prospect, pour qu'elle réponde en un clic.
exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  const brevoKey = process.env.BREVO_API_KEY;
  if (!url || !key) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Config manquante' }) };

  let body;
  try { body = JSON.parse(event.body || '{}'); } catch (e) { return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'JSON invalide' }) }; }

  const slug = String(body.slug || '').toLowerCase().replace(/[^a-z0-9-]/g, '');
  const nom = String(body.nom || '').slice(0, 120).trim();
  const email = String(body.email || '').slice(0, 200).trim();
  const tel = String(body.telephone || '').slice(0, 40).trim();
  const message = String(body.message || '').slice(0, 2000).trim();
  // honeypot anti-spam : champ caché qui doit rester vide
  if (String(body.website || '').trim()) return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };

  if (!slug || !nom || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Nom et email valides requis' }) };
  }

  try {
    const r = await fetch(
      `${url}/rest/v1/entreprises?slug=eq.${encodeURIComponent(slug)}&active=eq.true&select=nom_marque,admin_email`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` } }
    );
    const rows = await r.json();
    const ent = Array.isArray(rows) ? rows[0] : null;
    if (!ent || !ent.admin_email) {
      return { statusCode: 404, headers: cors, body: JSON.stringify({ error: 'Introuvable' }) };
    }

    if (!brevoKey) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Envoi indisponible' }) };
    }

    const esc = (s) => String(s).replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const resp = await fetch('https://api.brevo.com/v3/smtp/email', {
      method: 'POST',
      headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', accept: 'application/json' },
      body: JSON.stringify({
        sender: { name: 'my batch', email: process.env.BREVO_SENDER_EMAIL || 'contact@mybatch.cooking' },
        to: [{ email: ent.admin_email, name: ent.nom_marque || 'Batchcookeuse' }],
        replyTo: { email, name: nom },
        subject: `Nouvelle demande depuis votre vitrine — ${nom}`,
        htmlContent: `<div style="font-family:sans-serif;max-width:520px;margin:0 auto;padding:24px">
          <h2 style="color:#3D6B4F">Nouvelle demande depuis votre page vitrine</h2>
          <p><strong>${esc(nom)}</strong> souhaite être recontacté·e.</p>
          <p>Email : <a href="mailto:${esc(email)}">${esc(email)}</a>${tel ? `<br>Téléphone : ${esc(tel)}` : ''}</p>
          ${message ? `<p style="background:#F4EEDB;padding:14px;border-radius:8px;white-space:pre-wrap">${esc(message)}</p>` : ''}
          <p style="font-size:12px;color:#888">Répondez directement à cet email pour recontacter ${esc(nom)}.</p>
        </div>`
      })
    });
    if (!resp.ok) return { statusCode: 502, headers: cors, body: JSON.stringify({ error: 'Envoi échoué' }) };

    return { statusCode: 200, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: e.message }) };
  }
};
