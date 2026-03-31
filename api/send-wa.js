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

    const now = new Date();
    const wibOffset = 7 * 60 * 60 * 1000;
    const nowWIB = new Date(now.getTime() + wibOffset);
    const jamWIB = nowWIB.getUTCHours();
    const menitWIB = String(nowWIB.getUTCMinutes()).padStart(2,'0');
    const jamStr = `${String(jamWIB).padStart(2,'0')}.${menitWIB} WIB`;
    const y = nowWIB.getUTCFullYear();
    const m = String(nowWIB.getUTCMonth()+1).padStart(2,'0');
    const d = String(nowWIB.getUTCDate()).padStart(2,'0');
    const today = `${y}-${m}-${d}`;
    const tanggalStr = formatTanggal(nowWIB);

    // 1. Ambil semua user beserta token Meta mereka dari user_config
    const { data: userConfigs, error: ucErr } = await sb
      .from('user_config')
      .select('user_id, meta_token');

    if (ucErr) throw new Error('user_config error: ' + ucErr.message);
    if (!userConfigs?.length) return res.json({ sent: 0, message: 'No user configs' });

    const allResults = [];

    // 2. Proses per user (per admin)
    for (const uc of userConfigs) {
      if (!uc.meta_token) continue; // skip user yang belum set token Meta

      const META_TOKEN = uc.meta_token;

      // Ambil advertisers milik user ini
      const { data: advertisers } = await sb
        .from('advertisers')
        .select('*')
        .eq('user_id', uc.user_id);

      if (!advertisers?.length) continue;

      // Ambil nama akun dari Meta API user ini
      const metaAccRes = await fetch(
        `https://graph.facebook.com/v19.0/me/adaccounts?access_token=${META_TOKEN}&fields=id,name&limit=50`
      );
      const metaAccData = await metaAccRes.json();
      if (metaAccData.error) {
        console.error('Meta token invalid for user', uc.user_id);
        continue;
      }

      const accNameMap = {};
      (metaAccData.data || []).forEach(a => accNameMap[a.id] = a.name);

      // Proses setiap advertiser
      for (const adv of advertisers) {
        if (!adv.pic_phone) continue;
        const accounts = JSON.parse(adv.accounts || '[]');
        if (!accounts.length) continue;

        const akunReports = [];

        for (const accId of accounts) {
          try {
            const namaAkun = accNameMap[accId] || accId;

            // Fetch kampanye aktif hari ini
            const url = `https://graph.facebook.com/v19.0/${accId}/campaigns` +
              `?access_token=${META_TOKEN}` +
              `&fields=id,name,status,insights.date_preset(today){spend,actions,impressions,clicks}` +
              `&filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE"]}]` +
              `&limit=30`;

            const campRes = await fetch(url);
            const campData = await campRes.json();
            if (campData.error || !campData.data?.length) continue;

            const scale = [], kill = [], pantau = [];

            for (const camp of campData.data) {
              const ins = camp.insights?.data?.[0];
              if (!ins) continue;
              const spend = parseFloat(ins.spend || 0);
              if (spend <= 0) continue;

              const hasil = parseInt((ins.actions || []).find(a =>
                ['web_in_store_purchase','omni_purchase','offsite_conversion.fb_pixel_purchase',
                 'lead','onsite_conversion.lead_grouped'].includes(a.action_type)
              )?.value || 0);
              const cpr = hasil > 0 ? Math.round(spend / hasil) : 0;
              const impresi = parseInt(ins.impressions || 0);
              const klik = parseInt(ins.clicks || 0);
              const info = { name: camp.name, spend, hasil, cpr, impresi, klik };

              if (hasil > 0 && cpr < 150000) scale.push(info);
              else if (spend > 50000 && hasil === 0) kill.push(info);
              else pantau.push(info);
            }

            if (scale.length || kill.length || pantau.length) {
              akunReports.push({ namaAkun, scale, kill, pantau });
            }
          } catch(e) {
            console.error('Error fetch account', accId, e.message);
          }
        }

        if (!akunReports.length) continue;

        // Susun pesan WA
        let pesan = `📊 *Laporan Iklan Hari Ini*\n`;
        pesan += `🕐 ${jamStr} | ${tanggalStr}\n`;
        pesan += `👤 Halo, *${adv.pic_name || adv.name}*!\n`;
        pesan += `_(Data dari jam 00.00 s/d ${jamStr})_\n`;

        for (const akun of akunReports) {
          pesan += `\n━━━━━━━━━━━━━━━━\n`;
          pesan += `🏢 *${akun.namaAkun}*\n`;
          pesan += `━━━━━━━━━━━━━━━━\n`;

          if (akun.scale.length > 0) {
            pesan += `\n✅ *BAGUS - Bisa Scale:*\n`;
            akun.scale.forEach(c => {
              pesan += `▸ *${c.name}*\n`;
              pesan += `   💰 Spend: ${fmtRp(c.spend)}\n`;
              pesan += `   🎯 Hasil: ${c.hasil} | CPR: ${fmtRp(c.cpr)}\n`;
              pesan += `   👁 Impresi: ${fmtNum(c.impresi)} | Klik: ${fmtNum(c.klik)}\n`;
            });
          }

          if (akun.kill.length > 0) {
            pesan += `\n❌ *KILL - Tidak Ada Hasil:*\n`;
            akun.kill.forEach(c => {
              pesan += `▸ *${c.name}*\n`;
              pesan += `   💰 Spend: ${fmtRp(c.spend)} | Hasil: 0\n`;
            });
          }

          if (akun.pantau.length > 0) {
            pesan += `\n⚠️ *Perlu Dipantau:*\n`;
            akun.pantau.forEach(c => {
              pesan += `▸ ${c.name}\n`;
              pesan += `   Spend: ${fmtRp(c.spend)} | Hasil: ${c.hasil}\n`;
            });
          }
        }

        pesan += `\n_AdMonitor · Herbal Jaya_`;

        const waResult = await kirimWA(adv.pic_phone, pesan);
        allResults.push({ user: uc.user_id, advertiser: adv.name, phone: adv.pic_phone, status: waResult });
      }
    }

    // Log
    try {
      await sb.from('wa_logs').insert({
        sent_at: new Date().toISOString(),
        jam_wib: jamWIB,
        total_sent: allResults.length,
        detail: JSON.stringify(allResults)
      });
    } catch(e) {}

    return res.json({ success: true, sent: allResults.length, results: allResults, jamWIB, today });

  } catch(e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
};

async function kirimWA(nomor, pesan) {
  try {
    const phone = nomor.replace(/\D/g, '');
    const resp = await fetch('https://api.fonnte.com/send', {
      method: 'POST',
      headers: { 'Authorization': process.env.FONNTE_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify({ target: phone, message: pesan, countryCode: '62' })
    });
    const r = await resp.json();
    return r.status ? 'sent' : ('failed: ' + (r.reason || JSON.stringify(r)));
  } catch(e) {
    return 'error: ' + e.message;
  }
}

function formatTanggal(wib) {
  const hari = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const bln = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Ags','Sep','Okt','Nov','Des'];
  return `${hari[wib.getUTCDay()]}, ${wib.getUTCDate()} ${bln[wib.getUTCMonth()]} ${wib.getUTCFullYear()}`;
}

function fmtRp(n) { return 'Rp' + Math.round(n).toLocaleString('id-ID'); }
function fmtNum(n) { return parseInt(n).toLocaleString('id-ID'); }
