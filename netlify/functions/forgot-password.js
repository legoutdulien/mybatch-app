// Demande de reinitialisation de mot de passe.
// POST { email } -> si le compte existe, envoie un lien signe (valable 1h) par Brevo.
// Ne revele jamais si l'email existe (anti-enumeration) : renvoie toujours { ok: true }.
const crypto = require('crypto');

function sign(data, secret) {
  return crypto.createHmac('sha256', secret).update(data).digest('hex');
}

exports.handler = async (event) => {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers: cors, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers: cors, body: 'Method not allowed' };

  const sbUrl = process.env.SUPABASE_URL;
  const sbKey = process.env.SUPABASE_SERVICE_KEY;
  const brevoKey = process.env.BREVO_API_KEY;
  const okResp = { statusCode: 200, headers: cors, body: JSON.stringify({ ok: true }) };
  if (!sbUrl || !sbKey) return { statusCode: 500, headers: cors, body: JSON.stringify({ error: 'Config manquante' }) };

  let email = '';
  try { email = (JSON.parse(event.body || '{}').email || '').trim().toLowerCase(); } catch (e) {}
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return okResp;

  try {
    const r = await fetch(`${sbUrl}/auth/v1/admin/users?email=${encodeURIComponent(email)}`, {
      headers: { apikey: sbKey, Authorization: `Bearer ${sbKey}` }
    });
    const d = await r.json();
    const user = (d.users || []).find(u => u.email && u.email.toLowerCase() === email);
    if (!user) return okResp; // pas de compte -> on ne dit rien

    const exp = Date.now() + 60 * 60 * 1000; // 1 heure
    const base = `${user.id}.${exp}`;
    const token = `${base}.${sign(base, sbKey)}`;
    const link = `https://app.mybatch.cooking/reset.html?token=${encodeURIComponent(token)}`;

    if (brevoKey) {
      const html = `<!DOCTYPE html><html><body style="margin:0;background:#FAF6EE;font-family:Arial,Helvetica,sans-serif;color:#3a3a34">
        <div style="max-width:520px;margin:0 auto;padding:28px 22px">
          <div style="font-size:26px;font-weight:800;color:#1A1A1A;letter-spacing:-1px;text-align:center">my batch<span style="color:#E8843D">.</span></div>
          <div style="background:#fff;border-radius:16px;padding:26px 24px;margin-top:16px;box-shadow:0 6px 24px rgba(0,0,0,.06)">
            <h1 style="font-size:20px;color:#264935;margin:0 0 14px">Réinitialisation de votre mot de passe</h1>
            <p style="line-height:1.6;margin:0 0 18px">Vous avez demandé à réinitialiser votre mot de passe my batch. Cliquez sur le bouton ci-dessous pour en choisir un nouveau&nbsp;:</p>
            <div style="text-align:center;margin:0 0 18px">
              <a href="${link}" style="display:inline-block;background:#3D6B4F;color:#fff;text-decoration:none;font-weight:700;padding:13px 26px;border-radius:11px">Choisir un nouveau mot de passe</a>
            </div>
            <p style="line-height:1.6;margin:0 0 8px;font-size:13px;color:#8a8578">Ce lien est valable <b>1 heure</b>. Si vous n'êtes pas à l'origine de cette demande, ignorez simplement cet email — votre mot de passe reste inchangé.</p>
            <p style="line-height:1.5;margin:14px 0 0;font-size:12px;color:#a8a49a;word-break:break-all">Si le bouton ne fonctionne pas, copiez ce lien dans votre navigateur&nbsp;:<br>${link}</p>
          </div>
          <div style="text-align:center;color:#8a8578;font-size:12px;margin-top:16px">my batch — l'app des batchcookeuses · mybatch.cooking</div>
        </div>
      </body></html>`;
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: { 'api-key': brevoKey, 'Content-Type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({
          sender: { name: 'my batch', email: process.env.BREVO_SENDER_EMAIL || 'contact@mybatch.cooking' },
          to: [{ email }],
          subject: 'Réinitialisation de votre mot de passe my batch',
          htmlContent: html
        })
      });
    }
    return okResp;
  } catch (e) {
    return okResp; // on ne divulgue pas d'erreur
  }
};
