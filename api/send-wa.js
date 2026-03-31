const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY;
const FONNTE_TOKEN = process.env.FONNTE_TOKEN;
const META_TOKEN = process.env.META_TOKEN;

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // Waktu WIB
    const now = new Date();
    const jamWIB = (now.getUTCHours() + 7) % 24;
    const menit = String(now.getUTCMinutes()).padStart(2,'0');
    const today = getToday();
    const tanggalStr = formatTanggal(now);
    const jamStr = `${String(jamWIB).padStart(2,'0')}.${menit} WIB`;

    // 1. Ambil semua advertiser + akun iklan mereka
    const { data: advertisers, error: advErr } = await sb
      .from('advertisers')
      .select('*');

    if (advErr) throw new Error('Supabase error: ' + advErr.message);
    if (!advertisers?.length) return res.json({ sent: 0, message: 'No advertisers' });

    // 2. Ambil mapping account_id -> nama akun dari Supabase
    const { data: accData } = await sb.from('ad_accounts').select('ad_account_id, account_name');
    const accNameMap = {};
    (accData || []).forEach(a => accNameMap[a.ad_account_id] = a.account_name);

    const results = [];

    for (const adv of advertisers) {
      if (!adv.pic_phone) continue;

      const accounts = JSON.parse(adv.accounts || '[]');
      if (!accounts.length) continue;

      // 3. Fetch kampanye per akun
      const akunReports = [];

      for (const accId of accounts) {
        try {
          const campRes = await fetch(
            `https://graph.facebook.com/v19.0/${accId}/campaigns?` +
            `access_token=${META_TOKEN}&` +
            `fields=id,name,status,insights{spend,actions,impressions,clicks}&` +
            `time_range={"since":"${today}","until":"${today}"}&` +
            `filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE","PAUSED"]}]&` +
            `limit=20`
          );
          const campData = await campRes.json();
          if (campData.error || !campData.data?.length) continue;

          const namaAkun = accNameMap[accId] || accId;
          const scale = [];
          const kill = [];
          const semua = [];

          for (const camp of campData.data) {
            const ins = camp.insights?.data?.[0];
            const spend = ins ? parseFloat(ins.spend || 0) : 0;
            const hasil = ins ? parseInt((ins.actions || []).find(a =>
              ['web_in_store_purchase','omni_purchase','offsite_conversion.fb_pixel_purchase','lead','onsite_conversion.lead_grouped'].includes(a.action_type)
            )?.value || 0) : 0;
            const cpr = hasil > 0 ? Math.round(spend / hasil) : 0;
            const impresi = ins ? parseInt(ins.impressions || 0) : 0;
            const klik = ins ? parseInt(ins.clicks || 0) : 0;
            const status = camp.status === 'ACTIVE' ? 'Aktif' : 'Paused';

            const info = { name: camp.name, spend, hasil, cpr, impresi, klik, status };
            semua.push(info);

            if (spend > 0 && hasil > 0 && cpr < 150000) scale.push(info);
            else if (spend > 50000 && hasil === 0) kill.push(info);
          }

          if (semua.length > 0) {
            akunReports.push({ namaAkun, scale, kill, semua });
          }

        } catch (e) {
          console.error('Error fetch account', accId, e.message);
        }
      }

      if (!akunReports.length) continue;

      // 4. Susun pesan WA
      let pesan = `📊 *Laporan Iklan*\n`;
      pesan += `🕐 ${jamStr} | ${tanggalStr}\n`;
      pesan += `👤 Halo, *${adv.name}*!\n\n`;

      for (const akun of akunReports) {
        pesan += `━━━━━━━━━━━━━━━━\n`;
        pesan += `🏢 *${akun.namaAkun}*\n`;
        pesan += `━━━━━━━━━━━━━━━━\n\n`;

        if (akun.scale.length > 0) {
          pesan += `✅ *PERFORMA BAGUS (Scale):*\n`;
          akun.scale.forEach(c => {
            pesan += `▸ *${c.name}*\n`;
            pesan += `   Spend: ${fmtRp(c.spend)}\n`;
            pesan += `   Hasil: ${c.hasil} | CPR: ${fmtRp(c.cpr)}\n`;
            pesan += `   Impresi: ${fmtNum(c.impresi)} | Klik: ${fmtNum(c.klik)}\n\n`;
          });
        }

        if (akun.kill.length > 0) {
          pesan += `❌ *TIDAK ADA HASIL (Kill):*\n`;
          akun.kill.forEach(c => {
            pesan += `▸ *${c.name}*\n`;
            pesan += `   Spend: ${fmtRp(c.spend)} | Hasil: 0\n\n`;
          });
        }

        // Kampanye aktif lain yang tidak masuk scale/kill
        const lainnya = akun.semua.filter(c => 
          !akun.scale.find(s => s.name === c.name) && 
          !akun.kill.find(k => k.name === c.name) &&
          c.spend > 0
        );
        if (lainnya.length > 0) {
          pesan += `📌 *Lainnya:*\n`;
          lainnya.forEach(c => {
            pesan += `▸ ${c.name} (${c.status})\n`;
            pesan += `   Spend: ${fmtRp(c.spend)} | Hasil: ${c.hasil}\n\n`;
          });
        }
      }

      pesan += `_Powered by AdMonitor_`;

      // 5. Kirim WA
      const waResult = await kirimWA(adv.pic_phone, pesan);
      results.push({ advertiser: adv.name, phone: adv.pic_phone, status: waResult });
    }

    // 6. Log ke Supabase
    try {
      await sb.from('wa_logs').insert({
        sent_at: new Date().toISOString(),
        jam_wib: jamWIB,
        total_sent: results.length,
        detail: JSON.stringify(results)
      });
    } catch(e) { console.log('wa_logs skip:', e.message); }

    return res.json({ success: true, sent: results.length, results, jamWIB });

  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};

async function kirimWA(nomor, pesan) {
  try {
    const phone = nomor.replace(/\D/g, '');
    const resp = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { 'Authorization': FONNTE_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: phone, message: pesan, countryCode: '62' })
    });
    const result = await resp.json();
    return result.status ? 'sent' : ('failed: ' + (result.reason || JSON.stringify(result)));
  } catch (e) {
    return 'error: ' + e.message;
  }
}

function getToday() {
  const d = new Date();
  d.setUTCHours(d.getUTCHours() + 7);
  return d.toISOString().split('T')[0];
}

function formatTanggal(d) {
  const hari = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const bln = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Ags','Sep','Okt','Nov','Des'];
  const wib = new Date(d.getTime() + 7*3600000);
  return `${hari[wib.getUTCDay()]}, ${wib.getUTCDate()} ${bln[wib.getUTCMonth()]} ${wib.getUTCFullYear()}`;
}

function fmtRp(n) {
  return 'Rp' + Math.round(n).toLocaleString('id-ID');
}

function fmtNum(n) {
  return parseInt(n).toLocaleString('id-ID');
}
