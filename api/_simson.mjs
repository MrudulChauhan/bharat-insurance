const BASE = process.env.SIMSON_BASE_URL || 'https://swapmasteruat.getpolicy.in';
const CLIENT_NAME = process.env.SIMSON_CLIENT_NAME || '';
const USERNAME = process.env.SIMSON_USERNAME || '';
const PASSWORD = process.env.SIMSON_PASSWORD || '';

// Retained across warm invocations on the same instance. Cold starts pay
// one auth call.
let cached = { token: null, expiresAt: 0 };
let inflight = null;

function normaliseExpiry(raw) {
  // Vendor doc leaves the unit ambiguous; treat large values as ms, otherwise
  // seconds. Applies a 60s safety buffer so we never hand out a token that
  // is about to expire.
  if (raw == null) return 3600;
  const n = Number(raw);
  if (!isFinite(n) || n <= 0) return 3600;
  return n > 100000 ? Math.floor(n / 1000) : n;
}

async function fetchToken() {
  const r = await fetch(`${BASE}/Authentication/token`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'ClientName': CLIENT_NAME,
    },
    body: JSON.stringify({ Username: USERNAME, Password: PASSWORD }),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`Simson auth ${r.status}: ${text}`);
  let j;
  try { j = JSON.parse(text); } catch { throw new Error('Simson auth returned non-JSON'); }
  const token = j.token || j.Token || j.access_token || j.jwt || j.JWT;
  if (!token) throw new Error('Simson auth response missing token field');
  const seconds = normaliseExpiry(j.expiresIn ?? j.expires_in ?? j.ExpiresIn);
  cached = { token, expiresAt: Date.now() + Math.max(30, seconds - 60) * 1000 };
  return token;
}

async function getToken() {
  if (cached.token && Date.now() < cached.expiresAt) return cached.token;
  if (!inflight) {
    inflight = fetchToken().finally(() => { inflight = null; });
  }
  return inflight;
}

export async function simson(path, { method = 'GET', body } = {}) {
  const call = async (token) => {
    return fetch(`${BASE}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'accept': '*/*',
        'ClientName': CLIENT_NAME,
        'Authorization': `Bearer ${token}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  };

  let token = await getToken();
  let r = await call(token);

  if (r.status === 401) {
    cached = { token: null, expiresAt: 0 };
    token = await getToken();
    r = await call(token);
  }

  const text = await r.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  return { ok: r.ok, status: r.status, data };
}

// Doc ambiguity: schema block uses "Make" / "Model" but every curl example
// uses "make" / "model". Sending both keys is safe under ASP.NET Core's
// default case-insensitive JSON binding and costs nothing. Remove the
// duplicate once the vendor confirms the canonical casing.
export function mmvBody({ make, model, variant, cc, seatCapacity } = {}) {
  const b = {};
  if (make !== undefined)         { b.Make = make; b.make = make; }
  if (model !== undefined)        { b.Model = model; b.model = model; }
  if (variant !== undefined)      { b.Variant = variant; b.variant = variant; }
  if (cc !== undefined)           { b.Cc = cc; b.cc = cc; }
  if (seatCapacity !== undefined) { b.SeatCapacity = seatCapacity; b.seatCapacity = seatCapacity; }
  return b;
}

export function envReady() {
  return Boolean(CLIENT_NAME && USERNAME && PASSWORD);
}

export function makeRoute({ method, path, buildBody, validate }) {
  return async function handler(req, res) {
    if (req.method !== method) {
      return res.status(405).json({ error: 'method not allowed' });
    }
    try {
      if (validate) {
        const bad = validate(req);
        if (bad) return res.status(400).json({ error: bad });
      }
      if (!envReady()) {
        return res.status(500).json({ error: 'Simson credentials not configured' });
      }
      const body = buildBody ? buildBody(req) : undefined;
      const r = await simson(path, { method, body });
      if (!r.ok) return res.status(r.status).json({ error: r.data ?? 'upstream error' });
      return res.status(200).json(r.data);
    } catch (e) {
      return res.status(502).json({ error: String((e && e.message) || e) });
    }
  };
}
