const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { user_id } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  try {
    // Pakai service key untuk bypass RLS
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Verifikasi bahwa user ini memang super admin
    const { data: saCheck } = await sb
      .from('super_admins')
      .select('user_id')
      .eq('user_id', user_id)
      .single();

    if (!saCheck) return res.status(403).json({ error: 'Bukan super admin' });

    // Ambil semua user config beserta token Meta
    const { data: configs } = await sb
      .from('user_config')
      .select('user_id, meta_token, meta_tokens');

    if (!configs?.length) return res.json({ admins: [] });

    const today = getTodayWIB();
    const results = [];

    for (const cfg of configs) {
      if (!cfg.meta_token && !cfg.meta_tokens) continue;

      // Ambil semua token (multi-token support)
      let tokens = [];
      if (cfg.meta_tokens) {
        try { tokens = JSON.parse(cfg.meta_tokens).map(t => t.token).filter(Boolean); } catch(e) {}
      }
      if (!tokens.length && cfg.meta_token) tokens = [cfg.meta_token];
      if (!tokens.length) continue;

      const adminAccounts = [];
      const seenIds = new Set();

      for (const token of tokens) {
        try {
          // Fetch nama akun
          const accRes = await fetch(
            `https://graph.facebook.com/v19.0/me/adaccounts?access_token=${token}&fields=id,name&limit=50`
          );
          const accData = await accRes.json();
          if (accData.error) continue;

          // Fetch insights hari ini per akun
          for (const acc of (accData.data || [])) {
            if (seenIds.has(acc.id)) continue;
            seenIds.add(acc.id);

            try {
              const insRes = await fetch(
                `https://graph.facebook.com/v19.0/${acc.id}/insights?` +
                `access_token=${token}&` +
                `date_preset=today&` +
                `fields=spend,actions,impressions,clicks&` +
                `level=account`
              );
              const insData = await insRes.json();
              const ins = insData.data?.[0];
              const spend = parseFloat(ins?.spend || 0);
              const hasil = parseInt((ins?.actions || []).find(a =>
                ['web_in_store_purchase','omni_purchase','offsite_conversion.fb_pixel_purchase',
                 'lead','onsite_conversion.lead_grouped'].includes(a.action_type)
              )?.value || 0);

              adminAccounts.push({
                id: acc.id,
                name: acc.name,
                spend,
                hasil,
                cpr: hasil > 0 ? Math.round(spend / hasil) : 0,
                impresi: parseInt(ins?.impressions || 0),
                klik: parseInt(ins?.clicks || 0)
              });
            } catch(e) {
              adminAccounts.push({ id: acc.id, name: acc.name, spend: 0, hasil: 0, cpr: 0 });
            }
          }
        } catch(e) { continue; }
      }

      if (adminAccounts.length) {
        results.push({
          userId: cfg.user_id,
          accounts: adminAccounts,
          totalSpend: adminAccounts.reduce((s,a) => s+a.spend, 0),
          totalHasil: adminAccounts.reduce((s,a) => s+a.hasil, 0),
          jumlahAkun: adminAccounts.length
        });
      }
    }

    return res.json({ admins: results, today });

  } catch(e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};

function getTodayWIB() {
  const d = new Date();
  d.setTime(d.getTime() + 7 * 3600 * 1000);
  return d.toISOString().split('T')[0];
}
