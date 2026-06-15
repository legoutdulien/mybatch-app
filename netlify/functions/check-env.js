// One-shot debug: verify env vars are correctly set. DELETE AFTER USE.
const SECRET = 'mb-check-onetime-2026-06-15-z9x8w7';

exports.handler = async (event) => {
  if (event.queryStringParameters?.secret !== SECRET) {
    return { statusCode: 401, body: JSON.stringify({ error: 'Unauthorized' }) };
  }
  const k = process.env.SUPABASE_SERVICE_KEY || '';
  const u = process.env.SUPABASE_URL || '';
  return {
    statusCode: 200,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url: u,
      key_length: k.length,
      key_prefix: k.substring(0, 10),
      key_suffix: k.substring(k.length - 10),
      key_first_3_dots: (k.match(/\./g) || []).length, // JWT has 2 dots
    }, null, 2)
  };
};
