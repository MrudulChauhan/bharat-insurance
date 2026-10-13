import { put, list, del } from '@vercel/blob';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Legacy monolith path (pre per-id refactor). Read-only for the admin
// listing so history isn't lost; new writes go into per-id blobs.
const LEGACY_PATH = 'data/leads.json';
// One blob per lead id under this prefix — read-after-write consistent per
// key, which the shared-array approach could not guarantee under concurrent
// event-tracking POSTs.
const PER_ID_PREFIX = 'data/leads/';

const blobEnabled = () => !!process.env.BLOB_READ_WRITE_TOKEN;

const HERE = dirname(fileURLToPath(import.meta.url));
const LOCAL_FILE = join(HERE, '..', '.leads.local.json');
const LOCAL_DIR = join(HERE, '..', '.leads.local');

// ---------- Legacy monolith (read-only from here on) ----------
async function blobReadLegacy() {
  try {
    const { blobs } = await list({ prefix: LEGACY_PATH, limit: 1 });
    if (!blobs.length) return [];
    const r = await fetch(blobs[0].url, { cache: 'no-store' });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

// ---------- Per-id blobs ----------
function blobPathFor(id) { return `${PER_ID_PREFIX}${id}.json`; }
async function blobGetById(id) {
  try {
    const { blobs } = await list({ prefix: blobPathFor(id), limit: 1 });
    if (!blobs.length) return null;
    const r = await fetch(blobs[0].url, { cache: 'no-store' });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}
async function blobPutById(rec) {
  await put(blobPathFor(rec.id), JSON.stringify(rec), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  });
}
async function blobListAll() {
  const out = [];
  try {
    const { blobs } = await list({ prefix: PER_ID_PREFIX, limit: 1000 });
    for (const b of blobs) {
      try {
        const r = await fetch(b.url, { cache: 'no-store' });
        if (r.ok) out.push(await r.json());
      } catch {}
    }
  } catch {}
  return out;
}
async function blobDeleteAll() {
  try {
    const { blobs } = await list({ prefix: PER_ID_PREFIX, limit: 1000 });
    if (blobs.length) await del(blobs.map(b => b.url));
  } catch {}
  try {
    const { blobs } = await list({ prefix: LEGACY_PATH, limit: 1 });
    if (blobs.length) await del(blobs[0].url);
  } catch {}
}

// ---------- Local dev backend ----------
async function localReadLegacy() {
  try {
    const s = await fs.readFile(LOCAL_FILE, 'utf8');
    const j = JSON.parse(s);
    return Array.isArray(j) ? j : [];
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
    return [];
  }
}
function localFileFor(id) { return join(LOCAL_DIR, `${id}.json`); }
async function localGetById(id) {
  try {
    const s = await fs.readFile(localFileFor(id), 'utf8');
    return JSON.parse(s);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}
async function localPutById(rec) {
  await fs.mkdir(LOCAL_DIR, { recursive: true }).catch(() => {});
  await fs.writeFile(localFileFor(rec.id), JSON.stringify(rec, null, 2));
}
async function localListAll() {
  const out = [];
  try {
    const files = await fs.readdir(LOCAL_DIR);
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = await fs.readFile(join(LOCAL_DIR, f), 'utf8');
        out.push(JSON.parse(s));
      } catch {}
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  return out;
}
async function localDeleteAll() {
  try {
    const files = await fs.readdir(LOCAL_DIR);
    for (const f of files) if (f.endsWith('.json')) {
      try { await fs.unlink(join(LOCAL_DIR, f)); } catch {}
    }
  } catch (e) { if (e.code !== 'ENOENT') throw e; }
  try { await fs.unlink(LOCAL_FILE); } catch {}
}

// ---------- Storage facade ----------
async function getById(id)   { return blobEnabled() ? blobGetById(id) : localGetById(id); }
async function putById(rec)  { return blobEnabled() ? blobPutById(rec) : localPutById(rec); }
async function listAll()     { return blobEnabled() ? blobListAll()   : localListAll(); }
async function readLegacy()  { return blobEnabled() ? blobReadLegacy(): localReadLegacy(); }
async function deleteAll()   { return blobEnabled() ? blobDeleteAll() : localDeleteAll(); }

function storageLabel() { return blobEnabled() ? 'blob' : 'local-file'; }

// Fields we accept and store on a lead. Nested customer/kyc/quote objects
// keep the record readable in the admin panel without exploding the surface.
const cap = (v, n = 200) => (v == null ? '' : String(v).slice(0, n));
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const bool = (v) => v === true || v === 'true' || v === 1;
function safeId(v){ return String(v || '').replace(/[^A-Za-z0-9_.-]/g,'').slice(0, 64); }

// Deep merge two lead records. Non-empty values from b prefer over a, but a
// non-empty a beats a missing/empty b. Nested plain objects merge
// recursively; arrays and scalars take the b value only when it is truthy /
// non-empty. This lets partial upserts (e.g. a kyc_verified update that only
// has kyc data) preserve fields set by earlier writes.
function mergeVals(a, b) {
  if (b === undefined || b === null || b === '') return a;
  if (a === undefined || a === null || a === '') return b;
  const isPlainObj = (x) => x && typeof x === 'object' && !Array.isArray(x);
  if (isPlainObj(a) && isPlainObj(b)) {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) out[k] = mergeVals(a[k], v);
    return out;
  }
  return b;
}
function normaliseLead(b) {
  const out = {
    line: cap(b.line, 40),
    vtype: cap(b.vtype, 40),
    reg: cap(b.reg, 20),
    mobile: cap(b.mobile, 15),
    premium: num(b.premium),
    make: cap(b.make),
    model: cap(b.model),
    variant: cap(b.variant),
    rto: cap(b.rto),
    previousInsurer: cap(b.previousInsurer),
    // New: journey status + insurer + customer / kyc / quote snapshots.
    status: cap(b.status, 40),
    insurerCode: cap(b.insurerCode, 20),
    insurerLabel: cap(b.insurerLabel, 40),
    // Post-payment / issuance identifiers.
    policyNo: cap(b.policyNo, 40),
    proposalNo: cap(b.proposalNo, 40),
    hdfcTxnId: cap(b.hdfcTxnId, 40),
    reason: cap(b.reason, 300),
  };
  if (b.customer && typeof b.customer === 'object') {
    const c = b.customer;
    out.customer = {
      fullname: cap(c.fullname), email: cap(c.email, 120), regDate: cap(c.regDate, 20),
      mfgMonth: cap(c.mfgMonth, 4), mfgYear: cap(c.mfgYear, 6),
      vehicleOwnedBy: cap(c.vehicleOwnedBy, 2),
      validPolCopy: cap(c.validPolCopy, 4),
      prepolExpiryDate: cap(c.prepolExpiryDate, 20),
      previousYearPolicyType: cap(c.previousYearPolicyType, 120),
      occupation: cap(c.occupation, 40),
      hypothecated: bool(c.hypothecated),
      financier: c.financier && typeof c.financier === 'object'
        ? { name: cap(c.financier.name), code: cap(c.financier.code, 20) } : null,
      address: c.address && typeof c.address === 'object' ? {
        pincode: cap(c.address.pincode, 10), city: cap(c.address.city, 60),
        state: cap(c.address.state, 60), line: cap(c.address.line, 300),
      } : null,
      nominee: c.nominee && typeof c.nominee === 'object' ? {
        name: cap(c.nominee.name), dob: cap(c.nominee.dob, 20),
        relation: cap(c.nominee.relation, 40),
      } : null,
    };
  }
  if (b.kyc && typeof b.kyc === 'object') {
    const k = b.kyc;
    out.kyc = {
      verified: bool(k.verified),
      kycId: cap(k.kycId, 40), ckycNumber: cap(k.ckycNumber, 40),
      fullName: cap(k.fullName), dob: cap(k.dob, 20), pan: cap(k.pan, 20),
    };
  }
  if (b.quote && typeof b.quote === 'object') {
    const q = b.quote;
    out.quote = {
      pTransactionId: cap(q.pTransactionId, 60),
      policystartDate: cap(q.policystartDate, 20),
      policyEndDate: cap(q.policyEndDate, 20),
      thirdPartyPremium: num(q.thirdPartyPremium),
      baseThirdPartyPremium: num(q.baseThirdPartyPremium),
      paOwnerDriver: num(q.paOwnerDriver),
      geogExtensionTPPremium: num(q.geogExtensionTPPremium),
      tpBiFuel: num(q.tpBiFuel),
      netPremium: num(q.netPremium),
      serviceTax: num(q.serviceTax),
      payablePremium: num(q.payablePremium),
      errorStatus: bool(q.errorStatus),
      errorText: cap(q.errorText, 300),
    };
  }
  // Session/browser info for fraud tracing.
  if (b.session && typeof b.session === 'object') {
    const s = b.session;
    out.session = {
      ua: cap(s.ua, 300), lang: cap(s.lang, 20), tz: cap(s.tz, 40),
      referrer: cap(s.referrer, 200), screen: cap(s.screen, 20),
    };
  }
  return out;
}

export default async function handler(req, res) {
  try {
    if (req.method === 'POST') {
      const b = req.body || {};
      const id = safeId(b.id);
      const mobile = String(b.mobile || '');
      // Every meaningful lead has an id (generated client-side per session).
      // For back-compat we still accept id-less posts, but they can't be
      // upserted — they land as one-shot records under a synthetic id.
      const now = new Date().toISOString();
      const partial = normaliseLead(b);
      const effectiveId = id || `LEG-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        // Per-id blob = strongly consistent read-after-write. No shared array,
        // no race between concurrent event tracking posts.
        const existing = await getById(effectiveId);
        let record;
        if (existing) {
          const events = Array.isArray(existing.events) ? existing.events.slice() : [];
          if (partial.status) events.push({ ts: now, status: partial.status });
          record = mergeVals(existing, partial);
          record.id = effectiveId;
          record.firstSeen = existing.firstSeen || existing.ts || now;
          record.lastSeen = now;
          record.ts = existing.ts || now;
          record.updates = (existing.updates || 0) + 1;
          record.events = events;
        } else {
          // Mobile required only for the very first write (create-fresh).
          // Updates don't need to re-send it.
          if (!/^[6-9]\d{9}$/.test(mobile) && !id) {
            return res.status(400).json({ error: 'invalid mobile' });
          }
          record = {
            ...partial, id: effectiveId,
            firstSeen: now, lastSeen: now, ts: now, updates: 1,
            events: partial.status ? [{ ts: now, status: partial.status }] : [],
          };
        }
        await putById(record);
        return res.status(200).json({ ok: true, stored: storageLabel(), id: record.id, updates: record.updates });
      } catch (e) {
        return res.status(200).json({ ok: true, stored: false,
          note: `Persistence unavailable (${String(e.message || e)}). Lead accepted client-side only.` });
      }
    }

    // GET / DELETE require the admin passcode. Reject when the env var is
    // missing so a misconfigured deployment can never open unauth access.
    const pass = (req.query && req.query.pass) || req.headers['x-admin-pass'];
    const expected = process.env.ADMIN_PASS;
    if (!expected || !pass || pass !== expected) return res.status(401).json({ error: 'unauthorized' });

    if (req.method === 'GET') {
      const perId = await listAll();
      const legacy = await readLegacy();
      const leads = [...perId, ...legacy].sort((a, b) =>
        String(b.lastSeen || b.ts || '').localeCompare(String(a.lastSeen || a.ts || '')));
      return res.status(200).json({ leads, stored: storageLabel() });
    }
    if (req.method === 'DELETE') {
      await deleteAll();
      return res.status(200).json({ ok: true, stored: storageLabel() });
    }

    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    return res.status(500).json({ error: String((e && e.message) || e) });
  }
}
