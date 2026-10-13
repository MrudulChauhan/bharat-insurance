// Shared client for the MIALTUS Partner API (insert-quote subsystem).
// Base URL: uatswapapi.pushbutton.in
//
// Auth model is unusual: the /Authentication/token call itself requires a
// static "master" bearer token issued by the vendor, PLUS partner
// username/password in the body. The response returns a *session* token which
// is what we use on subsequent /partner/motor/insert*quote calls.

// Fall back to the master SIMSON_* credentials since UAT accepts the same
// user/pass for all three subsystems. Deployments can still override with a
// dedicated MIALTUS_* pair if the vendor issues one later.
const BASE     = process.env.MIALTUS_BASE_URL || 'https://uatswapapi.pushbutton.in';
const CLIENT   = process.env.MIALTUS_CLIENT_NAME || process.env.SIMSON_CLIENT_NAME || 'MIALTUS';
const SERVER   = process.env.MIALTUS_SERVER || 'UAT';
const STATIC   = process.env.MIALTUS_STATIC_TOKEN || ''; // optional in UAT
const USERNAME = process.env.MIALTUS_USERNAME || process.env.SIMSON_USERNAME || '';
const PASSWORD = process.env.MIALTUS_PASSWORD || process.env.SIMSON_PASSWORD || '';
// Partner userCode (Simson requirement, vendor Q5): must be sent on the
// insertquote body. Same env var as the swapinsurer client so a single
// value governs both partner subsystems.
const USER_CODE = process.env.MIALTUS_USER_CODE || process.env.SWAPINSURER_USER_CODE || process.env.SIMSON_USER_CODE || '3614';
export function partnerUserCode() { return USER_CODE; }

let cached = { token: null, expiresAt: 0 };
let inflight = null;

function normaliseExpiry(raw) {
  if (raw == null) return 3600;
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return 3600;
  return n > 100000 ? Math.floor(n / 1000) : n;
}

async function fetchSessionToken() {
  const headers = {
    'accept': '*/*',
    'ClientName': CLIENT,
    'Content-Type': 'application/json',
  };
  // Doc says the token endpoint requires a static Bearer; UAT accepts calls
  // without it. Send it only if configured.
  if (STATIC) headers['Authorization'] = `Bearer ${STATIC}`;
  const r = await fetch(`${BASE}/Authentication/token`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ username: USERNAME, password: PASSWORD }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`MIALTUS auth ${r.status}: ${text}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('MIALTUS auth returned non-JSON'); }
  const token = j.token || j.Token || j.access_token;
  if (!token) throw new Error('MIALTUS auth response missing token field');
  // Response is like Swapinsurer: {token, refreshToken, expiryTime, ...}.
  // expiryTime is ISO 8601; fall back to +55min if absent.
  let expiresAt = Date.now() + 55 * 60 * 1000;
  if (j.expiryTime) {
    const t = Date.parse(j.expiryTime);
    if (!isNaN(t)) expiresAt = t - 60 * 1000;
  } else if (j.expiresIn ?? j.expires_in) {
    const seconds = normaliseExpiry(j.expiresIn ?? j.expires_in);
    expiresAt = Date.now() + Math.max(30, seconds - 60) * 1000;
  }
  cached = { token, expiresAt };
  return token;
}

async function getSessionToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;
  if (!inflight) inflight = fetchSessionToken().finally(() => { inflight = null; });
  return inflight;
}

export async function mialtus(path, { method = 'POST', body } = {}) {
  const call = async (token) => fetch(`${BASE}${path}`, {
    method,
    headers: {
      'accept': '*/*',
      'ClientName': CLIENT,
      'Server': SERVER,
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
  // Static token is optional in UAT; only user/pass are actually required.
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
          error: 'MIALTUS credentials not configured',
          need: ['MIALTUS_CLIENT_NAME (or SIMSON_CLIENT_NAME)',
                 'MIALTUS_USERNAME (or SIMSON_USERNAME)',
                 'MIALTUS_PASSWORD (or SIMSON_PASSWORD)'],
        });
      }
      const body = buildBody ? buildBody(req) : (req.body || undefined);
      const r = await mialtus(path, { method, body });
      if (!r.ok) return res.status(r.status).json({ error: r.data ?? 'upstream error' });
      return res.status(200).json(r.data);
    } catch (e) {
      return res.status(502).json({ error: String((e && e.message) || e) });
    }
  };
}
