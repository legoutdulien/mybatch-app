// Proxy vers l'API Anthropic pour l'assistant IA (Aria) de l'espace batchcookeuse.
// Réservé aux utilisatrices CONNECTÉES : on vérifie le JWT Supabase de l'appelant
// avant tout appel à Anthropic (sinon n'importe qui pourrait consommer le quota).
const SB_URL = process.env.SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_KEY;

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Allow-Methods': 'POST, OPTIONS'
};
function json(code, obj) {
  return { statusCode: code, headers: { ...cors, 'Content-Type': 'application/json' }, body: JSON.stringify(obj) };
}

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };

  // Authentification : token Supabase valide obligatoire
  const auth = event.headers.authorization || event.headers.Authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '');
  if (!token || !SB_URL || !SVC) return json(401, { error: { message: 'Connexion requise.' } });
  try {
    const userRes = await fetch(`${SB_URL}/auth/v1/user`, { headers: { apikey: SVC, Authorization: `Bearer ${token}` } });
    if (!userRes.ok) return json(401, { error: { message: 'Session invalide, reconnecte-toi.' } });
  } catch (e) {
    return json(401, { error: { message: 'Vérification de session impossible.' } });
  }

  try {
    const body = JSON.parse(event.body);
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        // plafond serveur : empêche un utilisateur connecté de gonfler la conso
        max_tokens: Math.min(parseInt(body.max_tokens, 10) || 1000, 1500),
        system: body.system || '',
        messages: body.messages || []
      })
    });
    const data = await response.json();
    return json(200, data);
  } catch (e) {
    return json(500, { error: { message: e.message } });
  }
};
