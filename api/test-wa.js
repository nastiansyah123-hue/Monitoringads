// api/test-wa.js
module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { target, message, token, countryCode } = req.body;
  if (!target || !message || !token) return res.status(400).json({ error: 'target, message, token wajib' });

  try {
    const resp = await fetch('https://fonnte.com/api/send-message', {
      method: 'POST',
      headers: { 'Authorization': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target, message, countryCode: countryCode || '62' })
    });
    const result = await resp.json();
    return res.json(result);
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
