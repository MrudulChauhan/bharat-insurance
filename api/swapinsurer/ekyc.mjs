import { swapinsurer, envReady } from '../_swapinsurer.mjs';

// Combined /partner/ekyc/* proxy. Dispatches by ?op=:
//   (default) ekyc              -> POST /partner/ekyc/getekycresponse    (Insurer: HDFC)
//   payment-after-kyc           -> POST /partner/ekyc/getpaymentafterkyc (Insurer: DIGIT)
//
// Default eKYC path handles all documented ekycType scenarios without per-
// scenario branching:
//   1. Pan Number                      (kycPan)                         — Individual
//   2. PAN + DOI                       (kycPan, kycDob)                 — Corporate
//   3. Pan Number web-KYC initiation   (kycPan, ekycNumber, ReturnUrl, domain, ...)
//   4. KYC Id                          (kyc_id)
//   5. KYC Id + Date Of Birth          (kyc_id, kycDob)
//   6. Aadhar Number + Date Of Birth   (kycAadharNo, kycDob)
//   7. CIN + DOI                       (kycCinNo, kycDob)
//   8. CKYC NUMBER + DOI               (ckycNumber, kycDob)
//   9. kyc id (post-web-KYC fetch)     (transID, module, kyc_id)
//
// payment-after-kyc body (Digit, per the Digit Private Car / Bike Proposal docs):
//   { paymentororkycLink, insurerName, errorStatus, errorMessage, enquiryID,
//     applicationId, refProposal, module, transId, callbackurl }
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const body = req.body || {};
  const op = String((req.query && req.query.op) || '').toLowerCase();

  if (!envReady()) {
    return res.status(500).json({
      error: 'Swapinsurer credentials not configured',
      need: ['SWAPINSURER_CLIENT_NAME (or SIMSON_CLIENT_NAME)',
             'SWAPINSURER_USERNAME (or SIMSON_USERNAME)',
             'SWAPINSURER_PASSWORD (or SIMSON_PASSWORD)'],
    });
  }

  // ---- Digit: payment-after-kyc ----
  if (op === 'payment-after-kyc') {
    if (!body.enquiryID || !body.applicationId || !body.refProposal || !body.transId || !body.module) {
      return res.status(400).json({
        error: 'body must have { paymentororkycLink, enquiryID, applicationId, refProposal, module, transId, callbackurl }',
      });
    }
    try {
      const { insurer: _drop, ...upstreamBody } = body;
      const r = await swapinsurer('/partner/ekyc/getpaymentafterkyc', {
        method: 'POST',
        body: upstreamBody,
        insurer: 'DIGIT',
      });
      if (!r.ok) return res.status(r.status).json({ error: r.data ?? 'upstream error' });
      return res.status(200).json(r.data);
    } catch (e) {
      return res.status(502).json({ error: String((e && e.message) || e) });
    }
  }

  // ---- HDFC eKYC (default) ----
  if (!body.ekycType || typeof body.ekycType !== 'string') {
    return res.status(400).json({ error: 'body.ekycType is required' });
  }
  try {
    const { insurer: _drop, ...upstreamBody } = body;
    const r = await swapinsurer('/partner/ekyc/getekycresponse', {
      method: 'POST',
      body: upstreamBody,
      insurer: 'HDFC',
    });
    if (!r.ok) return res.status(r.status).json({ error: r.data ?? 'upstream error' });
    return res.status(200).json(r.data);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}
