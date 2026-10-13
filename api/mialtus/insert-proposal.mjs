import { makeRoute } from '../_mialtus.mjs';

// MIALTUS "Insert Proposal" proxy — Digit flow API 1.
//   POST /partner/motor/insertcarproposal  (?type=car)
//   POST /partner/motor/insertbikeproposal (?type=bike)
// Body: { quote, carAddons|bikeAddons, carQuoteResponse|quoteResponseBike, proposal }.
// Must be called BEFORE getcarproposal / getbikeproposal with Insurer:DIGIT —
// saves the proposal against the quote transaction. For HDFC we don't call
// this step: HDFC's getcarproposal / getbikeproposal doesn't require a prior
// insertproposal.
export default async function handler(req, res) {
  const type = String((req.query && req.query.type) || '').toLowerCase();
  if (type !== 'car' && type !== 'bike') {
    return res.status(400).json({ error: 'query ?type=car|bike is required' });
  }
  const isCar = type === 'car';
  const route = makeRoute({
    method: 'POST',
    path: isCar ? '/partner/motor/insertcarproposal' : '/partner/motor/insertbikeproposal',
    validate: (r) => {
      const b = r.body || {};
      const addonsKey = isCar ? 'carAddons' : 'bikeAddons';
      const quoteRespKey = isCar ? 'carQuoteResponse' : 'quoteResponseBike';
      if (!b.quote || !b[addonsKey] || !b[quoteRespKey] || !b.proposal) {
        return `body must have { quote, ${addonsKey}, ${quoteRespKey}, proposal }`;
      }
      return null;
    },
  });
  return route(req, res);
}
