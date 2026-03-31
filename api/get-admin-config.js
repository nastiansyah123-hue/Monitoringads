const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { user_id, member_id } = req.body;
  if (!user_id || !member_id) return res.status(400).json({ error: 'Missing params' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Verifikasi member_id memang karyawan dari admin user_id
    const { data: advCheck } = await sb.from('adv_users')
      .select('user_id').eq('user_id', member_id).eq('admin_user_id', user_id).single();
    const { data: viewerCheck } = await sb.from('viewer_users')
      .select('user_id').eq('user_id', member_id).eq('admin_user_id', user_id).single();

    if (!advCheck && !viewerCheck) return res.status(403).json({ error: 'Unauthorized' });

    // Ambil config admin
    const { data: config } = await sb.from('user_config')
      .select('meta_token, meta_tokens')
      .eq('user_id', user_id).single();

    // Ambil limits admin
    const { data: limits } = await sb.from('account_limits')
      .select('account_id, limit_amount, saldo_awal, spend_saat_set')
      .eq('user_id', user_id);

    return res.json({ config, limits: limits || [] });
  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
