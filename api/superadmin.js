const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { user_id, since, until, preset } = req.body;
  if (!user_id) return res.status(400).json({ error: 'user_id required' });

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Verifikasi super admin
    const { data: saCheck } = await sb.from('super_admins').select('user_id').eq('user_id', user_id).single();
    if (!saCheck) return res.status(403).json({ error: 'Bukan super admin' });

    const todayWIB = getTodayWIB();
    const sinceDate = since || todayWIB;
    const untilDate = until || todayWIB;

    // Ambil semua user config
    const { data: configs } = await sb.from('user_config').select('user_id, meta_token, meta_tokens');
    if (!configs?.length) return res.json({ admins: [] });

    // Proses semua admin PARALEL
    const results = await Promise.all(configs.map(async (cfg) => {
      let tokens = [];
      if (cfg.meta_tokens) {
        try { tokens = JSON.parse(cfg.meta_tokens).map(t => t.token).filter(Boolean); } catch(e) {}
      }
      if (!tokens.length && cfg.meta_token) tokens = [cfg.meta_token];
      if (!tokens.length) return null;

      const seenIds = new Set();
      const allAccounts = [];

      await Promise.all(tokens.map(async (token) => {
        try {
          // Step 1: Fetch daftar akun
          const accRes = await fetch(
            `https://graph.facebook.com/v19.0/me/adaccounts?access_token=${token}&fields=id,name&limit=50`
          );
          const accData = await accRes.json();
          if (accData.error) return;

          // Step 2: Fetch insights per akun PARALEL
          await Promise.all((accData.data || []).map(async (acc) => {
            if (seenIds.has(acc.id)) return;
            seenIds.add(acc.id);

            try {
              // Gunakan time_range untuk semua kasus
              const insUrl = `https://graph.facebook.com/v19.0/${acc.id}/insights` +
                `?access_token=${token}` +
                `&fields=spend,actions,impressions,clicks` +
                `&time_range={"since":"${sinceDate}","until":"${untilDate}"}` +
                `&level=account`;

              const insRes = await fetch(insUrl);
              const insData = await insRes.json();
              const ins = insData.data?.[0];

              const spend = parseFloat(ins?.spend || 0);
              const hasil = parseInt((ins?.actions || []).find(a =>
                ['web_in_store_purchase','omni_purchase','offsite_conversion.fb_pixel_purchase',
                 'lead','onsite_conversion.lead_grouped'].includes(a.action_type)
              )?.value || 0);

              allAccounts.push({
                id: acc.id,
                name: acc.name,
                spend,
                hasil,
                cpr: hasil > 0 ? Math.round(spend / hasil) : 0,
                impresi: parseInt(ins?.impressions || 0),
                klik: parseInt(ins?.clicks || 0)
              });
            } catch(e) {
              allAccounts.push({ id: acc.id, name: acc.name, spend: 0, hasil: 0, cpr: 0, impresi: 0, klik: 0 });
            }
          }));
        } catch(e) {}
      }));

      if (!allAccounts.length) return null;

      const totalSpend = allAccounts.reduce((s,a) => s+a.spend, 0);
      const totalHasil = allAccounts.reduce((s,a) => s+a.hasil, 0);

      return {
        userId: cfg.user_id,
        accounts: allAccounts.sort((a,b) => b.spend - a.spend),
        totalSpend,
        totalHasil,
        avgCPR: totalHasil > 0 ? Math.round(totalSpend/totalHasil) : 0,
        jumlahAkun: allAccounts.length
      };
    }));

    // Ambil semua account_limits
    const { data: allLimits } = await sb.from('account_limits')
      .select('user_id, account_id, limit_amount, saldo_awal, spend_saat_set');

    // Attach limits ke setiap admin
    const adminsWithLimits = results.filter(Boolean).map(admin => ({
      ...admin,
      limits: (allLimits || []).filter(l => l.user_id === admin.userId)
    }));

    return res.json({ admins: adminsWithLimits, since: sinceDate, until: untilDate });

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
