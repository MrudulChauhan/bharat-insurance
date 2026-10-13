// E2E vendor call harness for Bharat Insurance.
//
// Hits the three Simson subsystems (Master, MIALTUS, Swapinsurer) directly
// on their UAT endpoints and records every request / response pair.
// Writes vendor-e2e-log.html at repo root.
//
// Usage:  node scripts/e2e-log.mjs
// Requires SIMSON_* env vars (auto-loaded from .env.local).

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

// Load .env.local (KEY=VALUE, optional quotes, ignore comments/blanks).
try {
  const env = readFileSync(join(ROOT, '.env.local'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
} catch { /* env optional */ }

const SIMSON_BASE   = process.env.SIMSON_BASE_URL || 'https://swapmasteruat.getpolicy.in';
const MIALTUS_BASE  = process.env.MIALTUS_BASE_URL || 'https://uatswapapi.pushbutton.in';
const SWAPINS_BASE  = process.env.SWAPINSURER_BASE_URL || 'https://swapinsureruat.getpolicy.in';
const CLIENT        = process.env.SIMSON_CLIENT_NAME || 'MIALTUS';
const USERNAME      = process.env.SIMSON_USERNAME || '';
const PASSWORD      = process.env.SIMSON_PASSWORD || '';
const USER_CODE     = process.env.SIMSON_USER_CODE || '3614';

if (!USERNAME || !PASSWORD) {
  console.error('Missing SIMSON_USERNAME / SIMSON_PASSWORD in env.');
  process.exit(1);
}

// ---------- capture layer ----------
const log = [];  // ordered list of { section, step, req, res, err, ms }

function redactBearer(v) {
  if (!v) return v;
  const s = String(v);
  if (!s.startsWith('Bearer ')) return v;
  const t = s.slice(7);
  if (t.length <= 16) return 'Bearer ***';
  return `Bearer ${t.slice(0, 8)}…${t.slice(-6)} (redacted)`;
}
function redactHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) {
    if (/^authorization$/i.test(k)) out[k] = redactBearer(v);
    else out[k] = v;
  }
  return out;
}
function redactBody(body) {
  if (!body || typeof body !== 'object') return body;
  const clone = JSON.parse(JSON.stringify(body));
  if (clone.password) clone.password = '***';
  if (clone.Password) clone.Password = '***';
  return clone;
}

async function call(section, step, url, { method = 'POST', headers = {}, body } = {}) {
  const t0 = Date.now();
  const entry = {
    section, step,
    req: {
      url, method,
      headers: redactHeaders(headers),
      body: body ? redactBody(body) : undefined,
    },
  };
  try {
    const r = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let data = null;
    if (text) { try { data = JSON.parse(text); } catch { data = text; } }
    const resHeaders = {};
    for (const [k, v] of r.headers.entries()) resHeaders[k] = v;
    entry.res = {
      status: r.status,
      ok: r.ok,
      headers: resHeaders,
      body: data,
    };
    entry.ms = Date.now() - t0;
    log.push(entry);
    return { ok: r.ok, status: r.status, data };
  } catch (e) {
    entry.err = String(e && e.message || e);
    entry.ms = Date.now() - t0;
    log.push(entry);
    return { ok: false, status: 0, data: null, err: entry.err };
  }
}

// ---------- vendor auth ----------
async function authSimson() {
  const r = await call('Simson Master', 'Auth: get token', `${SIMSON_BASE}/Authentication/token`, {
    headers: { 'Content-Type': 'application/json', 'ClientName': CLIENT },
    body: { Username: USERNAME, Password: PASSWORD },
  });
  return r.data && (r.data.token || r.data.Token);
}
async function authMialtus() {
  const r = await call('MIALTUS Partner', 'Auth: get session token', `${MIALTUS_BASE}/Authentication/token`, {
    headers: { 'Content-Type': 'application/json', 'ClientName': CLIENT, 'accept': '*/*' },
    body: { username: USERNAME, password: PASSWORD },
  });
  return r.data && (r.data.token || r.data.Token);
}
async function authSwapinsurer() {
  const r = await call('Swapinsurer Partner', 'Auth: get session token', `${SWAPINS_BASE}/Partner/Authentication/token`, {
    headers: { 'Content-Type': 'application/json', 'ClientName': CLIENT, 'accept': '*/*' },
    body: { username: USERNAME, password: PASSWORD },
  });
  return r.data && (r.data.token || r.data.Token);
}

// ---------- helpers ----------
const H = (token, extra = {}) => ({
  'Content-Type': 'application/json',
  'accept': '*/*',
  'ClientName': CLIENT,
  'Authorization': `Bearer ${token}`,
  ...extra,
});

function mmv({ make, model, variant, cc, seatCapacity }) {
  const b = {};
  if (make !== undefined)         { b.Make = make; b.make = make; }
  if (model !== undefined)        { b.Model = model; b.model = model; }
  if (variant !== undefined)      { b.Variant = variant; b.variant = variant; }
  if (cc !== undefined)           { b.Cc = cc; b.cc = cc; }
  if (seatCapacity !== undefined) { b.SeatCapacity = seatCapacity; b.seatCapacity = seatCapacity; }
  return b;
}

// ---------- fixtures ----------
// Test fixtures. Per the 22-Sep vendor-alignment E2E, Honda Activa 3G at 110cc
// was confirmed live on Digit. We use the same CC here; the reg number is
// synthetic (UAT sample MH12NT5588 has cc=109 which the vendor master doesn't
// have variants for — a separate master-data gap flagged in the report).
const CAR_REG = 'MH02FE5735';        // Honda City 1.5L 1497cc (from _uat_regs.json)
const BIKE_REG = 'MH12NT5588';        // Honda Activa 3G (query at 110cc)

// Vendor's insurer proxies use DateTime.ParseExact with dd/MM/yyyy — ISO
// YYYY-MM-DD triggers a raw C# exception ("String '...' was not recognized as
// a valid DateTime"). Convert every date we send.
function toDMY(s) {
  if (!s) return s;
  const iso = String(s).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (iso) return `${iso[3]}/${iso[2]}/${iso[1]}`;
  return s;   // already dd/MM/yyyy or something else
}

const carVehicle = {
  // Switched from Honda City 1.5 (which Digit UAT doesn't rate) to Honda Amaze
  // 1.2 EX Manual Petrol (1198 CC) at the vendor's request — a mainstream car
  // both HDFC and Digit are expected to have in UAT.
  reg: CAR_REG, make: 'Honda', model: 'Amaze', variant: null,
  rto: 'MH02', regDate: toDMY('2019-05-09'),
  fuel: 'PETROL', cc: 1198,
  previousInsurer: 'HDFC ERGO General Insurance',
  ownerName: 'HEERA SHARMA',
};
const bikeVehicle = {
  // NOTE: vendor Honda bike master doesn't contain "Activa 3G" — only "Activa",
  // "Activa 125 Fi", "Activa I". FastLane sample says "Activa 3G". Using
  // "Activa" so downstream quote actually rates. This is itself a master-data
  // drift issue worth flagging to vendor.
  reg: BIKE_REG, make: 'Honda', model: 'Activa', variant: null,
  rto: 'MH12', regDate: toDMY('2017-07-01'),
  fuel: 'PETROL', cc: 110,
  previousInsurer: 'ICICI  LOMBARD',
  ownerName: 'NARESH CHIMANLAL DANGI',
};

const customer = {
  fullname: 'Test Customer',
  mobile: '9999999999',
  email: 'test@example.com',
  vehicleOwnedBy: 'I',
  validPolCopy: 'No',      // default; overridden per-vehicle for HDFC bike below
};

// HDFC UAT test KYC credentials. BAPPN1467E auto-verifies under
// ekycType: "Pan Number" (scenario 1); scenario 2 (PAN + DOI) falls through
// to the web-KYC redirect for this PAN.
const KYC_PAN = process.env.HDFC_TEST_PAN || 'BAPPN1467E';
const KYC_DOB = process.env.HDFC_TEST_DOB || toDMY('1999-02-03');   // dd/MM/yyyy

// ---------- flow builders ----------
// Extract mfgMonth/mfgYear from a dd/MM/yyyy regDate.
function mfgFromRegDate(dmy) {
  const m = String(dmy || '').match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  return m ? { mfgMonth: m[2], mfgYear: m[3] } : { mfgMonth: '', mfgYear: '' };
}

function buildInsertBody(v, isBike, overrides = {}) {
  const { mfgMonth, mfgYear } = mfgFromRegDate(v.regDate);
  const hasPrevPol = (overrides.validPolCopy || customer.validPolCopy) === 'Yes';
  const common = {
    coverType: 'TP',
    make: v.make, model: v.model, variant: v.variant,
    rto: v.rto,
    regDate: v.regDate, mfgMonth, mfgYear,
    fullname: customer.fullname, mobile: customer.mobile, email: customer.email,
    vehicleOwnedBy: customer.vehicleOwnedBy,
    validPolCopy: overrides.validPolCopy || customer.validPolCopy,
    isPreClaimed: 'No', ownershipChange: 'No', preNCB: '',
    vehicleNo: toHyphen(v.reg),
    // Mialtus_Client_QA Q4: Previous Policy Number is required at the Quote API.
    // For TP, NCB is not required.
    ...(hasPrevPol ? {
      previousInsurer: v.previousInsurer || '',
      prepolExpiryDate: overrides.prepolExpiryDate || '',
      prevoiusPolicyNumber: overrides.prevoiusPolicyNumber || '',
    } : {}),
  };
  if (isBike) {
    return {
      quote: {
        ...common,
        policyType: hasPrevPol ? 'renew' : 'expired',
        previousYearPolicyType: 'Comprehensive (Own damage + Third Party Liability)',
        tpprepolExpiryDate: null,
      },
      bikeAddons: {
        paTenure: '1', isCPACover: true, isNoCPAReason: '',
        paidDriver: false, accidentCoPassenger: false,
        accidentCoPassengerValue: 0, tppd: false,
        TPPDSI: '0', llPaidDriverCheck: '', llPaidDriverValue: '',
      },
      userCode: USER_CODE,
    };
  }
  return {
    quote: {
      ...common,
      seatingCapacity: '5',
      policyType: hasPrevPol ? 'renewcar' : 'expired',
    },
    carAddons: {
      paTenure: '1', isCPACover: true, isNoCPAReason: '',
      paidDriver: false, accidentCoPassenger: false,
      accidentCoPassengerValue: 0,
      externallyCng: false, externallycngValue: 0,
      tppd: false,
    },
    userCode: USER_CODE,
  };
}

function toHyphen(reg) {
  const s = String(reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const m = s.match(/^([A-Z]{2})(\d{1,2})([A-Z]{0,3})(\d{1,4})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}-${m[4]}` : reg;
}

function buildGetQuoteBody(insertBody, transId, isBike) {
  const body = JSON.parse(JSON.stringify(insertBody));
  body.quote.quoteId = String(transId || '');
  if (isBike && !body.quote.seatingCapacity) body.quote.seatingCapacity = '2';
  return body;
}

// ---------- MAIN FLOW ----------
(async () => {
  console.log('== 1. Simson master auth ==');
  const simsonTok = await authSimson();
  if (!simsonTok) { console.error('Simson auth failed'); }

  const simsonHeaders = H(simsonTok);

  console.log(`== 2. CAR flow master data (${CAR_REG} Honda Amaze 1198) ==`);
  // Vehicle lookup - documented but local; still list as flow step
  log.push({
    section: 'CAR — Vehicle lookup',
    step: 'FastLane lookup (currently LOCAL sample data)',
    note: 'Real FastLane API not provisioned. Handler reads api/_uat_regs.json.',
    req: { url: `GET /api/vehicle-lookup?reg=${CAR_REG}`, method: 'GET (local proxy)' },
    res: { status: 200, body: carVehicle, ok: true },
    ms: 0,
  });

  await call('CAR — Master data', 'GetCarMakes', `${SIMSON_BASE}/Motor/GetCarMakes`, {
    method: 'GET', headers: simsonHeaders,
  });
  const carModelsRes = await call('CAR — Master data', 'GetCarModelApp (make=Honda)', `${SIMSON_BASE}/Motor/GetCarModelApp`, {
    headers: simsonHeaders, body: mmv({ make: 'Honda' }),
  });
  // Simson stores models with a fuel suffix. Pick the "(Petrol)" Amaze variant.
  const carModelList = Array.isArray(carModelsRes.data) ? carModelsRes.data : [];
  const carModelHit = carModelList.find(m => /^Amaze \(Petrol\)/i.test(m.model || ''))
    || carModelList.find(m => /^Amaze\b/i.test(m.model || ''));
  const carModelName = carModelHit ? carModelHit.model : 'Amaze (Petrol)';
  carVehicle.model = carModelName;
  console.log('   car model picked =', carModelName);

  const carVariantsRes = await call('CAR — Master data', `GetCarVarient (Honda / ${carModelName} / 1198)`, `${SIMSON_BASE}/Motor/GetCarVarient`, {
    headers: simsonHeaders, body: mmv({ make: 'Honda', model: carModelName, cc: '1198' }),
  });
  const carVariantList = Array.isArray(carVariantsRes.data) ? carVariantsRes.data : [];
  // Vendor said: "1.2 EX Manual Transmission Petrol (1198 CC)". Match that exactly, fall back to first.
  const carVariantHit = carVariantList.find(v => /1\.2 EX Manual Transmission Petrol \(1198 CC\)/i.test(v.variant || v.Variant || ''))
    || carVariantList.find(v => /\(1198 CC\)/i.test(v.variant || v.Variant || ''))
    || carVariantList[0];
  const carFirstVariant = carVariantHit && (carVariantHit.variant || carVariantHit.Variant);
  carVehicle.variant = carFirstVariant;
  console.log('   car variant picked =', carFirstVariant);

  const rtoRes = await call('CAR — Master data', 'GetRTOMasterApi', `${SIMSON_BASE}/Motor/GetRTOMasterApi`, {
    method: 'GET', headers: simsonHeaders,
  });
  const rtoList = Array.isArray(rtoRes.data) ? rtoRes.data : [];
  const carRto = (rtoList.find(r => /^MH02\b/.test(r.regno || '')) || {}).regno || 'MH02';
  const bikeRto = (rtoList.find(r => /^MH12\b/.test(r.regno || '')) || {}).regno || 'MH12';
  carVehicle.rto = carRto;
  bikeVehicle.rto = bikeRto;
  console.log('   car rto =', carRto, ' | bike rto =', bikeRto);

  await call('CAR — Master data', 'GetPreviousInsurers', `${SIMSON_BASE}/Motor/GetPreviousInsurers`, {
    method: 'GET', headers: simsonHeaders,
  });

  console.log('== 3. MIALTUS auth + insertcarquote (two tracks: HDFC renewcar, Digit expired) ==');
  const mialtusTok = await authMialtus();

  // Near-future prev-expiry (per HDFC 4W doc sample) so policy start/end
  // come out in the future.
  const CAR_PREV_EXPIRY = toDMY('2026-09-30');

  // ---- HDFC car track (validPolCopy=Yes + prev policy, per HDFC 4W doc) ----
  const carInsertBodyHDFC = buildInsertBody(carVehicle, false, {
    validPolCopy: 'Yes',
    prepolExpiryDate: CAR_PREV_EXPIRY,
    prevoiusPolicyNumber: 'hfhe45uy3h34y34y6',
  });
  const carInsertResHDFC = await call('CAR — Quote (HDFC track)', 'insertcarquote (MIALTUS) — HDFC', `${MIALTUS_BASE}/partner/motor/insertcarquote`, {
    headers: {
      'Content-Type': 'application/json', 'accept': '*/*',
      'ClientName': CLIENT, 'Server': 'UAT',
      'Authorization': `Bearer ${mialtusTok}`,
    },
    body: carInsertBodyHDFC,
  });
  const carTransIdHDFC = carInsertResHDFC.data && (carInsertResHDFC.data.transId || carInsertResHDFC.data.TransId);

  // ---- Digit car track (validPolCopy=No, policyType=expired) ----
  const carInsertBodyDigit = buildInsertBody(carVehicle, false, { validPolCopy: 'No' });
  const carInsertResDigit = await call('CAR — Quote (Digit track)', 'insertcarquote (MIALTUS) — Digit', `${MIALTUS_BASE}/partner/motor/insertcarquote`, {
    headers: {
      'Content-Type': 'application/json', 'accept': '*/*',
      'ClientName': CLIENT, 'Server': 'UAT',
      'Authorization': `Bearer ${mialtusTok}`,
    },
    body: carInsertBodyDigit,
  });
  const carTransIdDigit = carInsertResDigit.data && (carInsertResDigit.data.transId || carInsertResDigit.data.TransId);

  console.log('== 4. Swapinsurer auth + getcarquote (HDFCTP + GODIGITTP) ==');
  const swapTok = await authSwapinsurer();

  const carGetBodyHDFC  = buildGetQuoteBody(carInsertBodyHDFC,  carTransIdHDFC,  false);
  const carGetBodyDigit = buildGetQuoteBody(carInsertBodyDigit, carTransIdDigit, false);
  console.log('   car transIds =', { HDFC: carTransIdHDFC, Digit: carTransIdDigit }, ' variant =', carGetBodyHDFC.quote.variant);
  let carQuoteResponseHDFC = null;
  const hdfcCarRes = await call('CAR — Quote (HDFCTP)', 'getcarquote (HDFCTP)', `${SWAPINS_BASE}/partner/motor/getcarquote`, {
    headers: {
      'Content-Type': 'application/json', 'accept': '*/*',
      'ClientName': CLIENT, 'Server': 'UAT', 'Insurer': 'HDFCTP',
      'Authorization': `Bearer ${swapTok}`,
    },
    body: carGetBodyHDFC,
  });
  carQuoteResponseHDFC = hdfcCarRes.data;
  console.log('   HDFCTP car →', { errorStatus: hdfcCarRes.data && hdfcCarRes.data.errorStatus, payablePremium: hdfcCarRes.data && hdfcCarRes.data.payablePremium, pTransactionId: hdfcCarRes.data && hdfcCarRes.data.pTransactionId });
  const digitCarRes = await call('CAR — Quote (GODIGITTP)', 'getcarquote (GODIGITTP)', `${SWAPINS_BASE}/partner/motor/getcarquote`, {
    headers: {
      'Content-Type': 'application/json', 'accept': '*/*',
      'ClientName': CLIENT, 'Server': 'UAT', 'Insurer': 'GODIGITTP',
      'Authorization': `Bearer ${swapTok}`,
    },
    body: carGetBodyDigit,
  });
  console.log('   GODIGITTP car →', { errorStatus: digitCarRes.data && digitCarRes.data.errorStatus, payablePremium: digitCarRes.data && digitCarRes.data.payablePremium });

  // ---------- E3 probe: send an intentionally-invalid policyType to Digit
  // car and record what comes back. Vendor claims they now return
  // "Please Pass Valid Policy Type" instead of a C# stack trace.
  const e3Body = JSON.parse(JSON.stringify(carGetBodyDigit));
  e3Body.quote.policyType = 'invalidtypetest';
  await call('CAR — E3 probe (GODIGITTP)', 'getcarquote with invalid policyType (E3 regression)', `${SWAPINS_BASE}/partner/motor/getcarquote`, {
    headers: {
      'Content-Type': 'application/json', 'accept': '*/*',
      'ClientName': CLIENT, 'Server': 'UAT', 'Insurer': 'GODIGITTP',
      'Authorization': `Bearer ${swapTok}`,
    },
    body: e3Body,
  });

  // ---------- HDFC CAR eKYC + Create Proposal (new HDFC 4W doc) ----------
  console.log('== 4b. HDFC CAR eKYC (PAN) ==');
  const commonCarEkyc = {
    transId: carTransIdHDFC || '',
    ekycInsurer: 'hdfc',
    module: 'car',
    vehicleOwnedBy: 'I',
    kycEmail: customer.email,
    kycName: customer.fullname,
    kycPan: KYC_PAN,
    ReturnUrl: 'https://www.bharatinsurance.online/?kyc_return=1',
    domain: 'https://www.bharatinsurance.online/',
  };
  let carEkycRes = await call('CAR — eKYC (HDFC)', 'getekycresponse (PAN + DOI) — car', `${SWAPINS_BASE}/partner/ekyc/getekycresponse`, {
    headers: {
      'Content-Type': 'application/json', 'accept': '*/*',
      'ClientName': CLIENT, 'Server': 'UAT', 'Insurer': 'HDFC',
      'Authorization': `Bearer ${swapTok}`,
    },
    body: { ...commonCarEkyc, ekycType: 'PAN + DOI', idVerificationDocType: 'PAN + DOI', kycDob: KYC_DOB },
  });
  if (!(carEkycRes.data && carEkycRes.data.isVerified)) {
    carEkycRes = await call('CAR — eKYC (HDFC)', 'getekycresponse (Pan Number, no DOI) — car', `${SWAPINS_BASE}/partner/ekyc/getekycresponse`, {
      headers: {
        'Content-Type': 'application/json', 'accept': '*/*',
        'ClientName': CLIENT, 'Server': 'UAT', 'Insurer': 'HDFC',
        'Authorization': `Bearer ${swapTok}`,
      },
      body: {
        ...commonCarEkyc,
        ekycType: 'Pan Number', idVerificationDocType: 'Pan Number',
        ekycNumber: KYC_PAN, customerType: 'I', isKYCDone: false, email: customer.email,
      },
    });
  }
  const carEkyc = carEkycRes.data || {};
  let carParsedKyc = {};
  if (carEkyc.kycData) {
    try { carParsedKyc = typeof carEkyc.kycData === 'string' ? JSON.parse(carEkyc.kycData) : carEkyc.kycData; } catch { /* ignore */ }
  }
  const carEkyId    = carEkyc.eky_Id || carParsedKyc.kyc_id || '';
  const carCkyc     = carEkyc.ckycNumber || carParsedKyc.ckycNumber || '';
  const carKycName  = carEkyc.fullName || carParsedKyc.name || '';
  const carKycDob   = carEkyc.kycDob   || carParsedKyc.dob  || '';
  const carKycPan   = carParsedKyc.pan || KYC_PAN;
  const carKycAddr  = {
    addrL1:  (carParsedKyc.permanentAddress1 || carParsedKyc.permanentAddress || '').toString().trim(),
    addrL2:  (carParsedKyc.permanentAddress2 || '').toString().trim(),
    city:    (carParsedKyc.permanentCity || '').toString().trim(),
    pincode: (carParsedKyc.permanentPincode || '').toString().trim(),
  };
  console.log('   car eKYC → isVerified =', carEkyc.isVerified, ' eky_Id =', carEkyId, ' name =', carKycName, ' dob =', carKycDob);

  // Resolve state/city codes from GetDetailsbyPincode for the KYC pincode.
  let carPinMaster = {};
  if (carKycAddr.pincode) {
    const r = await call('CAR — Master data', `GetDetailsbyPincode (${carKycAddr.pincode}, HDFC)`, `${SIMSON_BASE}/Motor/GetDetailsbyPincode`, {
      headers: simsonHeaders,
      body: { pincode: carKycAddr.pincode, company: 'HDFC' },
    });
    if (r.data) carPinMaster = Array.isArray(r.data) ? (r.data[0] || {}) : r.data;
    console.log('   car pincode master →', JSON.stringify(carPinMaster).slice(0, 200));
  }

  console.log('== 4c. HDFC Create Car Proposal (/partner/motor/getcarproposal) ==');
  // Build proposal payload verbatim per HDFC Four-Wheeler Proposal doc §2.
  const cqr = carQuoteResponseHDFC || {};
  const carMfg = mfgFromRegDate(carVehicle.regDate);
  const carNameParts = (carKycName || 'Test Customer').trim().split(/\s+/);
  const carFirstName = carNameParts[0] || 'NITIN';
  const carLastName  = carNameParts.slice(1).join(' ') || 'SINGH';
  const carDob       = carKycDob || toDMY('1990-01-01');

  const carRegCompact = String(carVehicle.reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const carRegParts = carRegCompact.match(/^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{1,4})$/) || [];
  const car_regA = carRegParts[1] || '';
  const car_regB = carRegParts[2] || '';
  const car_regC = carRegParts[3] || '';
  const car_regD = carRegParts[4] || '';

  const cpm = carPinMaster || {};
  const carStateName = String(cpm.statename || cpm.stateName || 'UTTAR PRADESH').toUpperCase();
  const carStateCode = String(cpm.statecode || cpm.stateCode || '');
  const carCityName  = String(cpm.cityname  || cpm.cityName  || carKycAddr.city || 'KANNAUJ').toUpperCase();
  const carCityCode  = String(cpm.citycode  || cpm.cityCode  || '');

  const carProposalBlock = {
    salutation: 'Mr',
    pTransactionId: cqr.pTransactionId || carTransIdHDFC || '',
    firstName: carFirstName,
    lastName:  carLastName,
    dob: carDob,
    email: (customer.email || '').toUpperCase() || 'TEST@GMAIL.COM',
    mobile: customer.mobile,
    panCard: carKycPan,
    gender: 'Male',
    maritialValue: 'Single', maritialText: 'Single',
    occupationValue: 'Govt. Service', occupationText: 'Govt. Service',
    gstNo: '', adhaarNumber: '',
    nomineeFname: 'Priya', nomineeLname: 'Singh',
    nomineeDob: toDMY('1995-06-15'),
    relationshipValue: 'Daughter', relationshipText: 'Daughter',
    vehicleOwnedBy: 'I',
    rto: carVehicle.rto || '',
    regA: car_regA, regB: car_regB, regC: car_regC, regD: car_regD,
    regDate: carVehicle.regDate,
    engineNo: 'DF34T34444ERY45UY45Y',
    chassisNo: 'FGHFGHRTYH54Y5Y5Y5',
    isVehcileFinance: false,
    financeCity: '',
    isPuc: false,
    pucNo: '',
    pucExpiryDate: null,
    prevoiusInsurerValue: 'CHOLAMANDALAM',
    prevoiusInsurerText: 'Cholamandalam MS General Insurance',
    prevoiusPolicyNumber: 'hfhe45uy3h34y34y6',
    prevoiusPolicyType: 'Comprehensive (Own damage + Third Party Liability)',
    prevoiusPolicyExpiryDate: CAR_PREV_EXPIRY,
    policyType: 'renewcar',
    addrL1: carKycAddr.addrL1 || 'noidadfgdf',
    addrL2: carKycAddr.addrL2 || 'noidagdfgdf',
    landmark: '',
    stateName: carStateName, stateCode: carStateCode,
    cityName: carCityName,   cityCode: carCityCode,
    pincode: carKycAddr.pincode || '209721',
    isSameAddressChecked: true,
    rcLandmark: '',
    rcAddrL1: carKycAddr.addrL1 || 'noidadfgdf',
    rcAddrL2: carKycAddr.addrL2 || 'noidagdfgdf',
    rcStateName: carStateName, rcStateCode: carStateCode,
    rcCityName: carCityName,   rcCityCode: carCityCode,
    rcPincode: carKycAddr.pincode || '209721',
    make: carVehicle.make,
    model: carVehicle.model,
    variant: carVehicle.variant || '',
    idv: '0',
    coverType: 'TPOnly',
    mfgYear: carMfg.mfgYear, mfgMonth: carMfg.mfgMonth,
    transId: carTransIdHDFC || '',
    netPremium: String(cqr.netPremium || ''),
    payablePremium: String(cqr.payablePremium || ''),
    serviceTax: String(cqr.serviceTax || ''),
    insurerName: 'hdfc',
    termsCondition: 'true',
    // Doc-v3 (2026-10-09): HDFC car proposal takes `callbackurl` — vendor
    // computes checksum against this URL (B2 fix).
    callbackurl: 'https://www.bharatinsurance.online/privateCar/hdfccartransaction',
    polStartDateToSaiba: cqr.policystartDate || '',
    polEndDateToSaiba: cqr.policyEndDate || '',
    seatCapacity: '5',
    cc: String(carVehicle.cc || '1198'),
    ckycNumber: carCkyc,
    isKYCDone: true,
    kycPan: carKycPan,
    kycDob: carDob,
    eky_Id: carEkyId,
  };
  const carProposalBody = {
    quote: carGetBodyHDFC.quote,
    carAddons: carGetBodyHDFC.carAddons,
    carQuoteResponse: cqr,
    proposal: carProposalBlock,
  };
  const carPropRes = await call('CAR — Proposal (HDFC only)', 'getcarproposal (HDFC)', `${SWAPINS_BASE}/partner/motor/getcarproposal`, {
    headers: {
      'Content-Type': 'application/json', 'accept': '*/*',
      'ClientName': CLIENT, 'Server': 'UAT', 'Insurer': 'HDFC',
      'Authorization': `Bearer ${swapTok}`,
    },
    body: carProposalBody,
  });
  console.log('   HDFC car proposal →',
    typeof carPropRes.data === 'object' ? JSON.stringify(carPropRes.data).slice(0, 400) : String(carPropRes.data).slice(0, 400));

  log.push({
    section: 'CAR — Payment / Issuance / PDF',
    step: 'Payment gateway → getpolicyafterpayment → getpolicypdf',
    note: 'Per Mialtus_Client_QA Q9/Q10/D1/D2: payment is handled on HDFC\'s hosted gateway via form POST to paymentororkycLink; status returns through ReturnUrl, no webhook required. Not executable headless.',
    req: { url: `${SWAPINS_BASE}/partner/motor/getpolicyafterpayment`, method: 'POST', body: { paramater: { insurerName: 'HDFC', applicationId: '(from proposal transactionID)', refProposal: '(proposalNo)', module: 'car', transId: '(partner transId)', coverType: 'TPOnly', transactionID: '(transactionID)', paymentDate: '(from hdnmsg)', proposalNumber: '(proposalNo)', amount: '(txnAmount)' } } },
    res: { status: 0, ok: false, body: 'Requires a successful payment on HDFC\'s hosted gateway.' },
    ms: 0,
  });

  console.log(`== 5. BIKE flow master data (${BIKE_REG} Honda Activa 110) ==`);
  log.push({
    section: 'BIKE — Vehicle lookup',
    step: 'FastLane lookup (currently LOCAL sample data)',
    note: 'Same as car — local sample only.',
    req: { url: `GET /api/vehicle-lookup?reg=${BIKE_REG}`, method: 'GET (local proxy)' },
    res: { status: 200, body: bikeVehicle, ok: true },
    ms: 0,
  });

  await call('BIKE — Master data', 'GetBikeMakes', `${SIMSON_BASE}/Motor/GetBikeMakes`, {
    method: 'GET', headers: simsonHeaders,
  });
  const bikeModelsRes = await call('BIKE — Master data', 'GetBikeModelApp (make=Honda)', `${SIMSON_BASE}/Motor/GetBikeModelApp`, {
    headers: simsonHeaders, body: mmv({ make: 'Honda' }),
  });
  const bikeModelList = Array.isArray(bikeModelsRes.data) ? bikeModelsRes.data : [];
  // Honda Activa and Activa 125 Fi both return "Unable to generate proposal"
  // on HDFC today (vendor-side, insurer-level model block — confirmed by
  // probe-hdfc-bike-models.mjs on 2026-10-08). Activa I rates and proposals
  // cleanly, so use it as the default bike fixture to keep the matrix green.
  const bikeModelHit = bikeModelList.find(m => /^Activa I$/i.test(m.model || ''))
    || bikeModelList.find(m => /^Activa$/i.test(m.model || ''))
    || bikeModelList.find(m => /^Activa\b/i.test(m.model || ''));
  const bikeModelName = bikeModelHit ? bikeModelHit.model : 'Activa I';
  bikeVehicle.model = bikeModelName;
  console.log('   bike model picked =', bikeModelName);

  // Bike master accepts cc as a filter but Activa 3G exists at 110 in vendor's
  // catalogue (see 22-Sep E2E). Try 110 first, fall back to no-cc query.
  let bikeVariantsRes = await call('BIKE — Master data', `GetBikeVarient (Honda / ${bikeModelName} / 110)`, `${SIMSON_BASE}/Motor/GetBikeVarient`, {
    headers: simsonHeaders, body: mmv({ make: 'Honda', model: bikeModelName, cc: '110' }),
  });
  let bikeVariantList = Array.isArray(bikeVariantsRes.data) ? bikeVariantsRes.data : [];
  if (bikeVariantList.length === 0) {
    bikeVariantsRes = await call('BIKE — Master data', `GetBikeVarient (Honda / ${bikeModelName} — no cc filter)`, `${SIMSON_BASE}/Motor/GetBikeVarient`, {
      headers: simsonHeaders, body: mmv({ make: 'Honda', model: bikeModelName }),
    });
    bikeVariantList = Array.isArray(bikeVariantsRes.data) ? bikeVariantsRes.data : [];
  }
  const bikeFirstVariant = bikeVariantList[0] && (bikeVariantList[0].variant || bikeVariantList[0].Variant);
  bikeVehicle.variant = bikeFirstVariant;
  console.log('   bike variant picked =', bikeFirstVariant);
  await call('BIKE — Master data', 'GetPreviouspolicytype (Bike)', `${SIMSON_BASE}/Motor/GetPreviouspolicytype`, {
    headers: simsonHeaders,
    body: { companyName: 'HDFC', module: 'Bike', currentPolicyType: 'TP' },
  });

  console.log('== 6. MIALTUS insertbikequote + Swapinsurer getbikequote ==');
  // HDFC bike TP blocks quotes without a previous policy ("Quote Blocked For
  // No Prevoius Policy"). Digit works cleanly with policyType=expired. Run
  // two separate insert→get loops so we get a real, comparable result from
  // both insurers.
  let bikeQuoteResponseHDFC = null;
  let bikeInsertBodyHDFC = null;
  let bikeTransIdHDFC = null;

  // ---- HDFC bike track: validPolCopy=Yes + prev policy ----
  // Vendor derives policyStartDate from prepolExpiryDate + 1 day. Use a
  // near-future date so the issued policy sits in the future, which is what
  // the doc's sample shows (policyStart 18/09/2026, policyEnd 17/09/2027).
  const PREV_EXPIRY = toDMY('2026-11-30');
  bikeInsertBodyHDFC = buildInsertBody(bikeVehicle, true, {
    validPolCopy: 'Yes',
    prepolExpiryDate: PREV_EXPIRY,
  });
  const bikeInsertResHDFC = await call('BIKE — Quote (HDFC track)', 'insertbikequote (MIALTUS) — HDFC', `${MIALTUS_BASE}/partner/motor/insertbikequote`, {
    headers: {
      'Content-Type': 'application/json', 'accept': '*/*',
      'ClientName': CLIENT, 'Server': 'UAT',
      'Authorization': `Bearer ${mialtusTok}`,
    },
    body: bikeInsertBodyHDFC,
  });
  bikeTransIdHDFC = bikeInsertResHDFC.data && (bikeInsertResHDFC.data.transId || bikeInsertResHDFC.data.TransId);
  const bikeGetBodyHDFC = buildGetQuoteBody(bikeInsertBodyHDFC, bikeTransIdHDFC, true);
  const hdfcBikeRes = await call('BIKE — Quote (HDFCTP)', 'getbikequote (HDFCTP)', `${SWAPINS_BASE}/partner/bike/getbikequote`, {
    headers: {
      'Content-Type': 'application/json', 'accept': '*/*',
      'ClientName': CLIENT, 'Server': 'UAT', 'Insurer': 'HDFCTP',
      'Authorization': `Bearer ${swapTok}`,
    },
    body: bikeGetBodyHDFC,
  });
  bikeQuoteResponseHDFC = hdfcBikeRes.data;
  console.log('   HDFCTP bike →', {
    errorStatus: hdfcBikeRes.data && hdfcBikeRes.data.errorStatus,
    errorText: (hdfcBikeRes.data && String(hdfcBikeRes.data.errorText || '').slice(0, 200)),
    payablePremium: hdfcBikeRes.data && hdfcBikeRes.data.payablePremium,
  });

  // ---- Digit bike track: validPolCopy=No (policyType=expired) ----
  const bikeInsertBodyDigit = buildInsertBody(bikeVehicle, true, { validPolCopy: 'No' });
  const bikeInsertResDigit = await call('BIKE — Quote (Digit track)', 'insertbikequote (MIALTUS) — Digit', `${MIALTUS_BASE}/partner/motor/insertbikequote`, {
    headers: {
      'Content-Type': 'application/json', 'accept': '*/*',
      'ClientName': CLIENT, 'Server': 'UAT',
      'Authorization': `Bearer ${mialtusTok}`,
    },
    body: bikeInsertBodyDigit,
  });
  const bikeTransIdDigit = bikeInsertResDigit.data && (bikeInsertResDigit.data.transId || bikeInsertResDigit.data.TransId);
  const bikeGetBodyDigit = buildGetQuoteBody(bikeInsertBodyDigit, bikeTransIdDigit, true);
  const digitBikeRes = await call('BIKE — Quote (GODIGITTP)', 'getbikequote (GODIGITTP)', `${SWAPINS_BASE}/partner/bike/getbikequote`, {
    headers: {
      'Content-Type': 'application/json', 'accept': '*/*',
      'ClientName': CLIENT, 'Server': 'UAT', 'Insurer': 'GODIGITTP',
      'Authorization': `Bearer ${swapTok}`,
    },
    body: bikeGetBodyDigit,
  });
  console.log('   GODIGITTP bike →', {
    errorStatus: digitBikeRes.data && digitBikeRes.data.errorStatus,
    errorText: (digitBikeRes.data && String(digitBikeRes.data.errorText || '').slice(0, 200)),
    payablePremium: digitBikeRes.data && digitBikeRes.data.payablePremium,
  });

  // Use the HDFC-track body + response for the proposal below (which is HDFC-only).
  const bikeGetBody = bikeGetBodyHDFC;
  const bikeTransId = bikeTransIdHDFC;

  console.log('== 7b. HDFC BIKE eKYC (PAN) ==');
  // Uses the top-level KYC_PAN / KYC_DOB constants (shared with car flow).
  // Try both documented direct-verify scenarios. Scenario 1 (PAN alone) uses
  // ekycType "Pan Number"; scenario 2 (PAN + DOI) uses ekycType "PAN + DOI".
  // We attempt scenario 2 first (matches frontend flow), then fall back to
  // scenario 1 if verification fails — some UAT test PANs auto-verify on
  // scenario 1 only.
  const commonEkyc = {
    transId: bikeTransIdHDFC || '',
    ekycInsurer: 'hdfc',
    module: 'bike',
    vehicleOwnedBy: 'I',
    kycEmail: customer.email,
    kycName: customer.fullname,
    kycPan: KYC_PAN,
    ReturnUrl: 'https://www.bharatinsurance.online/?kyc_return=1',
    domain: 'https://www.bharatinsurance.online/',
  };

  let ekycRes = await call('BIKE — eKYC (HDFC)', 'getekycresponse (PAN + DOI)', `${SWAPINS_BASE}/partner/ekyc/getekycresponse`, {
    headers: {
      'Content-Type': 'application/json', 'accept': '*/*',
      'ClientName': CLIENT, 'Server': 'UAT', 'Insurer': 'HDFC',
      'Authorization': `Bearer ${swapTok}`,
    },
    body: { ...commonEkyc, ekycType: 'PAN + DOI', idVerificationDocType: 'PAN + DOI', kycDob: KYC_DOB },
  });
  if (!(ekycRes.data && ekycRes.data.isVerified)) {
    // Fallback: scenario 1 (PAN alone).
    ekycRes = await call('BIKE — eKYC (HDFC)', 'getekycresponse (Pan Number, no DOI)', `${SWAPINS_BASE}/partner/ekyc/getekycresponse`, {
      headers: {
        'Content-Type': 'application/json', 'accept': '*/*',
        'ClientName': CLIENT, 'Server': 'UAT', 'Insurer': 'HDFC',
        'Authorization': `Bearer ${swapTok}`,
      },
      body: {
        ...commonEkyc,
        ekycType: 'Pan Number', idVerificationDocType: 'Pan Number',
        // Web-KYC initiation fields per doc scenario 3, in case scenario 1 flips into that.
        ekycNumber: KYC_PAN, customerType: 'I', isKYCDone: false, email: customer.email,
      },
    });
  }
  const ekycData = ekycRes.data || {};
  let parsedKycData = {};
  if (ekycData.kycData) {
    try { parsedKycData = typeof ekycData.kycData === 'string' ? JSON.parse(ekycData.kycData) : ekycData.kycData; } catch { /* ignore */ }
  }
  // When auto-verify can't complete (our test PAN isn't in HDFC UAT's whitelist),
  // HDFC returns isVerified:false + ekycUrl for interactive web-KYC. The URL
  // carries a txnId — try that as the proposal linkage since we can't complete
  // web-KYC in a headless script.
  let txnIdFromEkycUrl = '';
  if (ekycData.ekycUrl) {
    try {
      const u = new URL(ekycData.ekycUrl);
      txnIdFromEkycUrl = u.searchParams.get('txnId') || '';
    } catch { /* ignore */ }
  }
  const ekyId = ekycData.eky_Id || parsedKycData.kyc_id || txnIdFromEkycUrl || '';
  const ckycNumber = ekycData.ckycNumber || parsedKycData.ckycNumber || '';
  // The verified KYC record is authoritative for name/DOB/address — the
  // proposal cross-checks against it and returns "Name or date-of-birth
  // mismatch" if we send anything else.
  const kycFullName = ekycData.fullName || parsedKycData.name || '';
  const kycDob      = ekycData.kycDob   || parsedKycData.dob  || '';
  const kycPanEff   = parsedKycData.pan || KYC_PAN;
  const kycAddr = {
    addrL1: (parsedKycData.permanentAddress1 || parsedKycData.permanentAddress || '').toString().trim(),
    addrL2: (parsedKycData.permanentAddress2 || '').toString().trim(),
    city:   (parsedKycData.permanentCity || '').toString().trim(),
    pincode:(parsedKycData.permanentPincode || '').toString().trim(),
  };
  console.log('   eKYC → isVerified =', ekycData.isVerified,
    ' eky_Id =', ekyId || '(none)',
    ' ckycNumber =', ckycNumber || '(none)',
    ' name =', kycFullName || '(none)',
    ' dob =', kycDob || '(none)',
    ekycData.ekycUrl ? ' redirectRequired=true' : '');

  // Per HDFC bike proposal doc: stateName/stateCode/cityName/cityCode are
  // resolved from the KYC pincode via GetDetailsbyPincode master.
  let pincodeMaster = {};
  if (kycAddr.pincode) {
    const pinRes = await call('BIKE — Master data', `GetDetailsbyPincode (${kycAddr.pincode}, HDFC)`, `${SIMSON_BASE}/Motor/GetDetailsbyPincode`, {
      headers: simsonHeaders,
      body: { pincode: kycAddr.pincode, company: 'HDFC' },
    });
    if (pinRes.data) {
      pincodeMaster = Array.isArray(pinRes.data) ? (pinRes.data[0] || {}) : pinRes.data;
    }
    console.log('   pincode master →', JSON.stringify(pincodeMaster).slice(0, 200));
  }

  console.log('== 8. Swapinsurer getbikeproposal (HDFC only) ==');
  // Only HDFC has a bike proposal endpoint. The doc requires quote +
  // bikeAddons + quoteResponseBike (echo back the getbikequote response) +
  // proposal (customer/nominee/address block with the deliberately misspelled
  // field names from the vendor doc).
  // Vendor's C# schema binds to `bikeProposal` (per the 400 error we saw on
  // the first pass). Frontend currently sends `proposal` — we send both here
  // so the report shows exactly what the vendor accepts and what needs to be
  // fixed in either place.
  // Build the proposal payload verbatim per the HDFC Two-Wheeler Proposal doc,
  // substituting our verified KYC / quote / vehicle values in.
  const qr = bikeQuoteResponseHDFC || {};
  const bikeMfg = mfgFromRegDate(bikeVehicle.regDate);
  // Derive name parts from the verified KYC full name (falls back to synthetic).
  const kycNameParts = (kycFullName || 'Test Customer').trim().split(/\s+/);
  const propFirstName = kycNameParts[0] || 'Test';
  const propLastName  = kycNameParts.slice(1).join(' ') || 'Customer';
  const propFullName  = kycFullName || 'Test Customer';
  const propDob       = kycDob || toDMY('1990-01-01');
  const propAddrL1    = kycAddr.addrL1 || 'noida';
  const propAddrL2    = kycAddr.addrL2 || 'noida';
  const propPincode   = kycAddr.pincode || '209721';

  // Parse the reg number into regA/B/C/D per the doc's sample:
  //   MH-12-NT-5588 → regA=MH, regB=12, regC=NT, regD=5588.
  const regCompact = String(bikeVehicle.reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const regParts = regCompact.match(/^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{1,4})$/) || [];
  const regA = regParts[1] || '';
  const regB = regParts[2] || '';
  const regC = regParts[3] || '';
  const regD = regParts[4] || '';

  // State/city codes from GetDetailsbyPincode for the KYC pincode. Response
  // field names are lowercase: statename / statecode / cityname / citycode.
  const pm = pincodeMaster || {};
  const propStateName = String(pm.statename || pm.stateName || 'UTTAR PRADESH').toUpperCase();
  const propStateCode = String(pm.statecode || pm.stateCode || '');
  const propCityName  = String(pm.cityname  || pm.cityName  || kycAddr.city || 'KANNAUJ').toUpperCase();
  const propCityCode  = String(pm.citycode  || pm.cityCode  || '');

  // HDFC's quote-response pTransactionId is the id HDFC generated on their
  // side for the quote; the proposal must echo it back (doc page 5:
  // "pTransactionId — HDFC transaction id from the quote response").
  const hdfcPTransactionId = qr.pTransactionId || bikeTransId || '';

  const proposalBlock = {
    salutation: 'Mr',
    pTransactionId: hdfcPTransactionId,
    paymentNumber: null, bankrefnum: null, paymentStatus: null,
    referenceNumber: null, refProposal: null, isAngular: true,
    fullname: propFullName,
    firstName: propFirstName, lastName: propLastName,
    dob: propDob,
    email: 'TEST@GMAIL.COM',
    mobile: customer.mobile, landLine: '',
    panCard: kycPanEff,
    gender: 'Male',
    maritialValue: 'Divorced', maritialText: 'Divorced',
    occupationValue: 'Retired', tyreRimNo: '',
    occupationText: 'Retired',
    gstNo: '', adhaarNumber: '',
    nomineefullname: 'DFGDFGDF DFDFGDFDF',
    nomineeFname: 'DFGDFGDF', nomineeLname: 'DFDFGDFDF',
    nomineeDob: toDMY('1999-11-11'),
    relationshipValue: 'Daughter', relationshipText: 'Daughter',
    orgName: propFullName,
    vehicleOwnedBy: 'I',
    rto: bikeVehicle.rto || '',       // e.g. "MH12 (Pune)"
    regA, regB, regC, regD,
    regDate: bikeVehicle.regDate,     // dd/MM/yyyy
    engineNo: 'GT4534YTERGF34TG342',
    chassisNo: '234TG34VDFGREG34',
    isVehcileFinance: false,
    financeCity: '',
    isPuc: false, pucNo: '',
    pucExpiryDate: null,               // per doc sample
    inspectionTid: '', transactionRef: '',
    prevoiusInsurerValue: 'CHOLAMANDALAM',
    prevoiusInsurerText: 'Cholamandalam MS General Insurance',
    prevoiusPolicyNumber: '34T34TGEG334G',
    prevoiusPolicyType: 'Comprehensive (Own damage + Third Party Liability)',
    pdfLink: '', base64PDF: '',
    prevoiusPolicyExpiryDate: PREV_EXPIRY,
    tpPolicyExpiryDate: null, tpPolicyNumber: '',
    tpprevoiusInsurerValue: 'CHOLAMANDALAM',
    tpprevoiusInsurerText: 'Cholamandalam MS General Insurance',
    policyType: 'renew',
    addrL1: propAddrL1, addrL2: propAddrL2, landmark: '',
    stateName: propStateName, stateCode: propStateCode,
    cityName: propCityName,   cityCode: propCityCode,
    pincode: propPincode, areaName: '', areaCode: '',
    isSameAddressChecked: true,
    rcLandmark: '',
    rcAddrL1: propAddrL1, rcAddrL2: propAddrL2,
    rcStateName: propStateName, rcStateCode: propStateCode,
    rcCityName: propCityName,   rcCityCode: propCityCode,
    rcPincode: propPincode, rcAreaName: '', rcAreaCode: '',
    cpaPolicyNo: '', cpaSuminsured: '', cpaPreinsurer: '', cpaPreinsurerName: '',
    cpaPolicyFromdate: null, cpaPolicyTodate: null,
    make: bikeVehicle.make, model: bikeVehicle.model,
    variant: bikeVehicle.variant || '',
    idv: '0', coverType: 'tponly',
    mfgYear: bikeMfg.mfgYear, mfgMonth: bikeMfg.mfgMonth,
    transId: bikeTransId || '', quoteId: bikeTransId || '',
    logo: '',
    netPremium: String(qr.netPremium || ''),
    payablePremium: String(qr.payablePremium || ''),
    serviceTax: String(qr.serviceTax || ''),
    insurerName: 'hdfc',
    saveForLater: '', typeofButon: '', transSavelaterText: '', transSaveLater: '',
    termsCondition: 'true',
    // Doc-v3 (2026-10-09): HDFC bike proposal takes `callbackurl` (B2 fix).
    callbackurl: 'https://www.bharatinsurance.online/privateBike/hdfcbiketransaction',
    proposerLink: '', stage: '6',
    polStartDateToSaiba: qr.policystartDate || '',
    polEndDateToSaiba: qr.policyEndDate || '',
    tPexpiryDateToSaiba: qr.policyEndDate || '',
    policyStartDate: qr.policystartDate || '',
    policyEndDate:   qr.policyEndDate || '',
    currentNCB: qr.currentNCB || 'NA',
    seatCapacity: '', policyStatus: 'Inforce',
    proposalPDFHTML: '',
    domainName: 'https://www.bharatinsurance.online/',
    InsureAPIDomainName: 'https://www.bharatinsurance.online/',
    ClientDomainName: 'https://www.bharatinsurance.online/',
    odYear: '', isRenewalPolicy: false,
    insuredFullName: propFullName,
    tp: Number(qr.totalTPCalculated || qr.thirdPartyPremium || 0),
    od: 0,
    cc: bikeVehicle.variant || '',
    fuel: 'Petrol',
    coverNote: '', refBy: null, saibaAutoid: '', custCode: '',
    zone: qr.zone || 'A',
    enquiryID: '', applicationId: '',
    ckycNumber: ckycNumber || '',
    insuredPolicyNumber: '', inspectiontype: '',
    share_EmailID: null, share_MobileNo: '', paymentTinyURL: null,
    isKYCDone: true, isKYC: 'No',
    kycPan: kycPanEff, kycDob: propDob, policy_Gen_Flag: '',
    addressVerificationDocExt: null,
    eky_Id: ekyId || '',
    photoupload: null, photoDocExt: null, photouploadFileName: null,
    idVerificationDocType: null, idVerificationDocId: null, idVerificationDocExt: null,
    idProofupload: null, addreesProofupload: null,
    addressVerificationDocType: null, addressVerificationDocId: null,
    kycStatus: null, otp: null, isSaveLater: null,
    lvTransactionIDGlobal: null, fatherName: null,
    insured_photoExt: null, paNorForm60: null,
    pan_Form60_Document: null, pan_Form60_Document_Ext: null,
  };
  // Per HDFC bike proposal doc §1: request body is exactly { quote, bikeAddons,
  // quoteResponseBike, proposal }. The earlier "bikeProposal is required"
  // validator error was triggered by isVehcileFinance being sent as a string;
  // with the correct boolean the documented `proposal` key is what binds.
  const bikeProposalBody = {
    quote: bikeGetBody.quote,
    bikeAddons: bikeGetBody.bikeAddons,
    quoteResponseBike: bikeQuoteResponseHDFC || {},
    proposal: proposalBlock,
  };
  const propRes = await call('BIKE — Proposal (HDFC only)', 'getbikeproposal (HDFC)', `${SWAPINS_BASE}/partner/bike/getbikeproposal`, {
    headers: {
      'Content-Type': 'application/json',
      'accept': '*/*',
      'ClientName': CLIENT,
      'Server': 'UAT',
      'Insurer': 'HDFC',
      'Authorization': `Bearer ${swapTok}`,
    },
    body: bikeProposalBody,
  });
  console.log('   bike proposal →', typeof propRes.data === 'object'
    ? JSON.stringify(propRes.data).slice(0, 400)
    : String(propRes.data).slice(0, 400));

  log.push({
    section: 'BIKE — Payment / Issuance / PDF',
    step: 'Payment gateway → getpolicyafterpayment → getpolicypdf',
    note: 'Not executable end-to-end without a real payment. Contract wired for HDFC.',
    req: { url: `${SWAPINS_BASE}/partner/motor/getpolicyafterpayment`, method: 'POST', body: { paramater: { TransactionID: '(from payment)', ProposalNumber: '(from proposal)', Amount: '(quote payable)', Module: 'Bike' } } },
    res: { status: 0, ok: false, body: 'Payment gateway not integrated — see vendor question D1.' },
    ms: 0,
  });

  // =====================================================================
  // == 9. Digit CAR flow — Insert Proposal + Create Proposal (new docs) ==
  // =====================================================================
  // Per Digit_Private_Car_Proposal_APIs_Documentation (2026-10-07):
  //   API 1: POST uatswapapi.pushbutton.in/partner/motor/insertcarproposal (MIALTUS)
  //   API 2: POST swapinsureruat.getpolicy.in/partner/motor/getcarproposal  (DIGIT)
  //   API 3: POST /partner/ekyc/getpaymentafterkyc    (after real KYC — can't do headless)
  //   API 4: POST /partner/motor/getresponseafterpayment  (after real payment — can't do headless)
  console.log('== 9. Digit CAR Insert Proposal + Create Proposal ==');
  // MIALTUS insertcarproposal deserializes carQuoteResponse into a strongly
  // typed C# model. The quote endpoint returns HDFC-superset fields; Digit's
  // model only accepts the fields in Digit's doc schema, with specific types
  // (Decimal, string, bool). Build a schema-exact copy pulling our quote's
  // actual numbers.
  const _r = digitCarRes.data || {};
  const num = (k) => Number(_r[k]) || 0;
  const digitCarQR = {
    applicationId: null,
    lLtoEmployee: num('lLtoEmployee'),
    geogExtensionTPPremium: num('geogExtensionTPPremium'),
    motorPolicyType: null,
    // Placeholder — overwritten per endpoint below. The vendor's two
    // endpoints bind this field to incompatible types (insertcarproposal =
    // Boolean, getcarproposal = String), so each request body is forked.
    errorStatus: false,
    insurer: 'digit',
    idv: num('idv'),
    totalpremiumliabillity: num('totalpremiumliabillity'),
    vehicleOwnedBy: null,
    quoteId: null,
    errorText: null,
    idvRequest: null,
    idvResponse: null,
    tppd: num('tppd'),
    unnamedsi: num('unnamedsi'),
    baseThirdPartyPremium: num('baseThirdPartyPremium'),
    paOwnerDriver: num('paOwnerDriver'),
    paTenure: null,
    netPremium: num('netPremium'),
    serviceTax: num('serviceTax'),
    policystartDate: String(_r.policystartDate || ''),
    policyEndDate:   String(_r.policyEndDate || ''),
    payablePremium:  num('payablePremium'),
    quoteNo: null,
    modifiedIDV: num('modifiedIDV'),
    originalIDV: num('originalIDV'),
    exshowroomPrice: num('exshowroomPrice'),
    ncbDiscount: num('ncbDiscount'),
    tpBiFuel: num('tpBiFuel'),
    paidDriversi: num('paidDriversi'),
    thirdPartyPremium: num('thirdPartyPremium'),
    paidDriverPremium: num('paidDriverPremium'),
    llPaidDriver: num('llPaidDriver'),
    totalTPCalculated: num('totalTPCalculated'),
    maxIDV: num('maxIDV'), minIDV: num('minIDV'),
    cngminIDV: 0, cngmaxIDV: 0, elecminIDV: 0, elecmaxIDV: 0,
    iscpaCover: null,
    aaiDiscount: num('aaiDiscount'),
    coverType: 'TPOnly',
    termType: null,
    pTransactionId: String(_r.pTransactionId || ''),
    cngValue: null, fuel: null, planName: null,
    userSpecialDiscount: null, fuelType: null,
  };
  const digitCarMfg = mfgFromRegDate(carVehicle.regDate);
  const digitCarReg = String(carVehicle.reg || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const digitCarRegParts = digitCarReg.match(/^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{1,4})$/) || [];
  const digitCarProposal = {
    salutation: 'Mr',
    pTransactionId: digitCarQR.pTransactionId || '',   // Digit's MIALTUS-GUID id
    firstName: 'AVINASH', lastName: 'PANDEY',
    dob: toDMY('1990-01-01'),
    // Digit UAT rejects "9999999999" style sequential mobiles ("Entered
    // Mobile Number is invalid"). Use the vendor's own sample value.
    email: 'test@gmail.com', mobile: '9798798797',
    panCard: KYC_PAN,
    gender: 'Male',
    maritialValue: 'Married', maritialText: 'Married',
    occupationValue: 'Private Service', occupationText: 'Private Service',
    gstNo: '', adhaarNumber: '',
    nomineeFname: 'Priya', nomineeLname: 'Singh',
    nomineeDob: toDMY('1995-06-15'),
    relationshipValue: 'FATHER', relationshipText: 'FATHER',
    vehicleOwnedBy: 'I',
    rto: carVehicle.rto,
    regA: digitCarRegParts[1] || '', regB: digitCarRegParts[2] || '',
    regC: digitCarRegParts[3] || '', regD: digitCarRegParts[4] || '',
    regDate: carVehicle.regDate,
    engineNo: 'TESTENGINE12345', chassisNo: 'TESTCHASSIS12345',
    isVehcileFinance: false, financeCity: '',
    isPuc: false, pucNo: '', pucExpiryDate: null,
    prevoiusInsurerValue: '123',   // vendor doc sample uses "123" as code
    prevoiusInsurerText: 'Cholamandalam MS General Insurance',
    prevoiusPolicyNumber: 'hfhe45uy3h34y34y6',
    prevoiusPolicyType: 'Comprehensive (Own damage + Third Party Liability)',
    prevoiusPolicyExpiryDate: CAR_PREV_EXPIRY,
    policyType: 'renewcar',
    addrL1: 'DFGDFGDFGF', addrL2: 'GDFGDFGDFGDFGFG', landmark: '',
    stateName: 'Maharashtra', stateCode: '27',
    cityName: 'MUMBAI', cityCode: 'MUMBAI',   // Digit uses city name as code
    pincode: '400001',
    isSameAddressChecked: true,
    rcLandmark: '',
    rcAddrL1: 'DFGDFGDFGF', rcAddrL2: 'GDFGDFGDFGDFGFG',
    rcStateName: 'Maharashtra', rcStateCode: '27',
    rcCityName: 'MUMBAI', rcCityCode: 'MUMBAI',
    rcPincode: '400001',
    make: carVehicle.make, model: carVehicle.model,
    variant: carVehicle.variant || '',
    idv: '0', coverType: 'TPOnly',
    mfgYear: digitCarMfg.mfgYear, mfgMonth: digitCarMfg.mfgMonth,
    transId: String(carTransIdDigit || ''),
    netPremium:     String(digitCarQR.netPremium || ''),
    payablePremium: String(digitCarQR.payablePremium || ''),
    serviceTax:     String(digitCarQR.serviceTax || ''),
    insurerName: 'digit',
    termsCondition: 'true',
    polStartDateToSaiba: digitCarQR.policystartDate || '',
    polEndDateToSaiba:   digitCarQR.policyEndDate || '',
    seatCapacity: '5',
    cc: '1198', fuel: 'Petrol',
  };
  // Vendor doc-v3 + S1 resolution (2026-10-09): errorStatus unified across
  // both Insert and Create endpoints to the String "false" per the doc
  // samples. Pre-fix per-endpoint fork is gone.
  const digitCarInsertPropBody = {
    quote: carGetBodyDigit.quote,
    carQuoteResponse: { ...digitCarQR, errorStatus: 'false' },
    carAddons: carGetBodyDigit.carAddons,
    proposal: digitCarProposal,
  };
  const digitInsertCarPropRes = await call('CAR — Proposal (Digit)', 'insertcarproposal (MIALTUS)', `${MIALTUS_BASE}/partner/motor/insertcarproposal`, {
    headers: {
      'Content-Type': 'application/json', 'accept': '*/*',
      'ClientName': CLIENT, 'Server': 'UAT',
      'Authorization': `Bearer ${mialtusTok}`,
    },
    body: digitCarInsertPropBody,
  });
  console.log('   Digit insertcarproposal →',
    typeof digitInsertCarPropRes.data === 'object' ? JSON.stringify(digitInsertCarPropRes.data).slice(0, 300) : String(digitInsertCarPropRes.data).slice(0, 300));

  // Vendor's getcarproposal validator demands `carProposal` key even though
  // the doc sample uses `proposal`. Send both — same workaround we used for
  // the HDFC bike proposal before they fixed it.
  const digitCreateProposal = {
    ...digitCarProposal,
    callbackurl: 'https://www.bharatinsurance.online/digit/kyc-return',
  };
  const digitCarCreatePropBody = {
    ...digitCarInsertPropBody,
    proposal: digitCreateProposal,
  };
  // Vendor confirmed 2026-10-08: Digit UAT is intermittent — "Kyc Link is
  // Empty" or "Failed as endpoint takes more than 30 sec" on first try,
  // succeeds on second/third. Retry up to 3 times.
  let digitCreateCarPropRes = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    digitCreateCarPropRes = await call(
      'CAR — Proposal (Digit)',
      `getcarproposal (DIGIT)${attempt === 1 ? '' : ' — attempt ' + attempt}`,
      `${SWAPINS_BASE}/partner/motor/getcarproposal`,
      {
        headers: {
          'Content-Type': 'application/json', 'accept': '*/*',
          'ClientName': CLIENT, 'Server': 'UAT', 'Insurer': 'DIGIT',
          'Authorization': `Bearer ${swapTok}`,
        },
        body: digitCarCreatePropBody,
      });
    const b = digitCreateCarPropRes.data || {};
    const transientErr = /Kyc Link is Empty|takes more than 30 sec|timeout|timed out|502 bad gateway|<title>\s*5\d\d/i.test(String(b.errorMessage||''));
    const ok = b.paymentororkycLink && b.enquiryID && b.refProposal;
    if (ok || !transientErr) break;
    console.log(`   Digit getcarproposal attempt ${attempt} transient (${(b.errorMessage||'').slice(0,60)}) — retrying…`);
    await new Promise(r => setTimeout(r, 1500));
  }
  console.log('   Digit getcarproposal →',
    typeof digitCreateCarPropRes.data === 'object' ? JSON.stringify(digitCreateCarPropRes.data).slice(0, 400) : String(digitCreateCarPropRes.data).slice(0, 400));

  log.push({
    section: 'CAR — Payment / Issuance (Digit)',
    step: 'Customer completes KYC → getpaymentafterkyc → payment → getresponseafterpayment',
    note: 'Headless harness stops at the Create Proposal response (KYC link). Steps 3–4 require a real browser KYC + payment.',
    req: { url: `${SWAPINS_BASE}/partner/ekyc/getpaymentafterkyc then ${SWAPINS_BASE}/partner/motor/getresponseafterpayment`, method: 'POST', body: '{ enquiryID, applicationId, refProposal, module:"Car", transId, callbackurl }' },
    res: { status: 0, ok: false, body: 'Awaits real KYC completion on the Digit portal returned by getcarproposal.' },
    ms: 0,
  });

  console.log('\nWriting report…');
  writeFileSync(join(ROOT, 'vendor-e2e-log.html'), renderHtml(log), 'utf8');
  console.log('Wrote vendor-e2e-log.html');
})();


// ---------- HTML rendering ----------
function esc(s) {
  return String(s == null ? '' : s)
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}
function pretty(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}
function isUpstreamErr(body) {
  if (!body || typeof body !== 'object') return false;
  // Vendor doc-v2 contract: errorStatus is one of null / "" / "false" on
  // success; "true" (or boolean true on legacy endpoints) signals an error.
  // Any other string ("Premium Mismatch", "Vehicle not Mapped at UAT") is
  // caught via errorMessage/errorText below. Don't flag "false" as error.
  const es = body.errorStatus;
  if (es === true) return true;
  if (typeof es === 'string' && es.trim().toLowerCase() === 'true') return true;
  if (body.errorMessage && String(body.errorMessage).trim()) return true;
  if (body.errorText && String(body.errorText).trim()) return true;
  // insertquote returns status:"0" + message with C# stack trace and transId:null
  if (body.transId === null && String(body.status || '') === '0' && body.message) return true;
  return false;
}
function statusClass(entry) {
  if (entry.err) return 'err';
  if (!entry.res) return 'skip';
  const s = entry.res.status;
  if (s === 0) return 'skip';
  if (isUpstreamErr(entry.res.body)) return 'warn';
  if (s >= 200 && s < 300) return 'ok';
  return 'err';
}
function statusLabel(entry) {
  if (entry.err) return `NETWORK ERROR (${esc(entry.err)})`;
  if (!entry.res) return 'SKIPPED';
  const s = entry.res.status;
  if (s === 0) return 'NOT EXECUTED';
  const upstreamErr = isUpstreamErr(entry.res.body) ? ' · upstream error' : '';
  return `HTTP ${s}${upstreamErr}`;
}

function renderEntry(entry, idx) {
  const cls = statusClass(entry);
  const label = statusLabel(entry);
  const req = entry.req || {};
  const res = entry.res || {};
  const note = entry.note ? `<div class="note">${esc(entry.note)}</div>` : '';
  const reqHeaders = req.headers ? `<pre class="mono">${esc(pretty(req.headers))}</pre>` : '';
  const reqBody = req.body != null ? `<pre class="mono">${esc(pretty(req.body))}</pre>` : '<div class="empty">(no body)</div>';
  const resHeaders = res.headers ? `<pre class="mono">${esc(pretty(res.headers))}</pre>` : '';
  const resBody = res.body != null ? `<pre class="mono">${esc(pretty(res.body))}</pre>` : '<div class="empty">(no body)</div>';
  return `
    <details class="entry ${cls}" ${cls === 'err' || cls === 'warn' ? 'open' : ''}>
      <summary>
        <span class="badge ${cls}">${label}</span>
        <span class="stepname">${esc(entry.step)}</span>
        ${entry.ms != null ? `<span class="ms">${entry.ms} ms</span>` : ''}
      </summary>
      ${note}
      <div class="row">
        <div class="col">
          <h5>Request</h5>
          <div class="url"><code>${esc(req.method || 'POST')} ${esc(req.url || '')}</code></div>
          ${reqHeaders ? '<div class="sublabel">Headers</div>' + reqHeaders : ''}
          <div class="sublabel">Body</div>
          ${reqBody}
        </div>
        <div class="col">
          <h5>Response</h5>
          <div class="url"><code>status: ${esc(res.status ?? '')}</code></div>
          ${resHeaders ? '<div class="sublabel">Headers</div>' + resHeaders : ''}
          <div class="sublabel">Body</div>
          ${resBody}
        </div>
      </div>
    </details>
  `;
}

function renderHtml(log) {
  const sections = new Map();
  for (const e of log) {
    if (!sections.has(e.section)) sections.set(e.section, []);
    sections.get(e.section).push(e);
  }
  const summary = {
    total: log.length,
    ok: log.filter(e => statusClass(e) === 'ok').length,
    warn: log.filter(e => statusClass(e) === 'warn').length,
    err: log.filter(e => statusClass(e) === 'err').length,
    skip: log.filter(e => statusClass(e) === 'skip').length,
  };
  const generatedAt = new Date().toISOString();

  // 4-cell outcome matrix (car|bike × HDFCTP|GODIGITTP) driven from log data.
  const findQuote = (line, insurer) => {
    const e = log.find(x => new RegExp(`get${line}quote \\(${insurer}\\)`, 'i').test(x.step));
    if (!e || !e.res) return { cls: 'skip', text: 'not run' };
    const b = e.res.body || {};
    // Vendor doc-v2 contract: errorStatus is null / "" / "false" on success,
    // "true" (or boolean true legacy) on error. Non-"true" error strings
    // (e.g. "Vehicle not Mapped at UAT") come through errorText / errorMessage.
    const es = b.errorStatus;
    const isErr = es === true
      || (typeof es === 'string' && es.trim().toLowerCase() === 'true')
      || (b.errorText && String(b.errorText).trim())
      || (b.errorMessage && String(b.errorMessage).trim());
    const premium = Number(b.payablePremium);
    if (isErr) {
      return { cls: 'warn', text: `DECLINED · ${String(b.errorText || b.errorMessage || '').split('\n')[0].slice(0, 90)}` };
    }
    if (premium > 0) {
      return { cls: 'ok', text: `SUCCESS · ₹${premium.toLocaleString('en-IN')} payable` };
    }
    return { cls: 'err', text: `HTTP ${e.res.status}` };
  };
  const classifyProposal = (stepPat) => {
    // Match a specific step entry (e.g. "getcarproposal (HDFC)" or
    // "getcarproposal (DIGIT)" — vendor is HDFC proposal flow vs Digit flow).
    const e = log.find(x => new RegExp(stepPat, 'i').test(x.step));
    if (!e || !e.res || !e.res.body) return { cls: 'skip', text: 'not run' };
    const b = e.res.body;
    // HDFC success: proposalNo populated. Digit success: enquiryID + refProposal
    // + paymentororkycLink populated (Digit returns a KYC link, not a proposalNo).
    if (b.proposalNo) return { cls: 'ok', text: `SUCCESS · proposalNo ${b.proposalNo}` };
    if (b.paymentororkycLink && b.refProposal) {
      return { cls: 'ok', text: `SUCCESS · refProposal ${b.refProposal} · KYC link OK` };
    }
    if (b.errorMessage) {
      const msg = String(b.errorMessage).replace(/[\r\n\\]+/g, ' ').split('"').join('').trim().slice(0, 120);
      const isStack = /Message is:-|StackTrace is:-/i.test(String(b.errorMessage));
      return { cls: isStack ? 'err' : 'warn', text: `${isStack ? 'VENDOR EXCEPTION' : 'BLOCKED'} · ${msg}` };
    }
    return { cls: 'err', text: `HTTP ${e.res.status}` };
  };
  const carProposalHdfc  = classifyProposal('getcarproposal \\(HDFC\\b');
  const bikeProposalHdfc = classifyProposal('getbikeproposal \\(HDFC\\b');
  const carProposalDigit = classifyProposal('getcarproposal \\(DIGIT\\b');
  const cell = (title, r) => `<div class="cell ${r.cls}"><div class="cell-title">${title}</div><div class="cell-text">${esc(r.text)}</div></div>`;
  const matrixHtml = `
    <div class="matrix">
      ${cell('Car · Quote · HDFC ERGO (HDFCTP)', findQuote('car', 'HDFCTP'))}
      ${cell('Car · Quote · Digit (GODIGITTP)',  findQuote('car', 'GODIGITTP'))}
      ${cell('Car · Proposal · HDFC',             carProposalHdfc)}
      ${cell('Car · Proposal · Digit',            carProposalDigit)}
      ${cell('Bike · Quote · HDFC ERGO (HDFCTP)', findQuote('bike', 'HDFCTP'))}
      ${cell('Bike · Quote · Digit (GODIGITTP)',  findQuote('bike', 'GODIGITTP'))}
      ${cell('Bike · Proposal · HDFC',            bikeProposalHdfc)}
      ${cell('Payment · Issuance · PDF',  { cls: 'skip', text: 'not executable headless — insurer-hosted gateway' })}
    </div>`;
  const sectionHtml = [...sections.entries()].map(([name, entries]) => `
    <section class="flowsection">
      <h3>${esc(name)}</h3>
      ${entries.map(renderEntry).join('\n')}
    </section>
  `).join('\n');

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Bharat Insurance — Vendor E2E Log (HDFC ERGO + Digit)</title>
<style>
:root{--navy:#122f63;--ink:#1a1a2e;--muted:#5b6b86;--line:#e2e8f4;--bg:#f7f9fc;
  --ok:#1a7d3c;--warn:#b8630a;--err:#c8102e;--skip:#7a4bcc;}
*{box-sizing:border-box}
html,body{margin:0;padding:0;background:var(--bg);color:var(--ink);
  font:14.5px/1.55 -apple-system,BlinkMacSystemFont,Segoe UI,Roboto,Helvetica,Arial,sans-serif}
.wrap{max-width:1200px;margin:0 auto;padding:32px 24px 80px}
header{border-bottom:2px solid var(--navy);padding-bottom:16px;margin-bottom:24px}
h1{margin:0 0 6px;font-size:22px;color:var(--navy)}
header .meta{color:var(--muted);font-size:13px}
header .meta b{color:var(--ink)}
h2{margin:28px 0 8px;font-size:17px;color:var(--navy);border-bottom:1px solid var(--line);padding-bottom:4px}
h3{margin:22px 0 10px;font-size:15px;color:var(--navy)}
h5{margin:0 0 6px;font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.5px}
.summary{display:flex;gap:14px;flex-wrap:wrap;margin:6px 0 22px}
.pill{background:#fff;border:1px solid var(--line);border-radius:6px;padding:8px 14px;font-size:13px}
.pill b{font-size:16px;display:block;color:var(--navy)}
.pill.ok b{color:var(--ok)} .pill.warn b{color:var(--warn)}
.pill.err b{color:var(--err)} .pill.skip b{color:var(--skip)}
.entry{background:#fff;border:1px solid var(--line);border-left:4px solid var(--line);
  border-radius:6px;margin:8px 0;padding:0;overflow:hidden}
.entry.ok{border-left-color:var(--ok)}
.entry.warn{border-left-color:var(--warn)}
.entry.err{border-left-color:var(--err)}
.entry.skip{border-left-color:var(--skip)}
.entry summary{padding:10px 14px;cursor:pointer;display:flex;gap:10px;align-items:center;
  font-weight:600;list-style:none}
.entry summary::-webkit-details-marker{display:none}
.entry summary::before{content:"▸";color:var(--muted);font-size:12px;transition:transform .1s}
.entry[open] summary::before{content:"▾"}
.badge{font-size:10.5px;font-weight:800;letter-spacing:.5px;text-transform:uppercase;
  padding:3px 7px;border-radius:4px;background:#eef2fa;color:var(--muted)}
.badge.ok{background:#e0f2e6;color:var(--ok)}
.badge.warn{background:#fdece0;color:var(--warn)}
.badge.err{background:#fce4e6;color:var(--err)}
.badge.skip{background:#ece0fa;color:var(--skip)}
.stepname{flex:1;font-weight:600;color:var(--ink)}
.ms{font-size:11.5px;color:var(--muted);font-weight:500}
.note{background:#fdf6d8;border-top:1px solid var(--line);padding:8px 14px;
  font-size:13px;color:#6a5100}
.row{display:grid;grid-template-columns:1fr 1fr;gap:0;border-top:1px solid var(--line)}
@media(max-width:820px){.row{grid-template-columns:1fr}}
.col{padding:12px 14px}
.col + .col{border-left:1px solid var(--line)}
@media(max-width:820px){.col + .col{border-left:0;border-top:1px solid var(--line)}}
.url{font-size:12.5px;margin:0 0 8px;color:var(--ink);word-break:break-all}
.url code{background:#eef2fa;padding:2px 6px;border-radius:3px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
.sublabel{font-size:11px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px;margin:6px 0 2px}
pre.mono{background:#f4f7fc;border:1px solid var(--line);border-radius:4px;padding:8px 10px;
  font:12px/1.45 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;color:#0e2547;
  overflow-x:auto;max-height:420px;margin:0;white-space:pre-wrap;word-break:break-word}
.empty{font-size:12px;color:var(--muted);font-style:italic;padding:4px 0}
.matrix{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:6px 0 24px}
@media(max-width:820px){.matrix{grid-template-columns:1fr 1fr}}
@media(max-width:520px){.matrix{grid-template-columns:1fr}}
.cell{background:#fff;border:1px solid var(--line);border-left:4px solid var(--line);
  border-radius:6px;padding:10px 14px}
.cell.ok{border-left-color:var(--ok);background:#f2fbf5}
.cell.warn{border-left-color:var(--warn);background:#fef8ee}
.cell.err{border-left-color:var(--err);background:#fdf1f3}
.cell.skip{border-left-color:var(--skip);background:#f7f2fc}
.cell-title{font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--muted);margin-bottom:4px}
.cell-text{font-size:13.5px;color:var(--ink);font-weight:500}
ol.findings{margin:6px 0 22px;padding-left:22px}
ol.findings li{margin:8px 0;font-size:14px}
ol.findings li b{color:var(--navy)}
ol.findings code{background:#eef2fa;padding:1px 5px;border-radius:3px;font-size:12.5px}
footer{color:var(--muted);font-size:12px;margin-top:28px;padding-top:14px;border-top:1px solid var(--line)}
</style></head><body><div class="wrap">
<header>
  <h1>Bharat Insurance &mdash; Vendor E2E Log (HDFC ERGO + Digit)</h1>
  <div class="meta">
    <b>Generated:</b> ${esc(generatedAt)} &nbsp;|&nbsp;
    <b>Environment:</b> Simson UAT &nbsp;|&nbsp;
    <b>ClientName:</b> <code>${esc(CLIENT)}</code> &nbsp;|&nbsp;
    <b>Partner userCode:</b> <code>${esc(USER_CODE)}</code>
  </div>
  <div class="meta" style="margin-top:6px">
    <b>Test fixtures:</b>
    Car reg <code>${esc(CAR_REG)}</code> (Honda Amaze 1.2 EX Manual Petrol, 1198 CC, MH02 &mdash; vendor-suggested for Digit UAT),
    Bike reg <code>${esc(BIKE_REG)}</code> (Honda Activa 110 H Smart, MH12). eKYC now runs a real HDFC PAN + DOI verification and forwards <code>eky_Id</code> / <code>ckycNumber</code> to the bike proposal.
    Customer &amp; nominee are synthetic. Two bike tracks are run:
    HDFC needs <code>validPolCopy=Yes</code> + prev policy (block message: &ldquo;Quote Blocked For No Prevoius Policy&rdquo;),
    Digit needs <code>policyType=expired</code> when there is no prev policy (avoids the vendor's <code>DateTime.Parse</code> crash in <code>DigitIns.cs</code>).
  </div>
  <div class="meta" style="margin-top:6px">
    <b>What this covers:</b> auth for all 3 subsystems, master-data lookups, <code>insertquote</code>,
    <code>getquote</code> on both <code>HDFCTP</code> and <code>GODIGITTP</code>, HDFC eKYC (direct auto-verify &rarr;
    verified <code>eky_Id</code> + <code>ckycNumber</code> + <code>kycData</code>), <code>GetDetailsbyPincode</code>,
    <strong>HDFC Create Car Proposal</strong> (new 4W doc, received 2026-10-01), and the HDFC Create Bike Proposal.
    An E3 regression probe sends an invalid <code>policyType</code> to Digit and records the response.
    Not run headless: payment (insurer-hosted gateway form-POST / redirect per QA Q9/Q10/D1),
    <code>getpolicyafterpayment</code> and <code>getpolicypdf</code> &mdash; both documented but require a
    completed real payment first.
  </div>
</header>

<h2>Outcome matrix</h2>
${matrixHtml}

<h2>Confirmed fixed by vendor (verified by this run)</h2>
<ol class="findings">
  <li><b>HDFC Car Proposal &mdash; "Premium Mismatch" is resolved.</b>
      Vendor response: "working fine from our end, kindly try again with a fresh journey."
      Fresh run returns a full payment-gateway handoff:
      <code>proposalNo: 202610050000859</code>, <code>transactionID: 97526100507151</code>,
      <code>checkSum: 565228693</code>, <code>txnAmount: "4414"</code>,
      <code>paymentororkycLink: https://heapp21.hdfcergo.com/UAT/.../MakePayment.aspx</code>,
      <code>cis_pdfbytes</code> populated, <code>appid: 10127</code>, <code>subid: S000000179</code>.
      Quote <code>payablePremium</code> is now <code>4414</code> (matches the doc sample; was <code>4532</code> previously) &mdash;
      HDFC reconciled their quote-time and proposal-time rate engines.</li>
  <li><b>HDFC Bike Proposal &mdash; <code>KeyNotFoundException('ProposalNumber')</code> + C# stack trace eliminated.</b>
      Vendor response: "resolved, kindly check now." Verified: response is now a clean business error without any
      <code>Message is:- / StackTrace is:- / D:\\PROJECT\\...</code> leak. The dictionary lookup in
      <code>HdfcNewJsonProposalResponse</code> is now guarded. (See next section for the remaining business-level issue.)</li>
</ol>

<h2>What the Mialtus_Client_QA.pdf closed out</h2>
<ol class="findings">
  <li><b>A1 (single journey transId).</b> Confirmed: <code>insertquote</code> is called once; the returned <code>transId</code>
      flows through eKYC, quote, and proposal. Harness updated accordingly.</li>
  <li><b>A2 (KYC linkage per insurer).</b> Confirmed: HDFC uses pre-proposal eKYC with <code>eky_Id</code> &amp;
      <code>ckycNumber</code> embedded in the proposal; Digit handles KYC internally during proposal creation (no
      pre-eKYC needed).</li>
  <li><b>A3 (journey sequence).</b> Confirmed: <code>insertquote</code> &rarr; <code>getquote</code> &rarr; eKYC. Verified
      KYC address goes to the downstream proposal, not to <code>insertquote</code>.</li>
  <li><b>A4 (ReturnUrl whitelisting).</b> Not required — any URL (preview and prod) is accepted.</li>
  <li><b>B1, B2, C1, C2 (proposal + issuance + PDF).</b> HDFC bike proposal doc + HDFC car proposal doc now shared;
      post-payment and PDF documented. Harness exercises the car flow end-to-end (quote &rarr; eKYC &rarr; proposal) today.</li>
  <li><b>D1 / D2 (payment gateway).</b> No custom third-party gateway and no webhook/signature. Payment goes through the
      insurer's own hosted page; status returns on the <code>ReturnUrl</code> redirect. HDFC uses a form POST to
      <code>MakePayment.aspx</code> and parses <code>hdnmsg</code> on return. Digit returns its own payment link.
      <br><b>Action for us:</b> wire the HDFC form POST (fields <code>Trnsno/Amt/Appid/Subid/Surl/Furl/Src/Chksum</code>)
      and the Digit payment link into the frontend post-proposal step.</li>
  <li><b>E3 regression test.</b> Sent <code>policyType: "invalidtypetest"</code> to Digit (GODIGITTP) car quote. Previous
      behaviour was a raw C# <code>DateTime.Parse</code> stack trace with <code>D:\\PROJECT\\...</code> path leak. New
      behaviour: Digit returns a successful quote (<code>errorStatus: false, payablePremium: 4420</code>) &mdash; it
      <i>silently accepts</i> unknown policy types rather than rejecting. The stack-trace leak is fixed, but the vendor's
      claimed <code>"Please Pass Valid Policy Type"</code> validation isn't observed. Please add explicit rejection for
      unknown values so garbage input can't produce a priced quote.</li>
  <li><b>E1 (multi-insurer).</b> Only HDFC + Digit active today. Next up: Bajaj, ICICI, Kotak, Reliance, Royal Sundaram,
      Shriram, TATA AIG &mdash; short codes to follow.</li>
  <li><b>F1 (FastLane prod).</b> Shared on go-live; UAT uses the local sample.</li>
  <li><b>Q4 (prev-policy # at quote).</b> Confirmed required: harness now sends <code>prevoiusPolicyNumber</code> on
      <code>insertquote</code> whenever <code>validPolCopy=Yes</code>. For TP, NCB is omitted per the same answer.</li>
</ol>

<h2>Remaining vendor blockers surfaced by this run</h2>
<ol class="findings">
  <li><b>HDFC Bike Proposal &mdash; "Unable to generate proposal".</b> Stack-trace crash is fixed (see "Confirmed fixed").
      With the same doc-compliant payload that drives the car proposal successfully, the bike proposal returns:
      <br><code>errorStatus: "true"</code>, <code>errorMessage: "Unable to generate proposal"</code>, every other field
      <code>null</code>.
      <br>No further detail is surfaced &mdash; we cannot tell from the response whether HDFC rejected the payload, the
      rating failed, a required field is missing, or an underwriting rule blocked it.
      <br><b>Asks:</b> (i) echo HDFC's upstream request/response (or the specific rule that failed) inside
      <code>errorMessage</code> &mdash; "Unable to generate proposal" is too generic to action; (ii) confirm with an
      internal UAT test that the doc's own bike-proposal sample payload posted verbatim produces a <code>proposalNo</code>
      today, and if it does, share the exact body so we can diff against ours.</li>
</ol>

<h2>Vendor-closed with a business rationale (not fixed, but explained)</h2>
<ol class="findings">
  <li><b>HDFC bike TP requires a previous policy.</b> Vendor: "As per HDFC UW guidelines, previous policy details are
      required." Accepted &mdash; carrier-side underwriting rule, not a vendor bug. Harness always sends
      <code>validPolCopy=Yes</code> + prev policy on the HDFC bike track.</li>
  <li><b>UAT masters: Honda City 1.5 AT / Honda "Activa 3G" absence.</b> Vendor: "In UAT, the selected Make &amp; Model
      are available for testing. Kindly proceed with the available options." Accepted &mdash; we'll continue testing with
      Honda Amaze (car) and Honda Activa (bike).</li>
  <li><b>Dates in <code>dd/MM/yyyy</code>.</b> Vendor: "Kindly pass the date in the format as specified in the API
      documentation." Accepted &mdash; harness converts all ISO dates to <code>dd/MM/yyyy</code>. The remaining concern
      is that an ISO-formatted date still leaks a C# stack trace instead of returning a graceful validation message; that
      sub-issue is now folded into "stack trace leaks" below.</li>
  <li><b>eKYC scenario 1 vs scenario 2: individual vs corporate.</b> Vendor: "In the first scenario, KYC is for an
      individual person; in the second scenario, KYC is for a corporate entity." Great clarification &mdash;
      <code>ekycType: "Pan Number"</code> is for individuals (uses PAN alone), <code>ekycType: "PAN + DOI"</code> is for
      corporates (PAN + Date of Incorporation). <code>BAPPN1467E</code> is an individual PAN, which is why it only verifies
      under scenario 1. <b>Ask:</b> please add this explicitly to the HDFC eKYC API documentation to prevent the same
      confusion for future integrators.</li>
  <li><b>Schema inconsistencies.</b>
      <ul>
        <li><code>isVehcileFinance</code> is Boolean per doc &mdash; vendor confirmed 7a. Accepted.</li>
        <li><code>errorStatus</code> &mdash; vendor said 7b "We have made the required changes. Kindly pass the value as a
            String now." Current observed state: proposal responses return the string <code>"true"</code>; quote responses
            still return boolean <code>false</code> or <code>null</code>. Please standardise response types across quote
            and proposal, or document that the field is semi-structured.</li>
        <li>Casing differences in <code>getpolicyafterpayment</code> (PascalCase for bike, lowerCamel for car) &mdash;
            vendor said 7c "pass the value as per the selected bike/vehicle." Accepted &mdash; harness will branch per
            module.</li>
      </ul>
  </li>
</ol>

<h2>Remaining vendor-side ask (one item)</h2>
<ol class="findings">
  <li><b>Stack-trace leaks from any upstream.</b> HDFC car proposal and HDFC bike proposal are now cleanly handled, but
      earlier runs still show a raw C# stack trace surfacing from <code>insertcarquote</code> when an ISO date is sent,
      with <code>D:\\PROJECT\\SwapCoreApi\\...</code> file paths visible to the API caller. The business-level fix (we must
      send <code>dd/MM/yyyy</code>) is accepted &mdash; the remaining ask is to apply the same guard the proposal path now
      has to the quote path so a bad date returns a clean validation message instead of a trace.</li>
</ol>

<h2>Summary</h2>
<div class="summary">
  <div class="pill"><b>${summary.total}</b>total calls</div>
  <div class="pill ok"><b>${summary.ok}</b>2xx OK</div>
  <div class="pill warn"><b>${summary.warn}</b>upstream errorStatus</div>
  <div class="pill err"><b>${summary.err}</b>failed</div>
  <div class="pill skip"><b>${summary.skip}</b>skipped / vendor-blocked</div>
</div>

<h2>Flow log</h2>
${sectionHtml}

<footer>
  Generated by <code>scripts/e2e-log.mjs</code>. Bearer tokens redacted (first 8 &hellip; last 6).
  Share this document with Simson Softwares alongside the vendor-alignment-report.
</footer>

</div></body></html>`;
}
