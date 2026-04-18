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

  // Fetch thumbnail dengan timeout pendek (4 detik)
  let imageBlock = null;
  if (thumbnail_url) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
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
      // Gambar gagal, lanjut tanpa gambar
    }
  }

  const badgeLabel = badge === 'winner' ? '🏆 Winner' : badge === 'underperform' ? '🔴 Underperform' : '⚠️ Average';

  const systemPrompt = `Kamu adalah creative strategist dan visual analyst untuk Meta Ads, spesialis pasar Indonesia.
Kamu ahli mengevaluasi konten iklan secara visual dan mengidentifikasi elemen yang membuat iklan perform bagus atau buruk.
Yang kamu perhatikan: hook visual, kejelasan produk, text overlay, social proof, CTA visual, warna & kontras, emosi & relevansi untuk audience Indonesia.
Berikan analisis praktis dan actionable dalam Bahasa Indonesia.`;

  const metricsSummary = `Spend: Rp${Math.round(spend||0).toLocaleString('id-ID')} | Hasil: ${hasil||0} | CPR: ${cpr>0?'Rp'+Math.round(cpr).toLocaleString('id-ID'):'–'} | CTR: ${parseFloat(ctr||0).toFixed(2)}% | Freq: ${parseFloat(frequency||0).toFixed(1)} | Status: ${badgeLabel}`;

  const conciseNote = '\n\nPenting: Setiap bagian maksimal 3 kalimat. Langsung ke poin, tidak perlu intro.';

  const textPrompt = imageBlock
    ? `Analisis iklan Meta Ads ini:\nNama: ${ad_name}\nData: ${metricsSummary}\n\nLihat gambarnya, jawab 4 bagian berikut:${conciseNote}\n\n**🖼️ Analisis Visual**\nHook, produk, teks overlay, warna — apa yang kamu lihat?\n\n**✅ Yang Bekerja**\nElemen visual yang berkontribusi pada performa ${badge === 'winner' ? 'bagus' : 'ini'}.\n\n**⚠️ Kelemahan Visual**\n${badge === 'winner' ? 'Apa yang masih bisa ditingkatkan?' : 'Masalah visual utama penyebab performa rendah.'}\n\n**✏️ Brief Konten Baru**\nBackground, posisi produk, teks overlay, tone warna — spesifik untuk desainer.`
    : `Analisis iklan Meta Ads ini (tanpa gambar):\nNama: ${ad_name}\nData: ${metricsSummary}\n\nJawab 3 bagian berikut:${conciseNote}\n\n**📊 Diagnosa dari Data**\nApa yang metrik ini ceritakan tentang kreativnya?\n\n**⚠️ Kemungkinan Masalah Visual**\nBerdasarkan CTR dan CPR, masalah visual yang kemungkinan terjadi?\n\n**✏️ Brief Konten Baru**\nBackground, posisi produk, teks overlay, tone warna — spesifik untuk desainer.`;

  const contentBlocks = imageBlock
    ? [imageBlock, { type: 'text', text: textPrompt }]
    : [{ type: 'text', text: textPrompt }];

  // Streaming response via SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  // Kirim has_image info dulu
  res.write(`data: ${JSON.stringify({ meta: { has_image: !!imageBlock } })}\n\n`);

  try {
    const client = new Anthropic({ apiKey });
    const stream = client.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: contentBlocks }]
    });

    for await (const event of stream) {
      if (event.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ text: event.delta.text })}\n\n`);
      }
    }
    res.write(`data: [DONE]\n\n`);
    res.end();
  } catch (e) {
    res.write(`data: ${JSON.stringify({ error: e.message })}\n\n`);
    res.end();
  }
};
