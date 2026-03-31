const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, password, role, admin_user_id } = req.body;
  if (!email || !password || !role || !admin_user_id) {
    return res.status(400).json({ error: 'Email, password, role, admin_user_id wajib diisi' });
  }

  try {
    const sb = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

    // Cek apakah email sudah ada
    const { data: existing } = await sb.auth.admin.listUsers();
    const existingUser = existing?.users?.find(u => u.email?.toLowerCase() === email.toLowerCase());

    let userId;
    if (existingUser) {
      // Email sudah ada, langsung assign role
      userId = existingUser.id;
    } else {
      // Buat akun baru
      const { data: newUser, error: createErr } = await sb.auth.admin.createUser({
        email,
        password,
        email_confirm: true // Langsung aktif tanpa verifikasi email
      });
      if (createErr) return res.status(400).json({ error: createErr.message });
      userId = newUser.user.id;
    }

    // Assign role
    const table = role === 'adv' ? 'adv_users' : 'viewer_users';
    const { error: roleErr } = await sb.from(table).upsert({
      user_id: userId,
      admin_user_id,
      created_at: new Date().toISOString()
    }, { onConflict: 'user_id' });

    if (roleErr) return res.status(500).json({ error: roleErr.message });

    return res.json({ success: true, user_id: userId, email, role, is_new: !existingUser });

  } catch(e) {
    return res.status(500).json({ error: e.message });
  }
};
