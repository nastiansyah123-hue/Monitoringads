// api/send-wa.js
// Vercel Serverless Function — dipanggil oleh cron job
// Ambil data dari Supabase → analisa kampanye → kirim WA via Fonnte

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY; // service role key (bukan anon)
const FONNTE_TOKEN = process.env.FONNTE_TOKEN;
const META_TOKEN = process.env.META_TOKEN;

module.exports = async function handler(req, res) {
  // Verifikasi request dari cron Vercel
  const authHeader = req.headers['authorization'];
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  try {
    const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

    // 1. Ambil semua advertiser + akun mereka
    const { data: advertisers, error } = await sb
      .from('advertisers')
      .select('*');

    if (error) throw new Error('Supabase error: ' + error.message);
    if (!advertisers?.length) return res.json({ sent: 0, message: 'No advertisers' });

    const results = [];
    const now = new Date();
    const jam = now.getHours(); // jam lokal server (UTC, perlu +7 untuk WIB)
    const jamWIB = (jam + 7) % 24;

    for (const adv of advertisers) {
      if (!adv.pic_phone) continue;

      const accounts = JSON.parse(adv.accounts || '[]');
      if (!accounts.length) continue;

      // 2. Fetch insights per akun dari Meta API
      const today = getToday();
      const messages = [];

      for (const accId of accounts) {
        try {
          // Fetch kampanye + insights hari ini
          const campRes = await fetch(
            `https://graph.facebook.com/v19.0/${accId}/campaigns?` +
            `access_token=${META_TOKEN}&` +
            `fields=id,name,status,insights{spend,actions,cpm,cpc}&` +
            `time_range={"since":"${today}","until":"${today}"}&` +
            `limit=10`
          );
          const campData = await campRes.json();
          if (campData.error || !campData.data?.length) continue;

          // Analisa kampanye
          const scale = [];
          const kill = [];

          for (const camp of campData.data) {
            if (camp.status !== 'ACTIVE') continue;
            const ins = camp.insights?.data?.[0];
            if (!ins) continue;

            const spend = parseFloat(ins.spend || 0);
            const leads = (ins.actions || []).find(a =>
              ['web_in_store_purchase','omni_purchase','lead'].includes(a.action_type)
            );
            const hasil = parseInt(leads?.value || 0);
            const cpr = hasil > 0 ? Math.round(spend / hasil) : 0;

            // Logika sederhana: CPR bagus = scale, tidak ada hasil = kill
            if (hasil > 0 && cpr > 0 && cpr < 100000) {
              scale.push({ name: camp.name, spend: fmtRp(spend), hasil, cpr: fmtRp(cpr) });
            } else if (spend > 50000 && hasil === 0) {
              kill.push({ name: camp.name, spend: fmtRp(spend) });
            }
          }

          if (scale.length || kill.length) {
            // Ambil nama akun dari Supabase
            const { data: accData } = await sb
              .from('ad_accounts')
              .select('account_name')
              .eq('ad_account_id', accId)
              .single();

            const accName = accData?.account_name || accId;
            let msg = `📊 *Update Iklan - ${accName}*\n`;
            msg += `🕐 ${formatJam(jamWIB)} WIB, ${formatTanggal(now)}\n\n`;

            if (scale.length) {
              msg += `✅ *SCALE (Performa Bagus):*\n`;
              scale.forEach(c => {
                msg += `▸ ${c.name}\n  Spend: ${c.spend} | Hasil: ${c.hasil} | CPR: ${c.cpr}\n`;
              });
              msg += '\n';
            }

            if (kill.length) {
              msg += `❌ *KILL (Tidak Ada Hasil):*\n`;
              kill.forEach(c => {
                msg += `▸ ${c.name}\n  Spend: ${c.spend} | Hasil: 0\n`;
              });
            }

            messages.push(msg);
          }
        } catch (e) {
          console.error('Error fetch account', accId, e.message);
        }
      }

      // 3. Kirim WA via Fonnte
      if (messages.length) {
        const fullMessage = messages.join('\n─────────────────\n');
        const waResult = await kirimWA(adv.pic_phone, fullMessage);
        results.push({ advertiser: adv.name, phone: adv.pic_phone, status: waResult });
      }
    }

    // 4. Log ke Supabase
    await sb.from('wa_logs').insert({
      sent_at: new Date().toISOString(),
      jam_wib: jamWIB,
      total_sent: results.length,
      detail: JSON.stringify(results)
    }).catch(() => {});

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
      headers: {
        'Authorization': FONNTE_TOKEN,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        target: phone,
        message: pesan,
        countryCode: '62'
      })
    });
    const result = await resp.json();
    return result.status ? 'sent' : ('failed: ' + result.reason);
  } catch (e) {
    return 'error: ' + e.message;
  }
}

function getToday() {
  const d = new Date();
  d.setHours(d.getHours() + 7); // UTC ke WIB
  return d.toISOString().split('T')[0];
}

function formatJam(h) {
  return String(h).padStart(2, '0') + '.00';
}

function formatTanggal(d) {
  const hari = ['Minggu','Senin','Selasa','Rabu','Kamis','Jumat','Sabtu'];
  const bln = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Ags','Sep','Okt','Nov','Des'];
  return `${hari[d.getDay()]}, ${d.getDate()} ${bln[d.getMonth()]} ${d.getFullYear()}`;
}

function fmtRp(n) {
  return 'Rp' + Math.round(n).toLocaleString('id-ID');
}
