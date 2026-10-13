import { swapinsurer, envReady } from '../_swapinsurer.mjs';

// Two-wheeler Create Proposal proxy -> POST /partner/bike/getbikeproposal.
// Used by both HDFC (Insurer: HDFC) and Digit (Insurer: DIGIT). Body shape:
//   HDFC:  { quote, bikeAddons, quoteResponseBike, proposal }
//   Digit: same shape; proposal uses the "Digit" set of fields per their doc.
// Frontend selects insurer via ?insurer=HDFC|DIGIT or body.insurer; defaults
// to HDFC for backward compatibility.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const body = req.body || {};
  if (!body.proposal || !body.quote || !body.bikeAddons) {
    return res.status(400).json({ error: 'body must have { quote, bikeAddons, quoteResponseBike, proposal }' });
  }
  if (!envReady()) {
    return res.status(500).json({ error: 'Swapinsurer credentials not configured' });
  }
  const insurerIn = String((req.query && req.query.insurer) || body.insurer || 'HDFC').toUpperCase();
  const insurer = insurerIn === 'DIGIT' ? 'DIGIT' : 'HDFC';
  try {
    const { insurer: _drop, ...upstreamBody } = body;
    const r = await swapinsurer('/partner/bike/getbikeproposal', {
      method: 'POST',
      body: upstreamBody,
      insurer,
    });
    if (!r.ok) return res.status(r.status).json({ error: r.data ?? 'upstream error' });
    return res.status(200).json(r.data);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}
