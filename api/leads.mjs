import { put, list } from '@vercel/blob';

const PATH = 'data/leads.json';

async function readAll() {
  try {
    const { blobs } = await list({ prefix: PATH, limit: 1 });
    if (!blobs.length) return [];
    const r = await fetch(blobs[0].url, { cache: 'no-store' });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch {
    return [];
  }
}

async function writeAll(arr) {
  await put(PATH, JSON.stringify(arr), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
  });
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const b = req.body || {};
      const mobile = String(b.mobile || '');
      if (!/^[6-9]\d{9}$/.test(mobile)) return res.status(400).json({ error: 'invalid mobile' });
      const arr = await readAll();
      arr.push({
        line: String(b.line || ''),
        vtype: String(b.vtype || ''),
        reg: String(b.reg || ''),
        mobile,
        premium: Number(b.premium) || 0,
        ts: new Date().toISOString(),
      });
      await writeAll(arr);
      return res.status(200).json({ ok: true, count: arr.length });
    }

    // GET / DELETE require the admin passcode
    const pass = (req.query && req.query.pass) || req.headers['x-admin-pass'];
    if (pass !== process.env.ADMIN_PASS) return res.status(401).json({ error: 'unauthorized' });

    if (req.method === 'GET') return res.status(200).json({ leads: await readAll() });
    if (req.method === 'DELETE') { await writeAll([]); return res.status(200).json({ ok: true }); }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
