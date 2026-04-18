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

  try {
    const client = new Anthropic({ apiKey });

    const prompt = `Kamu adalah analis iklan digital Meta Ads berpengalaman. Analisis data kampanye berikut dan berikan insight dalam Bahasa Indonesia yang singkat, padat, dan actionable.

Data Kampanye:
- Nama: ${campaign.name}
- Status: ${campaign.status || 'N/A'}
- Objective: ${campaign.objective || 'N/A'}
- Spend: Rp${Math.round(campaign.spend || 0).toLocaleString('id-ID')}
- Hasil: ${campaign.hasil || 0}
- CPR: ${campaign.cpr > 0 ? 'Rp' + Math.round(campaign.cpr).toLocaleString('id-ID') : '0 (belum ada hasil)'}
- CTR: ${(campaign.ctr || 0).toFixed ? (campaign.ctr || 0).toFixed(2) : campaign.ctr}%
- Impressi: ${(campaign.impressions || 0).toLocaleString('id-ID')}
- Klik: ${(campaign.clicks || 0).toLocaleString('id-ID')}

Berikan analisis dalam format berikut (gunakan **bold** untuk heading):

**🔍 Diagnosa Performa**
[1-2 kalimat tentang kondisi kampanye saat ini — bagus/sedang/buruk dan kenapa]

**📋 Rekomendasi Spesifik**
[2-3 poin actionable: scale up / pause / ganti konten / perluas audience / dll]

**📈 Estimasi Dampak**
[1-2 kalimat estimasi hasil jika rekomendasi dijalankan]

Jawab singkat dan spesifik. Jangan bertele-tele.`;

    const message = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      messages: [{ role: 'user', content: prompt }]
    });

    const insight = message.content[0]?.text || 'Tidak ada respons dari AI';
    return res.json({ insight });

  } catch (e) {
    console.error('AI insight error:', e);
    return res.status(500).json({ error: e.message });
  }
};
