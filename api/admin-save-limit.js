const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { user_id, account_id, limit_amount, saldo_awal, spend_saat_set } = req.body;
  if (!user_id || !account_id) return res.status(400).json({ error: 'Missing params' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Verifikasi user_id ada di user_config (hanya admin)
    const { data: cfg } = await sb.from('user_config')
      .select('user_id').eq('user_id', user_id).single();
    if (!cfg) return res.status(403).json({ error: 'User tidak ditemukan' });

    const { error } = await sb.from('account_limits').upsert({
      user_id,
      account_id,
      limit_amount: parseFloat(limit_amount || 0),
      saldo_awal:   parseFloat(saldo_awal   || 0),
      spend_saat_set: parseFloat(spend_saat_set || 0),
      updated_at: new Date().toISOString()
    }, { onConflict: 'user_id,account_id' });

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ success: true });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
};
