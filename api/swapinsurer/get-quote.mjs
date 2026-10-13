import { makeRoute } from '../_swapinsurer.mjs';

// Combined car + bike get-quote proxy - dispatch by ?type=car|bike.
// Insurer code comes from ?insurer=HDFCTP (etc).
export default async function handler(req, res) {
  const type = String((req.query && req.query.type) || '').toLowerCase();
  if (type !== 'car' && type !== 'bike') {
    return res.status(400).json({ error: 'query ?type=car|bike is required' });
  }
  const isCar = type === 'car';
  const route = makeRoute({
    method: 'POST',
    path: isCar ? '/partner/motor/getcarquote' : '/partner/bike/getbikequote',
    validate: (r) => {
      const b = r.body || {};
      const addonsKey = isCar ? 'carAddons' : 'bikeAddons';
      if (!b.quote || !b[addonsKey]) return `body must have { quote, ${addonsKey} }`;
      const insurer = (r.query && r.query.insurer) || b.insurer;
      if (!insurer) return 'insurer is required (query ?insurer=HDFCTP or body.insurer)';
      return null;
    },
  });
  return route(req, res);
}
