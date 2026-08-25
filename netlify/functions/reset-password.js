// Applique le nouveau mot de passe a partir d'un token signe.
// POST { token, password } -> verifie signature + expiration, puis change le mdp via service_role.
const crypto = require('crypto');

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}
function safeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: JSON.stringify({ error: 'Method not allowed' }) };

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  if (!sbUrl || !sbKey) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Config manquante' }) };

  let token = '', password = '';
  try { const b = JSON.parse(event.body || '{}'); token = b.token || ''; password = b.password || ''; } catch (e) {}
  if (!token || !password) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Champs manquants' }) };
  if (password.length < 8) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Le mot de passe doit faire au moins 8 caractères.' }) };

  const parts = String(token).split('.');
  if (parts.length !== 3) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Lien invalide.' }) };
  const [userId, expStr, sig] = parts;
  const base = `${userId}.${expStr}`;
  if (!safeEq(sig, sign(base, sbKey))) return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Lien invalide.' }) };
  if (!Number(expStr) || Date.now() > Number(expStr)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Ce lien a expiré. Redemandez un nouveau lien.' }) };
  }

  try {
    const r = await fetch(`${sbUrl}/auth/v1/admin/users/${userId}`, {
      method: 'PUT',
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ password })
    });
    if (!r.ok) {
      return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Impossible de changer le mot de passe, réessayez.' }) };
    }
    return { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  } catch (e) {
    return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Erreur serveur, réessayez.' }) };
  }
};
