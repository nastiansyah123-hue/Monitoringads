const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
    const { test_threshold, test_phone } = req.body || {};
    const THRESHOLD = test_threshold ? 0 : 70;

    const nowWIB = new Date(Date.now() + 7 * 3600 * 1000);
    const jamStr = `${String(nowWIB.getUTCHours()).padStart(2,'0')}.${String(nowWIB.getUTCMinutes()).padStart(2,'0')} WIB`;
    const today = nowWIB.toISOString().split('T')[0];

    // Ambil semua account_limits (tanpa filter user_id)
    const { data: allLimits, error: limErr } = await sb
      .from('account_limits')
      .select('user_id, account_id, limit_amount, saldo_awal, spend_saat_set');

    if (limErr) return res.json({ error: 'limits error: ' + limErr.message });
    if (!allLimits?.length) return res.json({ alerts: 0, reason: 'no limits set' });

    // Ambil user_config untuk setiap user yang punya limits
    const userIds = [...new Set(allLimits.map(l => l.user_id))];
    const { data: userConfigs } = await sb
      .from('user_config')
      .select('user_id, meta_token, meta_tokens, fonnte_token, spv_name, spv_phone')
      .in('user_id', userIds);

    if (!userConfigs?.length) return res.json({ alerts: 0, reason: 'no user configs' });

    // Anti spam log
    const { data: todayLogs } = await sb.from('budget_alert_logs')
      .select('account_id, alert_type').eq('tanggal', today);
    const sentToday = new Set((todayLogs || []).map(l => `${l.account_id}_${l.alert_type}`));

    const allAlerts = [];
    const debug = [];

    for (const uc of userConfigs) {
      // Kumpulkan token
      let tokens = [];
      if (uc.meta_tokens) {
        try { tokens = JSON.parse(uc.meta_tokens).map(t => t.token).filter(Boolean); } catch(e) {}
      }
      if (!tokens.length && uc.meta_token) tokens = [uc.meta_token];
      if (!tokens.length) continue;

      // Limits user ini
      const userLimits = allLimits.filter(l => l.user_id === uc.user_id);
      debug.push({ userId: uc.user_id, limitsCount: userLimits.length, tokensCount: tokens.length });

      for (const token of tokens) {
        try {
          // Fetch semua akun + spend hari ini sekaligus
          const url = `https://graph.facebook.com/v19.0/me/adaccounts?access_token=${token}` +
            `&fields=id,name,insights.date_preset(today){spend}&limit=50`;
          const accRes = await fetch(url);
          const accData = await accRes.json();
          if (accData.error) { debug.push({ metaError: accData.error.message }); continue; }

          for (const acc of (accData.data || [])) {
            const lim = userLimits.find(l => l.account_id === acc.id);
            if (!lim || !lim.limit_amount || lim.limit_amount <= 0) continue;

            // Hitung saldo tertunggak
            const spendAPI = parseFloat(acc.insights?.data?.[0]?.spend || 0);
            const spendSejak = Math.max(0, spendAPI - (lim.spend_saat_set || 0));
            const saldoTertunggak = (lim.saldo_awal || 0) + spendSejak;
            const pct = Math.min(100, Math.round(saldoTertunggak / lim.limit_amount * 100));
            const sisa = Math.max(0, lim.limit_amount - saldoTertunggak);

            debug.push({ account: acc.name, pct, saldoTertunggak, limit: lim.limit_amount });

            if (pct < THRESHOLD) continue;

            const alertType = pct >= 90 ? 'kritis_90' : 'hampir_70';
            if (!test_threshold && sentToday.has(`${acc.id}_${alertType}`)) continue;

            const finalPhone = test_phone || uc.spv_phone;
            if (!finalPhone) { debug.push({ skip: 'no phone', account: acc.name }); continue; }

            const fonnteToken = uc.fonnte_token || process.env.FONNTE_TOKEN;
            const spvName = uc.spv_name || 'SPV';
            const emoji = pct >= 90 ? '🚨' : '⚠️';

            let pesan = `${emoji} *ALERT BUDGET ${pct >= 90 ? 'KRITIS' : 'PERINGATAN'}*\n\n`;
            pesan += `👔 Halo, *${spvName}*!\n`;
            pesan += `🏢 *${acc.name}*\n`;
            pesan += `🕐 ${jamStr}\n\n`;
            pesan += `📊 *Status Budget:*\n`;
            pesan += `Limit: Rp${Math.round(lim.limit_amount).toLocaleString('id-ID')}\n`;
            pesan += `Terpakai: Rp${Math.round(saldoTertunggak).toLocaleString('id-ID')} (${pct}%)\n`;
            pesan += `Sisa: Rp${Math.round(sisa).toLocaleString('id-ID')}\n\n`;
            pesan += pct >= 90
              ? `🚨 Budget hampir habis! Segera lakukan pembayaran.`
              : `⚠️ Budget ${pct}% terpakai. Pantau pengeluaran iklan.`;
            pesan += `\n\n_AdMonitor · Herbal Jaya_`;

            const waResult = await kirimWA(finalPhone, pesan, fonnteToken);

            await sb.from('budget_alert_logs').insert({
              user_id: uc.user_id, account_id: acc.id, account_name: acc.name,
              alert_type: alertType, pct_used: pct, sisa, tanggal: today,
              sent_at: new Date().toISOString(), wa_status: waResult
            }).catch(() => {});

            sentToday.add(`${acc.id}_${alertType}`);
            allAlerts.push({ account: acc.name, pct, alertType, phone: finalPhone, status: waResult });
          }
        } catch(e) { debug.push({ tokenError: e.message }); }
      }
    }

    return res.json({ success: true, alerts: allAlerts.length, detail: allAlerts, debug });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};

async function kirimWA(nomor, pesan, token) {
  try {
    const resp = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { 'Authorization': token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: nomor.replace(/\D/g,''), message: pesan, countryCode: '62' })
    });
    const r = await resp.json();
    return r.status ? 'sent' : 'failed: ' + (r.reason || JSON.stringify(r));
  } catch(e) { return 'error: ' + e.message; }
}
