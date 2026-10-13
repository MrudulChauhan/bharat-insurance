import { swapinsurer, envReady } from '../_swapinsurer.mjs';

// HDFC "get policy PDF" proxy -> POST /partner/policyPdf/getpolicypdf.
// Uses PascalCase field names (PolicyNo, Module, RefNo, Transid) plus the
// deliberately-misspelled `covertType` field per the vendor doc.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const body = req.body || {};
  if (!body.PolicyNo || !body.RefNo) {
    return res.status(400).json({ error: 'body must include PolicyNo and RefNo (from Get Policy After Payment)' });
  }
  if (!envReady()) {
    return res.status(500).json({ error: 'Swapinsurer credentials not configured' });
  }
  try {
    const r = await swapinsurer('/partner/policyPdf/getpolicypdf', {
      method: 'POST',
      body,
      insurer: 'HDFC',
    });
    if (!r.ok) return res.status(r.status).json({ error: r.data ?? 'upstream error' });
    return res.status(200).json(r.data);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}
