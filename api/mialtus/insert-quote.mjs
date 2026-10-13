import { makeRoute, partnerUserCode } from '../_mialtus.mjs';

// Combined car + bike insert-quote proxy - dispatch by ?type=car|bike.
// (Two endpoints merged into one to stay under Vercel Hobby's 12-fn cap.)
export default async function handler(req, res) {
  const type = String((req.query && req.query.type) || '').toLowerCase();
  if (type !== 'car' && type !== 'bike') {
    return res.status(400).json({ error: 'query ?type=car|bike is required' });
  }
  const isCar = type === 'car';
  const route = makeRoute({
    method: 'POST',
    path: isCar ? '/partner/motor/insertcarquote' : '/partner/motor/insertbikequote',
    validate: (r) => {
      const b = r.body || {};
      const addonsKey = isCar ? 'carAddons' : 'bikeAddons';
      if (!b.quote || !b[addonsKey]) return `body must have { quote, ${addonsKey} }`;
      const q = b.quote;
      const req = ['make','model','variant','rto','regDate','fullname','mobile','email','vehicleNo'];
      if (!isCar) req.push('previousYearPolicyType');
      for (const k of req) if (!q[k]) return `quote.${k} is required`;
      return null;
    },
    // Vendor Q5: userCode must be sent on the insertquote body.
    buildBody: (r) => ({ ...(r.body || {}), userCode: partnerUserCode() }),
  });
  return route(req, res);
}
