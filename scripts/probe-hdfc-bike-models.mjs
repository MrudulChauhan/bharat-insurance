// Vendor ask (2026-10-08): validate HDFC bike proposal "Unable to generate
// proposal" with a few alternative vehicle models to see if it's model-specific.
// Loop a candidate list, run insertbikequote → getbikequote (HDFCTP) → eKYC →
// getbikeproposal (HDFC), and tabulate the result per model.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = dirname(HERE);

// Env loader
try {
  const env = readFileSync(join(ROOT, '.env.local'), 'utf8');
  for (const line of env.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    if (!process.env[m[1]]) process.env[m[1]] = v;
  }
} catch {}

const SIMSON_BASE = process.env.SIMSON_BASE_URL || 'https://swapmasteruat.getpolicy.in';
const MIALTUS_BASE = process.env.MIALTUS_BASE_URL || 'https://uatswapapi.pushbutton.in';
const SWAPINS_BASE = process.env.SWAPINSURER_BASE_URL || 'https://swapinsureruat.getpolicy.in';
const CLIENT = process.env.SIMSON_CLIENT_NAME || 'MIALTUS';
const USERNAME = process.env.SIMSON_USERNAME || '';
const PASSWORD = process.env.SIMSON_PASSWORD || '';
const USER_CODE = process.env.SIMSON_USER_CODE || '3614';
const KYC_PAN = process.env.HDFC_TEST_PAN || 'BAPPN1467E';

const toDMY = (s) => {
  const m = String(s||'').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : s;
};

async function token(path, body) {
  const r = await fetch(path, {
    method: 'POST',
    headers: {'Content-Type':'application/json','ClientName':CLIENT,'accept':'*/*'},
    body: JSON.stringify(body),
  });
  const j = await r.json();
  return j.token || j.Token;
}

const simsonTok = await token(`${SIMSON_BASE}/Authentication/token`, {Username:USERNAME,Password:PASSWORD});
const mialtusTok = await token(`${MIALTUS_BASE}/Authentication/token`, {username:USERNAME,password:PASSWORD});
const swapTok   = await token(`${SWAPINS_BASE}/Partner/Authentication/token`, {username:USERNAME,password:PASSWORD});

// Candidate bike models to try (Honda is the only make the vendor's master
// has multiple variants for; also include a different make for breadth).
const candidates = [
  { make: 'Honda', model: 'Activa',        cc: '110' },
  { make: 'Honda', model: 'Activa 125 Fi', cc: '125' },
  { make: 'Honda', model: 'Activa I',      cc: '110' },
  { make: 'Honda', model: 'Unicorn',       cc: '150' },
  { make: 'Hero',  model: 'Splendor Plus', cc: '100' },
  { make: 'Bajaj', model: 'Pulsar',        cc: '150' },
];

async function listVariants(make, model, cc) {
  const r = await fetch(`${SIMSON_BASE}/Motor/GetBikeVarient`, {
    method:'POST',
    headers:{'Content-Type':'application/json','ClientName':CLIENT,'accept':'*/*','Authorization':`Bearer ${simsonTok}`},
    body: JSON.stringify({ Make: make, make, Model: model, model, Cc: cc, cc }),
  });
  const j = await r.json();
  return Array.isArray(j) ? j : [];
}

async function probe({ make, model, cc }) {
  const variants = await listVariants(make, model, cc);
  if (!variants.length) {
    return { make, model, cc, status: 'no-variants', detail: 'GetBikeVarient returned empty — model not in master at this CC' };
  }
  const variant = variants[0].variant || variants[0].Variant;
  // Pick an RTO we know works: MH12 (Pune)
  const rto = 'MH12 (Pune)';
  const regDate = toDMY('2017-07-01');
  // Build HDFC-track insert body (needs prev policy)
  const insertBody = {
    quote: {
      coverType:'TP', make, model, variant, rto, regDate, mfgMonth:'07', mfgYear:'2017',
      fullname:'Test Customer', mobile:'9798798797', email:'test@gmail.com',
      vehicleOwnedBy:'I', validPolCopy:'Yes',
      isPreClaimed:'No', ownershipChange:'No', preNCB:'',
      vehicleNo:'MH-12-NT-5588',
      previousInsurer: 'ICICI  LOMBARD',
      prepolExpiryDate: toDMY('2026-11-30'),
      prevoiusPolicyNumber: 'TEST-PREV-POL-123',
      policyType: 'renew',
      previousYearPolicyType: 'Comprehensive (Own damage + Third Party Liability)',
      tpprepolExpiryDate: null,
    },
    bikeAddons: {
      paTenure:'1', isCPACover:true, isNoCPAReason:'',
      paidDriver:false, accidentCoPassenger:false,
      accidentCoPassengerValue:0, tppd:false,
      TPPDSI:'0', llPaidDriverCheck:'', llPaidDriverValue:'',
    },
    userCode: USER_CODE,
  };
  // Insert quote
  const ir = await fetch(`${MIALTUS_BASE}/partner/motor/insertbikequote`, {
    method:'POST',
    headers:{'Content-Type':'application/json','ClientName':CLIENT,'Server':'UAT','accept':'*/*','Authorization':`Bearer ${mialtusTok}`},
    body: JSON.stringify(insertBody),
  });
  const ij = await ir.json();
  if (!ij.transId) return { make, model, variant, cc, status: 'insert-failed', detail: (ij.message||JSON.stringify(ij)).slice(0,160) };
  const transId = ij.transId;
  // Get quote
  const gBody = JSON.parse(JSON.stringify(insertBody));
  gBody.quote.quoteId = String(transId);
  gBody.quote.seatingCapacity = '2';
  const gr = await fetch(`${SWAPINS_BASE}/partner/bike/getbikequote`, {
    method:'POST',
    headers:{'Content-Type':'application/json','ClientName':CLIENT,'Server':'UAT','Insurer':'HDFCTP','accept':'*/*','Authorization':`Bearer ${swapTok}`},
    body: JSON.stringify(gBody),
  });
  const gj = await gr.json();
  if (gj.errorStatus === true || gj.errorStatus === 'true') {
    return { make, model, variant, cc, status: 'quote-failed', detail: String(gj.errorText||gj.errorMessage||'').slice(0,160), transId };
  }
  if (!Number(gj.payablePremium)) {
    return { make, model, variant, cc, status: 'quote-zero', detail: 'quote returned 0 payablePremium', transId };
  }
  const premium = Number(gj.payablePremium);
  // eKYC (reuse the known-good PAN)
  const ekycRes = await fetch(`${SWAPINS_BASE}/partner/ekyc/getekycresponse`, {
    method:'POST',
    headers:{'Content-Type':'application/json','ClientName':CLIENT,'Server':'UAT','Insurer':'HDFC','accept':'*/*','Authorization':`Bearer ${swapTok}`},
    body: JSON.stringify({
      transId: String(transId), ekycInsurer:'hdfc', module:'bike', vehicleOwnedBy:'I',
      kycEmail:'test@gmail.com', kycName:'Test Customer', kycPan: KYC_PAN,
      ekycType:'Pan Number', idVerificationDocType:'Pan Number',
      ekycNumber: KYC_PAN, customerType:'I', isKYCDone:false, email:'test@gmail.com',
      ReturnUrl:'https://www.bharatinsurance.online/?kyc_return=1',
      domain:'https://www.bharatinsurance.online/',
    }),
  });
  const ekyc = await ekycRes.json();
  if (!ekyc.isVerified) return { make, model, variant, cc, status: 'ekyc-failed', detail: 'isVerified=false', transId };
  const ekyId = ekyc.eky_Id;
  const ckyc  = ekyc.ckycNumber;
  const kycData = (typeof ekyc.kycData === 'string') ? JSON.parse(ekyc.kycData || '{}') : (ekyc.kycData || {});
  const propFirstName = (ekyc.fullName || 'Test').split(/\s+/)[0];
  const propLastName  = (ekyc.fullName || 'Customer').split(/\s+/).slice(1).join(' ') || 'Customer';
  const propDob       = ekyc.kycDob || toDMY('1990-01-01');
  const pincode = String(kycData.permanentPincode || '209721');
  // Pincode lookup
  const pinRes = await fetch(`${SIMSON_BASE}/Motor/GetDetailsbyPincode`, {
    method:'POST',
    headers:{'Content-Type':'application/json','ClientName':CLIENT,'accept':'*/*','Authorization':`Bearer ${simsonTok}`},
    body: JSON.stringify({ pincode, company:'HDFC' }),
  });
  const pinJ = await pinRes.json();
  const pm = Array.isArray(pinJ) ? (pinJ[0]||{}) : pinJ;
  const stateName = String(pm.statename||'UTTAR PRADESH').toUpperCase();
  const stateCode = String(pm.statecode||'24');
  const cityName  = String(pm.cityname||'KANNAUJ').toUpperCase();
  const cityCode  = String(pm.citycode||'469');
  // Build proposal per HDFC bike doc
  const regParts = 'MH12NT5588'.match(/^([A-Z]{2})(\d{1,2})([A-Z]{1,3})(\d{1,4})$/) || [];
  const proposal = {
    salutation:'Mr', pTransactionId: gj.pTransactionId || String(transId),
    paymentNumber:null, bankrefnum:null, paymentStatus:null,
    referenceNumber:null, refProposal:null, isAngular:true,
    fullname: ekyc.fullName, firstName: propFirstName, lastName: propLastName,
    dob: propDob, email: 'TEST@GMAIL.COM', mobile:'9798798797', landLine:'',
    panCard: KYC_PAN, gender:'Male',
    maritialValue:'Divorced', maritialText:'Divorced',
    occupationValue:'Retired', tyreRimNo:'', occupationText:'Retired',
    gstNo:'', adhaarNumber:'',
    nomineefullname:'DFGDFGDF DFDFGDFDF', nomineeFname:'DFGDFGDF', nomineeLname:'DFDFGDFDF',
    nomineeDob: toDMY('1999-11-11'),
    relationshipValue:'Daughter', relationshipText:'Daughter',
    orgName: ekyc.fullName, vehicleOwnedBy:'I',
    rto, regA:regParts[1]||'', regB:regParts[2]||'', regC:regParts[3]||'', regD:regParts[4]||'',
    regDate, engineNo:'GT4534YTERGF34TG342', chassisNo:'234TG34VDFGREG34',
    isVehcileFinance:false, financeCity:'',
    isPuc:false, pucNo:'', pucExpiryDate:null,
    inspectionTid:'', transactionRef:'',
    prevoiusInsurerValue:'CHOLAMANDALAM', prevoiusInsurerText:'Cholamandalam MS General Insurance',
    prevoiusPolicyNumber:'34T34TGEG334G',
    prevoiusPolicyType:'Comprehensive (Own damage + Third Party Liability)',
    pdfLink:'', base64PDF:'',
    prevoiusPolicyExpiryDate: toDMY('2026-11-30'),
    tpPolicyExpiryDate:null, tpPolicyNumber:'',
    tpprevoiusInsurerValue:'CHOLAMANDALAM', tpprevoiusInsurerText:'Cholamandalam MS General Insurance',
    policyType:'renew',
    addrL1: kycData.permanentAddress1||'noida', addrL2: kycData.permanentAddress2||'noida',
    landmark:'', stateName, stateCode, cityName, cityCode, pincode,
    areaName:'', areaCode:'', isSameAddressChecked:true,
    rcLandmark:'', rcAddrL1: kycData.permanentAddress1||'noida', rcAddrL2: kycData.permanentAddress2||'noida',
    rcStateName:stateName, rcStateCode:stateCode, rcCityName:cityName, rcCityCode:cityCode,
    rcPincode:pincode, rcAreaName:'', rcAreaCode:'',
    cpaPolicyNo:'', cpaSuminsured:'', cpaPreinsurer:'', cpaPreinsurerName:'',
    cpaPolicyFromdate:null, cpaPolicyTodate:null,
    make, model, variant,
    idv:'0', coverType:'tponly',
    mfgYear:'2017', mfgMonth:'07',
    transId: String(transId), quoteId: String(transId),
    logo:'', netPremium: String(gj.netPremium||''), payablePremium: String(gj.payablePremium||''),
    serviceTax: String(gj.serviceTax||''), insurerName:'hdfc',
    saveForLater:'', typeofButon:'', transSavelaterText:'', transSaveLater:'',
    termsCondition:'true', proposerLink:'', stage:'6',
    polStartDateToSaiba: gj.policystartDate||'', polEndDateToSaiba: gj.policyEndDate||'',
    tPexpiryDateToSaiba: gj.policyEndDate||'',
    policyStartDate: gj.policystartDate||'', policyEndDate: gj.policyEndDate||'',
    currentNCB: gj.currentNCB||'NA',
    seatCapacity:'', policyStatus:'Inforce',
    proposalPDFHTML:'',
    domainName:'https://www.bharatinsurance.online/',
    InsureAPIDomainName:'https://www.bharatinsurance.online/',
    ClientDomainName:'https://www.bharatinsurance.online/',
    odYear:'', isRenewalPolicy:false,
    insuredFullName: ekyc.fullName,
    tp: Number(gj.totalTPCalculated||gj.thirdPartyPremium||0), od:0,
    cc: variant, fuel:'Petrol',
    coverNote:'', refBy:null, saibaAutoid:'', custCode:'',
    zone: gj.zone||'A',
    enquiryID:'', applicationId:'',
    ckycNumber: ckyc, insuredPolicyNumber:'', inspectiontype:'',
    share_EmailID:null, share_MobileNo:'', paymentTinyURL:null,
    isKYCDone:true, isKYC:'No',
    kycPan: KYC_PAN, kycDob: propDob, policy_Gen_Flag:'',
    addressVerificationDocExt:null, eky_Id: ekyId,
    photoupload:null, photoDocExt:null, photouploadFileName:null,
    idVerificationDocType:null, idVerificationDocId:null, idVerificationDocExt:null,
    idProofupload:null, addreesProofupload:null,
    addressVerificationDocType:null, addressVerificationDocId:null,
    kycStatus:null, otp:null, isSaveLater:null,
    lvTransactionIDGlobal:null, fatherName:null,
    insured_photoExt:null, paNorForm60:null,
    pan_Form60_Document:null, pan_Form60_Document_Ext:null,
  };
  const propBody = {
    quote: gBody.quote,
    bikeAddons: gBody.bikeAddons,
    quoteResponseBike: gj,
    proposal,
    bikeProposal: proposal,
  };
  const pr = await fetch(`${SWAPINS_BASE}/partner/bike/getbikeproposal`, {
    method:'POST',
    headers:{'Content-Type':'application/json','ClientName':CLIENT,'Server':'UAT','Insurer':'HDFC','accept':'*/*','Authorization':`Bearer ${swapTok}`},
    body: JSON.stringify(propBody),
  });
  const pj = await pr.json();
  if (pj.proposalNo) {
    return { make, model, variant, cc, status: 'proposal-ok', detail: `proposalNo ${pj.proposalNo}`, transId, premium };
  }
  const errMsg = String(pj.errorMessage||'').replace(/[\r\n\\]+/g,' ').slice(0,160);
  return { make, model, variant, cc, status: 'proposal-failed', detail: errMsg || JSON.stringify(pj).slice(0,160), transId, premium };
}

console.log(`\nProbing ${candidates.length} HDFC bike models...\n`);
const results = [];
for (const c of candidates) {
  process.stdout.write(`  ${c.make.padEnd(6)} / ${c.model.padEnd(14)} / ${c.cc.padStart(3)}cc  `);
  try {
    const r = await probe(c);
    results.push(r);
    const flag = r.status === 'proposal-ok' ? '✅' : (r.status === 'proposal-failed' ? '❌' : '⏭ ');
    console.log(`${flag} ${r.status.padEnd(18)} ${r.detail || ''}`);
  } catch (e) {
    results.push({ ...c, status: 'exception', detail: String(e.message||e) });
    console.log(`💥 exception: ${e.message}`);
  }
  await new Promise(r => setTimeout(r, 500));
}

console.log('\n\nSummary table:');
console.log('='.repeat(100));
for (const r of results) {
  const line = `${(r.make||'').padEnd(6)}  ${(r.model||'').padEnd(16)} ${(r.cc||'').padStart(3)}cc  → ${r.status.padEnd(18)} ${r.detail || ''}`;
  console.log(line.slice(0, 160));
}

writeFileSync(join(ROOT, 'probe-hdfc-bike-models.json'), JSON.stringify(results, null, 2));
console.log('\n(full results in probe-hdfc-bike-models.json)');
