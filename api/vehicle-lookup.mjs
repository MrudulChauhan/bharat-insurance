import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Reads the vendor UAT sample data from disk. When FastLane (or a Simson
// wrapper of it) becomes available, swap the body of `lookupReg` to call
// that endpoint instead - the frontend contract stays the same.
const HERE = dirname(fileURLToPath(import.meta.url));
// Co-located data file: underscore-prefixed files under api/ are neither
// routed as functions nor served as static assets, so this stays private
// while remaining bundled with the function.
const DATA_FILE = join(HERE, '_uat_regs.json');

let cache = null;
async function loadData() {
  if (cache) return cache;
  const raw = await readFile(DATA_FILE, 'utf8');
  const j = JSON.parse(raw);
  cache = (j && j.byReg) || {};
  return cache;
}

function normaliseReg(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Vendor sample uses FastLane-style make names; Simson's own GetCarMakes /
// GetBikeMakes catalogue uses slightly different names for a couple of brands.
// Bridge them here so the sample data drives correct pre-fills in the picker.
// Flag on the vendor call: their two data sources should be reconciled.
const MAKE_ALIASES = {
  'Mg':            'Morris Garages',
  'Maruti Suzuki': 'Maruti',
};

async function lookupReg(reg) {
  const data = await loadData();
  const raw = data[reg];
  if (!raw) return null;
  const make = raw.make && MAKE_ALIASES[raw.make] ? MAKE_ALIASES[raw.make] : raw.make;
  return { ...raw, make };
}

export default async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'method not allowed' });
  }
  const reg = normaliseReg((req.query && req.query.reg) || '');
  if (!reg) return res.status(400).json({ error: 'reg is required' });
  try {
    const hit = await lookupReg(reg);
    if (!hit) return res.status(200).json({ found: false, reg });
    return res.status(200).json({ found: true, reg, ...hit });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
