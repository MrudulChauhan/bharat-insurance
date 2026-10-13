import { swapinsurer, envReady } from '../_swapinsurer.mjs';

// Four-wheeler Create Proposal proxy -> POST /partner/motor/getcarproposal.
// Used by both HDFC (Insurer: HDFC) and Digit (Insurer: DIGIT) — same path,
// different Insurer header. The frontend passes ?insurer=HDFC|DIGIT or
// body.insurer; defaults to HDFC for backward compatibility. Body shape per
// the respective vendor doc:
//   HDFC: { quote, carAddons, carQuoteResponse, proposal }
//   Digit: same shape + proposal.callbackurl (customer-return after KYC)
// We pass the body through unchanged so the frontend owns the payload shape.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const body = req.body || {};
  if (!body.proposal || !body.quote || !body.carAddons) {
    return res.status(400).json({ error: 'body must have { quote, carAddons, carQuoteResponse, proposal }' });
  }
  if (!envReady()) {
    return res.status(500).json({ error: 'Swapinsurer credentials not configured' });
  }
  const insurerIn = String((req.query && req.query.insurer) || body.insurer || 'HDFC').toUpperCase();
  const insurer = insurerIn === 'DIGIT' ? 'DIGIT' : 'HDFC';
  try {
    const { insurer: _drop, ...upstreamBody } = body;
    const r = await swapinsurer('/partner/motor/getcarproposal', {
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
