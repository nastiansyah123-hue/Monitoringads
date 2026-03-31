const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FONNTE_TOKEN = process.env.FONNTE_TOKEN;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  if (req.headers['authorization'] !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    const nowWIB = new Date(Date.now() + 7 * 3600 * 1000);
    const jamStr = `${String(nowWIB.getUTCHours()).padStart(2,'0')}.${String(nowWIB.getUTCMinutes()).padStart(2,'0')} WIB`;
    const today = nowWIB.toISOString().split('T')[0];

    // 1. Ambil semua user config
    const { data: userConfigs } = await sb.from('user_config').select('user_id, meta_token, meta_tokens, fonnte_token, spv_name, spv_phone');
    if (!userConfigs?.length) return res.json({ alerts: 0 });

    // 2. Ambil semua account_limits
    const { data: allLimits } = await sb.from('account_limits')
      .select('user_id, account_id, limit_amount, saldo_awal, spend_saat_set');

    // 3. Ambil log notif hari ini (anti spam)
    const { data: todayLogs } = await sb.from('budget_alert_logs')
      .select('account_id, alert_type')
      .eq('tanggal', today);
    
    const sentToday = new Set((todayLogs || []).map(l => `${l.account_id}_${l.alert_type}`));

    const allAlerts = [];

    for (const uc of userConfigs) {
      if (!uc.meta_token) continue;

      // Token Meta
      let tokens = [];
      if (uc.meta_tokens) {
        try { tokens = JSON.parse(uc.meta_tokens).map(t => t.token).filter(Boolean); } catch(e) {}
      }
      if (!tokens.length && uc.meta_token) tokens = [uc.meta_token];

      // Limits milik user ini
      const userLimits = (allLimits || []).filter(l => l.user_id === uc.user_id);
      if (!userLimits.length) continue;

      // Ambil advertisers + nomor WA
      const { data: advertisers } = await sb.from('advertisers').select('*').eq('user_id', uc.user_id);

      // Fetch spend hari ini dari Meta
      for (const token of tokens) {
        try {
          const accRes = await fetch(
            `https://graph.facebook.com/v19.0/me/adaccounts?access_token=${token}&fields=id,name,insights.date_preset(today){spend}&limit=50`
          );
          const accData = await accRes.json();
          if (accData.error) continue;

          for (const acc of (accData.data || [])) {
            const limitData = userLimits.find(l => l.account_id === acc.id);
            if (!limitData || !limitData.limit_amount) continue;

            const spendAPI = parseFloat(acc.insights?.data?.[0]?.spend || 0);
            const spendSejak = Math.max(0, spendAPI - (limitData.spend_saat_set || 0));
            const saldoTertunggak = (limitData.saldo_awal || 0) + spendSejak;
            const limit = limitData.limit_amount;
            const sisa = Math.max(0, limit - saldoTertunggak);
            const pct = Math.round(saldoTertunggak / limit * 100);

            // Tentukan level alert
            let alertType = null;
            if (pct >= 90) alertType = 'kritis_90';
            else if (pct >= 70) alertType = 'hampir_70';

            if (!alertType) continue;
            if (sentToday.has(`${acc.id}_${alertType}`)) continue; // Sudah kirim hari ini

            // Cari nomor WA PIC dari advertisers
            const adv = (advertisers || []).find(a => {
              const accounts = JSON.parse(a.accounts || '[]');
              return accounts.includes(acc.id);
            });

            // Kirim ke SPV, bukan PIC

            // Susun pesan alert
            const emoji = pct >= 90 ? '🚨' : '⚠️';
            const level = pct >= 90 ? 'KRITIS' : 'PERINGATAN';
            const spvName = uc.spv_name || 'SPV';
            let pesan = `${emoji} *ALERT BUDGET ${level}*\n\n`;
            pesan += `👔 Halo, *${spvName}*!\n`;
            pesan += `🏢 *${acc.name}*\n`;
            pesan += `🕐 ${jamStr}\n\n`;
            pesan += `📊 *Status Budget:*\n`;
            pesan += `Limit: Rp${Math.round(limit).toLocaleString('id-ID')}\n`;
            pesan += `Terpakai: Rp${Math.round(saldoTertunggak).toLocaleString('id-ID')} (${pct}%)\n`;
            pesan += `Sisa: Rp${Math.round(sisa).toLocaleString('id-ID')}\n\n`;
            pesan += pct >= 90
              ? `🚨 Budget hampir habis! Segera lakukan pembayaran atau kurangi budget iklan.`
              : `⚠️ Budget sudah ${pct}% terpakai. Pantau terus pengeluaran iklan.`;
            pesan += `\n\n_AdMonitor · Herbal Jaya_`;

            // Kirim WA
            const targetPhone = uc.spv_phone;
            if (!targetPhone) continue;
            const fonnteToken = uc.fonnte_token || FONNTE_TOKEN;
            const waResult = await kirimWA(targetPhone, pesan, fonnteToken);

            // Log agar tidak kirim lagi hari ini
            await sb.from('budget_alert_logs').insert({
              user_id: uc.user_id,
              account_id: acc.id,
              account_name: acc.name,
              alert_type: alertType,
              pct_used: pct,
              sisa,
              tanggal: today,
              sent_at: new Date().toISOString(),
              wa_status: waResult
            }).catch(() => {});

            sentToday.add(`${acc.id}_${alertType}`);
            allAlerts.push({ account: acc.name, pct, alertType, status: waResult });
          }
        } catch(e) { console.error(e.message); }
      }
    }

    return res.json({ success: true, alerts: allAlerts.length, detail: allAlerts });

  } catch(e) {
    console.error(e);
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
    return r.status ? 'sent' : 'failed: ' + (r.reason || '');
  } catch(e) { return 'error: ' + e.message; }
}
