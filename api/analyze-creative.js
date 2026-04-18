const Anthropic = require('@anthropic-ai/sdk');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { thumbnail_url, ad_name, spend, hasil, cpr, ctr, impressions, clicks, frequency, badge } = req.body;
  if (!ad_name) return res.status(400).json({ error: 'ad_name required' });

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY belum diset' });

  const hasImage = !!thumbnail_url;
  let imageBlock = null;

  // Coba fetch thumbnail dan konvert ke base64
  if (hasImage) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      const imgRes = await fetch(thumbnail_url, { signal: controller.signal });
      clearTimeout(timeout);

      if (imgRes.ok) {
        const buffer = await imgRes.arrayBuffer();
        const base64 = Buffer.from(buffer).toString('base64');
        const contentType = imgRes.headers.get('content-type') || 'image/jpeg';
        const mediaType = contentType.startsWith('image/') ? contentType.split(';')[0] : 'image/jpeg';
        imageBlock = { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } };
      }
    } catch (e) {
      console.warn('Thumbnail fetch failed, proceeding text-only:', e.message);
    }
  }

  const badgeLabel = badge === 'winner' ? '🏆 Winner' : badge === 'underperform' ? '🔴 Underperform' : '⚠️ Average';
  const metricsSummary = `
- Spend: Rp${Math.round(spend || 0).toLocaleString('id-ID')}
- Hasil: ${hasil || 0}
- CPR: ${cpr > 0 ? 'Rp' + Math.round(cpr).toLocaleString('id-ID') : 'belum ada hasil'}
- CTR: ${parseFloat(ctr || 0).toFixed(2)}%
- Impresi: ${(impressions || 0).toLocaleString('id-ID')}
- Klik: ${(clicks || 0).toLocaleString('id-ID')}
- Frequency: ${parseFloat(frequency || 0).toFixed(1)}
- Status performa: ${badgeLabel}`;

  const systemPrompt = `Kamu adalah creative strategist dan visual analyst untuk Meta Ads, spesialis pasar Indonesia.
Kamu ahli mengevaluasi konten iklan secara visual dan mengidentifikasi elemen yang membuat iklan perform bagus atau buruk.

Yang kamu perhatikan saat analisis visual:
- Hook visual: apakah gambar langsung menarik perhatian dalam 1–2 detik?
- Kejelasan produk: produk terlihat jelas dan menarik?
- Text overlay: ada headline/promo yang terbaca dengan mudah?
- Social proof: ada testimoni, angka, bintang rating, atau endorser?
- CTA visual: ada elemen yang mendorong action (panah, tombol, sticker)?
- Warna & kontras: apakah warna menarik perhatian atau justru membosankan?
- Emosi & relevansi: apakah visual memunculkan emosi yang tepat untuk target audience Indonesia?

Berikan analisis dalam Bahasa Indonesia yang praktis dan actionable.`;

  const textPrompt = imageBlock
    ? `Analisis konten iklan Meta Ads berikut secara visual dan berdasarkan performanya:

**Nama Ad:** ${ad_name}
**Data Performa:**${metricsSummary}

Lihat gambarnya dan berikan analisis lengkap dalam format berikut:

**🖼️ Analisis Visual**
Jelaskan apa yang kamu lihat: hook visual, kejelasan produk, text overlay, komposisi, warna. Spesifik ke detail gambar yang kamu lihat.

**✅ Elemen yang Bekerja**
${badge === 'winner' ? '2–3 elemen visual yang kemungkinan besar berkontribusi pada performa bagus ini.' : badge === 'underperform' ? 'Kalau ada, sebutkan 1–2 elemen yang masih oke.' : '1–2 elemen yang cukup oke.'}

**⚠️ Kelemahan Visual**
${badge === 'winner' ? 'Kalau ada, apa yang masih bisa ditingkatkan?' : '2–3 masalah visual utama yang kemungkinan menyebabkan performa rendah.'}

**✏️ Brief Konten Baru**
Deskripsikan konten baru yang harus dibuat tim kreatif berdasarkan analisis ini. Spesifik: background, posisi produk, teks overlay apa, elemen tambahan apa, tone warna. Buat dalam format brief yang bisa langsung diberikan ke desainer.`

    : `Analisis konten iklan Meta Ads berikut berdasarkan performanya (gambar tidak tersedia):

**Nama Ad:** ${ad_name}
**Data Performa:**${metricsSummary}

Berikan rekomendasi dalam format berikut:

**📊 Diagnosa dari Data**
Apa yang data metrik ini ceritakan tentang kreativnya? (CTR tinggi/rendah = signal apa untuk visual)

**⚠️ Kemungkinan Masalah Visual**
Berdasarkan pattern data (CTR, CPR, frequency), apa masalah visual yang kemungkinan terjadi?

**✏️ Brief Konten Baru**
Deskripsikan konten baru yang direkomendasikan. Spesifik: background, posisi produk, teks overlay, elemen tambahan, tone warna. Format yang bisa langsung diberikan ke desainer.`;

  try {
    const client = new Anthropic({ apiKey });

    const contentBlocks = imageBlock
      ? [imageBlock, { type: 'text', text: textPrompt }]
      : [{ type: 'text', text: textPrompt }];

    const message = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 1500,
      system: systemPrompt,
      messages: [{ role: 'user', content: contentBlocks }]
    });

    const analysis = message.content[0]?.text || 'Tidak ada respons dari AI';
    return res.json({ analysis, has_image: !!imageBlock });

  } catch (e) {
    console.error('Creative analysis error:', e);
    return res.status(500).json({ error: e.message });
  }
};
