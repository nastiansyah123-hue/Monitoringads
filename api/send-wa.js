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

    // Waktu WIB
    const now = new Date();
    const nowWIB = new Date(now.getTime() + 7 * 3600 * 1000);
    const jamWIB = nowWIB.getUTCHours();
    const menitWIB = String(nowWIB.getUTCMinutes()).padStart(2,'0');
    const jamStr = `${String(jamWIB).padStart(2,'0')}.${menitWIB} WIB`;
    const y = nowWIB.getUTCFullYear();
    const m = String(nowWIB.getUTCMonth()+1).padStart(2,'0');
    const d = String(nowWIB.getUTCDate()).padStart(2,'0');
    const today = `${y}-${m}-${d}`;
    const tanggalStr = formatTanggal(nowWIB);

    // 1. Ambil semua user config (token Meta + info SPV)
    const { data: userConfigs, error: ucErr } = await sb
      .from('user_config')
      .select('user_id, meta_token, spv_name, spv_phone, wa_jadwal');

    if (ucErr) throw new Error('user_config error: ' + ucErr.message);
    if (!userConfigs?.length) return res.json({ sent: 0, message: 'No user configs' });

    const allResults = [];

    // 2. Proses per admin
    for (const uc of userConfigs) {
      if (!uc.meta_token) continue;

      // Cek apakah jam sekarang ada di jadwal user ini
      const jadwalUser = (uc.wa_jadwal || '9,14,18,21')
        .split(',').map(j => parseInt(j.trim())).filter(j => !isNaN(j));
      
      if (!jadwalUser.includes(jamWIB)) {
        console.log(`User ${uc.user_id}: jam ${jamWIB} bukan jadwal (${jadwalUser.join(',')}), skip`);
        continue; // Skip user ini kalau bukan waktunya
      }

      console.log(`User ${uc.user_id}: jam ${jamWIB} sesuai jadwal, kirim WA...`);

      const META_TOKEN = uc.meta_token;

      // Ambil advertisers milik admin ini
      const { data: advertisers } = await sb
        .from('advertisers')
        .select('*')
        .eq('user_id', uc.user_id);

      if (!advertisers?.length) continue;

      // Ambil nama akun dari Meta API
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

      // Kumpulkan data semua akun admin ini untuk SPV
      const semuaAkunSPV = [];

      // 3. Proses per advertiser → kirim WA ke advertiser
      for (const adv of advertisers) {
        if (!adv.pic_phone) continue;
        const accounts = JSON.parse(adv.accounts || '[]');
        if (!accounts.length) continue;

        const akunReports = [];

        for (const accId of accounts) {
          try {
            const namaAkun = accNameMap[accId] || accId;
            const url = `https://graph.facebook.com/v19.0/${accId}/campaigns` +
              `?access_token=${META_TOKEN}` +
              `&fields=id,name,status,insights.date_preset(today){spend,actions,impressions,clicks}` +
              `&filtering=[{"field":"effective_status","operator":"IN","value":["ACTIVE"]}]` +
              `&limit=30`;

            const campRes = await fetch(url);
            const campData = await campRes.json();
            if (campData.error || !campData.data?.length) continue;

            const scale = [], kill = [], pantau = [];
            let totalSpendAkun = 0, totalHasilAkun = 0;

            for (const camp of campData.data) {
              const ins = camp.insights?.data?.[0];
              if (!ins) continue;
              const spend = parseFloat(ins.spend || 0);
              if (spend <= 0) continue;

              const hasil = parseInt((ins.actions || []).find(a =>
                ['web_in_store_purchase','omni_purchase','offsite_conversion.fb_pixel_purchase',
                 'lead','onsite_conversion.lead_grouped','onsite_web_lead','onsite_conversion.lead','offsite_conversion.fb_pixel_lead','onsite_web_app_purchase','web_app_in_store_purchase','onsite_web_purchase','purchase','onsite_conversion.messaging_first_reply','onsite_conversion.messaging_conversation_started_7d','onsite_conversion.total_messaging_connection','onsite_conversion.messaging_user_depth_2_message_send'].includes(a.action_type)
              )?.value || 0);
              const cpr = hasil > 0 ? Math.round(spend / hasil) : 0;
              const impresi = parseInt(ins.impressions || 0);
              const klik = parseInt(ins.clicks || 0);
              const info = { name: camp.name, spend, hasil, cpr, impresi, klik };

              totalSpendAkun += spend;
              totalHasilAkun += hasil;

              if (hasil > 0 && cpr < 150000) scale.push(info);
              else if (spend > 50000 && hasil === 0) kill.push(info);
              else pantau.push(info);
            }

            if (scale.length || kill.length || pantau.length) {
              akunReports.push({ namaAkun, scale, kill, pantau });
              // Simpan untuk rekap SPV
              semuaAkunSPV.push({
                namaAkun, namaAdv: adv.name,
                spend: totalSpendAkun, hasil: totalHasilAkun,
                cpr: totalHasilAkun > 0 ? Math.round(totalSpendAkun/totalHasilAkun) : 0,
                scale, kill, pantau
              });
            }
          } catch(e) {
            console.error('Error', accId, e.message);
          }
        }

        if (!akunReports.length) continue;

        // Kirim WA ke advertiser
        let pesan = `📊 *Laporan Iklan Hari Ini*\n`;
        pesan += `🕐 ${jamStr} | ${tanggalStr}\n`;
        pesan += `👤 Halo, *${adv.pic_name || adv.name}*!\n`;
        pesan += `_(Data dari jam 00.00 s/d ${jamStr})_\n`;

        for (const akun of akunReports) {
          pesan += `\n━━━━━━━━━━━━━━━━\n`;
          pesan += `🏢 *${akun.namaAkun}*\n`;
          pesan += `━━━━━━━━━━━━━━━━\n`;
          if (akun.scale.length) {
            pesan += `\n✅ *BAGUS - Bisa Scale:*\n`;
            akun.scale.forEach(c => {
              pesan += `▸ *${c.name}*\n`;
              pesan += `   💰 Spend: ${fmtRp(c.spend)} | 🎯 Hasil: ${c.hasil} | CPR: ${fmtRp(c.cpr)}\n`;
              pesan += `   👁 Impresi: ${fmtNum(c.impresi)} | Klik: ${fmtNum(c.klik)}\n`;
            });
          }
          if (akun.kill.length) {
            pesan += `\n❌ *KILL - Tidak Ada Hasil:*\n`;
            akun.kill.forEach(c => {
              pesan += `▸ *${c.name}*\n`;
              pesan += `   💰 Spend: ${fmtRp(c.spend)} | Hasil: 0\n`;
            });
          }
          if (akun.pantau.length) {
            pesan += `\n⚠️ *Perlu Dipantau:*\n`;
            akun.pantau.forEach(c => {
              pesan += `▸ ${c.name} — Spend: ${fmtRp(c.spend)} | Hasil: ${c.hasil}\n`;
            });
          }
        }
        pesan += `\n_AdMonitor · Herbal Jaya_`;

        const r1 = await kirimWA(adv.pic_phone, pesan);
        allResults.push({ type: 'advertiser', advertiser: adv.name, phone: adv.pic_phone, status: r1 });
      }

      // 4. Kirim rekap ke SPV admin ini (kalau ada SPV)
      if (uc.spv_phone && semuaAkunSPV.length) {
        let totalSpend = 0, totalHasil = 0;
        semuaAkunSPV.forEach(a => { totalSpend += a.spend; totalHasil += a.hasil; });

        let pesanSPV = `📋 *Rekap Iklan - Semua Akun*\n`;
        pesanSPV += `🕐 ${jamStr} | ${tanggalStr}\n`;
        pesanSPV += `👔 Halo, *${uc.spv_name || 'SPV'}*!\n`;
        pesanSPV += `_(Data hari ini s/d ${jamStr})_\n\n`;

        pesanSPV += `📊 *RINGKASAN:*\n`;
        pesanSPV += `Total Akun: ${semuaAkunSPV.length}\n`;
        pesanSPV += `Total Spend: ${fmtRp(totalSpend)}\n`;
        pesanSPV += `Total Hasil: ${totalHasil}\n`;
        pesanSPV += `Avg CPR: ${totalHasil > 0 ? fmtRp(Math.round(totalSpend/totalHasil)) : '-'}\n`;

        const akunBagus = semuaAkunSPV.filter(a => a.scale.length > 0);
        const akunKill = semuaAkunSPV.filter(a => a.kill.length > 0 && a.scale.length === 0);
        const akunPantau = semuaAkunSPV.filter(a => a.pantau.length > 0 && a.scale.length === 0 && a.kill.length === 0);

        if (akunBagus.length) {
          pesanSPV += `\n✅ *BAGUS (${akunBagus.length} akun):*\n`;
          akunBagus.forEach(a => {
            pesanSPV += `▸ *${a.namaAkun}*\n`;
            pesanSPV += `   Spend: ${fmtRp(a.spend)} | Hasil: ${a.hasil} | CPR: ${fmtRp(a.cpr)}\n`;
          });
        }

        if (akunKill.length) {
          pesanSPV += `\n❌ *KILL (${akunKill.length} akun):*\n`;
          akunKill.forEach(a => {
            pesanSPV += `▸ *${a.namaAkun}* — Spend: ${fmtRp(a.spend)}\n`;
          });
        }

        if (akunPantau.length) {
          pesanSPV += `\n⚠️ *DIPANTAU (${akunPantau.length} akun):*\n`;
          akunPantau.forEach(a => {
            pesanSPV += `▸ ${a.namaAkun} — Spend: ${fmtRp(a.spend)}\n`;
          });
        }

        pesanSPV += `\n_AdMonitor · Herbal Jaya_`;

        const r2 = await kirimWA(uc.spv_phone, pesanSPV);
        allResults.push({ type: 'spv', spv: uc.spv_name, phone: uc.spv_phone, status: r2 });
      }
    }

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
