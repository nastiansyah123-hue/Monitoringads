module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { target, message, token } = req.body;
  if (!target || !message || !token) return res.status(400).json({ error: 'target, message, token wajib' });

  try {
    const resp = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: {
        'Authorization': token,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        target: target,
        message: message,
        countryCode: '62'
      })
    });

    const text = await resp.text();
    console.log('Fonnte raw response:', text.substring(0, 500));

    try {
      return res.json(JSON.parse(text));
    } catch(e) {
      return res.json({ status: false, reason: text.substring(0, 300) });
    }
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
