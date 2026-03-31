const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email required' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    
    // Cari user berdasarkan email
    const { data, error } = await sb.auth.admin.listUsers();
    if (error) return res.status(500).json({ error: error.message });

    const user = data.users.find(u => u.email?.toLowerCase() === email.toLowerCase());
    if (!user) return res.json({ user_id: null, found: false });

    return res.json({ user_id: user.id, email: user.email, found: true });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
