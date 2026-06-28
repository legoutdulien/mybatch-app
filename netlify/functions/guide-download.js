// /.netlify/functions/guide-download?session_id=cs_xxx
// Livre le PDF du guide UNIQUEMENT si la session Stripe est PAYÉE (produit guide_unique).
// Le PDF est stocké dans un bucket Supabase PRIVÉ (jamais exposé publiquement).
// Variables d'env : STRIPE_SECRET_KEY, SUPABASE_URL, SUPABASE_SERVICE_KEY

const STRIPE = process.env.STRIPE_SECRET_KEY;
const SB_URL = process.env.SUPABASE_URL;
const SVC = process.env.SUPABASE_SERVICE_KEY;

function deny(code, msg) {
  return {
    statusCode: code,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><meta charset="utf-8"><div style="font-family:system-ui,Segoe UI,Arial;max-width:540px;margin:90px auto;text-align:center;color:#1A1A1A;line-height:1.6"><h2 style="color:#E8843D">Accès au guide refusé</h2><p>${msg}</p><p style="margin-top:24px"><a href="https://mybatch.cooking/guide-achat.html" style="background:#E8843D;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:600">Acheter le guide →</a></p></div>`
  };
}

exports.handler = async (event) => {
  if (!STRIPE || !SB_URL || !SVC) return deny(500, 'Configuration serveur incomplète.');
  const sid = (event.queryStringParameters || {}).session_id;
  if (!sid) return deny(400, 'Lien invalide : identifiant de commande manquant.');

  // 1) Vérifier le paiement auprès de Stripe
  let session;
  try {
    const r = await fetch(`https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sid)}`, {
      headers: { Authorization: `Bearer ${STRIPE}` }
    });
    session = await r.json();
    if (!r.ok) return deny(403, 'Commande introuvable.');
  } catch (e) {
    return deny(500, 'Vérification du paiement impossible pour le moment.');
  }
  const paid = session.payment_status === 'paid';
  const isGuide = session.metadata && session.metadata.product_type === 'guide_unique';
  if (!paid || !isGuide) {
    return deny(403, "Cette commande n'est pas un achat de guide valide, ou le paiement n'a pas été confirmé.");
  }

  // 2) Récupérer le PDF depuis le bucket privé (service_role, côté serveur uniquement)
  let pdfB64;
  try {
    const r = await fetch(`${SB_URL}/storage/v1/object/guides/guide-my-batch.pdf`, {
      headers: { apikey: SVC, Authorization: `Bearer ${SVC}` }
    });
    if (!r.ok) return deny(500, 'Fichier du guide momentanément indisponible.');
    const ab = await r.arrayBuffer();
    pdfB64 = Buffer.from(ab).toString('base64');
  } catch (e) {
    return deny(500, 'Téléchargement du guide impossible pour le moment.');
  }

  return {
    statusCode: 200,
    headers: {
      'Content-Type': 'application/pdf',
      'Content-Disposition': 'attachment; filename="Guide-my-batch.pdf"',
      'Cache-Control': 'no-store'
    },
    isBase64Encoded: true,
    body: pdfB64
  };
};
