import { createHmac, timingSafeEqual } from 'node:crypto';
import { put, list, del } from '@vercel/blob';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

// Shared helpers for the payment-gateway webhook + browser return flow.
//
// Storage model: one blob (or one local-file entry) per transaction, keyed
// by transId. This gives us idempotent upserts without a read-modify-write
// race under concurrent callbacks, which the shared-array approach used by
// api/leads.mjs cannot offer.

const BLOB_PREFIX = 'data/payments/';
export const blobEnabled = () => !!process.env.BLOB_READ_WRITE_TOKEN;

const HERE = dirname(fileURLToPath(import.meta.url));
// api/_payment.mjs → api/ → repo root
const LOCAL_DIR = join(HERE, '..', '.payments.local');

// ---------- status classification ------------------------------------------

export function classifyStatus(raw) {
  const s = String(raw || '').toUpperCase();
  if (/SUCCESS|SUCCESSFUL|CAPTURED|PAID|COMPLETED/.test(s))    return 'success';
  if (/FAIL|FAILED|DECLINED|ERROR/.test(s))                    return 'failure';
  if (/CANCEL|CANCELLED|USER_ABORT|USER_DROPPED/.test(s))      return 'cancelled';
  if (/PENDING|INITIATED|PROCESSING/.test(s))                  return 'pending';
  return 'unknown';
}

// First non-empty value in a bag of alias keys.
export function pickAlias(obj, keys) {
  if (!obj) return '';
  for (const k of keys) {
    const v = obj[k];
    if (v != null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
}

// Field-name aliases we accept from the gateway.
export const FIELD_ALIASES = {
  status:      ['status','paymentStatus','txnStatus','payment_status','transactionStatus'],
  transId:     ['transId','txnId','transactionId','pgTxnId','tran_id'],
  orderId:     ['orderId','order_id','merchantOrderId'],
  policyNo:    ['policyNo','policyNumber','policy_no'],
  proposalNo:  ['proposalNo','proposal_no','proposalNumber'],
  amount:      ['amount','payablePremium','txnAmount','transactionAmount'],
};

// ---------- body parsing ---------------------------------------------------

// Consume the request stream ourselves. Works whether Vercel already parsed
// req.body or not: if the stream is drained, we fall back to re-serialising
// the parsed body so HMAC verification still has something deterministic to
// hash. When the vendor signs the exact wire bytes, the raw path is used;
// when they sign canonical JSON, both paths agree.
export async function readRawBody(req) {
  const chunks = [];
  try {
    for await (const c of req) chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c));
  } catch { /* stream already consumed */ }
  if (chunks.length) return Buffer.concat(chunks);
  if (req.body == null) return Buffer.alloc(0);
  if (Buffer.isBuffer(req.body)) return req.body;
  if (typeof req.body === 'string') return Buffer.from(req.body);
  return Buffer.from(JSON.stringify(req.body));
}

export function parseBody(rawBuf, contentType) {
  const s = rawBuf.toString('utf8').trim();
  if (!s) return {};
  const ct = String(contentType || '').toLowerCase();
  if (ct.includes('application/json') || s.startsWith('{') || s.startsWith('[')) {
    try { return JSON.parse(s); } catch { /* fall through */ }
  }
  if (ct.includes('application/x-www-form-urlencoded') || s.includes('=')) {
    try {
      const p = new URLSearchParams(s);
      const out = {};
      for (const [k, v] of p.entries()) out[k] = v;
      return out;
    } catch { /* fall through */ }
  }
  return {};
}

// ---------- HMAC signature verification ------------------------------------

// Locates the signature header the gateway sent. Different PGs use different
// header names; accept the common ones.
const SIG_HEADERS = [
  'x-signature', 'x-webhook-signature', 'x-checksum', 'x-hash',
  'signature', 'checksum',
];

export function extractSignature(req, parsedBody) {
  for (const h of SIG_HEADERS) {
    const v = req.headers[h];
    if (v) return String(v);
  }
  if (parsedBody && typeof parsedBody === 'object') {
    for (const k of ['signature','checksum','hash','sig']) {
      if (parsedBody[k]) return String(parsedBody[k]);
    }
  }
  return '';
}

// Return { ok, mode } where mode is 'verified' | 'unconfigured' | 'invalid'.
// Fail-open when PAYMENT_WEBHOOK_SECRET is not set so the vendor can start
// integration before the secret is exchanged. This is logged prominently so
// it cannot silently persist into production.
export function verifySignature(rawBuf, providedSig) {
  const secret = process.env.PAYMENT_WEBHOOK_SECRET;
  if (!secret) return { ok: true, mode: 'unconfigured' };
  if (!providedSig) return { ok: false, mode: 'missing' };

  const expected = createHmac('sha256', secret).update(rawBuf).digest('hex');
  const provided = providedSig.trim().toLowerCase().replace(/^sha256=/, '');

  if (expected.length !== provided.length) return { ok: false, mode: 'invalid' };
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(provided, 'utf8');
  const ok = timingSafeEqual(a, b);
  return { ok, mode: ok ? 'verified' : 'invalid' };
}

// ---------- redaction + structured logging ---------------------------------

const REDACT_KEYS = /pass(word)?|secret|token|otp|cvv|cvc|card(no|number)?|pan|aadhaar|aadhar/i;

export function redact(obj) {
  if (obj == null || typeof obj !== 'object') return obj;
  const out = Array.isArray(obj) ? [] : {};
  for (const [k, v] of Object.entries(obj)) {
    if (REDACT_KEYS.test(k)) out[k] = '[redacted]';
    else if (v && typeof v === 'object') out[k] = redact(v);
    else out[k] = v;
  }
  return out;
}

export function logEvent(event, payload) {
  const line = { ts: new Date().toISOString(), event, ...redact(payload || {}) };
  // Single-line JSON keeps Vercel log ingestion happy.
  try { console.log(JSON.stringify(line)); } catch { /* never throw from logging */ }
}

// ---------- per-transaction persistence ------------------------------------

// Ids from PGs are usually alphanumeric but we defensively strip anything
// that would let a caller escape the intended blob prefix / local directory.
export function safeKey(id) {
  return String(id || '').replace(/[^A-Za-z0-9._-]/g, '_').slice(0, 128);
}

function blobPath(transId) { return `${BLOB_PREFIX}${safeKey(transId)}.json`; }
function localPath(transId){ return join(LOCAL_DIR, `${safeKey(transId)}.json`); }

async function blobPutRecord(rec) {
  await put(blobPath(rec.transId), JSON.stringify(rec), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json',
    cacheControlMaxAge: 0,
  });
}

async function blobGetRecord(transId) {
  const { blobs } = await list({ prefix: blobPath(transId), limit: 1 });
  if (!blobs.length) return null;
  const r = await fetch(blobs[0].url, { cache: 'no-store' });
  if (!r.ok) return null;
  try { return await r.json(); } catch { return null; }
}

async function blobListRecords(limit = 500) {
  const { blobs } = await list({ prefix: BLOB_PREFIX, limit });
  const out = [];
  for (const b of blobs) {
    try {
      const r = await fetch(b.url, { cache: 'no-store' });
      if (r.ok) out.push(await r.json());
    } catch { /* skip */ }
  }
  out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
  return out;
}

async function ensureLocalDir() {
  try { await fs.mkdir(LOCAL_DIR, { recursive: true }); } catch { /* ignore */ }
}

async function localPutRecord(rec) {
  await ensureLocalDir();
  await fs.writeFile(localPath(rec.transId), JSON.stringify(rec, null, 2));
}

async function localGetRecord(transId) {
  try {
    const s = await fs.readFile(localPath(transId), 'utf8');
    return JSON.parse(s);
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

async function localListRecords() {
  try {
    const files = await fs.readdir(LOCAL_DIR);
    const out = [];
    for (const f of files) {
      if (!f.endsWith('.json')) continue;
      try {
        const s = await fs.readFile(join(LOCAL_DIR, f), 'utf8');
        out.push(JSON.parse(s));
      } catch { /* skip */ }
    }
    out.sort((a, b) => String(b.ts || '').localeCompare(String(a.ts || '')));
    return out;
  } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw e;
  }
}

// Idempotent upsert. Preserves the earliest ts as `firstSeen` so we can tell
// how long the gateway took to reach us on retries.
export async function upsertPayment(newRec) {
  const backend = blobEnabled() ? 'blob' : 'local-file';
  const existing = blobEnabled()
    ? await blobGetRecord(newRec.transId)
    : await localGetRecord(newRec.transId);

  const merged = existing
    ? {
        ...existing,
        ...newRec,
        firstSeen: existing.firstSeen || existing.ts || newRec.ts,
        lastSeen: newRec.ts,
        updates: (existing.updates || 0) + 1,
      }
    : { ...newRec, firstSeen: newRec.ts, lastSeen: newRec.ts, updates: 1 };

  if (blobEnabled()) await blobPutRecord(merged);
  else                await localPutRecord(merged);
  return { backend, record: merged, wasNew: !existing };
}

export async function getPayment(transId) {
  return blobEnabled() ? blobGetRecord(transId) : localGetRecord(transId);
}

export async function listPayments(limit) {
  return blobEnabled() ? blobListRecords(limit) : localListRecords();
}

export function storageLabel() { return blobEnabled() ? 'blob' : 'local-file'; }
