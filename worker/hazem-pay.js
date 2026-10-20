// Hazem Store payment server (Cloudflare Worker) — hazem-pay
// Gives every USDT payment its own exact amount, watches BNB Smart Chain (BEP20) and Tron (TRC20),
// and when the money arrives it confirms the order or top-up by itself and hands out instant codes.
//
// Secrets (Cloudflare → the Worker → Settings → Variables and Secrets):
//   SA_JSON       the Firebase service-account key file (paste the whole JSON text)   [required]
//   TRONGRID_KEY  a free TronGrid API key (more Tron requests per day)                [optional]

const ORIGINS = ['https://hazem-store.com', 'https://www.hazem-store.com'];
const USDT_BSC = '0x55d398326f99059ff775485246999027b3197955';
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const BSC_RPC = ['https://bsc-rpc.publicnode.com', 'https://bsc.drpc.org', 'https://1rpc.io/bnb', 'https://bsc-dataseed.bnbchain.org'];
const PAY_MIN = 60;             // minutes the customer is asked to pay within
const HOLD_H = 24;              // hours an exact amount belongs to one payment, and we keep accepting it
const CHUNK = 2000, CHUNKS = 8; // BSC blocks per getLogs call, calls per check

export default {
  async fetch(req, env) {
    const origin = req.headers.get('origin') || '';
    const allowed = ORIGINS.concat(String(env.EXTRA_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean));
    const cors = {
      'access-control-allow-origin': allowed.includes(origin) ? origin : allowed[0],
      'access-control-allow-methods': 'GET, POST, OPTIONS',
      'access-control-allow-headers': 'content-type',
      'access-control-max-age': '86400',
      'vary': 'origin',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    try {
      if (req.method === 'GET') return json(await health(env), 200, cors);
      if (req.method !== 'POST') return json({ error: 'method' }, 405, cors);
      let body = {};
      try { body = JSON.parse(await req.text() || '{}'); } catch (e) { throw fail('bad json'); }
      const fs = await firestore(env);
      if (url.pathname === '/pay/start') return json(await start(fs, env, body), 200, cors);
      if (url.pathname === '/pay/check') return json(await check(fs, env, body), 200, cors);
      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: e && e.message ? e.message : String(e) }, e && e.status ? e.status : 500, cors);
    }
  },
};
function json(o, status, headers) { return new Response(JSON.stringify(o), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }); }
function fail(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

// GET / : is the server set up and can it read the store?
async function health(env) {
  if (!env.SA_JSON) return { ok: false, service: 'hazem-pay', error: 'SA_JSON missing' };
  const fs = await firestore(env);
  const s = await fs.get('settings/main');
  const m = s && (s.data.payments || []).find(isUsdt);
  return { ok: true, service: 'hazem-pay', project: fs.project, usdt: m ? { auto: !!m.auto, bsc: validAddr('bsc', m.number), tron: validAddr('tron', m.tron) } : null };
}

// ---------------------------------------------------------------- /pay/start : reserve an exact amount
async function start(fs, env, b) {
  const kind = b.kind === 'topup' ? 'topup' : 'order', id = cleanId(b.id), net = b.net === 'tron' ? 'tron' : 'bsc';
  const col = kind === 'topup' ? 'topups' : 'orders', ref = `${col}/${id}`;
  const m = await usdtMethod(fs);
  const addr = net === 'tron' ? m.tron : m.number;
  if (!validAddr(net, addr)) throw fail('network not available');
  for (let attempt = 0; attempt < 4; attempt++) {
    const doc = await fs.get(ref);
    if (!doc) throw fail('not found', 404);
    const d = doc.data, now = Date.now();
    if (d.status !== 'pending') return { status: d.status };
    if (!isUsdt({ name: d.payment })) throw fail('not a USDT payment');
    if (d.createdAt && now - d.createdAt > 48 * 3600e3) throw fail('expired');
    if (d.pay && d.pay.net === net && d.pay.amt && d.pay.lockExp > now + 30 * 60e3) return payOut(d.pay, d);
    const ils = kind === 'topup' ? +d.amount : await orderTotal(fs, d);
    if (!(ils > 0)) throw fail('bad amount');
    const rate = +m.rate > 0 ? +m.rate : 3.1;
    const base = Math.ceil((ils / rate) * 100 - 1e-9) / 100;
    const head = net === 'bsc' ? await bscBlock() : 0;
    for (const tag of shuffle([...Array(99)].map((_, i) => i + 1)).slice(0, 15)) {
      const amt = r3(base + tag / 1000), lockId = `${net}_${amt.toFixed(3).replace('.', '_')}`;
      const lock = await fs.get(`payLocks/${lockId}`);
      if (lock && lock.data.exp > now && lock.data.ref !== ref) continue;
      const pay = { net, amt, addr, ils, rate, exp: now + PAY_MIN * 60e3, lockExp: now + HOLD_H * 3600e3, startBlock: head ? head - 20 : 0, startTs: now - 120e3, scanned: 0, lock: lockId };
      try {
        await fs.commit([
          fs.wUpdate(`payLocks/${lockId}`, { ref, exp: pay.lockExp }, null, lock ? { updateTime: lock.updateTime } : { exists: false }),
          fs.wUpdate(ref, { pay }, ['pay'], { updateTime: doc.updateTime }),
        ]);
        return payOut(pay, d);
      } catch (e) {
        if (e.status !== 400 && e.status !== 409) throw e;
        break; // someone changed the order or took the amount at the same moment: read again
      }
    }
  }
  throw fail('busy, try again', 503);
}
function payOut(p, d) { return { status: 'pending', net: p.net, amt: p.amt, addr: p.addr, exp: p.exp, ils: p.ils, rate: p.rate, no: d.orderNo || '' }; }

// ---------------------------------------------------------------- /pay/check : look for the payment on the chain
async function check(fs, env, b) {
  const kind = b.kind === 'topup' ? 'topup' : 'order', id = cleanId(b.id);
  const col = kind === 'topup' ? 'topups' : 'orders', ref = `${col}/${id}`;
  const doc = await fs.get(ref);
  if (!doc) throw fail('not found', 404);
  const d = doc.data, p = d.pay;
  if (d.status !== 'pending') return finished(fs, d);
  if (!p || !p.amt) return { status: 'pending', nopay: true };
  if (Date.now() > p.lockExp) return { status: 'pending', expired: true, amt: p.amt, net: p.net };
  let hits = [], scanned = p.scanned || 0;
  if (p.net === 'bsc') {
    const latest = (await bscBlock()) - 2, from = scanned ? scanned + 1 : p.startBlock;
    const to = Math.min(latest, from + CHUNK * CHUNKS - 1);
    if (to >= from) { hits = await bscFind(p.addr, p.amt, from, to); scanned = to; }
  } else {
    hits = await tronFind(env, p.addr, p.amt, p.startTs);
  }
  for (const h of hits) {
    const res = await settle(fs, kind, ref, id, h);
    if (res) return res;
  }
  if (p.net === 'bsc' && scanned !== p.scanned) {
    try { await fs.commit([fs.wUpdate(ref, { pay: { scanned } }, ['pay.scanned'], { exists: true })]); } catch (e) {}
  }
  return { status: 'pending', amt: p.amt, net: p.net, exp: p.exp };
}
async function finished(fs, d) {
  const out = { status: d.status, tx: (d.pay && d.pay.tx) || '', net: (d.pay && d.pay.net) || '', amt: (d.pay && d.pay.paidAmt) || 0 };
  if (d.status === 'done' && Array.isArray(d.stockIds) && d.stockIds.length) out.codes = await readCodes(fs, d);
  return out;
}
async function readCodes(fs, d) {
  const names = [];
  for (const it of d.items || []) for (let i = 0; i < (+it.qty || 1); i++) names.push(it.productName + (it.planName ? ' · ' + it.planName : ''));
  const out = [];
  for (let i = 0; i < d.stockIds.length; i++) {
    const c = await fs.get(`codes/${d.stockIds[i]}`);
    out.push({ name: names[i] || '', value: c ? String(c.data.value || '') : '' });
  }
  return out;
}

async function settle(fs, kind, ref, id, hit) {
  const doc = await fs.get(ref);
  if (!doc) return null;
  const d = doc.data;
  if (d.status !== 'pending') return finished(fs, d);
  const txKey = `${d.pay.net}_${hit.tx.toLowerCase()}`;
  if (await fs.get(`usedTx/${txKey}`)) return null;
  const proof = `${d.pay.amt} USDT ${d.pay.net === 'tron' ? 'TRC20' : 'BEP20'} · ${hit.tx}`.slice(0, 120);
  const pay = { ...d.pay, tx: hit.tx, paidAmt: hit.amt };
  const used = fs.wUpdate(`usedTx/${txKey}`, { ref, amt: hit.amt, at: Date.now() }, null, { exists: false });
  const unlock = d.pay.lock ? [{ delete: fs.name(`payLocks/${d.pay.lock}`) }] : [];
  const writes = [used];
  let status, claims = null;
  if (kind === 'topup') {
    status = 'approved';
    writes.push(fs.wUpdate(ref, { status, proofText: proof, pay }, ['status', 'proofText', 'pay'], { updateTime: doc.updateTime }, [{ fieldPath: 'decidedAt', setToServerValue: 'REQUEST_TIME' }]));
    writes.push(fs.wUpdate(`wallets/${d.uid}`, {}, [], null, [{ fieldPath: 'balance', increment: num(+d.amount) }]));
  } else {
    claims = await claimStock(fs, d);
    status = claims ? 'done' : 'paid';
    const fields = { status, proofText: proof, pay }, mask = ['status', 'proofText', 'pay'];
    const tr = [{ fieldPath: 'paidAt', setToServerValue: 'REQUEST_TIME' }];
    if (claims) { fields.stockIds = claims.map(c => c.id); mask.push('stockIds'); tr.push({ fieldPath: 'doneAt', setToServerValue: 'REQUEST_TIME' }); }
    writes.push(fs.wUpdate(ref, fields, mask, { updateTime: doc.updateTime }, tr));
    for (const c of claims || []) writes.push(fs.wUpdate(`stock/${c.id}`, { owner: d.uid || 'guest_' + id, order: id }, ['owner', 'order'], { updateTime: c.updateTime }, [{ fieldPath: 'claimedAt', setToServerValue: 'REQUEST_TIME' }]));
  }
  try { await fs.commit(writes.concat(unlock)); } catch (e) {
    const again = await fs.get(ref);
    if (again && again.data.status !== 'pending') return finished(fs, again.data);
    if (claims && again) { // a code was taken at the same moment: confirm the payment, deliver by hand
      try {
        await fs.commit([used, fs.wUpdate(ref, { status: 'paid', proofText: proof, pay }, ['status', 'proofText', 'pay'], { updateTime: again.updateTime }, [{ fieldPath: 'paidAt', setToServerValue: 'REQUEST_TIME' }])].concat(unlock));
        return { status: 'paid', tx: hit.tx, net: d.pay.net, amt: hit.amt };
      } catch (e2) {}
    }
    return null;
  }
  const out = { status, tx: hit.tx, net: d.pay.net, amt: hit.amt };
  if (claims) out.codes = await readCodes(fs, { ...d, stockIds: claims.map(c => c.id) });
  return out;
}

// instant codes: every unit in the order must be an instant plan with a free code
async function claimStock(fs, d) {
  if (!Array.isArray(d.items) || !d.items.length) return null;
  const units = [];
  for (const it of d.items) {
    const p = await fs.get(`products/${it.productId}`);
    const pl = p && (p.data.plans || []).find(x => x.id === it.planId);
    if (!pl || !pl.instant) return null;
    for (let i = 0; i < (+it.qty || 1); i++) units.push(it);
  }
  if (units.length > 5) return null;
  const out = [], taken = new Set();
  for (const it of units) {
    const free = await fs.query('stock', [['pid', 'EQUAL', it.productId], ['plan', 'EQUAL', it.planId], ['owner', 'IS_NULL']], 10);
    const pick = free.find(s => !taken.has(s.id));
    if (!pick) return null;
    taken.add(pick.id); out.push(pick);
  }
  return out;
}

// the order total comes from the product prices in the database, never from the browser
async function orderTotal(fs, d) {
  if (!Array.isArray(d.items) || !d.items.length) throw fail('no items');
  let sum = 0;
  for (const it of d.items) {
    const p = await fs.get(`products/${it.productId}`);
    const pl = p && (p.data.plans || []).find(x => x.id === it.planId);
    if (!pl || !(+pl.price > 0)) throw fail('unknown product');
    sum += +pl.price * Math.max(1, Math.round(+it.qty || 1));
  }
  return Math.round(sum * 100) / 100;
}
function isUsdt(m) { return !!m && (m.id === 'usdt' || /usdt/i.test(m.name || '')); }
async function usdtMethod(fs) {
  const s = await fs.get('settings/main');
  const m = s && (s.data.payments || []).find(isUsdt);
  if (!m || m.active === false || !m.auto) throw fail('USDT is off');
  return { number: String(m.number || '').trim(), tron: String(m.tron || '').trim(), rate: m.rate };
}
function validAddr(net, a) { return net === 'tron' ? /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a || '') : /^0x[0-9a-fA-F]{40}$/.test(a || ''); }
function cleanId(v) { const id = String(v || ''); if (!/^[A-Za-z0-9_-]{6,40}$/.test(id)) throw fail('bad id'); return id; }

// ---------------------------------------------------------------- chains
let rpcI = 0;
async function rpc(method, params) {
  let last;
  for (let k = 0; k < BSC_RPC.length; k++) {
    const i = (rpcI + k) % BSC_RPC.length;
    try {
      const r = await fetch(BSC_RPC[i], { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message || 'rpc error');
      rpcI = i;
      return j.result;
    } catch (e) { last = e; }
  }
  throw last || new Error('rpc down');
}
async function bscBlock() { return parseInt(await rpc('eth_blockNumber', []), 16); }
async function bscFind(addr, amt, from, to) {
  const topic = '0x000000000000000000000000' + addr.toLowerCase().replace(/^0x/, ''), hits = [];
  for (let a = from; a <= to; a += CHUNK) {
    const b = Math.min(to, a + CHUNK - 1);
    const logs = await rpc('eth_getLogs', [{ address: USDT_BSC, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16), topics: [TRANSFER, null, topic] }]);
    for (const l of logs || []) {
      const v = Number(BigInt(l.data) / 10n ** 12n) / 1e6; // 18 decimals → 6, no float drift
      if (Math.abs(v - amt) < 0.0005) hits.push({ tx: l.transactionHash, amt: r3(v) });
    }
  }
  return hits;
}
async function tronFind(env, addr, amt, sinceTs) {
  const u = `https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20?only_to=true&only_confirmed=true&limit=200&contract_address=${USDT_TRON}&min_timestamp=${Math.floor(sinceTs)}`;
  const r = await fetch(u, { headers: env.TRONGRID_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_KEY } : {} });
  if (!r.ok) throw new Error('trongrid ' + r.status);
  const j = await r.json(), hits = [], want = Math.round(amt * 1e6);
  for (const t of j.data || []) {
    if (t.to !== addr || (t.token_info && t.token_info.address !== USDT_TRON)) continue;
    const v = Number(t.value);
    if (Math.abs(v - want) < 500) hits.push({ tx: t.transaction_id, amt: r3(v / 1e6) });
  }
  return hits;
}

// ---------------------------------------------------------------- Firestore REST with the service account
let tokenCache = null;
async function firestore(env) {
  if (!env.SA_JSON) throw fail('server not set up: SA_JSON is missing', 500);
  let sa;
  try { sa = JSON.parse(env.SA_JSON); } catch (e) { throw fail('SA_JSON is not valid JSON', 500); }
  const project = sa.project_id, root = `projects/${project}/databases/(default)/documents`, api = 'https://firestore.googleapis.com/v1/';
  const token = await accessToken(sa);
  const H = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
  const name = p => `${root}/${p}`;
  const parse = doc => ({ id: doc.name.split('/').pop(), data: fromFields(doc.fields || {}), updateTime: doc.updateTime });
  return {
    project, name,
    async get(p) {
      const r = await fetch(api + name(p), { headers: H });
      if (r.status === 404) return null;
      if (!r.ok) throw fail('firestore get ' + r.status, 502);
      return parse(await r.json());
    },
    async query(col, filters, limit) {
      const fl = filters.map(([f, op, v]) => op === 'IS_NULL' ? { unaryFilter: { op: 'IS_NULL', field: { fieldPath: f } } } : { fieldFilter: { field: { fieldPath: f }, op, value: toValue(v) } });
      const body = { structuredQuery: { from: [{ collectionId: col }], where: fl.length > 1 ? { compositeFilter: { op: 'AND', filters: fl } } : fl[0], limit } };
      const r = await fetch(api + root + ':runQuery', { method: 'POST', headers: H, body: JSON.stringify(body) });
      if (!r.ok) throw fail('firestore query ' + r.status, 502);
      return (await r.json()).filter(x => x.document).map(x => parse(x.document));
    },
    wUpdate(p, fields, mask, pre, transforms) {
      const w = { update: { name: name(p), fields: toFields(fields) } };
      if (mask) w.updateMask = { fieldPaths: mask };
      if (pre) w.currentDocument = pre;
      if (transforms && transforms.length) w.updateTransforms = transforms;
      return w;
    },
    async commit(writes) {
      const r = await fetch(api + root + ':commit', { method: 'POST', headers: H, body: JSON.stringify({ writes }) });
      if (!r.ok) throw fail('commit ' + r.status, r.status);
      return r.json();
    },
  };
}
async function accessToken(sa) {
  if (tokenCache && tokenCache.email === sa.client_email && tokenCache.exp > Date.now() + 60e3) return tokenCache.token;
  const now = Math.floor(Date.now() / 1000);
  const enc = o => b64url(new TextEncoder().encode(JSON.stringify(o)));
  const unsigned = enc({ alg: 'RS256', typ: 'JWT' }) + '.' + enc({ iss: sa.client_email, scope: 'https://www.googleapis.com/auth/datastore', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const pem = String(sa.private_key || '').replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
  const der = Uint8Array.from(atob(pem), c => c.charCodeAt(0));
  const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + unsigned + '.' + b64url(sig) });
  if (!r.ok) throw fail('google auth ' + r.status, 502);
  const j = await r.json();
  tokenCache = { email: sa.client_email, token: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return j.access_token;
}
function b64url(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

// ---------------------------------------------------------------- Firestore value helpers
function num(n) { return Number.isInteger(n) ? { integerValue: String(n) } : { doubleValue: n }; }
function toValue(v) {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') return num(v);
  if (typeof v === 'string') return { stringValue: v };
  if (Array.isArray(v)) return { arrayValue: { values: v.map(toValue) } };
  if (typeof v === 'object') return { mapValue: { fields: toFields(v) } };
  return { stringValue: String(v) };
}
function toFields(o) { const f = {}; for (const k of Object.keys(o)) f[k] = toValue(o[k]); return f; }
function fromValue(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return +v.integerValue;
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('timestampValue' in v) return Date.parse(v.timestampValue);
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(fromValue);
  if ('mapValue' in v) return fromFields(v.mapValue.fields || {});
  return null;
}
function fromFields(f) { const o = {}; for (const k of Object.keys(f)) o[k] = fromValue(f[k]); return o; }
function r3(v) { return Math.round(v * 1000) / 1000; }
function shuffle(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
