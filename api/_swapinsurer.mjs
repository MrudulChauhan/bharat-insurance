// Shared client for the Swapinsurer Partner API (get-quote subsystem).
// Base URL: swapinsureruat.getpolicy.in
//
// Auth is simpler than MIALTUS Partner: just username/password on the token
// endpoint (no static bearer). Response returns { token, expiryTime } where
// expiryTime is an ISO 8601 timestamp with timezone offset.

// Fall back to master SIMSON_* credentials; UAT accepts the same user/pass
// across all three subsystems.
const BASE     = process.env.SWAPINSURER_BASE_URL || 'https://swapinsureruat.getpolicy.in';
const CLIENT   = process.env.SWAPINSURER_CLIENT_NAME || process.env.SIMSON_CLIENT_NAME || 'MIALTUS';
const SERVER   = process.env.SWAPINSURER_SERVER || 'UAT';
const USERNAME = process.env.SWAPINSURER_USERNAME || process.env.SIMSON_USERNAME || '';
const PASSWORD = process.env.SWAPINSURER_PASSWORD || process.env.SIMSON_PASSWORD || '';
// Partner userCode issued by Simson — must be sent on proposal / policy /
// PDF requests. Configurable so we can change it without a redeploy.
const USER_CODE = process.env.SWAPINSURER_USER_CODE || process.env.SIMSON_USER_CODE || '3614';
export function partnerUserCode() { return USER_CODE; }

let cached = { token: null, expiresAt: 0 };
let inflight = null;

async function fetchSessionToken() {
  const r = await fetch(`${BASE}/Partner/Authentication/token`, {
    method: 'POST',
    headers: {
      'accept': '*/*',
      'ClientName': CLIENT,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Swapinsurer auth ${r.status}: ${text}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('Swapinsurer auth returned non-JSON'); }
  const token = j.token || j.Token || j.access_token;
  if (!token) throw new Error('Swapinsurer auth response missing token field');
  // expiryTime is an ISO 8601 timestamp with tz offset; fall back to +1h
  let expiresAt = Date.now() + 55 * 60 * 1000;
  if (j.expiryTime) {
    const t = Date.parse(j.expiryTime);
    if (!isNaN(t)) expiresAt = t - 60 * 1000; // 60s safety buffer
  }
  cached = { token, expiresAt };
  return token;
}

async function getSessionToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;
  if (!inflight) inflight = fetchSessionToken().finally(() => { inflight = null; });
  return inflight;
}

export async function swapinsurer(path, { method = 'POST', body, insurer } = {}) {
  const call = async (token) => fetch(`${BASE}${path}`, {
    method,
    headers: {
      'accept': '*/*',
      'ClientName': CLIENT,
      'Server': SERVER,
      'Insurer': insurer || '',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  let token = await getSessionToken();
  let r = await call(token);

  if (r.status === 401) {
    cached = { token: null, expiresAt: 0 };
    token = await getSessionToken();
    r = await call(token);
  }

  const text = await r.text();
  let data = null;
  if (text) { try { data = JSON.parse(text); } catch { data = text; } }
  return { ok: r.ok, status: r.status, data };
}

export function envReady() {
  return Boolean(CLIENT && USERNAME && PASSWORD);
}

export function makeRoute({ method, path, buildBody, validate }) {
  return async function handler(req, res) {
    if (req.method !== method) return res.status(405).json({ error: 'method not allowed' });
    try {
      if (validate) {
        const bad = validate(req);
        if (bad) return res.status(400).json({ error: bad });
      }
      if (!envReady()) {
        return res.status(500).json({
          error: 'Swapinsurer credentials not configured',
          need: ['SWAPINSURER_CLIENT_NAME (or SIMSON_CLIENT_NAME)',
                 'SWAPINSURER_USERNAME (or SIMSON_USERNAME)',
                 'SWAPINSURER_PASSWORD (or SIMSON_PASSWORD)'],
        });
      }
      // Insurer header comes from the frontend's ?insurer= query or a body.insurer field
      const insurer = (req.query && req.query.insurer) || (req.body && req.body.insurer) || '';
      // Never forward the meta insurer field to the upstream body
      const body = buildBody ? buildBody(req) : (() => {
        if (!req.body) return undefined;
        const { insurer: _drop, ...rest } = req.body;
        return rest;
      })();
      const r = await swapinsurer(path, { method, body, insurer });
      if (!r.ok) return res.status(r.status).json({ error: r.data ?? 'upstream error' });
      return res.status(200).json(r.data);
    } catch (e) {
      return res.status(502).json({ error: String((e && e.message) || e) });
    }
  };
}
