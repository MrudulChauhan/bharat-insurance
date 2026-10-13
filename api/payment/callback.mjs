import {
  readRawBody, parseBody,
  verifySignature, extractSignature,
  classifyStatus, pickAlias, FIELD_ALIASES,
  upsertPayment, getPayment, listPayments,
  storageLabel, logEvent, redact, safeKey,
} from '../_payment.mjs';

// Vercel: give us the raw request bytes so HMAC verification can hash exactly
// what the gateway signed. We then parse the body ourselves in _payment.mjs.
export const config = { api: { bodyParser: false } };

// Payment gateway integration endpoint. One handler serves three shapes:
//
//   POST /api/payment/callback
//       Server-to-server webhook from the payment gateway. HMAC-verified when
//       PAYMENT_WEBHOOK_SECRET is set. Idempotent per transactionId. Always
//       returns 200 on a valid, verified receipt so the gateway does not
//       spin on retries.
//
//   GET  /api/payment/callback?transId=<id>
//       Status lookup for the browser return page (or ops tooling) to confirm
//       that the S2S callback for a given transaction has actually landed.
//
//   GET  /api/payment/callback?admin=1&pass=<ADMIN_PASS>
//       Recent-payments listing for reconciliation. Same admin gate as
//       api/leads.mjs.
//
//   GET  /api/payment/callback
//       Health check for the vendor to poke while wiring things up.

function ip(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) return String(xff).split(',')[0].trim();
  return req.socket?.remoteAddress || null;
}

// Strip signature-like fields before we hand the record back on GET - no
// need to leak them into ops UIs.
function publicView(rec) {
  if (!rec) return rec;
  const { payload, ...rest } = rec;
  const cleanedPayload = payload && typeof payload === 'object'
    ? Object.fromEntries(
        Object.entries(payload).filter(([k]) => !/^(signature|checksum|hash|sig)$/i.test(k))
      )
    : payload;
  return { ...rest, payload: cleanedPayload };
}

async function handleGet(req, res) {
  const q = req.query || {};

  // Single-record lookup - used by the return page to poll for the S2S
  // callback confirming the outcome the browser was told.
  if (q.transId) {
    const rec = await getPayment(safeKey(q.transId));
    res.setHeader('Cache-Control', 'no-store');
    if (!rec) return res.status(404).json({ found: false, transId: String(q.transId) });
    return res.status(200).json({ found: true, ...publicView(rec) });
  }

  // Admin listing for reconciliation.
  if (q.admin) {
    const pass = q.pass || req.headers['x-admin-pass'];
    const expected = process.env.ADMIN_PASS;
    if (!expected || !pass || pass !== expected) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    const payments = await listPayments(Number(q.limit) || 500);
    return res.status(200).json({
      payments: payments.map(publicView),
      count: payments.length,
      stored: storageLabel(),
    });
  }

  return res.status(200).json({
    ok: true,
    endpoint: 'payment-callback',
    accepts: 'POST application/json OR application/x-www-form-urlencoded',
    signatureVerification: process.env.PAYMENT_WEBHOOK_SECRET ? 'enabled' : 'unconfigured',
    storage: storageLabel(),
  });
}

// HDFC posts a pipe-delimited `hdnmsg` back on the browser return, form-
// encoded. Recognise it and take a different branch: no HMAC (they don't
// sign), store the parsed result, and 302 the browser to our return page.
// hdnmsg format (from the vendor doc + sample):
//   HDFCGENINS | txnID | bankRef | bankTxnID | amount | bank | NA | DD | NA | STATUS | DD-MM-YYYY hh:mm:ss | appid | ... | ...
function parseHdfcHdnmsg(msg) {
  if (!msg) return null;
  const parts = String(msg).split('|');
  if (parts.length < 12 || parts[0] !== 'HDFCGENINS') return null;
  // Vendor code hint: index 9 carries a short status like SPD (success paid),
  // FLD (failed), CNL (cancelled). Treat SPD as success; anything else non-
  // empty as failure. If missing, fall back to bankRef presence.
  const shortStatus = String(parts[9] || '').trim().toUpperCase();
  const status = shortStatus === 'SPD' || shortStatus === 'SUC' ? 'SUCCESS'
    : shortStatus ? 'FAILURE'
    : (parts[2] ? 'SUCCESS' : 'UNKNOWN');
  return {
    provider: 'HDFCGENINS',
    txnId: parts[1] || '',
    bankRef: parts[2] || '',
    bankTxnId: parts[3] || '',
    amount: parts[4] || '',
    bank: parts[5] || '',
    shortStatus,
    paymentDateTime: parts[10] || '',
    appid: parts[11] || '',
    status,
  };
}

async function handlePost(req, res) {
  const raw = await readRawBody(req);
  const body = parseBody(raw, req.headers['content-type']);

  // ---- HDFC gateway browser return: form POST with hdnmsg field ----
  if (body && body.hdnmsg) {
    const parsed = parseHdfcHdnmsg(body.hdnmsg);
    const partnerTransId = String((req.query && req.query.transId) || '').trim();
    const now = new Date().toISOString();
    // Key the record under the PARTNER transId (what the frontend tracks
    // by), not the HDFC-generated txn id. HDFC's txn id is stored as an
    // attribute for lookup / reconciliation.
    const record = {
      ts: now,
      status: parsed ? classifyStatus(parsed.status) : 'unknown',
      rawStatus: parsed ? parsed.status : '',
      transId: partnerTransId || (parsed && parsed.txnId) || `hdfc_${Date.now()}`,
      partnerTransId,
      hdfcTxnId: parsed && parsed.txnId,
      orderId: partnerTransId,
      policyNo: '',
      proposalNo: '',
      amount: parsed ? parsed.amount : '',
      provider: 'HDFCGENINS',
      hdfc: parsed || null,
      signatureMode: 'unsigned-hdfc-return',
      payload: redact(body),
      ip: ip(req),
    };
    try {
      await upsertPayment(record);
      logEvent('payment.callback.hdfc_return', {
        transId: record.transId, partnerTransId, status: record.status,
        amount: record.amount, bankRef: parsed && parsed.bankRef,
      });
    } catch (e) {
      logEvent('payment.callback.storage_error', {
        transId: record.transId, error: String((e && e.message) || e),
      });
    }
    // Redirect the browser to our return page carrying both ids so the page
    // can look up the payment result and drive the next APIs (get-policy-
    // after-payment, get-policy-pdf).
    const qs = new URLSearchParams({
      transId: partnerTransId || record.transId,
      hdfcTxnId: record.transId,
      status: record.status,
    }).toString();
    res.setHeader('Location', `/payment/return.html?${qs}`);
    return res.status(302).end();
  }

  // ---- Generic HMAC-signed webhook path (existing) ----
  const providedSig = extractSignature(req, body);
  const verdict = verifySignature(raw, providedSig);
  if (!verdict.ok) {
    logEvent('payment.callback.rejected', {
      reason: verdict.mode, ip: ip(req),
      contentType: req.headers['content-type'] || null,
      sizeBytes: raw.length,
    });
    return res.status(401).json({ ok: false, error: 'signature verification failed' });
  }

  const rawStatus = pickAlias(body, FIELD_ALIASES.status);
  const transId   = pickAlias(body, FIELD_ALIASES.transId);
  const record = {
    ts: new Date().toISOString(),
    status: classifyStatus(rawStatus),
    rawStatus,
    transId:    transId || `unlabelled_${Date.now()}`,
    orderId:    pickAlias(body, FIELD_ALIASES.orderId),
    policyNo:   pickAlias(body, FIELD_ALIASES.policyNo),
    proposalNo: pickAlias(body, FIELD_ALIASES.proposalNo),
    amount:     pickAlias(body, FIELD_ALIASES.amount),
    signatureMode: verdict.mode,
    payload: redact(body),
    ip: ip(req),
  };

  try {
    const { wasNew, backend } = await upsertPayment(record);
    logEvent('payment.callback.received', {
      transId: record.transId, status: record.status, rawStatus, wasNew, backend,
      signatureMode: verdict.mode, amount: record.amount, policyNo: record.policyNo,
    });
    return res.status(200).json({ ok: true, received: record.status, duplicate: !wasNew });
  } catch (e) {
    logEvent('payment.callback.storage_error', {
      transId: record.transId, error: String((e && e.message) || e),
    });
    return res.status(200).json({ ok: true, received: record.status, stored: false });
  }
}

export default async function handler(req, res) {
  try {
    if (req.method === 'GET')  return handleGet(req, res);
    if (req.method === 'POST') return handlePost(req, res);
    return res.status(405).json({ error: 'method not allowed' });
  } catch (e) {
    logEvent('payment.callback.error', { error: String((e && e.message) || e) });
    return res.status(500).json({ error: 'internal error' });
  }
}
