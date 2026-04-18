const Anthropic = require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { campaign } = req.body;
  if (!campaign) return res.status(400).json({ error: 'campaign data required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY belum diset' });

  const spend   = Math.round(campaign.spend  || 0);
  const hasil   = campaign.hasil   || 0;
  const cpr     = campaign.cpr     || 0;
  const ctr     = parseFloat(campaign.ctr || 0);
  const impresi = campaign.impressions || 0;
  const klik    = campaign.clicks  || 0;

  // Hitung CPC manual jika ada
  const cpc = klik > 0 ? Math.round(spend / klik) : 0;
  // Landing page rate estimasi dari CTR
  const ctrLabel = ctr >= 3 ? 'tinggi (bagus)' : ctr >= 1.5 ? 'normal' : ctr > 0 ? 'rendah' : 'belum ada data';

  const systemPrompt = `Kamu adalah media buyer Meta Ads berpengalaman 5+ tahun, spesialis pasar Indonesia.
Kamu terbiasa menganalisis kampanye iklan untuk produk consumer goods, herbal, health, dan e-commerce Indonesia.
Benchmark umum pasar Indonesia yang kamu pakai:
- CTR bagus: > 2%, normal: 1–2%, buruk: < 1%
- CPR bagus tergantung produk, tapi secara umum < Rp50.000 untuk lead, < Rp150.000 untuk purchase produk consumer
- Frequency > 2.5 mulai jenuh, > 3.5 perlu rotasi konten segera
- Spend > Rp50.000 tanpa hasil = sinyal kuat untuk di-pause atau diganti konten
- CTR tinggi tapi konversi rendah = masalah di landing page atau penawaran, bukan di iklan

Gaya analisis:
- Jujur dan to-the-point, tidak perlu basa-basi
- Berikan rekomendasi yang spesifik dan bisa langsung dieksekusi
- Kalau data menunjukkan performa buruk, bilang dengan jelas
- Gunakan angka dari data yang diberikan dalam analisis`;

  const userPrompt = `Analisis kampanye Meta Ads berikut:

**Nama:** ${campaign.name}
**Objective:** ${campaign.objective || 'tidak diketahui'}
**Status:** ${campaign.status || 'N/A'}

**Metrik Performa:**
| Metrik | Nilai |
|--------|-------|
| Spend | Rp${spend.toLocaleString('id-ID')} |
| Hasil (konversi) | ${hasil} |
| CPR (Cost per Result) | ${cpr > 0 ? 'Rp' + cpr.toLocaleString('id-ID') : 'belum ada hasil'} |
| CTR | ${ctr.toFixed(2)}% (${ctrLabel}) |
| Impresi | ${impresi.toLocaleString('id-ID')} |
| Klik | ${klik.toLocaleString('id-ID')} |
| CPC | ${cpc > 0 ? 'Rp' + cpc.toLocaleString('id-ID') : '–'} |

Berikan analisis dalam format berikut. Isi setiap bagian dengan konten yang berguna, bukan placeholder:

**🔍 Diagnosa Performa**
Jelaskan kondisi kampanye ini: apakah performanya bagus, sedang, atau buruk? Sebutkan metrik mana yang jadi indikator utama dan kenapa.

**⚠️ Masalah Utama**
Identifikasi 1-2 masalah terbesar berdasarkan data. Kalau tidak ada masalah, sebutkan risiko yang perlu diwaspadai.

**✅ Rekomendasi Aksi**
Berikan 3 rekomendasi konkret yang bisa langsung dieksekusi hari ini. Format: nomor + aksi + alasan singkat.

**📈 Proyeksi**
Jika rekomendasi dijalankan, estimasi perubahan performa yang bisa dicapai (gunakan angka yang realistis).`;

  try {
    const client = new Anthropic({ apiKey });

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }]
    });

    const insight = message.content[0]?.text || 'Tidak ada respons dari AI';
    return res.json({ insight });

  } catch (e) {
    console.error('AI insight error:', e);
    return res.status(500).json({ error: e.message });
  }
};
