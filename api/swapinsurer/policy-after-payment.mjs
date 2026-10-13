import { swapinsurer, envReady } from '../_swapinsurer.mjs';

// Post-payment proxy. Dispatches to the right upstream path based on insurer
// + module, per the respective vendor doc:
//
//   HDFC (car | bike): POST /partner/motor/getpolicyafterpayment
//     body.paramater uses PascalCase for bike (TransactionID / ProposalNumber /
//     Amount) and lowerCamel for car (transactionID / proposalNumber / amount).
//
//   Digit car:  POST /partner/motor/getresponseafterpayment
//   Digit bike: POST /partner/policygenerate/getpolicyafterpayment
//     body.paramater carries { paymentororkycLink, insurerName, errorStatus,
//     errorMessage, enquiryID, applicationId, refProposal, module, transId,
//     callbackurl }.
//
// Called from payment/return.html after the gateway redirects back. Insurer
// comes from ?insurer=HDFC|DIGIT (default HDFC) and module from
// ?module=car|bike (default car). The body is passed through unchanged.
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });
  const body = req.body || {};
  if (!body.paramater || typeof body.paramater !== 'object') {
    return res.status(400).json({ error: 'body must have a `paramater` object (note the doc spelling)' });
  }
  if (!envReady()) {
    return res.status(500).json({ error: 'Swapinsurer credentials not configured' });
  }
  const insurerIn = String((req.query && req.query.insurer) || body.insurer || 'HDFC').toUpperCase();
  const insurer = insurerIn === 'DIGIT' ? 'DIGIT' : 'HDFC';
  const moduleIn = String((req.query && req.query.module) || body.module || 'car').toLowerCase();

  let path;
  if (insurer === 'DIGIT' && moduleIn === 'bike') {
    path = '/partner/policygenerate/getpolicyafterpayment';
  } else if (insurer === 'DIGIT') {
    path = '/partner/motor/getresponseafterpayment';
  } else {
    path = '/partner/motor/getpolicyafterpayment';
  }

  try {
    const r = await swapinsurer(path, {
      method: 'POST',
      body,
      insurer,
    });
    if (!r.ok) return res.status(r.status).json({ error: r.data ?? 'upstream error' });
    return res.status(200).json(r.data);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}
