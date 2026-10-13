import { simson, envReady, mmvBody } from '../_simson.mjs';

// One dispatcher for every Simson master-data endpoint. Vercel routes
// /api/simson/<op> straight to this file with req.query.op = <op>.
// Folding the whole surface into one function keeps us well under the
// Vercel Hobby plan's 12-function cap while leaving room to grow.

// helper: pick a field allowing either the docs' camelCase or lowercase key
const pick = (b, k) => String(b?.[k] ?? b?.[k[0].toUpperCase()+k.slice(1)] ?? '').trim();

const OPS = {
  // ---- original master data (Private Car + Two Wheeler docs) ----
  'rtos':                  { m:'GET',  p:'/Motor/GetRTOMasterApi' },
  'car-makes':             { m:'GET',  p:'/Motor/GetCarMakes' },
  'car-models':            { m:'POST', p:'/Motor/GetCarModelApp',    require:['make'],           mmv:true },
  'car-variants':          { m:'POST', p:'/Motor/GetCarVarient',     require:['make','model'],   mmv:true },
  'previous-insurers':     { m:'GET',  p:'/Motor/GetPreviousInsurers' },
  'bike-makes':            { m:'GET',  p:'/Motor/GetBikeMakes' },
  'bike-models':           { m:'POST', p:'/Motor/GetBikeModelApp',   require:['make'],           mmv:true },
  'bike-variants':         { m:'POST', p:'/Motor/GetBikeVarient',    require:['make','model'],   mmv:true },

  // ---- VAHAN-style reg → vehicle detail (via FastLane) ----
  'fastlane-vehicle-details': { m:'POST', p:'/Motor/GetFastlaneVehicleDetails',
                                require:['uniqueId','vehicleType'], pass:true },

  // ---- new per-company master data (Motor_Master_APIs_Documentation.pdf) ----
  'salutations':           { m:'POST', p:'/Motor/GetsalutationMaster',           require:['companyName'], pass:true },
  'marital-status':        { m:'POST', p:'/Motor/GetmartialstatusMaster',        require:['companyName'], pass:true },
  'relations':             { m:'POST', p:'/Motor/GetCompanyRelationMasterApp',   require:['companyName'], pass:true },
  'company-insurers':      { m:'POST', p:'/Motor/GetCompanyPreviousInsurersApp', require:['companyName'], pass:true },
  'pincode-list':          { m:'POST', p:'/Motor/GetDetailsbyPincodeList',       require:['pincode','company'], pass:true },
  'occupations':           { m:'POST', p:'/Motor/GetCompanyOccupationMasterApp', require:['companyName'], pass:true },
  'financiers':            { m:'POST', p:'/Motor/GetCompanyFinancierMasterApp',  require:['companyName'], pass:true },
  'previous-policy-types': { m:'POST', p:'/Motor/GetPreviouspolicytype',
                             require:['companyName','module','currentPolicyType'], pass:true },
  'pincode':               { m:'POST', p:'/Motor/GetDetailsbyPincode',           require:['pincode','company'], pass:true },
};

export default async function handler(req, res) {
  const op = String((req.query && req.query.op) || '');
  const spec = OPS[op];
  if (!spec) {
    return res.status(404).json({ error: `unknown op: ${op}`, valid: Object.keys(OPS) });
  }
  if (req.method !== spec.m) {
    return res.status(405).json({ error: `method not allowed (need ${spec.m})` });
  }
  try {
    if (spec.require) {
      const b = req.body || {};
      for (const f of spec.require) {
        if (!pick(b, f)) return res.status(400).json({ error: `${f} is required` });
      }
    }
    if (!envReady()) return res.status(500).json({ error: 'Simson credentials not configured' });

    let body;
    if (spec.m === 'POST') {
      const b = req.body || {};
      if (spec.mmv) {
        // GetCarModelApp / GetCarVarient / bike-* - dual-cased Make/Model body
        const args = {};
        for (const f of spec.require) args[f] = pick(b, f);
        body = mmvBody(args);
      } else if (spec.pass) {
        // Pass through with case normalisation for the required fields
        body = { ...b };
        for (const f of spec.require) body[f] = pick(b, f);
      }
    }

    const r = await simson(spec.p, { method: spec.m, body });
    if (!r.ok) return res.status(r.status).json({ error: r.data ?? 'upstream error' });
    return res.status(200).json(r.data);
  } catch (e) {
    return res.status(502).json({ error: String((e && e.message) || e) });
  }
}
