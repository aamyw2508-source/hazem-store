// Hazem Store payment server (Cloudflare Worker) — hazem-pay
// Gives every USDT payment its own exact amount, watches BNB Smart Chain (BEP20) and Tron (TRC20),
// and when the money arrives it confirms the order or top-up by itself and hands out instant codes.
//
// It also sends notifications: new orders to Hazem, and "payment received" to the customer.
//
// Secrets (Cloudflare → the Worker → Settings → Variables and Secrets):
//   SA_JSON       the Firebase service-account key file (paste the whole JSON text)   [required]
//   TRONGRID_KEY  a free TronGrid API key (more Tron requests per day)                [optional]
// Notifications (all optional, set the ones you want):
//   RESEND_KEY + ADMIN_EMAIL   email to Hazem (resend.com)
//   MAIL_FROM                  e.g. "حازم ستور <orders@hazem-store.com>" after verifying the domain in Resend → emails to customers too
//   WA_PHONE + WA_KEY          WhatsApp to Hazem's own number (callmebot.com)
//   TG_TOKEN + TG_CHAT         Telegram bot to Hazem
// Cron trigger (Settings → Triggers → Cron): */2 * * * *  → checks waiting payments + new orders even with no page open.
// Telegram shop bot (optional):
//   SHOP_BOT_TOKEN   the bot's token from @BotFather. Then open  <this worker's address>/tg/setup  once in the browser.

const ORIGINS = ['https://hazem-store.com', 'https://www.hazem-store.com'];
const USDT_BSC = '0x55d398326f99059ff775485246999027b3197955';
const USDT_TRON = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const TRANSFER = '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
// Public BNB Smart Chain nodes. They only answer small block ranges for logs, so we ask in small steps.
// To put your own node first (e.g. a free NodeReal or BlockPI key), set BSC_RPC in the Worker settings (comma separated).
const BSC_PUBLIC = ['https://bsc-rpc.publicnode.com', 'https://bsc.blockpi.network/v1/rpc/public', 'https://binance.llamarpc.com', 'https://bsc.drpc.org', 'https://1rpc.io/bnb', 'https://bsc.meowrpc.com', 'https://bsc-mainnet.public.blastapi.io', 'https://bsc-dataseed.bnbchain.org'];
const PAY_MIN = 60;             // minutes the customer is asked to pay within
const ORDER_MIN = 10;           // site orders: not paid (and the customer did not say they sent it) within this → cancelled by the cron
const HOLD_H = 24;              // hours an exact amount belongs to one payment, and we keep accepting it
const CHUNKS = 8; // getLogs calls per check (each covers SPAN blocks, SPAN shrinks by itself if a node refuses)

const SITE = 'https://hazem-store.com';
let BUDGET = 45; // outside calls left in this run (Cloudflare allows 50 on the free plan)
function xf(url, init) { if (BUDGET <= 0) { const e = fail('busy, try again', 503); e.budget = true; throw e; } BUDGET--; return fetch(url, init); }
const VERSION = 23;
const STORE = 'حازم ستور';

export default {
  async scheduled(event, env, ctx) { BUDGET = 45; useRpcs(env); ctx.waitUntil(cron(env).catch(e => cronFailed(env, e))); },
  async fetch(req, env, ctx) {
    BUDGET = 45; useRpcs(env);
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
    if (url.pathname === '/tg/hook') return tgHook(req, env);
    try {
      if (req.method === 'GET' && url.pathname === '/tg/setup') return json(await tgSetup(env, url), 200, cors);
      if (req.method === 'GET' && url.pathname === '/tg/app/data') return new Response(JSON.stringify(await tgAppData(env)), { status: 200, headers: { ...cors, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'public, max-age=60' } });
      if (req.method === 'GET' && url.searchParams.has('cron')) return json(await cronNow(env), 200, cors);
      if (req.method === 'GET' && url.searchParams.has('rpc')) return json(await rpcProbe(env), 200, cors);
      if (req.method === 'GET') return json(await health(env), 200, cors);
      if (req.method !== 'POST') return json({ error: 'method' }, 405, cors);
      let body = {};
      try { body = JSON.parse(await req.text() || '{}'); } catch (e) { throw fail('bad json'); }
      const fs = await firestore(env);
      if (url.pathname === '/pay/start') return json(await start(fs, env, body), 200, cors);
      if (url.pathname === '/pay/check') return json(await check(fs, env, body, ctx), 200, cors);
      if (url.pathname === '/notify/test') return json(await notifyTest(fs, env), 200, cors);
      if (url.pathname === '/notify/delivered') return json(await notifyDelivered(fs, env, body), 200, cors);
      if (url.pathname === '/tg/app/order') return json(await tgAppOrder(env, body), 200, cors);
      if (url.pathname === '/tg/link') return json(await tgLinkMake(fs, env, body), 200, cors);
      return json({ error: 'not found' }, 404, cors);
    } catch (e) {
      return json({ error: e && e.message ? e.message : String(e) }, e && e.status ? e.status : 500, cors);
    }
  },
};
function json(o, status, headers) { return new Response(JSON.stringify(o), { status, headers: { ...headers, 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } }); }
function fail(msg, status) { const e = new Error(msg); e.status = status || 400; return e; }

// GET / : is the server set up and can it read the store?
function castInfo(raw, settings, waiting) {
  let C = {};
  try { C = JSON.parse(raw || '{}') || {}; } catch (e) {}
  return { on: !settings || settings.tgCast !== false, waiting, lastLook: C.scan || 0, err: C.err || '' };
}
// waiting USDT payments, and how far the last look at each network got (bscBehind: blocks not looked at yet)
function watchInfo(sd) {
  const sc = sd.scan || {};
  return { waiting: Object.keys(sd.w || {}).length, bscBehind: sc.bscLag ?? null, bscAt: sc.bscAt || 0, tronAt: sc.tron || 0, seen: Array.isArray(sd.seen) ? sd.seen.length : 0 };
}
async function health(env) {
  if (!env.SA_JSON) return { ok: false, service: 'hazem-pay', error: 'SA_JSON missing', notify: channels(env) };
  const fs = await firestore(env);
  const s = await fs.get('settings/main');
  const m = s && (s.data.payments || []).find(isUsdt);
  const st = await fs.get('payState/main');
  const sd = (st && st.data) || {};
  return { ok: true, service: 'hazem-pay', version: VERSION, project: fs.project, usdt: m ? { auto: !!m.auto, bsc: validAddr('bsc', m.number), tron: validAddr('tron', m.tron) } : null, notify: channels(env), bot: !!env.SHOP_BOT_TOKEN, ...(env.SHOP_BOT_TOKEN ? { botNews: castInfo(sd.tgCast, s && s.data, await fs.count('tgPosts', []).catch(() => -1)) } : {}), cron: sd.cronAt || 0, cronErr: sd.cronErr || '', cronFail: sd.cronFail || 0, usdtWatch: watchInfo(sd) };
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
    // an order from the site waits ORDER_MIN minutes from when it was made (at least 5 more after a network change)
    const ac = kind === 'order' && d.source === 'site';
    const exp = ac ? Math.max((+d.createdAt || now) + ORDER_MIN * 60e3, now + 5 * 60e3) : now + PAY_MIN * 60e3;
    // part paid from the customer's balance (taken when the order was made) is not asked again
    const ils = kind === 'topup' ? +d.amount : Math.round(((d.source === 'telegram' && +d.total > 0 ? +d.total : await orderTotal(fs, d)) - (+d.walletPart > 0 ? +d.walletPart : 0)) * 100) / 100;
    if (!(ils > 0)) throw fail('bad amount');
    const rate = +m.rate > 0 ? +m.rate : 3.1;
    const base = Math.ceil((ils / rate) * 100 - 1e-9) / 100;
    const head = net === 'bsc' ? await bscBlock() : 0;
    for (const tag of shuffle([...Array(99)].map((_, i) => i + 1)).slice(0, 15)) {
      const amt = r3(base + tag / 1000), lockId = `${net}_${amt.toFixed(3).replace('.', '_')}`;
      const lock = await fs.get(`payLocks/${lockId}`);
      if (lock && lock.data.exp > now && lock.data.ref !== ref) continue;
      const pay = { net, amt, addr, ils, rate, exp, lockExp: now + HOLD_H * 3600e3, startBlock: head ? head - 20 : 0, startTs: now - 120e3, scanned: 0, lock: lockId, ...(ac ? { ac: ORDER_MIN } : {}) };
      try {
        const wk = watchKey(kind, id);
        await fs.commit([
          fs.wUpdate(`payLocks/${lockId}`, { ref, exp: pay.lockExp }, null, lock ? { updateTime: lock.updateTime } : { exists: false }),
          fs.wUpdate(ref, { pay }, ['pay'], { updateTime: doc.updateTime }),
          fs.wUpdate('payState/main', { w: { [wk]: watchOf(pay) } }, ['w.' + fp(wk)]), // the cron keeps checking it
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
function payOut(p, d) { return { status: 'pending', net: p.net, amt: p.amt, addr: p.addr, exp: p.exp, ils: p.ils, rate: p.rate, no: d.orderNo || '', ac: p.ac || 0, said: !!p.said }; }
// cancelled by the cron because nothing came in time: a payment that still arrives brings it back
const autoGone = d => d.status === 'cancelled' && d.cancelledBy === 'auto';

// ---------------------------------------------------------------- /pay/check : look for the payment on the chain
async function check(fs, env, b, ctx, chunks) {
  const kind = b.kind === 'topup' ? 'topup' : 'order', id = cleanId(b.id);
  const col = kind === 'topup' ? 'topups' : 'orders', ref = `${col}/${id}`;
  const doc = await fs.get(ref);
  if (!doc) throw fail('not found', 404);
  const d = doc.data, p = d.pay, gone = autoGone(d);
  if (d.status !== 'pending' && !(gone && p && p.amt)) return finished(fs, d);
  if (!p || !p.amt) return { status: 'pending', nopay: true };
  if (Date.now() > p.lockExp) return { status: d.status, expired: true, amt: p.amt, net: p.net };
  // the customer pressed "I sent it": the order is not cancelled for being late
  const said = !!b.said && !p.said && !gone;
  let hits = [], scanned = p.scanned || 0;
  if (p.net === 'bsc') {
    const latest = (await bscBlock()) - 2, from = scanned ? scanned + 1 : p.startBlock;
    const to = Math.min(latest, from + SPAN * (chunks || CHUNKS) - 1);
    if (to >= from) { const r = await bscFind(p.addr, p.amt, from, to); hits = r.hits; if (r.upto >= from) scanned = r.upto; }
  } else {
    hits = await tronFind(env, p.addr, p.amt, p.startTs);
  }
  for (const h of hits) {
    const res = await settle(fs, env, kind, ref, id, h, ctx);
    if (res) return res;
  }
  if ((p.net === 'bsc' && scanned !== p.scanned) || said) {
    const f = { pay: { scanned } }, mk = ['pay.scanned'];
    if (said) { f.pay.said = Date.now(); mk.push('pay.said'); }
    const w = [fs.wUpdate(ref, f, mk, { exists: true })];
    if (said && p.ac) w.push(fs.wUpdate('payState/main', { w: { [watchKey(kind, id)]: { ...watchOf(p), x: 0 } } }, ['w.' + fp(watchKey(kind, id))]));
    try { await fs.commit(w); } catch (e) {}
  }
  return { status: d.status, amt: p.amt, net: p.net, exp: p.exp, said: said || !!p.said };
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

async function settle(fs, env, kind, ref, id, hit, ctx, again) {
  const doc = await fs.get(ref);
  if (!doc) return null;
  const d = doc.data, revive = kind === 'order' && autoGone(d);
  if (d.status !== 'pending' && !revive) return finished(fs, d);
  const txKey = `${d.pay.net}_${hit.tx.toLowerCase()}`;
  if (await fs.get(`usedTx/${txKey}`)) return null;
  const proof = `${d.pay.amt} USDT ${d.pay.net === 'tron' ? 'TRC20' : 'BEP20'} · ${hit.tx}`.slice(0, 120);
  const pay = { ...d.pay, tx: hit.tx, paidAmt: hit.amt };
  const used = fs.wUpdate(`usedTx/${txKey}`, { ref, amt: hit.amt, at: Date.now() }, null, { exists: false });
  const unlock = (d.pay.lock ? [{ delete: fs.name(`payLocks/${d.pay.lock}`) }] : []).concat([fs.wUpdate('payState/main', {}, ['w.' + fp(watchKey(kind, id))])]);
  const writes = [used];
  let status, claims = null, short = false;
  if (kind === 'topup') {
    status = 'approved';
    writes.push(fs.wUpdate(ref, { status, proofText: proof, pay }, ['status', 'proofText', 'pay'], { updateTime: doc.updateTime }, [{ fieldPath: 'decidedAt', setToServerValue: 'REQUEST_TIME' }]));
    writes.push(fs.wUpdate(`wallets/${d.uid}`, {}, [], null, [{ fieldPath: 'balance', increment: num(+d.amount) }]));
  } else {
    // the part from the balance is taken now, together with the payment (it was only held until now)
    const wp = +d.walletPart > 0 && d.walletDue === true ? +d.walletPart : 0;
    let wal = null;
    if (wp) { wal = d.uid ? await fs.get('wallets/' + d.uid) : null; short = !wal || (+wal.data.balance || 0) < wp - 1e-9; }
    claims = short || again ? null : await claimStock(fs, d);
    status = claims ? 'done' : 'paid';
    const fields = { status, proofText: proof, pay }, mask = ['status', 'proofText', 'pay'];
    const tr = [{ fieldPath: 'paidAt', setToServerValue: 'REQUEST_TIME' }];
    if (claims) { fields.stockIds = claims.map(c => c.id); mask.push('stockIds'); tr.push({ fieldPath: 'doneAt', setToServerValue: 'REQUEST_TIME' }); }
    if (wp && short) { fields.walletShort = true; mask.push('walletShort'); }
    if (wp && !short) { fields.walletDue = false; mask.push('walletDue'); tr.push({ fieldPath: 'walletPaidAt', setToServerValue: 'REQUEST_TIME' }); }
    if (revive) { mask.push('cancelledBy', 'cancelNote'); tr.push({ fieldPath: 'revivedAt', setToServerValue: 'REQUEST_TIME' }); }
    writes.push(fs.wUpdate(ref, fields, mask, { updateTime: doc.updateTime }, tr));
    if (wp && !short) writes.push(fs.wUpdate('wallets/' + d.uid, { balance: Math.round(((+wal.data.balance || 0) - wp) * 100) / 100 }, ['balance'], { updateTime: wal.updateTime }));
    for (const c of claims || []) writes.push(fs.wUpdate(`stock/${c.id}`, { owner: d.uid || 'guest_' + id, order: id }, ['owner', 'order'], { updateTime: c.updateTime }, [{ fieldPath: 'claimedAt', setToServerValue: 'REQUEST_TIME' }]));
  }
  try { await fs.commit(writes.concat(unlock)); } catch (e) {
    const now = await fs.get(ref);
    if (now && now.data.status !== 'pending') return finished(fs, now.data);
    // a code or the balance changed at the same moment: try once more, without instant delivery
    if (!again && now && e.status !== 409) return settle(fs, env, kind, ref, id, hit, ctx, true);
    return null;
  }
  const out = { status, tx: hit.tx, net: d.pay.net, amt: hit.amt };
  if (short) out.walletShort = true;
  if (revive) out.revived = true;
  if (claims) out.codes = await readCodes(fs, { ...d, stockIds: claims.map(c => c.id) });
  await later(ctx, notifyPaid(fs, env, kind, id, d, out));
  return out;
}
// in a request: send after answering; in the cron: wait for it
function later(ctx, p) { const q = p.catch(e => console.error('notify', e && e.message)); if (ctx && ctx.waitUntil) { ctx.waitUntil(q); return Promise.resolve(); } return q; }
function watchKey(kind, id) { return (kind === 'topup' ? 't_' : 'o_') + id; }
// what the cron needs to recognise a payment without reading its order: until, network, amount, address, start block / time
// x: when a site order is cancelled if nothing came (0: never, e.g. the customer said they sent it); z: already cancelled
function watchOf(p) { return { e: p.lockExp, n: p.net, a: p.amt, d: p.addr, b: p.startBlock || 0, t: p.startTs || 0, x: p.ac && !p.said ? p.exp : 0 }; }
const txLink = (net, tx) => net === 'tron' ? 'https://tronscan.org/#/transaction/' + tx : 'https://bscscan.com/tx/' + tx;
function fp(seg) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(seg) ? seg : '`' + seg.replace(/[`\\]/g, '\\$&') + '`'; }

// ---------------------------------------------------------------- cron: every 2 minutes
async function cron(env) {
  const fs = await firestore(env), now = Date.now();
  const st = await fs.get('payState/main'), s = (st && st.data) || {};
  const fields = { cronAt: now }, mask = ['cronAt'], errs = [];
  // 1. payments still waiting: keep checking them even if the customer closed the page
  try { await watchRun(fs, env, s, fields, mask, now, errs); } catch (e) { errs.push('usdt: ' + (e && e.message)); }
  // 1b. orders from the Telegram bot: tell the customer there when Hazem confirms, delivers or cancels
  if (env.SHOP_BOT_TOKEN) {
    const tw = s.tg || {};
    const ids = Object.keys(tw), k0 = ids.length > 6 ? (+s.tgK || 0) % ids.length : 0; // more than 6 waiting: take turns
    if (ids.length > 6) { fields.tgK = k0 + 6; mask.push('tgK'); }
    for (const id of [...ids.slice(k0), ...ids.slice(0, k0)].slice(0, 6)) {
      if (BUDGET < 18) break;
      try { if (await tgFollow(fs, env, id, tw[id]) === 'drop') mask.push('tg.' + fp(id)); }
      catch (e) { errs.push('tg ' + id + ': ' + (e && e.message)); }
    }
  }
  // 2. new orders, top-ups and support tickets → tell Hazem
  const cur = { ...(s.cur || {}) };
  for (const col of ['orders', 'topups', 'tickets']) {
    if (!cur[col]) { cur[col] = now; continue; } // first run: start from now, no flood of old orders
    try {
      const rows = await fs.query(col, [['createdAt', 'GREATER_THAN', new Date(cur[col])]], 10, 'createdAt');
      for (const r of rows) {
        cur[col] = Math.max(cur[col], (+r.data.createdAt || 0) + 1); // +1 ms: stored times are finer than ms
        const msg = newItemMsg(col, r.data);
        if (msg) await notifyAdmin(env, msg.title, msg.lines, SITE + '/admin.html').catch(e => errs.push('notify: ' + (e && e.message)));
        if (col === 'orders' && r.data.source !== 'telegram' && r.data.source !== 'manual' && env.SHOP_BOT_TOKEN) await tgAdminNotify(fs, env, r.id, r.data, '🆕 <b>طلب جديد من الموقع</b>').catch(e => errs.push('tg admin: ' + (e && e.message)));
      }
    } catch (e) { errs.push(col + ': ' + (e && e.message)); }
  }
  fields.cur = cur; mask.push('cur');
  // 3. announcements from the Telegram bot (new products, back in stock, new codes, lower prices)
  if (env.SHOP_BOT_TOKEN) {
    try { fields.tgCast = await tgCastRun(fs, env, s, now); mask.push('tgCast'); }
    catch (e) { errs.push('cast: ' + (e && e.message)); }
  }
  fields.cronErr = errs.join(' | ').slice(0, 600); mask.push('cronErr');
  await fs.commit([fs.wUpdate('payState/main', fields, [...new Set(mask)])]);
  return { checked: Object.keys(s.w || {}).length };
}

// All USDT payments go to the same address, so one look at the chain covers every waiting payment:
// each run reads the new transfers to the address once (BSC from where the last run stopped, Tron since the
// oldest waiting payment), keeps them for a day in payState/main.seen, and settles the payment whose exact amount
// arrived. Money that matches no waiting payment is reported to Hazem once, with the closest order when there is one.
async function watchRun(fs, env, s, fields, mask, now, errs) {
  const w = s.w || {}, live = [], up = {};
  for (const [key, v] of Object.entries(w)) {
    const old = typeof v === 'number', exp = old ? v : v && +v.e;
    if (!(exp > now)) { mask.push('w.' + fp(key)); continue; }
    live.push({ key, kind: key[0] === 't' ? 'topup' : 'order', id: key.slice(2), ...(old ? { e: v, old } : v) });
  }
  // payments started before version 18 only hold their end time: read them once and remember the rest
  for (const x of live.filter(x => x.old).slice(0, 4)) {
    if (BUDGET < 30) break;
    const doc = await fs.get((x.kind === 'topup' ? 'topups/' : 'orders/') + x.id).catch(() => null), p = doc && doc.data.pay;
    if (!doc || doc.data.status !== 'pending' || !p || !p.amt) { x.drop = true; mask.push('w.' + fp(x.key)); continue; }
    // its own checks already looked up to p.scanned, so the shared look starts after that
    const wo = { ...watchOf(p), b: Math.max(p.startBlock || 0, (+p.scanned || 0) + 1) };
    Object.assign(x, wo, { old: false });
    up[x.key] = wo; mask.push('w.' + fp(x.key));
  }
  const ready = live.filter(x => !x.old && !x.drop && x.a > 0 && validAddr(x.n, x.d));
  const seen = (Array.isArray(s.seen) ? s.seen : []).filter(t => t && t.at > now - (HOLD_H + 2) * 3600e3);
  const scan = { ...(s.scan || {}) }, have = new Set(seen.map(t => t.n + t.x));
  let changed = seen.length !== (Array.isArray(s.seen) ? s.seen.length : 0);
  const add = (n, list, extra) => { for (const t of list) if (!have.has(n + t.tx)) { have.add(n + t.tx); seen.push({ n, x: t.tx, a: t.a, ...extra(t), at: now }); changed = true; } };

  const bw = ready.filter(x => x.n === 'bsc'), tw = ready.filter(x => x.n === 'tron');
  if (bw.length) {
    try {
      if (SPAN < SPAN0) SPAN = Math.min(SPAN0, SPAN * 2); // a node refused a big range before: try bigger steps again
      const latest = (await bscBlock()) - 2, from = Math.max((+scan.bsc || 0) + 1, Math.min(...bw.map(x => x.b || latest)));
      if (from <= latest) {
        const r = await bscScan([...new Set(bw.map(x => x.d.toLowerCase()))], from, Math.min(latest, from + SPAN * 12 - 1), 28);
        add('bsc', r.list, t => ({ b: t.blk }));
        if (r.upto >= from) { scan.bsc = r.upto; scan.bscLag = latest - r.upto; scan.bscAt = now; }
      } else { scan.bscLag = 0; scan.bscAt = now; }
    } catch (e) { errs.push('bsc: ' + (e && e.message)); }
  }
  if (tw.length && BUDGET > 26) {
    const since = Math.max(Math.min(...tw.map(x => x.t || now)), (+scan.tron || 0) - 30 * 60e3);
    try {
      for (const addr of [...new Set(tw.map(x => x.d))]) add('tron', await tronScan(env, addr, since), t => ({ s: t.ts }));
      scan.tron = now;
    } catch (e) { errs.push('tron: ' + (e && e.message)); }
  }
  const after = (t, x) => x.n === 'bsc' ? !(t.b < x.b) : !(t.s < x.t);

  // the exact amount arrived → confirm it (and hand out the code) like the payment page does
  for (const x of ready) {
    const t = seen.find(t => t.n === x.n && !t.u && Math.abs(t.a - x.a) < 0.0005 && after(t, x));
    if (!t || BUDGET < 16) continue;
    let res = null;
    try { res = await settle(fs, env, x.kind, (x.kind === 'topup' ? 'topups/' : 'orders/') + x.id, x.id, { tx: t.x, amt: r3(t.a) }, null); }
    catch (e) { errs.push('settle ' + x.key + ': ' + (e && e.message)); }
    if (res) { t.u = 1; x.done = true; delete up[x.key]; mask.push('w.' + fp(x.key)); }
    else t.tries = (t.tries || 0) + 1;
    if (t.tries >= 3) t.u = 1;
    changed = true;
  }
  // site orders whose time is up with nothing in and no "I sent it": cancelled. Only after this run's look at that
  // network got near the top of the chain, and they stay watched: a payment that still arrives brings the order back.
  const fresh = { bsc: scan.bscAt === now && (+scan.bscLag || 0) <= 40, tron: scan.tron === now };
  const wf = x => ({ e: x.e, n: x.n, a: x.a, d: x.d, b: x.b, t: x.t });
  let cut = 0;
  for (const x of ready) {
    if (x.done || x.z || !x.x || x.kind !== 'order' || now < x.x + 90e3 || !fresh[x.n] || cut >= 3 || BUDGET < 18) continue;
    const ref = 'orders/' + x.id, doc = await fs.get(ref).catch(() => null), d = doc && doc.data, p = d && d.pay;
    const taken = d && +d.walletPart > 0 && d.walletDue !== true; // balance already taken: Hazem decides (refund)
    if (!d || d.status !== 'pending' || !p || p.tx || p.said || String(d.proofText || '').trim() || d.proofImage || taken) {
      up[x.key] = { ...wf(x), x: 0 }; mask.push('w.' + fp(x.key)); continue;
    }
    try {
      await fs.commit([fs.wUpdate(ref, { status: 'cancelled', cancelledBy: 'auto', cancelNote: 'ما وصل الدفع خلال ' + (+p.ac || ORDER_MIN) + ' دقائق' }, ['status', 'cancelledBy', 'cancelNote'], { updateTime: doc.updateTime }, [{ fieldPath: 'cancelledAt', setToServerValue: 'REQUEST_TIME' }])]);
      cut++; up[x.key] = { ...wf(x), x: 0, z: 1 }; mask.push('w.' + fp(x.key));
    } catch (e) { if (e.status !== 400 && e.status !== 409) errs.push('cancel ' + x.id + ': ' + (e && e.message)); }
  }
  // money that fits no waiting payment: tell Hazem once (one per run, so the run stays within its calls)
  for (const t of seen) {
    if (t.u || t.k || BUDGET < 16) continue;
    const open = ready.filter(x => !x.done && x.n === t.n);
    if (open.some(x => Math.abs(t.a - x.a) < 0.0005 && after(t, x))) continue; // still being settled
    const cands = open.filter(x => after(t, x));
    t.k = 1; changed = true;
    if (!cands.length) continue; // older than every waiting payment: not ours to explain
    if (await fs.get(`usedTx/${t.n}_${String(t.x).toLowerCase()}`).catch(() => null)) { t.u = 1; continue; } // already paid an order
    // fees make the money come in a little under what was asked, so those orders come first, then the closest
    const near = cands.filter(x => Math.abs(x.a - t.a) <= Math.max(1, x.a * 0.05)).sort((p, q) => (q.a >= t.a) - (p.a >= t.a) || Math.abs(p.a - t.a) - Math.abs(q.a - t.a));
    try { await usdtStray(fs, env, t, near); } catch (e) { errs.push('stray: ' + (e && e.message)); }
    break;
  }
  if (Object.keys(up).length) fields.w = up;
  if (changed) { fields.seen = seen.slice(-150); mask.push('seen'); }
  fields.scan = scan; mask.push('scan');
}
// near: the waiting payments whose amount is close to what came (closest first), possibly none
async function usdtStray(fs, env, t, near) {
  const net = t.n === 'tron' ? 'TRC20' : 'BEP20', link = txLink(t.n, t.x), got = r3(t.a) + ' USDT (' + net + ')';
  const rows = [], more = Math.max(0, near.length - 6);
  for (const x of near.slice(0, 6)) {
    const doc = await fs.get((x.kind === 'topup' ? 'topups/' : 'orders/') + x.id).catch(() => null);
    if (doc && (doc.data.status === 'pending' || autoGone(doc.data))) rows.push({ x, d: doc.data, name: (x.kind === 'topup' ? 'شحن رصيد ' + money(doc.data.amount) : 'طلب ' + (doc.data.orderNo || x.id)) + (autoGone(doc.data) ? ' (انلغى تلقائياً)' : '') });
  }
  if (!rows.length) {
    await notifyAdmin(env, '💸 وصل تحويل USDT ما عرفنا لأي طلب', ['وصل: ' + got, 'ما في طلب بانتظار هالمبلغ. شوف مين حوّل وأكّد طلبه يدوي.', link], SITE + '/admin.html');
    await tgAdminText(fs, env, `💸 <b>وصل تحويل USDT ما عرفنا لأي طلب</b>\nوصل: <b>${esc(got)}</b>\nما في طلب بانتظار هالمبلغ. شوف مين حوّل وأكّد طلبه يدوي.\n${link}`);
    return;
  }
  if (rows.length === 1) {
    const { x, d, name } = rows[0], want = x.a + ' USDT';
    await notifyAdmin(env, '⚠️ وصل تحويل USDT بمبلغ مختلف', [name, 'المطلوب: ' + want + ' · وصل: ' + got, 'الزبون: ' + who(d), 'إذا هو نفس الزبون أكّد الدفع يدوي.', link], SITE + '/admin.html');
    if (x.kind === 'order') await tgAdminNotify(fs, env, x.id, { ...d, proofText: 'المطلوب ' + want + ' · وصل ' + got + ' · ' + link }, '⚠️ <b>وصل تحويل USDT بمبلغ مختلف</b> لطلب').catch(() => {});
    return;
  }
  // several waiting payments with a close amount: list them, Hazem knows who sent it
  const list = rows.map(r => '• ' + r.name + ' — المطلوب ' + r.x.a + ' USDT — ' + who(r.d)).concat(more ? ['• و' + more + ' طلبات تانية بمبالغ قريبة'] : []);
  await notifyAdmin(env, '⚠️ وصل تحويل USDT بمبلغ مختلف', ['وصل: ' + got, 'قريب من هالطلبات:', ...list, 'شوف مين حوّل وأكّد طلبه يدوي.', link], SITE + '/admin.html');
  await tgAdminText(fs, env, `⚠️ <b>وصل تحويل USDT بمبلغ مختلف</b>\nوصل: <b>${esc(got)}</b>\nقريب من هالطلبات:\n${list.map(esc).join('\n')}\nشوف مين حوّل وأكّد طلبه يدوي.\n${link}`);
}
// a plain message to every admin who talks to the shop bot
async function tgAdminText(fs, env, text) {
  if (!env.SHOP_BOT_TOKEN) return 0;
  let n = 0;
  for (const chat of (await tgAdminChats(fs)).slice(0, 3)) { if (BUDGET < 3) break; if (await tg(env, 'sendMessage', { chat_id: chat, text, parse_mode: 'HTML', disable_web_page_preview: true })) n++; }
  return n;
}

async function cronFailed(env, e) {
  console.error('cron', e && e.message);
  try { const fs = await firestore(env); await fs.commit([fs.wUpdate('payState/main', { cronFail: Date.now(), cronErr: String(e && e.message || e).slice(0, 600) }, ['cronFail', 'cronErr'])]); } catch (e2) {}
}
// GET /?cron=1 : run the 2-minute job now (at most every 20 s) and show the result
async function cronNow(env) {
  const fs = await firestore(env), st = await fs.get('payState/main'), last = (st && st.data.cronAt) || 0;
  if (Date.now() - last < 20e3) return { ran: false, wait: true, cron: last };
  try { const r = await cron(env); const st2 = await fs.get('payState/main'); return { ran: true, ...r, cronErr: (st2 && st2.data.cronErr) || '' }; }
  catch (e) { await cronFailed(env, e); return { ran: false, error: String(e && e.message || e) }; }
}

// ---------------------------------------------------------------- notifications
function channels(env) {
  return { email: !!(env.RESEND_KEY && env.ADMIN_EMAIL), customers: !!(env.RESEND_KEY && env.MAIL_FROM), whatsapp: !!(env.WA_PHONE && env.WA_KEY), telegram: !!(env.TG_TOKEN && env.TG_CHAT) };
}
const money = n => (Math.round((+n || 0) * 100) / 100) + ' ₪';
function itemLines(d) { return (d.items || []).map(i => '• ' + (i.productName || '') + (i.planName ? ' (' + i.planName + ')' : '') + ((+i.qty || 1) > 1 ? ' ×' + i.qty : '') + ' — ' + money((+i.price || 0) * (+i.qty || 1))); }
function mixLine(d) { return +d.walletPart > 0 ? ['من رصيده: ' + money(d.walletPart) + ' · الباقي: ' + money((+d.total || 0) - d.walletPart)] : []; }
function who(d) { return [d.customer || d.name || '', d.phone || ''].filter(Boolean).join(' · '); }
function newItemMsg(col, d) {
  if (col === 'orders') {
    if (d.source !== 'site' && d.source !== 'wallet') return null;      // your own WhatsApp sales
    if (/usdt/i.test(d.payment || '') && d.pay) return null;            // told when the payment arrives
    const st = d.source === 'wallet' ? (d.status === 'done' ? 'دفع من رصيده وتسلّم تلقائياً بكود' : 'دفع من رصيده – سلّمه الاشتراك') : 'بانتظار تأكيدك للحوالة';
    return { title: '🛒 طلب جديد ' + (d.orderNo || ''), lines: [...itemLines(d), 'المجموع: ' + money(d.total), ...mixLine(d), 'الدفع: ' + (d.payment || ''), 'الزبون: ' + who(d), 'الحالة: ' + st] };
  }
  if (col === 'topups') {
    if (d.source === 'admin' || (/usdt/i.test(d.payment || '') && d.pay)) return null;
    return { title: '💳 طلب شحن رصيد ' + money(d.amount), lines: ['الدفع: ' + (d.payment || ''), 'الزبون: ' + who(d) + (d.email ? ' · ' + d.email : ''), 'الحالة: بانتظار تأكيدك'] };
  }
  if (col === 'tickets') return { title: '🎧 تذكرة دعم جديدة', lines: ['الموضوع: ' + (d.topic || ''), d.orderNo ? 'رقم الطلب: ' + d.orderNo : '', 'الزبون: ' + who(d), d.last ? 'الرسالة: ' + String(d.last).slice(0, 300) : ''].filter(Boolean) };
  return null;
}
async function notifyPaid(fs, env, kind, id, d, r) {
  const n = r.net === 'tron' ? 'TRC20' : 'BEP20', paid = r.amt + ' USDT (' + n + ')';
  if (kind === 'topup') {
    await notifyAdmin(env, '✅ انشحن رصيد ' + money(d.amount) + ' تلقائياً', ['وصل: ' + paid, 'الزبون: ' + who(d) + (d.email ? ' · ' + d.email : '')], SITE + '/admin.html');
    if (d.email) await mailCustomer(env, d.email, 'انضاف ' + money(d.amount) + ' لرصيدك ✓', d.name, ['وصلت دفعتك ' + paid + ' وتأكدت، وانضاف <b>' + esc(money(d.amount)) + '</b> لرصيدك.', 'هلأ فيك تشتري أي اشتراك بضغطة من رصيدك.']);
    return;
  }
  const done = r.status === 'done';
  await tgAdminNotify(fs, env, id, { ...d, status: done ? 'done' : 'paid' }, done ? '⚡ <b>دفعة USDT وصلت وتسلّم تلقائياً</b>' : '💰 <b>وصلت دفعة USDT</b>').catch(() => {});
  await notifyAdmin(env, '✅ وصلت دفعة USDT — طلب ' + (d.orderNo || ''), [...itemLines(d), ...mixLine(d), ...(r.walletShort ? ['⚠️ رصيد الزبون ما كفى للجزء ' + money(d.walletPart) + '، اطلب منه الباقي قبل التسليم'] : []), ...(r.revived ? ['↩️ الطلب كان انلغى تلقائياً (ما وصل الدفع خلال ' + ORDER_MIN + ' دقائق) ورجع لما وصلت الدفعة'] : []), 'وصل: ' + paid, 'الزبون: ' + who(d) + (d.email ? ' · ' + d.email : ''), done ? 'الحالة: تسلّم تلقائياً بكود ✓' : 'الحالة: قيد التسليم — سلّمه الاشتراك'], SITE + '/admin.html');
  if (d.source === 'telegram') return; // the bot tells them on Telegram, no email with a link to the site
  let to = d.email || '';
  if (!to && d.uid) { const w = await fs.get('wallets/' + d.uid); to = (w && w.data.email) || ''; }
  if (!to) return;
  const items = (d.items || []).map(i => esc(i.productName + (i.planName ? ' (' + i.planName + ')' : ''))).join('<br>');
  if (done) {
    const codes = (r.codes || []).map(c => '<div style="margin:8px 0;padding:10px 12px;border:1px dashed #16a34a;border-radius:10px;background:#f0fdf4"><div style="font-size:12px;color:#15803d">' + esc(c.name) + '</div><pre dir="ltr" style="margin:4px 0 0;font:600 14px/1.5 monospace;white-space:pre-wrap;text-align:left">' + esc(c.value) + '</pre></div>').join('');
    await mailCustomer(env, to, 'تم تسليم طلبك ' + (d.orderNo || '') + ' ✓', d.customer, ['وصلت دفعتك ' + paid + ' وتأكدت، وهاي بيانات التفعيل:', items, codes, 'احفظها عندك. إذا احتجت أي إشي راسلنا برقم الطلب <b dir="ltr">' + esc(d.orderNo || '') + '</b>.']);
  } else {
    await mailCustomer(env, to, 'وصلت دفعتك ✓ طلبك ' + (d.orderNo || '') + ' قيد التجهيز', d.customer, ['وصلت دفعتك ' + paid + ' وتأكدت.', items, 'طلبك رقم <b dir="ltr">' + esc(d.orderNo || '') + '</b> قيد التجهيز، ورح نبعتلك التفاصيل على واتساب بأقرب وقت.']);
  }
}
async function notifyAdmin(env, title, lines, link) {
  const text = title + '\n' + lines.join('\n'), jobs = [], names = [];
  if (env.WA_PHONE && env.WA_KEY) names.push('whatsapp'), jobs.push(xf('https://api.callmebot.com/whatsapp.php?phone=' + encodeURIComponent(env.WA_PHONE) + '&text=' + encodeURIComponent(text) + '&apikey=' + encodeURIComponent(env.WA_KEY)));
  if (env.TG_TOKEN && env.TG_CHAT) names.push('telegram'), jobs.push(xf('https://api.telegram.org/bot' + env.TG_TOKEN + '/sendMessage', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat_id: env.TG_CHAT, text: text + (link ? '\n' + link : ''), disable_web_page_preview: true }) }));
  if (env.RESEND_KEY && env.ADMIN_EMAIL) names.push('email'), jobs.push(sendMail(env, env.ADMIN_EMAIL, title, mailHTML(title, null, lines.map(esc), link, 'افتح لوحة الإدارة')));
  const res = await Promise.allSettled(jobs), errors = [];
  let sent = 0;
  for (let i = 0; i < res.length; i++) {
    const x = res[i];
    if (x.status === 'fulfilled' && x.value && x.value.ok) { sent++; continue; }
    let msg = x.status === 'rejected' ? String(x.reason && x.reason.message || x.reason) : 'http ' + x.value.status;
    if (x.status === 'fulfilled') { try { const t = await x.value.text(); try { const j = JSON.parse(t); msg = j.message || j.description || t; } catch (e) { msg = t || msg; } } catch (e) {} }
    errors.push({ ch: names[i], msg: String(msg).slice(0, 300) });
    console.error('notify', names[i], msg);
  }
  notifyAdmin.last = errors;
  return sent;
}
async function mailCustomer(env, to, subject, name, paras) {
  if (!(env.RESEND_KEY && env.MAIL_FROM) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return;
  await sendMail(env, to, subject, mailHTML(subject, name, paras, SITE, 'زور المتجر'));
}
function sendMail(env, to, subject, html) {
  return xf('https://api.resend.com/emails', { method: 'POST', headers: { authorization: 'Bearer ' + env.RESEND_KEY, 'content-type': 'application/json' }, body: JSON.stringify({ from: env.MAIL_FROM || STORE + ' <onboarding@resend.dev>', to: [to], subject, html }) });
}
function mailHTML(title, name, paras, link, linkLabel) {
  return '<div dir="rtl" style="font-family:Tahoma,Arial,sans-serif;background:#f4f6fb;padding:24px 12px"><div style="max-width:520px;margin:0 auto;background:#fff;border-radius:16px;padding:22px 20px;border:1px solid #e4e8f2;color:#1b2440;line-height:1.8;font-size:15px">' +
    '<div style="font-weight:800;font-size:18px;color:#1d4ed8;margin-bottom:6px">' + STORE + '</div><h2 style="margin:0 0 10px;font-size:18px">' + esc(title) + '</h2>' +
    (name ? '<p style="margin:0 0 8px">مرحباً ' + esc(name) + '،</p>' : '') + paras.filter(Boolean).map(p => '<div style="margin:0 0 10px">' + p + '</div>').join('') +
    (link ? '<a href="' + link + '" style="display:inline-block;margin-top:6px;background:#1d4ed8;color:#fff;text-decoration:none;padding:10px 18px;border-radius:10px;font-weight:700">' + linkLabel + '</a>' : '') +
    '</div></div>';
}
function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
// Hazem wrote the delivery details on a done order → email them to the customer (once per change)
async function notifyDelivered(fs, env, b) {
  const id = cleanId(b.id), doc = await fs.get('orders/' + id);
  if (!doc) throw fail('not found', 404);
  const d = doc.data;
  if (d.status !== 'done' || !d.delivery) return { sent: false, why: 'not delivered' };
  const sig = String(d.deliveredAt || '') + ':' + String(d.delivery).length;
  // a Telegram bot order: the details go to the customer's chat
  if (d.tgChat && env.SHOP_BOT_TOKEN && d.dlvTg !== sig) { await tgNotifyStatus(fs, env, id, d, sig); return { sent: true, telegram: true }; }
  if (d.dlvMail === sig) return { sent: false, why: 'already sent' };
  let to = d.email || '';
  if (!to && d.uid) { const w = await fs.get('wallets/' + d.uid); to = (w && w.data.email) || ''; }
  if (!to) return { sent: false, why: 'no email' };
  if (!(env.RESEND_KEY && env.MAIL_FROM)) return { sent: false, why: 'customer emails off' };
  const items = (d.items || []).map(i => esc(i.productName + (i.planName ? ' (' + i.planName + ')' : ''))).join('<br>');
  const box = '<div style="margin:8px 0;padding:12px;border:1px dashed #16a34a;border-radius:10px;background:#f0fdf4"><pre dir="auto" style="margin:0;font:600 14px/1.7 Tahoma,Arial,sans-serif;white-space:pre-wrap">' + esc(d.delivery) + '</pre></div>';
  await mailCustomer(env, to, 'تم تسليم طلبك ' + (d.orderNo || '') + ' ✓', d.customer, ['تم تسليم طلبك رقم <b dir="ltr">' + esc(d.orderNo || '') + '</b>:', items, box, 'بتلاقي هاي التفاصيل كمان بحسابك على الموقع تحت "طلباتي".']);
  await fs.commit([fs.wUpdate('orders/' + id, { dlvMail: sig }, ['dlvMail'], { exists: true })]);
  return { sent: true };
}
// a test message from the admin panel, at most once a minute
async function notifyTest(fs, env) {
  const ch = channels(env);
  if (!ch.email && !ch.whatsapp && !ch.telegram) return { sent: 0, notify: ch };
  const st = await fs.get('payState/main'), last = (st && st.data.testAt) || 0;
  if (Date.now() - last < 60e3) return { sent: 0, wait: true, notify: ch };
  await fs.commit([fs.wUpdate('payState/main', { testAt: Date.now() }, ['testAt'])]);
  const sent = await notifyAdmin(env, '🔔 تجربة إشعارات ' + STORE, ['هيك رح توصلك الطلبات الجديدة والدفعات.'], SITE + '/admin.html');
  return { sent, errors: notifyAdmin.last || [], notify: ch };
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
let RPCS = BSC_PUBLIC, rpcI = 0, SPAN = 200, SPAN0 = 200; // SPAN0: the step to go back to after a node refused a range
const RANGE_ERR = /range|too (large|big|wide)|block limit|max(imum)? .{0,20}block|more than \d+ (blocks|results)|10000 results|response size/i;
const rest = {}; // node → time it may be tried again (it said it is busy or needs a key)
function useRpcs(env) {
  const own = String((env && env.BSC_RPC) || '').split(',').map(x => x.trim()).filter(x => /^https:\/\//.test(x));
  const list = own.concat(BSC_PUBLIC.filter(u => !own.includes(u)));
  if (list.join() !== RPCS.join()) { RPCS = list; rpcI = 0; SPAN0 = own.length ? 1000 : 200; if (own.length && SPAN === 200) SPAN = 1000; } // a private node answers bigger ranges
}
async function rpcOne(url, method, params) {
  const r = await xf(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }), signal: AbortSignal.timeout ? AbortSignal.timeout(8000) : undefined });
  const t = await r.text(); let j;
  try { j = JSON.parse(t); } catch (e) { throw new Error('http ' + r.status + ' ' + t.slice(0, 80)); }
  if (j.error) throw new Error(String(j.error.message || 'rpc error'));
  return j.result;
}
// up to 3 nodes per call, starting from the one that answered last; busy nodes rest for 5 minutes
async function rpc(method, params) {
  let last, tried = 0;
  for (let k = 0; k < RPCS.length && tried < 3; k++) {
    const i = (rpcI + k) % RPCS.length, url = RPCS[i];
    if (rest[url] > Date.now() && k < RPCS.length - 1) continue;
    tried++;
    try { const res = await rpcOne(url, method, params); rpcI = i; delete rest[url]; return res; }
    catch (e) { if (e.budget) throw e; last = e; if (!RANGE_ERR.test(String(e.message))) rest[url] = Date.now() + 5 * 60e3; }
  }
  throw last || new Error('rpc down');
}
async function bscBlock() { return parseInt(await rpc('eth_blockNumber', []), 16); }
// every USDT transfer to the address(es) in [from, to], and the last block fully looked at
// (stops early when only `keep` outside calls are left)
async function bscScan(addrs, from, to, keep) {
  const tops = addrs.map(x => '0x000000000000000000000000' + x.toLowerCase().replace(/^0x/, '')), list = [];
  const topic = tops.length === 1 ? tops[0] : tops;
  let a = from;
  while (a <= to && BUDGET > keep) {
    const b = Math.min(to, a + SPAN - 1);
    let logs;
    try { logs = await rpc('eth_getLogs', [{ address: USDT_BSC, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16), topics: [TRANSFER, null, topic] }]); }
    catch (e) { if (SPAN > 25 && RANGE_ERR.test(String(e && e.message))) { SPAN = Math.max(25, Math.floor(SPAN / 2)); continue; } if (a > from) break; throw e; }
    for (const l of logs || []) {
      const v = Number(BigInt(l.data) / 10n ** 12n) / 1e6; // 18 decimals → 6, no float drift
      list.push({ tx: l.transactionHash, a: v, blk: parseInt(l.blockNumber, 16) || b });
    }
    a = b + 1;
  }
  return { list, upto: a - 1 };
}
// returns the matches and the last block fully looked at (stops early if few calls are left)
async function bscFind(addr, amt, from, to) {
  const r = await bscScan([addr], from, to, 12);
  return { hits: r.list.filter(t => Math.abs(t.a - amt) < 0.0005).map(t => ({ tx: t.tx, amt: r3(t.a) })), upto: r.upto };
}
// GET /?rpc=1 : which BNB Smart Chain nodes answer, and for how many blocks
async function rpcProbe(env) {
  const fs = await firestore(env), s = await fs.get('settings/main');
  const m = s && (s.data.payments || []).find(isUsdt), addr = (m && validAddr('bsc', m.number)) ? m.number : '0x289B2eae953DBaa04ba59EED4694B6b2919cFEf5';
  const topic = '0x000000000000000000000000' + addr.toLowerCase().replace(/^0x/, ''), out = [];
  for (const url of RPCS) {
    const own = !BSC_PUBLIC.includes(url), row = { node: own ? new URL(url).host + ' (مفتاحك)' : url.replace(/^https:\/\//, '').slice(0, 44) }; // never show the key
    try {
      const t0 = Date.now(), b = parseInt(await rpcOne(url, 'eth_blockNumber', []), 16); row.block = b; row.ms = Date.now() - t0;
      for (const span of [200, 2000]) {
        try { await rpcOne(url, 'eth_getLogs', [{ address: USDT_BSC, fromBlock: '0x' + (b - span).toString(16), toBlock: '0x' + b.toString(16), topics: [TRANSFER, null, topic] }]); row['logs' + span] = 'ok'; }
        catch (e) { row['logs' + span] = String(e.message).slice(0, 60); break; }
      }
    } catch (e) { row.err = String(e.message).slice(0, 70); }
    out.push(row);
  }
  let tron = '';
  try { const r = await xf('https://api.trongrid.io/v1/accounts/' + ((m && validAddr('tron', m.tron)) ? m.tron : 'THodKuiPeTJj6qq1QfEeGM8eVfuak1JLti') + '/transactions/trc20?limit=1&contract_address=' + USDT_TRON, { headers: env.TRONGRID_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_KEY } : {} }); tron = r.ok ? 'ok' : 'http ' + r.status + ' ' + (await r.text()).slice(0, 60); } catch (e) { tron = String(e.message).slice(0, 60); }
  return { span: SPAN, own: !!(env.BSC_RPC), nodes: out, tron };
}
// every confirmed USDT transfer to the address since a time (newest 200)
async function tronScan(env, addr, sinceTs) {
  const u = `https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20?only_to=true&only_confirmed=true&limit=200&contract_address=${USDT_TRON}&min_timestamp=${Math.floor(sinceTs)}`;
  const r = await xf(u, { headers: env.TRONGRID_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_KEY } : {}, signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined });
  if (!r.ok) throw new Error('trongrid ' + r.status);
  const j = await r.json(), out = [];
  for (const t of j.data || []) {
    if (t.to !== addr || (t.token_info && t.token_info.address !== USDT_TRON)) continue;
    out.push({ tx: t.transaction_id, a: Number(t.value) / 1e6, ts: +t.block_timestamp || 0 });
  }
  return out;
}
async function tronFind(env, addr, amt, sinceTs) {
  return (await tronScan(env, addr, sinceTs)).filter(t => Math.abs(t.a - amt) < 0.0005).map(t => ({ tx: t.tx, amt: r3(t.a) }));
}

// ================================================================ Telegram shop bot
// Same products, prices and payment methods as the site. Orders land in the admin panel (source "telegram"),
// and the customer hears back in the chat when the payment is confirmed, the order delivered or cancelled.
// Chat state lives in Firestore at tgBot/<chat id> (only this server can read it).
const TGB = 'https://api.telegram.org/bot';
let TGC = { at: 0 };

async function tgSecret(env) {
  const h = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('hz-shop:' + env.SHOP_BOT_TOKEN)));
  return [...h].slice(0, 20).map(b => b.toString(16).padStart(2, '0')).join('');
}
async function tg(env, method, body, plain) {
  const raw = JSON.stringify(body);
  const r = await xf(TGB + env.SHOP_BOT_TOKEN + '/' + method, { method: 'POST', headers: { 'content-type': 'application/json' }, body: raw });
  let j = null;
  try { j = await r.json(); } catch (e) {}
  TGERR = '';
  if (j && j.ok) return j.result;
  const why = (j && j.description) || 'http ' + r.status;
  if (/message is not modified/.test(why)) return {};
  console.error('tg', method, why);
  TGERR = why;
  // the brand icons need Telegram Premium on the bot owner's account: without it, send the same thing without them
  if (!plain && /icon_custom_emoji_id|tg-emoji/.test(raw) && !TG_GONE.test(why) && !/too many|retry after/i.test(why)) {
    ICON_OFF = Date.now() + 30 * 60e3;
    return tg(env, method, tgPlain(body), true);
  }
  return null;
}
let TGERR = '', ICON_OFF = 0; // why the last Telegram call failed; icons paused until
const TG_GONE = /blocked|deactivated|chat not found|kicked|PEER_ID_INVALID|user not found/i;
function tgPlain(body) {
  const b = JSON.parse(JSON.stringify(body));
  const un = t => String(t).replace(/<tg-emoji[^>]*>([\s\S]*?)<\/tg-emoji>/g, '$1');
  if (b.text) b.text = un(b.text);
  if (b.caption) b.caption = un(b.caption);
  if (b.media && b.media.caption) b.media.caption = un(b.media.caption);
  const kb = b.reply_markup && b.reply_markup.inline_keyboard;
  if (kb) for (const row of kb) for (const x of row) if (x.icon_custom_emoji_id) { delete x.icon_custom_emoji_id; if (x._e) x.text = x._e + ' ' + x.text; }
  if (kb) for (const row of kb) for (const x of row) delete x._e;
  return b;
}

// GET /tg/setup : connect the bot to this server (open it once in the browser after adding SHOP_BOT_TOKEN)
async function tgSetup(env, url) {
  if (!env.SHOP_BOT_TOKEN) return { ok: false, error: 'SHOP_BOT_TOKEN missing: add it in the Worker settings (Variables and Secrets)' };
  const me = await tg(env, 'getMe', {});
  if (!me) return { ok: false, error: 'Telegram did not accept SHOP_BOT_TOKEN: copy it again from @BotFather' };
  const hook = url.origin + '/tg/hook';
  const set = await tg(env, 'setWebhook', { url: hook, secret_token: await tgSecret(env), allowed_updates: TG_UPDATES, drop_pending_updates: true, max_connections: 10 });
  try { const fs = await firestore(env); await tgProfile(env, url.origin, await tgData(fs)); await fs.commit([fs.wUpdate('tgMeta/bot', { v: TG_BOT_V, at: Date.now() }, ['v', 'at'])]); TGSET = TG_BOT_V; } catch (e) {}
  return { ok: !!set, bot: '@' + me.username, link: 'https://t.me/' + me.username, webhook: hook };
}

// ---------------------------------------------------------------- the bot's profile (v21): the ☰ Menu list, the text people see
// before they press «ابدأ», and the kinds of updates we take (inline_query for sharing from any chat). Set again by the
// first update after a new version (tgMeta/bot.v), so nobody has to open /tg/setup.
const TG_BOT_V = 23;
const TG_UPDATES = ['message', 'callback_query', 'inline_query'];
const TG_CMDS = [{ command: 'start', description: '🏠 البدء' }, { command: 'products', description: '🛍 المنتجات' }, { command: 'help', description: '❓ المساعدة' }];
function tgAbout(data) {
  const all = (data.products || []).filter(p => !p.bundle && !tgOut(p));
  const latin = all.map(p => tgClean(p.name).split(' ')[0]).filter(n => /^[A-Za-z]/.test(n)).filter((n, i, a) => a.indexOf(n) === i);
  const one = latin.slice(0, 4), two = latin.slice(4, 8), rest = all.length - one.length - two.length;
  const pm = (data.settings.payments || []).filter(m => m.active !== false && m.name).map(m => tgClean(m.name));
  const ar = pm.filter(n => !/^[A-Za-z]/.test(n)), la = pm.filter(n => /^[A-Za-z]/.test(n)).slice(0, 1);
  const pays = [...ar.slice(0, 4 - la.length), ...la].join(' · ');   // Latin (USDT) last, so the line stays right-to-left
  const L = ['🛍 اشتراكات رقمية رسمية بالشيكل', ''];
  if (one.length) L.push('🔹 ' + one.join(' · '));
  if (two.length) L.push('🔹 ' + two.join(' · '));
  if (one.length && rest > 0) L.push(`➕ و${rest === 1 ? 'خدمة' : tgSvc(rest)} كمان`);
  L.push('', '⚡ التفعيل خلال دقائق بعد تأكيد الدفع', '💳 ' + (pays || 'دفع محلي'), '💬 دعم حقيقي على تيليجرام وواتساب', '', '👇 اكبس «ابدأ» وشوف الأسعار');
  return L.join('\n').slice(0, 500);
}
// "خدمة" with its number, the Arabic way
function tgSvc(n) { n = +n || 0; return n === 1 ? 'خدمة وحدة' : n === 2 ? 'خدمتين' : n <= 10 ? `${n} خدمات` : `${n} خدمة`; }
async function tgProfile(env, origin, data) {
  const ok = await tg(env, 'setMyCommands', { commands: TG_CMDS });
  await tg(env, 'setMyDescription', { description: tgAbout(data) });
  await tg(env, 'setMyShortDescription', { short_description: 'اشتراكات رقمية رسمية بالشيكل · تفعيل خلال دقائق · دعم مباشر' });
  const hook = await tg(env, 'setWebhook', { url: origin + '/tg/hook', secret_token: await tgSecret(env), allowed_updates: TG_UPDATES, max_connections: 10 });
  return !!ok && !!hook;
}
let TGSET = 0;
async function tgProfileOnce(env, origin) {
  if (TGSET === TG_BOT_V) return;
  TGSET = TG_BOT_V;
  try {
    const fs = await firestore(env), cur = await fs.get('tgMeta/bot');
    if (cur && +cur.data.v === TG_BOT_V) return;
    if (await tgProfile(env, origin, await tgData(fs))) await fs.commit([fs.wUpdate('tgMeta/bot', { v: TG_BOT_V, at: Date.now() }, ['v', 'at'])]);
  } catch (e) { console.error('tg profile', e && e.message); TGSET = 0; }
}

// POST /tg/hook : every message and button press from Telegram
async function tgHook(req, env) {
  const ok = new Response('ok');
  if (req.method !== 'POST' || !env.SHOP_BOT_TOKEN) return ok;
  if (req.headers.get('x-telegram-bot-api-secret-token') !== await tgSecret(env)) return new Response('forbidden', { status: 403 });
  let u;
  try { u = await req.json(); } catch (e) { return ok; }
  await tgProfileOnce(env, new URL(req.url).origin);
  try { await tgUpdate(env, u); } catch (e) {
    console.error('tg update', e && (e.stack || e.message));
    const cb = u.callback_query, chat = (u.message && u.message.chat && u.message.chat.id) || (cb && cb.message && cb.message.chat.id);
    if (chat) { try { await tg(env, 'sendMessage', { chat_id: chat, text: 'صار خطأ عندنا 🙏 جرّب كمان مرة بعد شوي، أو كلّمنا على الدعم.', reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] } }); } catch (e2) {} }
  }
  return ok;
}

async function tgData(fs) {
  if (TGC.products && Date.now() - TGC.at < TGC_MS) return TGC;
  const [rows, s, ic, ad, sl] = await Promise.all([fs.list('products'), fs.get('settings/main'), fs.get('tgMeta/icons'), fs.get('tgMeta/admins'), fs.get('tgMeta/sales')]);
  const settings = (s && s.data) || {};
  const products = rows.map(d => tgBotView({ ...d.data, id: d.id })).filter(Boolean)
    .filter(p => p.active !== false && Array.isArray(p.plans) && p.plans.some(pl => +pl.price > 0))
    .sort((a, b) => (+a.sort || 0) - (+b.sort || 0));
  const im = (ic && ic.data) || null;
  TGC = { at: Date.now(), products, settings, im, icons: im && im.on !== false && (im.prem || im.force) ? { ...(im.map || {}), ...(im.man || {}) } : {}, ph: (TGC && TGC.ph) || {},
    admins: (ad && ad.data.chats) || {}, sales: (sl && sl.data.s) || {} };
  return TGC;
}
const TGC_MS = 60e3;
// what the bot sells: everything except products marked "site only", at the bot's own price where Hazem set one
function tgBotView(p) {
  if (!p || p.where === 'site') return null;
  if (!Array.isArray(p.plans) || !p.plans.some(x => x && +x.tgPrice > 0)) return p;
  return { ...p, plans: p.plans.map(x => x && +x.tgPrice > 0 ? { ...x, price: +x.tgPrice, sitePrice: +x.price } : x) };
}
const tgBtn = (text, data) => ({ text, callback_data: data });
const tgUrl = (text, url) => ({ text, url });
function tgRows(a, n) { const o = []; for (let i = 0; i < a.length; i += n) o.push(a.slice(i, i + n)); return o; }
function tgClean(n) { return String(n || '').replace(/^[ً-ٰٟ\s]+/, '').replace(/\s+/g, ' ').trim(); }
function tgN(n) { return String(Math.round((+n || 0) * 100) / 100); }
function tgNorm(t) { return String(t || '').toLowerCase().replace(/[ً-ْـ]/g, '').replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه').replace(/[ىئ]/g, 'ي').replace(/ؤ/g, 'و').replace(/[غقگچ]/g, 'ج').replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
function tgLow(p) { const ok = p.plans.filter(x => +x.price > 0), live = ok.filter(x => !x.out && !p.soldOut); return Math.min(...(live.length ? live : ok).map(x => +x.price)); }
function tgPrice(p) { const many = new Set(p.plans.filter(x => +x.price > 0 && !x.out).map(x => +x.price)).size > 1; return (many ? 'من ' : '') + tgN(tgLow(p)) + ' ₪'; }
// support: Hazem's Telegram account (admin settings → بوت تيليجرام), never WhatsApp or the site
function tgUserName(v) { return String(v || '').trim().replace(/^.*t\.me\//i, '').replace(/^@/, '').replace(/[^A-Za-z0-9_]/g, ''); }
function tgSupUser(data) { return tgUserName(data.settings.tgSupport) || 'hazemstoresupport'; }
function tgSup(c) { return 'https://t.me/' + tgSupUser(c.data); }
function tgIsAdmin(c) {
  const u = String(c.from.username || '').toLowerCase();
  const list = String(c.data.settings.tgAdmins || 'hazemstoresupport').split(/[\s,،]+/).map(x => tgUserName(x).toLowerCase()).filter(Boolean);
  return !!u && list.includes(u);
}
function tgMethods(c) {
  return (c.data.settings.payments || []).map((m, i) => ({ ...m, key: String(m.id || i) })).filter(m => m.active !== false && m.name)
    .filter(m => !(isUsdt(m) && m.auto) || validAddr('bsc', m.number) || validAddr('tron', m.tron));
}
function tgPayList(c) { const n = tgMethods(c).map(m => m.name).slice(0, 4); return n.length > 1 ? n.slice(0, -1).join('، ') + ' أو ' + n[n.length - 1] : (n[0] || 'التحويل'); }
function tgWho(f) { return ([f.first_name, f.last_name].filter(Boolean).join(' ').trim() || f.username || 'زبون تيليجرام').slice(0, 60); }

async function tgUpdate(env, u) {
  if (u.inline_query) return tgInline(env, u.inline_query);
  const cb = u.callback_query, m = u.message;
  const chatObj = cb ? cb.message && cb.message.chat : m && m.chat;
  if (!chatObj || chatObj.type !== 'private') return;
  const c = await tgCtx(env, chatObj.id, (cb ? cb.from : m.from) || {}, cb && cb.message ? cb.message.message_id : 0);
  const { fs, data } = c;
  c.isPhoto = !!(cb && cb.message && (cb.message.photo || cb.message.caption != null));
  if (cb) {
    await tgOnButton(c, String(cb.data || ''));
    await tg(env, 'answerCallbackQuery', c.alert ? { callback_query_id: cb.id, text: c.alert, show_alert: true } : { callback_query_id: cb.id });
  } else await tgOnMessage(c, m);
  // everyone who talks to the bot goes on the list for announcements (tgUsers), once
  // admins are remembered, so new orders and the nightly summary can reach them here
  if (tgIsAdmin(c) && !(data.admins || {})[c.chat]) {
    await fs.commit([fs.wUpdate('tgMeta/admins', { chats: { [c.chat]: c.from.username || '' } }, ['chats.' + fp(String(c.chat))])]);
    TGC.at = 0;
  }
  // the icons show only when the bot owner has Telegram Premium: follow the admin's Premium (the owner) once icons exist
  if (data.im && !data.im.force && tgIsAdmin(c) && !!c.from.is_premium !== !!data.im.prem) {
    await fs.commit([fs.wUpdate('tgMeta/icons', { prem: !!c.from.is_premium }, ['prem'])]);
    TGC.at = 0;
  }
  await tgSave(c);
}
async function tgCtx(env, chat, from, msgId) {
  const fs = await firestore(env), data = await tgData(fs), sd = await fs.get('tgBot/' + chat);
  return { env, fs, data, chat, from: from || {}, S: (sd && sd.data) || {}, msgId: msgId || 0, dirty: false, alert: '', keys: (sd && +sd.data.keys) || 0, fresh: !sd || !sd.data.reg };
}
// the chat's half-done state (tgBot) and, the first time, its place on the announcements list (tgUsers)
async function tgSave(c) {
  if (!c.dirty && !c.fresh) return;
  const w = [c.fs.wUpdate('tgBot/' + c.chat, { ...c.S, at: Date.now(), reg: 1, keys: c.keys })];
  if (c.fresh) { const f = { name: tgWho(c.from), user: c.from.username || '', at: Date.now(), off: false, ...(c.newRef ? { refBy: c.newRef } : {}) }; w.push(c.fs.wUpdate('tgUsers/' + c.chat, f, Object.keys(f))); }
  await c.fs.commit(w);
  c.fresh = false; c.dirty = false;
}
function tgMarkup(kb) {
  if (!kb) return {};
  if (!Array.isArray(kb)) return { reply_markup: kb };
  return { reply_markup: { inline_keyboard: kb.map(row => row.map(x => { if (!x._e) return x; const y = { ...x }; delete y._e; return y; })) } };
}
// tgPlain needs the stand-in emoji (_e) when it strips an icon, so the stripping happens before _e is dropped
function tgCall(env, method, body, kb) {
  if (!Array.isArray(kb) || !kb.some(r => r.some(x => x._e))) return tg(env, method, { ...body, ...tgMarkup(kb) });
  return (async () => {
    const r = await tg(env, method, { ...body, ...tgMarkup(kb) }, true);
    if (r && r.message_id) {
      const back = ((r.reply_markup && r.reply_markup.inline_keyboard) || []).flat();
      if (back.length && !back.some(x => x.icon_custom_emoji_id)) {
        ICON_OFF = Date.now() + 30 * 60e3;
        await tg(env, 'editMessageReplyMarkup', { chat_id: body.chat_id, message_id: r.message_id, reply_markup: tgPlain({ reply_markup: { inline_keyboard: kb } }).reply_markup }, true);
      }
      return r;
    }
    if (r || TG_GONE.test(TGERR) || /too many|retry after/i.test(TGERR)) return r;
    ICON_OFF = Date.now() + 30 * 60e3;
    return tg(env, method, tgPlain({ ...body, reply_markup: { inline_keyboard: kb } }), true);
  })();
}
function tgSay(c, text, kb, extra) {
  return tgCall(c.env, 'sendMessage', { chat_id: c.chat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(extra || {}) }, kb);
}
// a menu: edit the message the button was on, so the chat stays tidy. A picture card keeps its picture
// for the product → order steps (keep); for anything else a new message comes under it.
async function tgShow(c, text, kb, keep) {
  if (c.msgId && c.isPhoto) {
    if (keep && tgLen(text) <= 1024) { const r = await tgCall(c.env, 'editMessageCaption', { chat_id: c.chat, message_id: c.msgId, caption: text, parse_mode: 'HTML' }, kb || []); if (r) return r; }
    c.msgId = 0;
    return tgSay(c, text, kb);
  }
  if (c.msgId) { const r = await tgCall(c.env, 'editMessageText', { chat_id: c.chat, message_id: c.msgId, text, parse_mode: 'HTML', disable_web_page_preview: true }, kb || []); if (r) return r; }
  return tgSay(c, text, kb);
}
// ---------------------------------------------------------------- screens with a picture (v20)
// the pictures: bot/<key>.jpg on the site, drawn every 6 hours by .github/bot/banners.py. bot/banners.json has a
// short hash per picture; it goes on the address, so Telegram fetches a picture again only when it changed.
let TGBAN = { at: 0, p: null };
const TGPH = {}; // picture address → Telegram's file_id, so the same picture is not downloaded again
async function tgBanners() {
  if (TGBAN.p && Date.now() - TGBAN.at < 15 * 60e3) return TGBAN.p;
  try {
    const r = await xf(SITE + '/bot/banners.json', { cf: { cacheTtl: 300 } });
    if (r.ok) { const j = await r.json(); TGBAN = { at: Date.now(), p: (j && j.p) || {} }; return TGBAN.p; }
  } catch (e) {}
  TGBAN = { at: Date.now() - 10 * 60e3, p: TGBAN.p || {} }; // look again in 5 minutes
  return TGBAN.p;
}
async function tgBan(...keys) { const m = await tgBanners(); for (const k of keys) if (m[k]) return `${SITE}/bot/${k}.jpg?v=${m[k]}`; return ''; }
// how long Telegram counts a caption (at most 1024): the text without its tags
function tgLen(html) { return String(html).replace(/<[^>]+>/g, '').replace(/&(lt|gt|amp|quot|#39);/g, '_').length; }
async function tgDel(c) { if (c.msgId) await tg(c.env, 'deleteMessage', { chat_id: c.chat, message_id: c.msgId }, true); c.msgId = 0; c.isPhoto = false; }
function tgKeepPh(url, r) { const ph = r && r.photo; if (ph && ph.length) TGPH[url] = ph[ph.length - 1].file_id; }
// a screen { photo, text, kb }: picture → picture and text → text edit the message the button was on; otherwise
// the old message goes and the new one comes, so the chat stays tidy. Without a picture: the same screen as text.
async function tgView(c, v, fresh) {
  const photo = v.photo && tgLen(v.text) <= 1024 ? v.photo : '';
  if (!photo) {
    if (!fresh && c.msgId && c.isPhoto) await tgDel(c);
    return fresh || !c.msgId ? tgSay(c, v.text, v.kb) : tgShow(c, v.text, v.kb);
  }
  const media = TGPH[photo] || photo;
  if (!fresh && c.msgId) {
    if (c.isPhoto) {
      const r = await tgCall(c.env, 'editMessageMedia', { chat_id: c.chat, message_id: c.msgId, media: { type: 'photo', media, caption: v.text, parse_mode: 'HTML' } }, v.kb || []);
      if (r) { tgKeepPh(photo, r); return r; }
    }
    await tgDel(c);
  }
  const r = await tgCall(c.env, 'sendPhoto', { chat_id: c.chat, photo: media, caption: v.text, parse_mode: 'HTML' }, v.kb);
  if (r) { tgKeepPh(photo, r); return r; }
  delete TGPH[photo];
  return tgSay(c, v.text, v.kb);
}
const tgCopy = (text, value) => ({ text, copy_text: { text: String(value).slice(0, 256) } });
const tgP = n => tgN(n) + '₪';
// a long name cut at a word, with …
function tgShort(t, n) { t = String(t || ''); if (t.length <= n) return t; const cut = t.slice(0, n), i = cut.lastIndexOf(' '); return (i > n / 2 ? cut.slice(0, i) : cut).trim() + '…'; }
function tgCatEmo(name) { for (const [re, e] of TG_CAT_ICON) if (re.test(String(name || ''))) return e; return '🛍️'; }
// a plan with a lower price than before (an offer from the admin, or a limited-time sale from the bot)
function tgDealOf(pl) { return pl && +pl.price > 0 && !pl.out && +pl.compare > +pl.price; }
function tgDeals(c) {
  const out = [];
  for (const p of c.data.products) if (!p.soldOut) (p.plans || []).forEach((pl, k) => { if (tgDealOf(pl)) out.push({ p, pl, k }); });
  return out;
}
// the keys that stay under the chat (Telegram's reply keyboard): each one opens a screen
const TG_KEYS = [['🛍 المنتجات', '🔥 العروض'], ['📦 طلباتي', '📅 اشتراكاتي'], ['💬 الدعم', '❓ المساعدة']];
const TG_KEYS_V = 1;
const TG_KEY_GO = { '🛍 المنتجات': 'prods', '🔥 العروض': 'deals', '📦 طلباتي': 'orders', '📅 اشتراكاتي': 'subs', '💬 الدعم': 'sup', '❓ المساعدة': 'help' };
function tgKeys() { return { keyboard: TG_KEYS.map(r => r.map(text => ({ text }))), resize_keyboard: true, is_persistent: true, input_field_placeholder: 'اكتب اسم اشتراك تدوّر عليه…' }; }
// what we ask the customer for after the payment is confirmed (never before): the plan's account type and the product's questions
function tgNeeds(products, o) {
  const out = [];
  for (const it of (o && o.items) || []) {
    const p = (products || []).find(x => x.id === it.productId), pl = p && (p.plans || []).find(x => x.id === it.planId);
    const a = (pl && pl.acct) || (p && p.acct) || '';
    if (a === 'login') out.push('إيميل الحساب وكلمة السر'); else if (a === 'email') out.push('الإيميل');
    for (const q of (p && p.ask) || []) if (q && q.l) out.push(tgClean(q.l).slice(0, 40));
  }
  return [...new Set(out)];
}
// after the payment: what we still need, and two ways to send it (our Telegram, our WhatsApp) with the order number written in
function tgNeedBlock(settings, o) {
  const need = tgNeeds(TGC.products, o);
  if (!need.length) return null;
  const it = (o.items || [])[0] || {}, msg = `مرحبا، طلبي ${o.orderNo || ''} (${tgClean(it.productName || '')}) تأكد دفعه، بدي أكمّل تفاصيل التفعيل.`;
  const sup = tgUserName(settings && settings.tgSupport) || 'hazemstoresupport', wa = String((settings && settings.whatsapp) || '').replace(/\D/g, '');
  const text = `📩 <b>الخطوة الجاية:</b> بنتواصل معك بالخاص عشان نكمّل بقية تفاصيل التفعيل، أو كلّمنا إنت مباشرة من الأزرار تحت 👇`;
  const kb = [[{ ...tgUrl('📩 كمّل التفاصيل على تيليجرام', `https://t.me/${sup}?text=${encodeURIComponent(msg)}`), style: 'success' }]];
  if (wa.length >= 9) kb.push([tgUrl('🟢 أو على واتساب', `https://wa.me/${wa}?text=${encodeURIComponent(msg)}`)]);
  return { text, kb, need };
}
// @bot in any chat: the products as cards with their picture and a 🛒 button that opens the bot on that product
async function tgInline(env, q) {
  const fs = await firestore(env), data = await tgData(fs), [bot, m] = await Promise.all([tgMe(env), tgBanners()]);
  const cats = data.settings.categories || [], words = tgNorm(q.query || '').split(' ').filter(Boolean);
  let list = data.products.filter(p => !tgOut(p));
  if (words.length) { // every word, or else any of them (people type the name in Arabic and English)
    const hay = p => { const cat = cats.find(x => x.id === p.cat); return tgNorm([p.name, p.keywords, p.desc, cat && cat.name, ...(p.plans || []).map(x => x.name)].join(' ')); };
    const all = list.filter(p => words.every(w => hay(p).includes(w)));
    list = all.length ? all : list.filter(p => words.some(w => w.length > 1 && hay(p).includes(w)));
  }
  const results = list.slice(0, 20).map(p => {
    const ban = m[p.id] ? `${SITE}/bot/${p.id}.jpg?v=${m[p.id]}` : m.home ? `${SITE}/bot/home.jpg?v=${m.home}` : '';
    const cat = cats.find(x => x.id === p.cat), plans = (p.plans || []).filter(x => +x.price > 0 && !x.out).map(x => tgClean(x.name)).slice(0, 3);
    const text = `${tgIcon(data, p)} <b>${esc(tgClean(p.name))}</b> · ${esc(tgPrice(p))}\n${plans.length ? esc(plans.join(' · ')) + '\n' : ''}⚡ التفعيل خلال دقائق · دفع محلي بالشيكل`;
    const thumb = tgLogo(p, 128) || ban;
    return { type: 'article', id: String(p.id).slice(0, 64), title: tgClean(p.name), description: tgPrice(p) + (cat ? ' · ' + tgClean(cat.name) : ''), ...(thumb ? { thumbnail_url: thumb } : {}),
      input_message_content: { message_text: text, parse_mode: 'HTML', link_preview_options: ban ? { url: ban, prefer_large_media: true, show_above_text: true } : { is_disabled: true } },
      ...(bot ? { reply_markup: { inline_keyboard: [[{ text: '🛒 اشتري من البوت', url: `https://t.me/${bot}?start=p_${p.id}` }]] } } : {}) };
  });
  return tg(env, 'answerInlineQuery', { inline_query_id: q.id, results, cache_time: 300, ...(!results.length && bot ? { button: { text: '🔎 ما لقينا، افتح البوت', start_parameter: 'shop' } } : {}) });
}
function tgReset(c) { if (Object.keys(c.S).length) { c.S = {}; c.dirty = true; } }
function tgClosed(c) { return c.data.settings.siteOrders === false; }

async function tgHome(c, fresh) {
  const hi = c.from.first_name ? ` <b>${esc(tgClean(c.from.first_name).slice(0, 30))}</b>` : '';
  const me = await tgMine(c), w = await tgWallet(c);
  let text = `أهلين${hi} 👋\n`;
  if (me.soon) text += `<blockquote>📅 <b>${esc(tgClean(me.soon.it.productName || ''))}</b>${me.soon.it.planName ? ' · ' + esc(me.soon.it.planName) : ''} بيخلص ${me.soon.days <= 0 ? '<b>اليوم</b>' : 'بعد <b>' + tgDays(me.soon.days) + '</b>'} (${tgWhen(me.soon.end)})</blockquote>`;
  if (me.act) { const it = (me.act.data.items || [])[0] || {}; text += `<blockquote>${tgStatus(me.act.data).split(' ')[0]} طلبك <code>${esc(me.act.data.orderNo || '')}</code> · ${esc(tgClean(it.productName || ''))}\n${esc(tgStatus(me.act.data).split(' ').slice(1).join(' '))}</blockquote>`; }
  if (w) text += `💰 رصيدك بالموقع: <b>${tgN(+w.balance || 0)} ₪</b>\n`;
  if (!me.soon && !me.act) text += `كل اشتراكاتك الرقمية الرسمية بمكان واحد، بأسعار بالشيكل ودفع محلي.\n<blockquote>⚡ التفعيل خلال دقائق بعد تأكيد الدفع\n💬 دعم مباشر على تيليجرام\n💳 ${esc(tgPayList(c))}</blockquote>\n`;
  text += me.soon || me.act ? 'شو بدك اليوم؟ 👇' : 'اختار من تحت 👇';
  const kb = [];
  if (me.soon && me.soon.pl) kb.push([{ ...tgBtn(`🔄 جدّد ${tgShort(tgClean(me.soon.it.productName || ''), 20)} · ${tgP(me.soon.pl.price)}`, 'rn:' + me.soon.id), style: 'success' }]);
  if (me.act) kb.push([tgBtn(`📦 تابع طلبك ${me.act.data.orderNo || ''}`, 'o:' + me.act.id)]);
  if (me.last && (!me.soon || me.last.id !== me.soon.id)) kb.push([tgBtn('🔁 اطلب نفس طلبك الأخير', 'rn:' + me.last.id)]);
  kb.push([{ ...tgApp('🛍 افتح المتجر'), style: 'primary' }]);
  const two = [...(tgDeals(c).length ? [tgBtn('🔥 العروض', 'deals')] : []), ...(c.data.products.some(p => p.bundle) ? [tgBtn('🎁 باقات التوفير', 'bund')] : [])];
  if (two.length) kb.push(two);
  kb.push([tgBtn('📦 طلباتي', 'orders'), tgBtn('📅 اشتراكاتي', 'subs')], [tgRefAmt(c.data) > 0 ? tgBtn('🎁 ادعُ صاحبك', 'ref') : tgBtn('🔎 بحث', 'find'), tgBtn('⭐ آراء الزباين', 'revs')]);
  const ch = tgChan(c.data.settings);
  kb.push([tgBtn('💬 الدعم', 'sup'), tgBtn('❓ المساعدة', 'help')]);
  if (ch && ch[0] === '@') kb.push([tgUrl('📣 قناتنا: العروض أول بأول', 'https://t.me/' + ch.slice(1))]);
  if (tgIsAdmin(c)) kb.push([{ ...tgBtn('📊 لوحة حازم', 'adm'), style: 'primary' }], [tgBtn('⏳ الطلبات المعلّقة', 'apend'), tgBtn('🔥 عرض لوقت محدود', 'sl')], [tgBtn('📢 إعلان للمشتركين', 'post'), tgBtn('🎨 الأيقونات', 'seticon')]);
  if (fresh && c.keys !== TG_KEYS_V) { // the keys under the chat, the first time (and after they change)
    await tgSay(c, '👇 <b>الأزرار تحت بتضل موجودة:</b> المنتجات، العروض، طلباتي، اشتراكاتي، الدعم والمساعدة.', tgKeys());
    c.keys = TG_KEYS_V; c.dirty = true;
  }
  return tgView(c, { photo: await tgBan('home'), text, kb }, fresh);
}
// an emoji for each product: from its name, else from its section (the stand-in when there is no brand icon)
const TG_ICON = [[/chatgpt|openai/i, '🤖'], [/claude/i, '🧠'], [/grok/i, '⚡'], [/gemini/i, '✨'], [/perplexity/i, '🔎'], [/canva/i, '🎨'], [/capcut/i, '🎬'], [/adobe/i, '🅰️'], [/autodesk/i, '📐'],
  [/duolingo/i, '🦉'], [/office|word|excel/i, '📄'], [/notion/i, '📝'], [/pdf/i, '📑'], [/jetbrains/i, '💻'], [/miro/i, '🧩'], [/lovable/i, '💜'], [/wispr/i, '🎙️'], [/muse/i, '🎵'],
  [/shahid|شاهد|netflix|نتفلكس/i, '🎬'], [/esim|شرائح|شريحة|انترنت|إنترنت/i, '📶'], [/توثيق/, '☑️'], [/إعلان|اعلان|ممول/, '📣'], [/تيليجرام|تلغرام|telegram/i, '✈️'],
  [/انستغرام|انستجرام|إنستغرام|instagram/i, '📸'], [/فيسبوك|facebook/i, '📘'], [/تويتر|twitter/i, '🐦'], [/snap|سناب/i, '👻'], [/youtube|يوتيوب/i, '▶️'], [/spotify|سبوتيفاي/i, '🎧']];
const TG_CAT_ICON = [[/ذكاء/, '🤖'], [/تصميم|مونتاج/, '🎨'], [/تعليم|إنتاج|انتاج/, '📚'], [/انترنت|إنترنت/, '📶'], [/سوشال|تواصل/, '📱'], [/برمج/, '💻'], [/افلام|أفلام|مسلسل/, '🎬'], [/العاب|ألعاب/, '🎮']];
function tgIcon(data, p) {
  if (p.bundle) return '🎁';
  for (const [re, e] of TG_ICON) if (re.test(String(p.name || ''))) return e;
  const cat = (data.settings.categories || []).find(x => x.id === p.cat);
  if (cat) for (const [re, e] of TG_CAT_ICON) if (re.test(String(cat.name || ''))) return e;
  return '🛍️';
}
// the official logo: the product's website (its "domain" in the admin), through Google's site icons,
// on a white square so dark logos show in dark mode too
const TG_DOM = [[/تيليجرام|تلغرام|telegram/i, 'telegram.org'], [/snap|سناب/i, 'snapchat.com'], [/shahid|شاهد/i, 'shahid.mbc.net'], [/انستغرام|انستجرام|إنستغرام|instagram/i, 'instagram.com'], [/فيسبوك|facebook/i, 'facebook.com'], [/netflix|نتفلكس/i, 'netflix.com'], [/spotify|سبوتيفاي/i, 'spotify.com'], [/youtube|يوتيوب/i, 'youtube.com']];
function tgDomain(p) {
  const d = String(p.domain || '').trim().replace(/^https?:\/\//i, '').replace(/[/?#].*$/, '').toLowerCase();
  if (/^[a-z0-9.-]+\.[a-z]{2,}$/.test(d)) return d;
  for (const [re, x] of TG_DOM) if (re.test(String(p.name || ''))) return x;
  return '';
}
function tgLogo(p, size) {
  const d = tgDomain(p), n = size || 256;
  if (!d) return '';
  return 'https://wsrv.nl/?url=' + encodeURIComponent('https://www.google.com/s2/favicons?domain=' + d + '&sz=256') + `&w=${n}&h=${n}&fit=contain&cbg=white&bg=white&output=png`;
}
// the brand icon as a Telegram custom emoji (made with /icons; shows when the bot owner has Telegram Premium)
function tgIco(data, p) { return Date.now() < ICON_OFF ? '' : String((data.icons || {})[p.id] || ''); }
function tgEmo(data, p) { const id = tgIco(data, p), e = tgIcon(data, p); return id ? `<tg-emoji emoji-id="${esc(id)}">${e}</tg-emoji>` : e; }
function tgOut(p) { return !!p.soldOut || !p.plans.some(x => +x.price > 0 && !x.out); }
function tgName(data, p) { return `${tgOut(p) ? '🔴' : tgIcon(data, p)} ${tgClean(p.name).slice(0, 26)}`; }
function tgPBtn(data, p, cb) {
  const id = !tgOut(p) && tgIco(data, p);
  return id ? { text: tgClean(p.name).slice(0, 26), callback_data: cb, icon_custom_emoji_id: id, _e: tgIcon(data, p) } : tgBtn(tgName(data, p), cb);
}
// a button line that reads right to left on every Telegram: Telegram Web in English draws buttons left to right, which
// threw the ₪ to the wrong end. The line is a right-to-left isolate, the name keeps its own direction, and a
// right-to-left mark before the price keeps "من 30 ₪" together after the name.
const TG_RLI = '\u2067', TG_FSI = '\u2068', TG_PDI = '\u2069', TG_RLM = '\u200f';
function tgLine(pre, name, tail) { name = String(name).replace(/\s+\)/g, ')').replace(/\(\s+/g, '('); return TG_RLI + (pre ? pre + ' ' : '') + TG_FSI + name + TG_PDI + (tail ? ' · ' + TG_RLM + tail : '') + TG_PDI; }
// a product as a catalogue button: icon, name and its lowest price (🔥 when it has an offer, 🔴 when it ran out)
function tgPBtnP(data, p, cb, star) {
  const out = tgOut(p), hot = !out && (p.plans || []).some(tgDealOf);
  const id = !out && tgIco(data, p), name = tgShort(tgClean(p.name), 34);
  const pre = out ? '🔴' : hot ? '🔥' : star ? '⭐' : id ? '' : tgIcon(data, p);
  const b = { text: tgLine(pre, name, out ? 'خلص' : tgPrice(p)), callback_data: cb };
  if (id) Object.assign(b, { icon_custom_emoji_id: id, _e: tgIcon(data, p) });
  b._w = tgLen(name) + 9;
  return b;
}
// two short buttons share a row, a long one gets its own
function tgPair(btns) {
  const rows = [];
  for (let i = 0; i < btns.length; i++) {
    const a = btns[i], b = btns[i + 1];
    if (b && a._w <= 19 && b._w <= 19) { rows.push([a, b]); i++; } else rows.push([a]);
  }
  for (const r of rows) for (const x of r) delete x._w;
  return rows;
}
// the catalogue, in three steps: the sections (with the whole store as a Mini App on top), then one section as a
// short priced list or as cards to flip through, then the product
function tgGroups(data) {
  const ps = data.products.filter(p => !p.bundle), cats = data.settings.categories || [];
  const groups = cats.map(cat => ({ cat, list: ps.filter(p => p.cat === cat.id) })).filter(g => g.list.length);
  const rest = ps.filter(p => !cats.some(x => x.id === p.cat));
  if (rest.length) groups.push({ cat: { id: '_', name: 'منتجات تانية' }, list: rest });
  for (const g of groups) g.list = tgSort(g.list);
  return { ps, groups };
}
// in a section: what you can buy first, the store's picks (a badge) on top, then from the cheapest; the sold out last
function tgSort(list) {
  const rank = p => (tgOut(p) ? 2 : String(p.badge || '').trim() ? 0 : 1);
  return list.map((p, i) => ({ p, i })).sort((a, b) => rank(a.p) - rank(b.p) || (tgOut(a.p) ? 0 : tgLow(a.p) - tgLow(b.p)) || a.i - b.i).map(x => x.p);
}
function tgCatName(cat) { return tgClean(cat.name).replace(/^خدمات\s+/, ''); }
async function tgGrid(c, fresh, only, page) {
  const { ps, groups } = tgGroups(c.data);
  if (only) { const g = groups.find(x => x.cat.id === only); if (g) return tgSection(c, g, fresh, +page || 0); }
  const kb = [[{ ...tgApp('🛍 افتح المتجر الكامل'), style: 'primary' }]];
  const secs = groups.map(g => { const b = tgBtn(`${tgCatEmo(g.cat.name)} ${tgCatName(g.cat)}`, 'cat:' + g.cat.id); b._w = tgLen(b.text) - 3; return b; });   // a section name fits half a row up to ~22 letters
  kb.push(...tgPair(secs));
  const deals = tgDeals(c).length, bund = c.data.products.filter(p => p.bundle).length;
  const two = [...(deals ? [{ ...tgBtn('🔥 العروض', 'deals'), style: 'success' }] : []), ...(bund ? [tgBtn(`🎁 باقات التوفير (${bund})`, 'bund')] : [])];
  if (two.length) kb.push(two);
  kb.push([tgBtn('🔎 بحث', 'find'), tgBtn('🏠 الرئيسية', 'home')]);
  const picks = ps.filter(p => !tgOut(p) && /طلب|مبيع|الأشهر|الأفضل|best/i.test(String(p.badge || ''))).slice(0, 3).map(p => esc(tgClean(p.name)));
  const q = [picks.length ? `🔥 الأكثر طلباً: ${picks.join(' · ')}` : '', '⚡ تفعيل خلال دقائق · 💳 الدفع بالشيكل'].filter(Boolean);
  const text = `🛍 <b>المتجر</b> · ${tgSvc(ps.length)}\nاختار القسم اللي بدك إياه 👇\n<blockquote>${q.join('\n')}</blockquote>`;
  return tgView(c, { photo: await tgBan('shop', 'home'), text, kb }, fresh);
}
const TG_PAGE = 10;
async function tgSection(c, g, fresh, page) {
  const all = g.list, pages = Math.max(1, Math.ceil(all.length / TG_PAGE)), pg = Math.min(Math.max(0, page), pages - 1);
  const list = all.slice(pg * TG_PAGE, pg * TG_PAGE + TG_PAGE), id = g.cat.id;
  const star = p => !tgOut(p) && !!String(p.badge || '').trim();
  const kb = list.map(p => [tgPBtnP(c.data, p, 'g:' + p.id, star(p))]);
  for (const r of kb) for (const x of r) delete x._w;
  if (pages > 1) kb.push([...(pg > 0 ? [tgBtn('السابق', `cat:${id}:${pg - 1}`)] : []), tgBtn(`${pg + 1} / ${pages}`, `cat:${id}:${pg}`), ...(pg < pages - 1 ? [tgBtn('التالي', `cat:${id}:${pg + 1}`)] : [])]);
  if (all.length > 1) kb.push([tgBtn('🃏 تصفّحهم كروت', `cv:${id}:0`)]);
  kb.push([tgBtn('« الأقسام', 'prods'), tgApp('🛍 المتجر الكامل')]);
  const has = f => all.some(f);
  const legend = [has(star) ? '⭐ الأكثر طلباً' : '', has(p => !tgOut(p) && (p.plans || []).some(tgDealOf)) ? '🔥 عليه عرض' : '', has(tgOut) ? '🔴 خلص هلأ' : ''].filter(Boolean);
  const text = `${tgCatEmo(g.cat.name)} <b>${esc(tgClean(g.cat.name))}</b> · ${tgSvc(all.length)}\nاكبس على الخدمة وشوف باقاتها 👇` + (legend.length ? `\n<blockquote>${legend.join('  ·  ')}</blockquote>` : '');
  return tgView(c, { photo: await tgBan('cat-' + id, 'shop', 'home'), text, kb }, fresh);
}
// one section as cards: the product's own picture, its price and what you get, السابق / التالي (words, no arrows:
// Telegram in English lays the row out left to right, which would turn arrows the wrong way)
async function tgCards(c, id, i) {
  const { groups } = tgGroups(c.data), g = groups.find(x => x.cat.id === id);
  if (!g) return tgGrid(c);
  const n = g.list.length, k = ((+i || 0) % n + n) % n, p = g.list[k], out = tgOut(p);
  const feats = (p.features || []).filter(Boolean).map(f => String(f).trim()).slice(0, 3);
  const what = feats.length ? feats.map(f => '✓ ' + esc(tgShort(f, 70))).join('\n') : esc(tgShort(String(p.desc || '').trim(), 180));
  const badge = String(p.badge || '').trim();
  const text = `${tgCatEmo(g.cat.name)} ${esc(tgClean(g.cat.name))} · <b>${k + 1} من ${n}</b>\n` +
    `${tgEmo(c.data, p)} <b>${esc(tgClean(p.name))}</b> · ${out ? '🔴 خلص هلأ' : esc(tgPrice(p))}${badge && !out ? ' · ⭐ ' + esc(badge.slice(0, 30)) : ''}` +
    (what ? `\n<blockquote>${what}</blockquote>` : '');
  const kb = [[{ ...tgBtn(out ? '🔔 شوف التفاصيل' : tgLine('✅', 'شوف الباقات', tgPrice(p)), 'g:' + p.id), style: out ? 'danger' : 'success' }]];
  if (n > 1) kb.push([tgBtn('السابق', `cv:${id}:${k - 1}`), tgBtn(`${k + 1} / ${n}`, 'cat:' + id), tgBtn('التالي', `cv:${id}:${k + 1}`)]);
  kb.push([tgBtn('« القائمة', 'cat:' + id), tgApp('🛍 المتجر الكامل')]);
  return tgView(c, { photo: await tgBan(p.id, 'cat-' + id, 'home'), text, kb });
}
// 🔥 every plan that is cheaper than before
async function tgDealsView(c) {
  const list = tgDeals(c).slice(0, 12);
  if (!list.length) { const t = 'ما في عروض هلأ، تابع قناتنا عشان توصلك أول بأول 🔔'; if (c.msgId) { c.alert = t; return; } return tgSay(c, t, [[tgBtn('🛍 كل المنتجات', 'prods')]]); }
  const L = list.map(({ p, pl }) => `• ${esc(tgVName(p, pl))}: <s>${tgN(pl.compare)}</s> <b>${tgP(pl.price)}</b>` + (pl.deal && +pl.deal.until > Date.now() ? ` · لحد ${tgWhen(+pl.deal.until, true)}` : ''));
  const kb = list.map(({ p, pl, k }) => [{ text: `🔥 ${tgVName(p, pl).slice(0, 30)} · ${tgP(pl.price)}`, callback_data: `dv:${p.id}:${k}`, style: 'success' }]);
  kb.push([tgBtn('🛍 كل المنتجات', 'prods'), tgBtn('🏠 الرئيسية', 'home')]);
  let text = `🔥 <b>العروض</b>\nأسعار أقل لفترة محدودة، الحق حالك 👇\n<blockquote>${L.join('\n')}</blockquote>`;
  while (tgLen(text) > 1000 && L.length > 1) { L.pop(); text = `🔥 <b>العروض</b>\nأسعار أقل لفترة محدودة، الحق حالك 👇\n<blockquote>${L.join('\n')}</blockquote>`; }
  return tgView(c, { photo: await tgBan('home'), text, kb });
}
// 🎁 products that bundle two or more others for less
async function tgBundles(c) {
  const list = c.data.products.filter(p => p.bundle);
  if (!list.length) { c.alert = 'ما في باقات هلأ'; return; }
  const L = list.slice(0, 10).map(p => {
    const inc = (p.bundleOf || []).map(id => c.data.products.find(x => x.id === id)).filter(Boolean).map(x => esc(tgClean(x.name)));
    return `• <b>${esc(tgClean(p.name))}</b>${inc.length ? ': ' + inc.join(' + ') : ''} · ${esc(tgPrice(p))}`;
  });
  const kb = [...tgPair(list.map(p => tgPBtnP(c.data, p, 'g:' + p.id))), [tgBtn('🛍 كل المنتجات', 'prods'), tgBtn('🏠 الرئيسية', 'home')]];
  return tgView(c, { photo: await tgBan('home'), text: `🎁 <b>باقات التوفير</b>\nأكتر من اشتراك مع بعض، بسعر أقل وبطلب واحد 👇\n<blockquote>${L.join('\n')}</blockquote>`, kb });
}
// ⭐ what customers said: the average and the latest few with words
async function tgRevsView(c) {
  const all = (await tgReviews(c)).filter(r => +r.rating > 0);
  const kb = [[{ ...tgBtn('🛍 تصفّح المنتجات', 'prods'), style: 'primary' }], [tgBtn('🏠 الرئيسية', 'home')]];
  if (!all.length) return tgView(c, { photo: await tgBan('home'), text: '⭐ <b>آراء الزباين</b>\nلسا ما في تقييمات منشورة. كون أول واحد بعد طلبك 🤍', kb });
  const avg = Math.round(all.reduce((a, r) => a + +r.rating, 0) / all.length * 10) / 10;
  const words = all.filter(r => String(r.text || '').trim()).sort((a, b) => (+b.createdAt || 0) - (+a.createdAt || 0));
  const one = r => `${'⭐'.repeat(Math.max(1, Math.min(5, Math.round(+r.rating))))}\n«${esc(String(r.text).trim().replace(/\s+/g, ' ').slice(0, 110))}»\n— ${esc(tgClean(r.name || 'زبون').slice(0, 20))}${r.product ? ' · ' + esc(String(r.product).slice(0, 30)) : ''}`;
  let n = Math.min(4, words.length), text;
  do { text = `⭐ <b>آراء الزباين</b>\n<b>${avg}</b> من 5 · ${all.length} تقييم` + words.slice(0, n).map(r => `\n<blockquote>${one(r)}</blockquote>`).join(''); n--; } while (tgLen(text) > 1000 && n > 0);
  return tgView(c, { photo: await tgBan('home'), text, kb });
}
// how many instant codes are left for the instant plans of these products (cached a minute)
async function tgCounts(c, list) {
  const st = c.data.stock || (c.data.stock = {}), want = [];
  for (const p of list) for (const pl of p.plans || []) if (pl.instant && pl.id && +pl.price > 0 && !((p.id + '|' + pl.id) in st)) want.push([p.id, pl.id]);
  await Promise.all(want.slice(0, 6).map(async ([pid, plan]) => {
    try { st[pid + '|' + plan] = await c.fs.count('stock', [['pid', 'EQUAL', pid], ['plan', 'EQUAL', plan], ['owner', 'IS_NULL']]); } catch (e) {}
  }));
}
// the name of one duration as a product of its own, like "ChatGPT Plus · شهر"
function tgVName(p, pl) {
  const nm = tgClean(p.name), pn = tgClean((pl && pl.name) || '');
  if (!pn) return nm;
  const first = nm.split(/\s+/)[0].toLowerCase();
  return pn.toLowerCase().includes(first) ? pn : nm + (/^[A-Za-z]/.test(pn) ? ' ' : ' — ') + pn;
}
function tgLeft(data, p, pl) { return pl.instant ? +(data.stock || {})[p.id + '|' + pl.id] || 0 : 0; }
// the product page: its picture, what you get, the details, a customer's words, and every duration as a button
function tgProductView(c, p, stars) {
  const emo = tgEmo(c.data, p), ico = tgIco(c.data, p), e = tgIcon(c.data, p);
  const plans = p.plans.map((pl, k) => ({ pl, k })).filter(x => +x.pl.price > 0);
  const live0 = plans.filter(x => !p.soldOut && !x.pl.out), low = live0.length > 1 ? Math.min(...live0.map(x => +x.pl.price)) : -1;
  const gone0 = x => !!p.soldOut || !!x.pl.out;
  const kb = [...plans].sort((a, b) => gone0(a) - gone0(b) || +a.pl.price - +b.pl.price || a.k - b.k).map(({ pl, k }) => {
    const gone = !!p.soldOut || !!pl.out, n = tgLeft(c.data, p, pl), pn = tgClean(pl.name || '') || tgClean(p.name), deal = tgDealOf(pl);
    const best = !gone && !deal && +pl.price === low;
    const label = gone ? tgLine('🔔', pn, 'نفد، نبّهني') : tgLine(deal ? '🔥' : best ? '⭐' : '', pn, `${tgN(pl.price)} ₪${deal ? ' بدل ' + tgN(pl.compare) : ''}${n ? ' · 📦 ' + n : ''}`);
    const b = { text: label, callback_data: gone ? `nt:${p.id}:${k}` : `v:${p.id}:${k}`, ...(gone ? { style: 'danger' } : deal || best || live0.length === 1 ? { style: 'success' } : {}) };
    return [ico && !gone ? { ...b, icon_custom_emoji_id: ico, _e: e } : b];
  });
  const back = (c.data.settings.categories || []).some(x => x.id === p.cat) ? 'cat:' + p.cat : 'prods';
  kb.push([...(c.bot ? [tgUrl('📤 شاركه', 'https://t.me/share/url?url=' + encodeURIComponent(`https://t.me/${c.bot}?start=p_${p.id}`) + '&text=' + encodeURIComponent(tgClean(p.name) + ' — ' + tgPrice(p)))] : []), tgBtn('« رجوع', p.bundle ? 'bund' : back)]);
  const inc = p.bundle ? (p.bundleOf || []).map(id => c.data.products.find(x => x.id === id)).filter(Boolean) : [];
  const live = plans.map(x => x.pl);
  const accts = new Set(live.map(pl => pl.acct || p.acct || ''));
  const det = [];
  if (accts.size === 1) { const a = [...accts][0]; if (a === 'login') det.push('📧 النوع: على إيميلك الشخصي'); else if (a === 'email') det.push('📧 النوع: دعوة على إيميلك'); else if (a === 'none') det.push('👤 النوع: حساب جاهز من عندنا'); }
  det.push(live.some(pl => pl.instant) ? '⚡ التسليم: فوري بعد الدفع بـ USDT' : '⚡ التسليم: خلال دقائق بعد تأكيد الدفع');
  const wars = new Set(live.map(pl => String(pl.tgWar || '').trim()));
  if (wars.size === 1 && [...wars][0]) det.push('🛡 الضمان: ' + esc([...wars][0]));
  const note = String(p.note || '').trim();
  if (note) det.push('📌 ' + esc(note.slice(0, 160)));
  let feats = (p.features || []).filter(Boolean).map(f => String(f).trim());
  const desc = String(p.desc || '').trim();
  const build = (nf, quote) => {
    const L = [`${emo} <b>${esc(tgClean(p.name))}</b>`];
    if (stars) L.push(`⭐ <b>${stars.avg}</b> من 5 · ${stars.n} تقييم`);
    if (p.badge) L.push(`🏷 ${esc(String(p.badge).slice(0, 40))}`);
    if (inc.length) L.push(`🎁 الباقة فيها: ${inc.map(x => esc(tgClean(x.name))).join(' + ')}`);
    const what = nf ? feats.slice(0, nf).map(f => '• ' + esc(f.slice(0, 110))).join('\n') : esc(desc.slice(0, 300));
    if (what) L.push(`<blockquote expandable>✨ <b>شو بتاخد؟</b>\n${what}</blockquote>`);
    else L.push('');
    L.push(`📋 <b>التفاصيل</b>\n${det.join('\n')}`);
    if (quote && stars && stars.last) L.push(`<blockquote>💬 «${esc(String(stars.last.text).trim().replace(/\s+/g, ' ').slice(0, 120))}» — ${esc(tgClean(stars.last.name || 'زبون').slice(0, 20))}</blockquote>`);
    else L.push('');
    L.push(`⏱ <b>اختار ${plans.length > 1 ? 'المدة' : 'من تحت'}</b> 👇`);
    return L.join('\n').replace(/\n{3,}/g, '\n\n');
  };
  let text = build(Math.min(5, feats.length), true);
  for (const [nf, q] of [[Math.min(5, feats.length), false], [Math.min(3, feats.length), false], [Math.min(2, feats.length), false], [0, false]]) { if (tgLen(text) <= 1024) break; text = build(nf, q); }
  return { text, kb };
}
async function tgProduct(c, id, fresh) {
  const p = c.data.products.find(x => x.id === id);
  if (!p) { c.alert = 'هالاشتراك مش متوفر هلأ'; return tgGrid(c); }
  const [, rv, bot, photo] = await Promise.all([tgCounts(c, [p]), tgReviews(c), tgMe(c.env), tgBan(p.id, 'home')]);
  c.bot = bot;
  const v = tgProductView(c, p, tgStars(rv, p));
  return tgView(c, { photo, text: v.text, kb: v.kb }, fresh || !c.msgId);
}
// what the customer gets with this duration: Hazem's own text for it (admin → the duration → وصف هالمدة), else built from the product
function tgDesc(data, p, pl) {
  const own = String(pl.desc || '').trim();
  if (own) return esc(own);
  const L = [];
  const d = String(p.desc || '').trim();
  if (d) L.push(esc(d));
  for (const f of (p.features || []).filter(Boolean).slice(0, 4)) L.push('• ' + esc(f));
  const a = pl.acct || p.acct || '';
  if (a === 'login') L.push('🔐 التفعيل على حسابك الشخصي');
  else if (a === 'email') L.push('📧 بنبعتلك دعوة على إيميلك');
  else if (a === 'none') L.push('👤 حساب جاهز من عندنا');
  L.push(pl.instant ? '⚡ تسليم فوري بعد الدفع بـ USDT' : '⏱ التفعيل خلال دقائق بعد تأكيد الدفع');
  return L.join('\n');
}
// one duration as a card on the product's picture: price, stock, warranty (Hazem's own words), description, 🛒
async function tgVariant(c, pid, k, fresh, pic) {
  const p = c.data.products.find(x => x.id === pid), pl = p && p.plans[+k];
  if (!p || !pl || !(+pl.price > 0)) { c.alert = 'هالمدة مش متوفرة هلأ'; return; }
  const [, bot, photo] = await Promise.all([tgCounts(c, [p]), tgMe(c.env), tgBan(p.id, 'home')]);
  const gone = !!p.soldOut || !!pl.out, n = tgLeft(c.data, p, pl);
  const L = [`${tgEmo(c.data, p)} <b>${esc(tgVName(p, pl))}</b>`, ''];
  L.push(`💵 السعر: ${+pl.compare > +pl.price ? `<s>${tgN(pl.compare)} ₪</s> ` : ''}<b>${tgN(pl.price)} ₪</b>`);
  L.push(gone ? '🔴 خلصت الكمية هلأ' : n ? `📦 المتوفر: ${n} قطعة` : '✅ متوفر');
  if (String(pl.tgWar || '').trim()) L.push(`🛡 الضمان: ${esc(String(pl.tgWar).trim())}`);
  if (!gone && pl.deal && +pl.deal.until > Date.now()) L.push(`🔥 عرض لحد ${tgWhen(+pl.deal.until, true)}`);
  L.push(`<blockquote expandable>📝 <b>الوصف</b>\n${tgDesc(c.data, p, pl)}</blockquote>`);
  let text = L.join('\n');
  if (tgLen(text) > 1024) text = L.slice(0, -1).join('\n') + `\n<blockquote expandable>📝 <b>الوصف</b>\n${tgDesc(c.data, p, pl).slice(0, 500)}…</blockquote>`;
  const kb = [gone ? [{ text: '🔔 نفدت، نبّهني لما ترجع', callback_data: `nt:${p.id}:${k}`, style: 'danger' }] : [{ text: '🛒 اشتري الآن', callback_data: `pl:${p.id}:${k}`, style: 'success' }]];
  kb.push([tgBtn('« رجوع', 'p:' + p.id), ...(bot ? [tgUrl('📤 شارك', 'https://t.me/share/url?url=' + encodeURIComponent(`https://t.me/${bot}?start=v_${p.id}_${k}`) + '&text=' + encodeURIComponent(`${tgVName(p, pl)} — ${tgN(pl.price)} ₪`))] : [])]);
  if (!fresh && !pic && c.msgId && c.isPhoto && tgLen(text) <= 1000) return tgShow(c, text, kb, true); // same picture: only the words change
  return tgView(c, { photo, text, kb }, fresh);
}
let TGME = '';
async function tgMe(env) {
  if (TGME) return TGME;
  const me = await tg(env, 'getMe', {}, true);
  return (TGME = (me && me.username) || '');
}
// 🛒 from an announcement: keep the announcement, carry on in a new message under it
function tgBuy(c, pid, i) {
  const p = c.data.products.find(x => x.id === pid);
  if (!p) { c.alert = 'هالاشتراك مش متوفر هلأ'; return; }
  if (tgOut(p)) { c.alert = 'خلصت كميته هلأ، وأول ما يرجع بنبعتلك إعلان هون 🔔'; return; }
  c.msgId = 0;
  if (i != null) {
    const pl = p.plans[+i];
    if (pl && +pl.price > 0 && !pl.out) return tgPlan(c, p.id, +i);
    return tgProduct(c, p.id, true);
  }
  const plans = p.plans.map((pl, k) => ({ pl, k })).filter(x => +x.pl.price > 0);
  if (plans.length === 1) return tgPlan(c, p.id, plans[0].k);
  return tgProduct(c, p.id, true);
}
async function tgHelp(c, edit) {
  const faq = (c.data.settings.faq || []).filter(f => f && String(f.q || '').trim() && String(f.a || '').trim()).slice(0, 10);
  const text = `❓ <b>المساعدة</b>\n<blockquote>🛒 <b>كيف بتشتري؟</b>\n1️⃣ اكبس «المنتجات» واختار اللي بدك\n2️⃣ اختار المدة واكبس «اشتري الآن»\n3️⃣ ادفع بـ${esc(tgPayList(c))}، وابعت سكرين التحويل هون\n4️⃣ بعد الدفع بنكمّل معك بقية التفاصيل على واتساب أو تيليجرام، وبيوصلك اشتراكك هون</blockquote>` +
    (faq.length ? '\nأو اختار سؤالك 👇' : '');
  const qs = faq.map((f, i) => { const b = tgBtn('❔ ' + tgShort(tgClean(f.q), 34), 'fq:' + i); b._w = tgLen(b.text); return b; });
  const kb = [...tgPair(qs), [tgBtn('💬 مركز الدعم', 'sup'), tgBtn('🏠 الرئيسية', 'home')]];
  if (tgIsAdmin(c)) kb.push([tgBtn('📢 إعلان للمشتركين', 'post')]);
  return tgView(c, { text, kb }, !edit);
}
// one question with its answer (the store's FAQ from the admin settings)
function tgFaq(c, i) {
  const f = (c.data.settings.faq || []).filter(f => f && String(f.q || '').trim() && String(f.a || '').trim())[+i];
  if (!f) return tgHelp(c, true);
  return tgView(c, { text: `❔ <b>${esc(tgClean(f.q))}</b>\n<blockquote>${esc(String(f.a).trim().slice(0, 3000))}</blockquote>`, kb: [[tgBtn('« باقي الأسئلة', 'help'), tgBtn('💬 الدعم', 'sup')]] });
}
// 📅 every subscription bought here that is still running, with how long it has left; ⚠️ and «جدّد» when it ends soon
async function tgMySubs(c) {
  const rows = await c.fs.query('orders', [['tgChat', 'EQUAL', c.chat]], 40), now = Date.now(), list = [];
  for (const r of rows) {
    const o = r.data;
    if (o.status !== 'done') continue;
    for (const it of o.items || []) {
      const end = tgItemEnd(o, it, c.data.products);
      if (end > now) list.push({ id: r.id, o, it, end, start: +it.startAt || +o.doneAt || +o.createdAt || now });
    }
  }
  list.sort((a, b) => a.end - b.end);
  if (!list.length) return tgView(c, { text: '📅 <b>اشتراكاتي</b>\nما عندك اشتراكات فعّالة من البوت هلأ.\nبعد ما تشتري، بتطلع هون مع قديش باقي عليها 🔔', kb: [[{ ...tgBtn('🛍 تصفّح المنتجات', 'prods'), style: 'primary' }], [tgBtn('🏠 الرئيسية', 'home')]] });
  const blocks = list.slice(0, 8).map(x => {
    const left = Math.max(1, Math.ceil((x.end - now) / 864e5)), frac = Math.max(0, Math.min(1, (x.end - now) / Math.max(1, x.end - x.start))), bars = Math.max(1, Math.round(frac * 5));
    const p = c.data.products.find(y => y.id === x.it.productId);
    return `<blockquote>${p ? tgIcon(c.data, p) : '📦'} <b>${esc(x.it.productName || '')}${x.it.planName ? ' · ' + esc(x.it.planName) : ''}</b>\n${'▰'.repeat(bars)}${'▱'.repeat(5 - bars)}  ${left <= 3 ? '⚠️ ' : ''}باقي <b>${tgDays(left)}</b> · لحد ${tgWhen(x.end)}</blockquote>`;
  });
  const kb = list.filter(x => x.end - now <= 7 * 864e5).slice(0, 3).map(x => {
    const p = c.data.products.find(y => y.id === x.it.productId), pl = p && p.plans.find(y => y.id === x.it.planId);
    return [{ text: `🔄 جدّد ${tgShort(tgClean(x.it.productName || ''), 22)}${pl && +pl.price > 0 ? ' · ' + tgP(pl.price) : ''}`, callback_data: 'rn:' + x.id, style: 'success' }];
  });
  kb.push([tgBtn('📦 كل طلباتي', 'orders'), tgBtn('🏠 الرئيسية', 'home')]);
  return tgView(c, { text: '📅 <b>اشتراكاتي الفعّالة</b>' + blocks.join('') + '🔔 بنذكّرك قبل ما يخلص أي اشتراك بـ 3 أيام.', kb });
}
// ---------------------------------------------------------------- 💬 support inside the bot: tgHelpDesk/<id> holds the thread;
// the customer writes here, admins get it in the bot and answer with ✍️, the answer comes back here
const TG_HELP_T = { o: '📦 مشكلة بطلب', s: '🔐 مشكلة بالاشتراك', p: '💳 سؤال عن الدفع', q: '❓ سؤال تاني' };
function tgSupport(c) {
  tgReset(c);
  return tgView(c, { text: '💬 <b>كيف بنقدر نساعدك؟</b>\nاختار نوع المشكلة، وبتوصلنا رسالتك مع تفاصيل طلبك 👇', kb: [
    [tgBtn(TG_HELP_T.o, 'hs:o'), tgBtn(TG_HELP_T.s, 'hs:s')], [tgBtn(TG_HELP_T.p, 'hs:p'), tgBtn(TG_HELP_T.q, 'hs:q')],
    [tgUrl('👤 كلّم الدعم مباشرة', tgSup(c))], [tgBtn('🏠 الرئيسية', 'home')]] });
}
async function tgHelpType(c, t) {
  if (!TG_HELP_T[t]) return tgSupport(c);
  if (t === 'o' || t === 's') {
    const rows = (await c.fs.query('orders', [['tgChat', 'EQUAL', c.chat]], 20)).sort((a, b) => (+b.data.createdAt || 0) - (+a.data.createdAt || 0)).slice(0, 5);
    if (rows.length) return tgView(c, { text: `${TG_HELP_T[t]}\n📦 <b>أي طلب؟</b>`, kb: [...rows.map(r => { const it = (r.data.items || [])[0] || {}; return [tgBtn(`${tgStatus(r.data).split(' ')[0]} ${r.data.orderNo || ''} · ${tgShort(tgClean(it.productName || ''), 22)}`, `ho:${t}:${r.id}`)]; }), [tgBtn('بدون طلب', `ho:${t}:-`)], [tgBtn('« رجوع', 'sup')]] });
  }
  return tgHelpAsk(c, t, '');
}
async function tgHelpAsk(c, t, oid) {
  c.S = { help: { t, o: oid && oid !== '-' ? oid : '' } }; c.dirty = true;
  return tgView(c, { text: `${TG_HELP_T[t] || '💬'}\n✍️ <b>اكتب مشكلتك برسالة وحدة</b> (وفيك تبعت صورة كمان) 👇`, kb: [[tgBtn('❌ إلغاء', 'hx')]] });
}
// the customer's message → the thread (new, or the one they answer) → the admins
async function tgHelpGot(c, m) {
  const h = c.S.help, text = String(m.text || m.caption || '').trim().slice(0, 1500), photo = !!(m.photo || (m.document && /^image\//.test(m.document.mime_type || '')));
  if (!text && !photo) return tgSay(c, 'اكتب رسالتك كنص أو ابعت صورة 🙏', [[tgBtn('❌ إلغاء', 'hx')]]);
  const now = Date.now(), msg = { by: 'c', t: text || '📷 صورة', at: now };
  let id = h.tk, d;
  if (id) {
    const doc = await c.fs.get('tgHelpDesk/' + id);
    if (!doc || doc.data.chat !== c.chat) { tgReset(c); return tgSay(c, 'هالمحادثة خلصت، ابدأ رسالة جديدة من «💬 الدعم».'); }
    d = doc.data;
    await c.fs.commit([c.fs.wUpdate('tgHelpDesk/' + id, { msgs: [...(d.msgs || []), msg].slice(-30), status: 'open', at: now }, ['msgs', 'status', 'at'])]);
  } else {
    let o = null;
    if (h.o) { const doc = await c.fs.get('orders/' + h.o); if (doc && doc.data.tgChat === c.chat) o = doc.data; }
    id = tgDocId();
    d = { no: 'T-' + (1000 + Math.floor(Math.random() * 9000)), chat: c.chat, user: c.from.username || '', name: tgWho(c.from), type: h.t || 'q', oid: o ? h.o : '', orderNo: o ? o.orderNo || '' : '', product: o ? ((o.items || [])[0] || {}).productName || '' : '', msgs: [msg], status: 'open', at: now };
    await c.fs.commit([c.fs.wUpdate('tgHelpDesk/' + id, d, null, { exists: false })]);
  }
  tgReset(c);
  const head = h.tk ? '💬 <b>رد من الزبون</b>' : '🆘 <b>رسالة دعم جديدة</b>';
  const L = [`${head} · <code>#${esc(d.no)}</code>`, `👤 ${esc(d.name)}${d.user ? ' · @' + esc(d.user) : ''}`, `🏷 ${TG_HELP_T[d.type] || ''}`];
  if (d.orderNo) L.push(`📦 <code>${esc(d.orderNo)}</code> · ${esc(d.product)}`);
  if (text) L.push(`<blockquote>${esc(text)}</blockquote>`);
  const kb = [[{ ...tgBtn('✍️ رد', 'hr:' + id), style: 'primary' }, ...(d.user ? [tgUrl('💬 راسله', 'https://t.me/' + tgUserName(d.user))] : [])]];
  for (const a of (await tgAdminChats(c.fs)).slice(0, 3)) {
    if (BUDGET < 4) break;
    await tg(c.env, 'sendMessage', { chat_id: a, text: L.join('\n'), parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    if (photo && m.message_id) await tg(c.env, 'copyMessage', { chat_id: a, from_chat_id: c.chat, message_id: m.message_id });
  }
  notifyAdmin(c.env, `💬 ${h.tk ? 'رد على تذكرة' : 'تذكرة دعم جديدة'} #${d.no} من البوت`, [`الزبون: ${d.name}${d.user ? ' · @' + d.user : ''}`, TG_HELP_T[d.type] || '', d.orderNo ? 'الطلب: ' + d.orderNo + ' · ' + d.product : '', 'الرسالة: ' + (text || 'صورة'), 'رد من البوت بزر ✍️ رد'].filter(Boolean), SITE + '/admin.html').catch(() => {});
  return tgSay(c, `✅ <b>وصلتنا رسالتك</b> · تذكرة <code>#${esc(d.no)}</code>` + (d.orderNo ? `\n<blockquote>📦 ${esc(d.orderNo)} · ${esc(d.product)}\n${TG_HELP_T[d.type] || ''}</blockquote>` : '') + '\nبنرد عليك <b>هون بالبوت</b> بأسرع وقت 🤍', [[tgBtn('🏠 الرئيسية', 'home')]]);
}
// an admin answers a thread → the customer gets it here, with ✍️ to write back
async function tgHelpReply(c, text) {
  const id = c.S.hrep, doc = await c.fs.get('tgHelpDesk/' + id);
  tgReset(c);
  if (!doc) return tgSay(c, 'ما لقينا هالمحادثة.');
  const d = doc.data, now = Date.now();
  const sent = await tg(c.env, 'sendMessage', { chat_id: d.chat, text: `💬 <b>رد من الدعم</b> · تذكرة <code>#${esc(d.no)}</code>\n<blockquote>${esc(text.slice(0, 3500))}</blockquote>`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[{ ...tgBtn('✍️ رد', 'hc:' + id), style: 'primary' }, tgBtn('🏠 الرئيسية', 'home')]] } });
  await c.fs.commit([c.fs.wUpdate('tgHelpDesk/' + id, { msgs: [...(d.msgs || []), { by: 'a', t: text.slice(0, 1500), at: now, who: c.from.username || '' }].slice(-30), status: 'answered', at: now }, ['msgs', 'status', 'at'])]);
  return tgSay(c, sent ? `✅ وصل ردك لـ ${esc(d.name)} · <code>#${esc(d.no)}</code>` : '⚠️ ما قدرنا نوصل الرد (يمكن الزبون مسكّر البوت).');
}

// ---------------------------------------------------------------- admin in the bot (usernames in admin settings → بوت تيليجرام)
// 📢 /post: pick a product (and a duration) → see the card exactly as people will get it → send it to everyone
function tgPostMenu(c) {
  if (!tgIsAdmin(c)) return tgHome(c, !c.msgId);
  const ps = c.data.products.filter(p => !tgOut(p));
  const kb = [[{ ...tgBtn('📝 بوست حر (نص، صورة، فيديو)', 'pfree'), style: 'success' }], ...tgRows(ps.map(p => tgPBtn(c.data, p, 'ps:' + p.id)), 2), [tgBtn('« الرئيسية', 'home')]];
  const ch = tgChan(c.data.settings);
  return tgShow(c, `📢 <b>إعلان ${ch ? 'للمشتركين أو للقناة ' + esc(ch) : 'لكل مشتركين البوت'}</b>\nاكتب بوست حر، أو اختار منتج وبنعمله بطاقة 👇`, kb);
}
// the announcement card, like the shops on Telegram: icon + name, what's new, stock, price, one 🛒 button.
// i = which duration (its index in the product), or null for one card with all the durations
function tgPostCard(data, p, i, extra) {
  const st = data.stock || {}, nm = tgClean(p.name), emo = tgEmo(data, p);
  const plans = (p.plans || []).map((pl, k) => ({ pl, k })).filter(x => x.pl && +x.pl.price > 0 && !x.pl.out && !p.soldOut);
  const one = i != null ? plans.find(x => x.k === +i) : plans.length === 1 ? plans[0] : null;
  const L = [];
  if (one) {
    const pl = one.pl, pn = tgClean(pl.name || ''), n = pl.instant ? +st[p.id + '|' + pl.id] || 0 : 0;
    L.push(`${emo} <b>${esc(tgVName(p, pl))}</b>`);
    if (extra && extra.length) L.push(...extra);
    if (n) L.push(`📦 المتوفر: ${n}`); else if (!(extra || []).some(x => /متوفر/.test(x))) L.push('✅ متوفر');
    L.push(`💵 السعر: ${+pl.compare > +pl.price ? `<s>${tgN(pl.compare)} ₪</s> ` : ''}<b>${tgN(pl.price)} ₪</b>`);
    if (String(pl.tgWar || '').trim()) L.push(`🛡 الضمان: ${esc(String(pl.tgWar).trim())}`);
    return { t: L.join('\n'), k: [[{ ...tgBtn('🛒 اشتري الآن', `b:${p.id}:${one.k}`), style: 'success' }]], img: '', pid: p.id };
  }
  L.push(`${emo} <b>${esc(nm)}</b>`);
  if (extra && extra.length) L.push(...extra);
  for (const x of plans.slice(0, 8)) L.push(`💵 ${esc(tgClean(x.pl.name || nm))}: <b>${tgN(x.pl.price)} ₪</b>`);
  return { t: L.join('\n'), k: [[{ ...tgBtn('🛒 اشتري الآن', 'b:' + p.id), style: 'success' }]], img: '', pid: p.id };
}
function tgSubs(fs) { return fs.count('tgUsers', [['off', 'EQUAL', false]]); }
function tgPostPlans(c, pid) {
  if (!tgIsAdmin(c)) return;
  const p = c.data.products.find(x => x.id === pid);
  if (!p || tgOut(p)) { c.alert = 'هالمنتج مش متوفر هلأ'; return; }
  const live = p.plans.map((pl, k) => ({ pl, k })).filter(x => +x.pl.price > 0 && !x.pl.out);
  if (live.length === 1) return tgPostPreview(c, pid, String(live[0].k));
  const kb = live.map(x => [tgBtn(`${tgClean(x.pl.name || p.name).slice(0, 26)} · ${tgN(x.pl.price)} ₪`, `pp:${p.id}:${x.k}`)]);
  kb.push([tgBtn('📋 كل المدد ببطاقة وحدة', `pp:${p.id}:a`)], [tgBtn('« منتج ثاني', 'post')]);
  return tgShow(c, `📢 ${tgEmo(c.data, p)} <b>${esc(tgClean(p.name))}</b>\nأي مدة بدك تعلن عنها؟`, kb);
}
async function tgPostPreview(c, pid, which) {
  if (!tgIsAdmin(c)) return;
  const p = c.data.products.find(x => x.id === pid);
  if (!p || tgOut(p)) { c.alert = 'هالمنتج مش متوفر هلأ'; return; }
  await tgCounts(c, [p]);
  const j = tgPostCard(c.data, p, which === 'a' ? null : which);
  c.msgId = 0;
  await tgSay(c, j.t, j.k);
  let n = 0;
  try { n = await tgSubs(c.fs); } catch (e) {}
  return tgSay(c, `👆 هيك رح يوصل.\nالمشتركين: <b>${n}</b>\n${tgChan(c.data.settings) ? 'وين بدك تنشره؟' : 'أبعته للكل؟'}`, [...tgDestKb(c, `pc:${p.id}:${which}:`), [tgBtn('« منتج ثاني', 'post'), { ...tgBtn('❌ لا', 'home'), style: 'danger' }]]);
}
async function tgPostSend(c, pid, which, dest) {
  dest = dest || 'u';
  if (!tgIsAdmin(c)) return;
  const p = c.data.products.find(x => x.id === pid);
  if (!p) { c.alert = 'هالمنتج مش موجود'; return; }
  await tgCounts(c, [p]);
  const j = tgPostCard(c.data, p, which === 'a' ? null : which);
  const id = 'p_' + p.id + '_' + which + '_' + dest + '_' + Math.floor(Date.now() / 60e3); // pressing twice in the same minute sends once
  // tgSent keeps a small mark per post, so a second press can't send it again even after the first one finished
  try { await c.fs.commit([c.fs.wUpdate('tgPosts/' + id, { ...j, ...tgDestJob(c, dest), a: '', n: 0, by: c.chat, at: Date.now(), lock: 0 }, null, { exists: false }), c.fs.wUpdate('tgSent/' + id, { at: Date.now() }, null, { exists: false })]); }
  catch (e) { c.alert = 'هاد الإعلان انبعت قبل شوي ✓'; return; }
  await tgShow(c, `✅ <b>بلّشنا ننشر إعلان ${esc(tgClean(p.name))}</b>\nبيوصل ${tgDestDone(c, dest)}، وبخبرك هون لما يخلص.`, [[tgBtn('📢 إعلان ثاني', 'post'), tgBtn('🏠 الرئيسية', 'home')]]);
  await tgJobRun(c.fs, c.env); // the first people right away
}
// ---------------------------------------------------------------- the store's Telegram channel (admin settings → بوت تيليجرام)
// The bot posts there as an admin of the channel. Buttons in a channel open the bot (links), since a channel has no chat with the bot.
function tgChan(settings) {
  const v = String((settings && settings.tgChannel) || '').trim().replace(/^.*t\.me\//i, '').replace(/^@/, '');
  if (/^-100\d{5,}$/.test(v)) return v;
  return /^[A-Za-z][A-Za-z0-9_]{3,}$/.test(v) ? '@' + v : '';
}
function tgChanAuto(settings) { return settings && settings.tgChanAuto !== false ? tgChan(settings) : ''; }
function tgChanKb(kb, bot) {
  const link = start => 'https://t.me/' + bot + (start ? '?start=' + start : '');
  const out = [];
  for (const row of kb || []) {
    const r = [];
    for (const b of row) {
      const d = String(b.callback_data || ''), m = d.match(/^b:([^:]+)(?::(\d+))?$/);
      if (b.url) r.push(b);
      else if (m && bot) r.push({ ...b, callback_data: undefined, url: link(m[2] != null ? `v_${m[1]}_${m[2]}` : 'p_' + m[1]) });
      else if (d === 'prods' && bot) r.push({ ...b, callback_data: undefined, url: link('shop') });
    }
    if (r.length) out.push(r.map(x => { const y = { ...x }; delete y.callback_data; return y; }));
  }
  return out;
}
async function tgChanCheck(c) {
  if (!tgIsAdmin(c)) return;
  const ch = tgChan(c.data.settings);
  if (!ch) return tgSay(c, '📣 ما في قناة محطوطة.\nحط يوزر القناة بلوحة الأدمن: الإعدادات ← بوت تيليجرام ← قناة تيليجرام.');
  const me = await tg(c.env, 'getMe', {}, true), chat = await tg(c.env, 'getChat', { chat_id: ch }, true);
  if (!chat) return tgSay(c, `⚠️ ما لقيت القناة ${esc(ch)}.\nتأكد من اليوزر، وإنه البوت مضاف فيها كأدمن.`);
  const mem = me && await tg(c.env, 'getChatMember', { chat_id: ch, user_id: me.id }, true);
  const ok = mem && (mem.status === 'creator' || (mem.status === 'administrator' && mem.can_post_messages !== false));
  return tgSay(c, ok ? `✅ البوت أدمن بالقناة <b>${esc(chat.title || ch)}</b> وبيقدر ينشر فيها.` : `⚠️ البوت مش أدمن بالقناة <b>${esc(chat.title || ch)}</b>، أو ما معه صلاحية النشر.\nمن إعدادات القناة: المشرفين ← إضافة مشرف ← @${esc((me && me.username) || 'البوت')} ← فعّل «نشر الرسائل».`);
}
// where a post goes: subscribers (u), the channel (c) or both (a)
function tgDestKb(c, prefix, okLabel) {
  const ch = tgChan(c.data.settings);
  if (!ch) return [[{ ...tgBtn(okLabel || '📢 آه، ابعته للمشتركين', prefix + 'u'), style: 'success' }]];
  return [[{ ...tgBtn('👥 للمشتركين', prefix + 'u'), style: 'success' }, { ...tgBtn('📣 للقناة', prefix + 'c'), style: 'success' }], [{ ...tgBtn('👥 + 📣 الاثنين', prefix + 'a'), style: 'success' }]];
}
function tgDestJob(c, dest) {
  const ch = tgChan(c.data.settings);
  return { chan: dest !== 'u' && ch ? ch : '', ...(dest === 'c' ? { to: [] } : {}) };
}
function tgDestDone(c, dest) {
  return dest === 'c' ? 'بالقناة' : dest === 'a' ? 'بالقناة ولكل المشتركين خلال دقايق (حوالي 25 شخص كل دقيقتين)' : 'لكل المشتركين خلال دقايق (حوالي 25 شخص كل دقيقتين)';
}
// 📝 a free post: whatever Hazem sends (text, a photo with words, a video…) is copied as it is, with a button to the products
function tgFreeAsk(c) {
  if (!tgIsAdmin(c)) return;
  c.S = { free: 'wait' }; c.dirty = true; c.msgId = 0;
  return tgSay(c, '📝 ابعتلي البوست زي ما بدك يوصل: نص، أو صورة مع كلام، أو فيديو.\nتحته بنحط زر «🛒 تصفّح المنتجات».', [[tgBtn('❌ إلغاء', 'home')]]);
}
async function tgFreeGot(c, m) {
  c.S = { free: 'ready', fc: c.chat, mid: m.message_id }; c.dirty = true;
  const kb = [[{ ...tgBtn('🛒 تصفّح المنتجات', 'prods'), style: 'success' }]];
  await tgCall(c.env, 'copyMessage', { chat_id: c.chat, from_chat_id: c.chat, message_id: m.message_id }, kb);
  let n = 0;
  try { n = await tgSubs(c.fs); } catch (e) {}
  return tgSay(c, `👆 هيك رح يوصل.\nالمشتركين: <b>${n}</b>\nوين بدك تنشره؟`, [...tgDestKb(c, 'pfs:'), [tgBtn('✏️ بوست ثاني', 'pfree'), { ...tgBtn('❌ إلغاء', 'home'), style: 'danger' }]]);
}
async function tgFreeSend(c, dest) {
  if (!tgIsAdmin(c) || c.S.free !== 'ready') { c.alert = 'ابعت البوست من جديد: /post'; return; }
  const { fc, mid } = c.S; tgReset(c);
  const id = 'f_' + fc + '_' + mid + '_' + dest;
  const job = { copy: { fc: String(fc), mid: +mid }, k: [[{ ...tgBtn('🛒 تصفّح المنتجات', 'prods'), style: 'success' }]], t: '', img: '', ...tgDestJob(c, dest), a: '', n: 0, by: c.chat, at: Date.now(), lock: 0 };
  try { await c.fs.commit([c.fs.wUpdate('tgPosts/' + id, job, null, { exists: false }), c.fs.wUpdate('tgSent/' + id, { at: Date.now() }, null, { exists: false })]); }
  catch (e) { c.alert = 'هاد البوست انبعت قبل ✓'; return; }
  await tgShow(c, `✅ <b>بلّشنا ننشر البوست</b> ${tgDestDone(c, dest)}، وبخبرك هون لما يخلص.`, [[tgBtn('📢 إعلان ثاني', 'post'), tgBtn('🏠 الرئيسية', 'home')]]);
  await tgJobRun(c.fs, c.env);
}
// /seticon: Hazem picks the icon of each product himself — any custom emoji, animated ones too —
// by sending it to the bot (needs Telegram Premium to send one). These win over the /icons logos.
function tgSetIconMenu(c) {
  if (!tgIsAdmin(c)) return tgHome(c, !c.msgId);
  const kb = [...tgRows(c.data.products.map(p => tgPBtn(c.data, p, 'si:' + p.id)), 2), [tgBtn('« الرئيسية', 'home')]];
  return tgShow(c, '🎨 <b>أيقونات المنتجات</b>\nاختار المنتج اللي بدك تغيّر أيقونته، وبعدين ابعتلي الإيموجي المميز (المتحرك أحلى) 👇\nبعد كل واحد بنقلك عالمنتج اللي بعده.', kb);
}
function tgSetIconAsk(c, pid) {
  if (!tgIsAdmin(c)) return;
  const ps = c.data.products, p = ps.find(x => x.id === pid);
  if (!p) { c.alert = 'هالمنتج مش موجود'; return; }
  const i = ps.indexOf(p), next = ps[i + 1];
  c.S = { seticon: p.id }; c.dirty = true; c.msgId = 0;
  return tgSay(c, `🎨 ابعتلي أيقونة <b>${esc(tgClean(p.name))}</b> (${i + 1}/${ps.length})\nابعت إيموجي مميز واحد من لوحة الإيموجي، إذا كان متحرك بيضل يتحرك بالبوت.`,
    [[tgBtn('⏭ تخطّي', next ? 'si:' + next.id : 'sidone'), tgBtn('⏹ خلص', 'sidone')]]);
}
async function tgSetIconGot(c, m) {
  const pid = c.S.seticon, p = c.data.products.find(x => x.id === pid);
  const ent = [...(m.entities || []), ...(m.caption_entities || [])].find(e => e.type === 'custom_emoji' && e.custom_emoji_id);
  const id = ent ? ent.custom_emoji_id : (m.sticker && m.sticker.custom_emoji_id) || '';
  if (!p) { tgReset(c); return tgSetIconMenu(c); }
  if (!id) return tgSay(c, 'هاد مش إيموجي مميز 🤔 ابعت إيموجي من الإيموجي المميزة (بدها Premium)، أو اكبس ⏭ تخطّي.', [[tgBtn('⏭ تخطّي', 'sidone')]]);
  await c.fs.commit([c.fs.wUpdate('tgMeta/icons', { man: { [p.id]: String(id) }, on: true, prem: !!c.from.is_premium }, ['man.' + fp(p.id), 'on', 'prem'])]);
  TGC.at = 0; ICON_OFF = 0;
  await tgSay(c, `✅ <tg-emoji emoji-id="${esc(String(id))}">⭐</tg-emoji> صارت أيقونة <b>${esc(tgClean(p.name))}</b>`);
  const ps = c.data.products, next = ps[ps.indexOf(p) + 1];
  if (next) return tgSetIconAsk(c, next.id);
  tgReset(c);
  return tgSay(c, '🎉 خلصنا كل المنتجات! اكبس /products وشوف.');
}
// /icons: make the brand icons as a Telegram custom emoji set (the bot owner needs Telegram Premium for them to show)
async function tgIconsMake(c, arg) {
  if (!tgIsAdmin(c)) return tgHome(c, true);
  const { fs, env } = c;
  if (arg === 'off' || arg === 'on') {
    await fs.commit([fs.wUpdate('tgMeta/icons', { on: arg === 'on' }, ['on'])]);
    TGC.at = 0;
    return tgSay(c, arg === 'on' ? '✅ رجّعت الأيقونات.' : '✅ وقّفت الأيقونات، الأزرار رجعت بالإيموجي العادي.');
  }
  if (arg === 'force') { // the owner is another account that has Premium
    await fs.commit([fs.wUpdate('tgMeta/icons', { force: true, on: true }, ['force', 'on'])]);
    TGC.at = 0; ICON_OFF = 0;
    return tgSay(c, '✅ شغّلت الأيقونات. إذا ما بيّنت، يعني حساب صاحب البوت مش عليه Premium.');
  }
  const me = await tg(env, 'getMe', {});
  if (!me) return tgSay(c, 'ما قدرت أوصل لتيليجرام، جرّب بعد شوي.');
  const name = 'hzicons_by_' + me.username;
  const list = c.data.products.map(p => ({ p, d: tgDomain(p) })).filter(x => x.d).slice(0, 30);
  if (!list.length) return tgSay(c, 'ما في منتجات إلها موقع (domain) بلوحة الأدمن عشان أجيب لوغو إلها.');
  await tgSay(c, `⏳ بجهّز ${list.length} أيقونة…`);
  // fetch every logo as a 100×100 picture, then upload them together
  const got = await Promise.all(list.map(async x => {
    try { const r = await xf(tgLogo(x.p, 100)); if (!r.ok) return null; const b = await r.arrayBuffer(); return b.byteLength > 100 && b.byteLength < 128e3 ? { ...x, b } : null; } catch (e) { return null; }
  }));
  const ok = got.filter(Boolean);
  if (!ok.length) return tgSay(c, 'ما قدرت أجيب اللوغوهات هلأ، جرّب بعد شوي.');
  await tg(env, 'deleteStickerSet', { name }, true); // start fresh (fails the first time, that's fine)
  const fd = new FormData();
  fd.append('user_id', String(c.from.id)); fd.append('name', name); fd.append('title', (c.data.settings.storeName || STORE) + ' · أيقونات'); fd.append('sticker_type', 'custom_emoji');
  fd.append('stickers', JSON.stringify(ok.map((x, i) => ({ sticker: 'attach://f' + i, format: 'static', emoji_list: [tgIcon(c.data, x.p)] }))));
  ok.forEach((x, i) => fd.append('f' + i, new Blob([x.b], { type: 'image/png' }), 'f' + i + '.png'));
  const r = await xf(TGB + env.SHOP_BOT_TOKEN + '/createNewStickerSet', { method: 'POST', body: fd });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) return tgSay(c, 'تيليجرام ما قبل الأيقونات: ' + esc(String(j.description || r.status).slice(0, 200)));
  const set = await tg(env, 'getStickerSet', { name });
  const map = {};
  (set && set.stickers || []).forEach((st, i) => { if (ok[i] && st.custom_emoji_id) map[ok[i].p.id] = st.custom_emoji_id; });
  const prem = !!c.from.is_premium;
  await fs.commit([fs.wUpdate('tgMeta/icons', { on: true, map, set: name, at: Date.now(), prem, force: false }, ['on', 'map', 'set', 'at', 'prem', 'force'])]);
  TGC.at = 0; ICON_OFF = 0;
  const miss = list.length - ok.length;
  await tgSay(c, `✅ جهزت ${Object.keys(map).length} أيقونة رسمية${miss ? ` (${miss} ما زبطوا)` : ''}.\n` + (prem
    ? 'حسابك عليه Premium، فالأيقونات شغالة 👇\nلتوقيفها: /icons off'
    : '⚠️ حسابك مش عليه <b>Telegram Premium</b> هلأ، وتيليجرام ما بيعرض الأيقونات إلا إذا صاحب البوت عليه Premium. لحد ما تشترك بتضل الأزرار بالإيموجي العادي، وأول ما تشترك وتبعت أي رسالة للبوت من هالحساب، الأيقونات بتطلع لحالها.\n(إذا صاحب البوت حساب ثاني عليه Premium ابعت /icons force)'));
  c.data = await tgData(fs);
  return tgGrid(c, true);
}
function tgPick(c) {
  const p = c.data.products.find(x => x.id === c.S.pid);
  const pl = p && p.plans.find(x => x.id === c.S.plan);
  return p && pl && +pl.price > 0 ? { p, pl } : null;
}
function tgSummary(c, x) {
  const acct = x.pl.acct || x.p.acct || '', war = String(x.pl.tgWar || '').trim();
  return `🧾 <b>ملخص طلبك</b>\n<blockquote>📦 <b>${esc(tgVName(x.p, x.pl))}</b>\n💰 السعر: <b>${tgN(x.pl.price)} ₪</b>` +
    (war ? `\n🛡 الضمان: ${esc(war)}` : '') +
    (acct === 'login' ? '\n📧 بيتفعّل على إيميلك الشخصي' : acct === 'email' ? '\n📧 بتوصلك دعوة على إيميلك' : acct === 'none' ? '\n👤 حساب جاهز من عندنا' : '') +
    `\n⚡ ${x.pl.instant ? 'تسليم فوري بعد الدفع بـ USDT' : 'التفعيل خلال دقائق بعد تأكيد الدفع'}</blockquote>` +
    (tgNeeds([x.p], { items: [{ productId: x.p.id, planId: x.pl.id }] }).length ? '\n📩 بقية التفاصيل بنكمّلها معك على واتساب أو تيليجرام <b>بعد الدفع</b>.' : '');
}
function tgMEmo(m) { const n = String(m.name || ''); return isUsdt(m) ? '🪙' : /جوال|jawwal/i.test(n) ? '📱' : /بال ?باي|pal/i.test(n) ? '💳' : /بنك|bank|iban|آيبان/i.test(n) ? '🏦' : /شات|chat/i.test(n) ? '💬' : '💰'; }
async function tgPlan(c, pid, i) {
  if (tgClosed(c)) { c.alert = 'الطلبات موقفة مؤقتاً، كلّمنا على الدعم'; return; }
  const p = c.data.products.find(x => x.id === pid), pl = p && p.plans[+i];
  if (!p || !pl || !(+pl.price > 0)) { c.alert = 'هالمدة مش متوفرة هلأ'; return tgProduct(c, pid); }
  if (p.soldOut || pl.out) { c.alert = 'هالمدة خلصت كميتها هلأ'; return; }
  c.S = { pid: p.id, plan: pl.id }; c.dirty = true;
  const deal = await tgDeal(c, pl.price), w = await tgWallet(c), bal = w ? +w.balance || 0 : -1;
  const ms = tgMethods(c), auto = ms.filter(m => isUsdt(m) && m.auto), hand = ms.filter(m => !(isUsdt(m) && m.auto));
  const kb = [];
  if (bal >= deal.total) kb.push([{ ...tgBtn(`💰 ادفع من رصيدي · بيضل ${tgN(bal - deal.total)} ₪`, 'wp'), style: 'success' }]);
  kb.push(...tgRows(hand.map(m => tgBtn(`${tgMEmo(m)} ${tgClean(m.name).slice(0, 22)}`, 'm:' + m.key)), 2),
    ...auto.map(m => [{ ...tgBtn('🪙 USDT · بيتأكد لحاله', 'm:' + m.key), style: 'primary' }]), [tgBtn('« رجوع', `vb:${p.id}:${+i}`)]);
  const low = bal >= 0 && bal < deal.total ? `\n💰 رصيدك بالموقع <b>${tgN(bal)} ₪</b>، ما بيكفي لهالطلب.` : '';
  return tgShow(c, tgSummary(c, { p, pl }) + tgDealLines(deal) + low + '\n💳 <b>اختار طريقة الدفع</b> 👇', kb, true);
}
async function tgMethod(c, key) {
  const x = tgPick(c), m = tgMethods(c).find(y => y.key === key);
  if (!x || !m) { c.alert = 'ابدأ الطلب من جديد'; return tgHome(c); }
  const auto = isUsdt(m) && !!m.auto, acct = x.pl.acct || x.p.acct || '';
  const pre = c.S.pre || null, pa = (pre && pre.ans) || {};
  const asks = (x.p.ask || []).map((a, k) => 'a' + k).filter(k => !(pre && pa[k.slice(1)]));
  const tail = []; // the email and the product's questions are asked after the payment is confirmed (by Hazem, in private), never here
  Object.assign(c.S, { method: m.key, q: auto ? [...tail, 'net'] : ['proof', ...tail], ans: { ...pa }, proofText: '', proofImg: '', email: (pre && pre.email) || '', phone: (pre && pre.phone) || '' });
  c.dirty = true;
  const deal = await tgDeal(c, x.pl.price);
  c.S.total = deal.total;
  await tgShow(c, tgSummary(c, x) + tgDealLines(deal) + `\n\nطريقة الدفع: <b>${esc(auto ? 'USDT (تأكيد تلقائي)' : m.name)}</b> ✓`, [], true);
  return tgAsk(c);
}
async function tgAsk(c) {
  const x = tgPick(c), step = (c.S.q || [])[0];
  if (!x || !step) return tgFinish(c);
  const cancel = [tgBtn('❌ إلغاء الطلب', 'cancel')];
  if (step === 'proof') {
    const m = tgMethods(c).find(y => y.key === c.S.method) || {};
    const box = [`حوّل <b>${tgN(+c.S.total > 0 ? c.S.total : x.pl.price)} ₪</b> على:`];
    if (m.number) box.push(`${esc(m.label || 'الرقم')}: <code>${esc(m.number)}</code>`);
    if (m.holder) box.push(`الاسم: <b>${esc(m.holder)}</b>`);
    if (m.note) box.push(esc(m.note));
    const lines = [`${tgMEmo(m)} <b>الدفع بـ${esc(m.name || '')}</b>`, `<blockquote>${box.join('\n')}</blockquote>`, '<b>بعد ما تحوّل:</b>', '📸 ابعت سكرين التحويل هون بالشات', `✍️ أو اكتب ${esc(m.proofLabel || 'رقم العملية')}`];
    const kb = m.number ? [[{ ...tgCopy('📋 انسخ ' + tgClean(m.label || 'الرقم').slice(0, 20), m.number), style: 'primary' }]] : [];
    kb.push([{ ...cancel[0], style: 'danger' }]);
    return tgSay(c, lines.join('\n'), kb);
  }
  if (step[0] === 'a') {
    const a = (x.p.ask || [])[+step.slice(1)];
    if (!a) { c.S.q.shift(); c.dirty = true; return tgAsk(c); }
    const kb = [];
    if (a.o && a.o.length) kb.push(...tgRows(a.o.map((o, j) => tgBtn(String(o), 'ao:' + j)), 2));
    if (a.req === false) kb.push([tgBtn('تخطّي', 'skip')]);
    kb.push(cancel);
    return tgSay(c, `📝 <b>${esc(a.l || 'تفاصيل الطلب')}</b>${a.req === false ? ' (اختياري)' : ''}${a.ph ? '\nمثال: ' + esc(a.ph) : ''}${a.o && a.o.length ? '\nاختار من تحت 👇' : '\nاكتبها برسالة 👇'}`, kb);
  }
  if (step === 'email') {
    const login = (x.pl.acct || x.p.acct) === 'login';
    return tgSay(c, '📧 <b>اكتب الإيميل</b> اللي بدك نفعّل عليه الاشتراك:' + (login ? '\n\n🔒 كلمة السر <b>لا تبعتها هون</b>، بنطلبها منك بشكل خاص وقت التفعيل.' : ''), [cancel]);
  }
  if (step === 'phone') {
    return tgSay(c, '📱 <b>شارك رقمك</b> عشان نقدر نتواصل معك إذا احتجنا (اختياري).', { keyboard: [[{ text: '📱 شارك رقمي', request_contact: true }], [{ text: 'تخطّي' }]], resize_keyboard: true, one_time_keyboard: true });
  }
  if (step === 'net') {
    const m = tgMethods(c).find(y => y.key === c.S.method) || {};
    const kb = [];
    if (validAddr('bsc', m.number)) kb.push([tgBtn('BEP20 · BNB Smart Chain', 'net:bsc')]);
    if (validAddr('tron', m.tron)) kb.push([tgBtn('TRC20 · Tron', 'net:tron')]);
    kb.push(cancel);
    return tgSay(c, '🌐 <b>اختار شبكة USDT</b> اللي بدك تحوّل عليها:', kb);
  }
  c.S.q.shift(); c.dirty = true;
  return tgAsk(c);
}
function tgNext(c) { c.S.q.shift(); c.dirty = true; return tgAsk(c); }

async function tgOnButton(c, d) {
  const nav = ['home', 'prods', 'cats', 'best', 'find', 'orders', 'help', 'post', 'apend', 'sl', 'deals', 'bund', 'revs', 'subs', 'sup', 'ref', 'adm', 'admw', 'adms'].includes(d) || /^(c|cat|cv|p|g|b|o|ps|pp|v|dv|vb|rn|nt|av):/.test(d);
  if (nav && (c.S.q || []).length) tgReset(c);           // browsing again ends a half-done order
  if (d === 'home') return tgHome(c);
  if (d === 'prods' || d === 'cats' || d === 'best' || /^c:/.test(d)) return tgGrid(c);   // cats/best/c: are buttons from the first version
  if (d.startsWith('cat:')) { const [, id, pg] = d.split(':'); return tgGrid(c, false, id, pg); }
  if (d.startsWith('cv:')) { const [, id, i] = d.split(':'); return tgCards(c, id, i); }
  if (d === 'deals') return tgDealsView(c);
  if (d === 'bund') return tgBundles(c);
  if (d === 'revs') return tgRevsView(c);
  if (d === 'subs') return tgMySubs(c);
  if (d === 'sup') return tgSupport(c);
  if (d === 'hx' || d === 'hrx') { tgReset(c); return tgShow(c, 'تمام، لغينا 👍', [[tgBtn('🏠 الرئيسية', 'home')]]); }
  if (d === 'find') return tgSay(c, '🔎 اكتب اسم الاشتراك اللي بتدوّر عليه، مثلاً: <b>كانفا</b> أو <b>ChatGPT</b> أو <b>شاهد</b>');
  if (d === 'orders') return tgOrders(c);
  if (d === 'help') return tgHelp(c, true);
  if (d === 'post') return tgPostMenu(c);
  if (d === 'pfree') return tgFreeAsk(c);
  if (d === 'apend') return tgAdminPending(c);
  if (d === 'sl') return tgSaleMenu(c);
  if (d === 'sgo') return tgSaleGo(c);
  if (d === 'adx') { tgReset(c); c.msgId = 0; return tgSay(c, 'تمام، لغيت التسليم.'); }
  if (d === 'rvs') { tgReset(c); return tgShow(c, 'شكراً إلك 🤍', []); }
  if (d === 'seticon') return tgSetIconMenu(c);
  if (d === 'sidone') { tgReset(c); c.msgId = 0; return tgSay(c, '👍 تمام. لتكمّل بعدين: /seticon'); }
  if (d === 'out') { c.alert = 'هالمدة خلصت كميتها هلأ، وأول ما ترجع بنبعتلك إعلان هون 🔔'; return; }
  if (d === 'cancel') { tgReset(c); return tgSay(c, 'تمام، لغينا الطلب 👍\nالأزرار تحت بترجعك لأي مكان 👇', tgKeys()); }
  let k;
  if (/^(un)?mute(:h)?$/.test(d)) { c.alert = '👍'; return; }   // buttons on old announcements
  if ((k = d.match(/^g:(.+)$/))) return tgProduct(c, k[1]);   // the grid turns into the product's durations
  if ((k = d.match(/^v:(.+):(\d+)$/))) return tgVariant(c, k[1], k[2], false);   // from the product page: the same picture, the card's words
  if ((k = d.match(/^dv:(.+):(\d+)$/))) return tgVariant(c, k[1], k[2], false, true); // from the offers: the product's picture comes in
  if ((k = d.match(/^vb:(.+):(\d+)$/))) return tgVariant(c, k[1], k[2], false);  // « رجوع from the order: back to the card
  if ((k = d.match(/^b:([^:]+)(?::(\d+))?$/))) return tgBuy(c, k[1], k[2]);
  if ((k = d.match(/^av:(.+)$/))) return tgAdminView(c, k[1]);
  if ((k = d.match(/^ap:(.+)$/))) return tgAdminSet(c, k[1], 'paid');
  if ((k = d.match(/^axy:(.+)$/))) return tgAdminSet(c, k[1], 'cancelled');
  if ((k = d.match(/^ax:(.+)$/))) return tgAdminAskReject(c, k[1]);
  if ((k = d.match(/^ad:(.+)$/))) return tgAdminAskDeliver(c, k[1]);
  if ((k = d.match(/^rn:(.+)$/))) return tgRenew(c, k[1]);
  if (d === 'ref') return tgRefView(c);
  if (d === 'wp') return tgWalletPay(c);
  if (d === 'adm') return tgAdminPanel(c);
  if (d === 'admw') return tgAdminPanel(c, 'month');
  if (d === 'adms') return tgAdminSoon(c);
  if (d === 'nk') { const x = tgPick(c), k2 = x ? x.p.plans.indexOf(x.pl) : -1; c.msgId = 0; return x && k2 >= 0 ? tgPlan(c, x.p.id, k2) : tgGrid(c, true); }
  if (d === 'nl') { return tgShow(c, 'تمام 👍 طلبك محفوظ، كمّله وقت ما بدك من «🛍 المنتجات».', []); }
  if (d === 'nn') { await c.fs.commit([tgUSet(c, { noNudge: 1 })]); return tgShow(c, '🔕 تمام، ما رح نبعتلك تذكير زي هيك.', []); }
  if ((k = d.match(/^qr:(.+)$/))) return tgUsdtQr(c, k[1]);
  if ((k = d.match(/^ai:(.+)$/))) return tgAdminAskInfo(c, k[1]);
  if ((k = d.match(/^fq:(\d+)$/))) return tgFaq(c, k[1]);
  if ((k = d.match(/^hs:([ospq])$/))) return tgHelpType(c, k[1]);
  if ((k = d.match(/^ho:([os]):(.+)$/))) return tgHelpAsk(c, k[1], k[2]);
  if ((k = d.match(/^hc:(.+)$/))) { c.S = { help: { tk: k[1] } }; c.dirty = true; return tgSay(c, '✍️ اكتب ردّك برسالة وحدة 👇', [[tgBtn('❌ إلغاء', 'hx')]]); }
  if ((k = d.match(/^hr:(.+)$/)) && tgIsAdmin(c)) { c.S = { hrep: k[1] }; c.dirty = true; return tgSay(c, '✍️ اكتب ردّك على الزبون برسالة وحدة 👇', [[tgBtn('❌ إلغاء', 'hrx')]]); }
  if ((k = d.match(/^rvt:(.+)$/))) { c.S = { rvw: k[1] }; c.dirty = true; return tgShow(c, '✍️ اكتب رأيك هون برسالة وحدة 👇', []); }
  if ((k = d.match(/^rv:(.+):([1-5])$/))) return tgRate(c, k[1], k[2]);
  if ((k = d.match(/^nt:(.+):(\d+)$/))) return tgNotifyMe(c, k[1], k[2]);
  if ((k = d.match(/^sp:(.+)$/))) return tgSalePlan(c, k[1]);
  if ((k = d.match(/^sk:(.+):(\d+)$/))) return tgSalePrice(c, k[1], k[2]);
  if ((k = d.match(/^sh:(\d+)$/))) return tgSalePreview(c, +k[1]);
  if ((k = d.match(/^sx:(.+)$/))) return tgSaleStop(c, k[1]);
  if ((k = d.match(/^ps:(.+)$/))) return tgPostPlans(c, k[1]);
  if ((k = d.match(/^si:(.+)$/))) return tgSetIconAsk(c, k[1]);
  if ((k = d.match(/^pp:(.+):(\d+|a)$/))) return tgPostPreview(c, k[1], k[2]);
  if ((k = d.match(/^pc:(.+):(\d+|a):([uca])$/))) return tgPostSend(c, k[1], k[2], k[3]);
  if ((k = d.match(/^pc:(.+):(\d+|a)$/))) return tgPostSend(c, k[1], k[2], 'u'); // buttons from before the channel
  if ((k = d.match(/^pfs:([uca])$/))) return tgFreeSend(c, k[1]);
  if ((k = d.match(/^p:(.+)$/))) return tgProduct(c, k[1]);
  if ((k = d.match(/^pl:(.+):(\d+)$/))) return tgPlan(c, k[1], k[2]);
  if ((k = d.match(/^m:(.+)$/))) return tgMethod(c, k[1]);
  if ((k = d.match(/^o:(.+)$/))) return tgOrder(c, k[1]);
  if ((k = d.match(/^chk:(.+)$/))) return tgCheck(c, k[1]);
  const step = (c.S.q || [])[0];
  if (!step) { c.alert = 'هالزر قديم، ابدأ من جديد'; return tgHome(c, true); }
  if (d === 'skip' && step[0] === 'a') return tgNext(c);
  if ((k = d.match(/^ao:(\d+)$/)) && step[0] === 'a') {
    const x = tgPick(c), a = x && (x.p.ask || [])[+step.slice(1)], o = a && a.o && a.o[+k[1]];
    if (o == null) return;
    c.S.ans = { ...(c.S.ans || {}), [step.slice(1)]: String(o) };
    return tgNext(c);
  }
  if ((k = d.match(/^net:(bsc|tron)$/)) && step === 'net') { c.S.net = k[1]; c.S.q.shift(); c.dirty = true; return tgFinish(c); }
}

async function tgOnMessage(c, m) {
  const text = String(m.text || m.caption || '').trim();
  const cmd = text.match(/^\/(\w+)(?:@\w+)?(?:\s+(.+))?$/);
  const key = !m.photo && TG_KEY_GO[text];
  if (key) { // one of the keys under the chat: a new screen under it (whatever was half done stops)
    if (Object.keys(c.S).length) tgReset(c);
    c.msgId = 0;
    if (key === 'prods') return tgGrid(c, true);
    if (key === 'deals') return tgDealsView(c);
    if (key === 'orders') return tgOrders(c);
    if (key === 'subs') return tgMySubs(c);
    if (key === 'sup') return tgSupport(c);
    return tgHelp(c);
  }
  if (!cmd && c.S.help) return tgHelpGot(c, m);
  if (!cmd && c.S.hrep && tgIsAdmin(c) && text) return tgHelpReply(c, text);
  if (!cmd && c.S.free === 'wait' && tgIsAdmin(c)) return tgFreeGot(c, m);
  if (!cmd && c.S.seticon && tgIsAdmin(c)) return tgSetIconGot(c, m);
  if (!cmd && c.S.dlv && tgIsAdmin(c)) return text ? tgAdminDeliver(c, text) : tgSay(c, 'ابعت تفاصيل التسليم كنص 🙏', [[tgBtn('❌ إلغاء', 'adx')]]);
  if (!cmd && c.S.sale && !c.S.sale.price && tgIsAdmin(c)) return tgSaleGotPrice(c, text);
  if (!cmd && c.S.rvw && text) return tgRateText(c, text);
  if (cmd) {
    const name = cmd[1].toLowerCase();
    if (['start', 'products', 'shop', 'orders', 'help', 'post', 'support', 'subs'].includes(name)) tgReset(c);
    if (name === 'support') { c.msgId = 0; return tgSupport(c); }
    if (name === 'subs') { c.msgId = 0; return tgMySubs(c); }
    if (name === 'post') return tgPostMenu(c);
    if (name === 'pending') { tgReset(c); return tgAdminPending(c); }
    if (name === 'admin' || name === 'dash') { tgReset(c); c.msgId = 0; return tgAdminPanel(c); }
    if (name === 'invite' || name === 'ref') { tgReset(c); c.msgId = 0; return tgRefView(c); }
    if (name === 'start' && cmd[2] && /^l_[A-Za-z0-9]{8,40}$/.test(cmd[2])) return tgLinkUse(c, cmd[2].slice(2));
    if (name === 'start' && cmd[2] && /^r_[a-z0-9]{1,14}$/.test(cmd[2])) await tgRefStart(c, cmd[2].slice(2));
    if (name === 'channel') { tgReset(c); return tgChanCheck(c); }
    if (name === 'sale') { tgReset(c); c.msgId = 0; return tgSaleMenu(c); }
    if (name === 'seticon' || name === 'seticons') { tgReset(c); return tgSetIconMenu(c); }
    if (name === 'icons') return tgIconsMake(c, String(cmd[2] || '').trim().toLowerCase());
    if (name === 'start' && cmd[2] && /^v_[A-Za-z0-9_-]+_\d+$/.test(cmd[2])) { const m2 = cmd[2].match(/^v_(.+)_(\d+)$/); return tgVariant(c, m2[1], m2[2], true); }
    if (name === 'start' && cmd[2] && /^p_[A-Za-z0-9_-]+$/.test(cmd[2])) return tgProduct(c, cmd[2].slice(2), true);
    if (name === 'start' && cmd[2] === 'shop') return tgGrid(c, true);
    if (name === 'start') return tgHome(c, true);
    if (name === 'products' || name === 'shop') return tgGrid(c, true);
    if (name === 'orders') { c.msgId = 0; return tgOrders(c); }
    if (name === 'help') return tgHelp(c);
  }
  const step = (c.S.q || [])[0];
  if (!step) return tgSearch(c, text);
  if (step === 'proof') {
    const photos = m.photo || (m.document && /^image\//.test(m.document.mime_type || '') ? [{ file_id: m.document.file_id, width: 0 }] : null);
    if (photos) {
      const img = await tgPhoto(c.env, photos);
      if (!img) return tgSay(c, 'ما قدرنا نفتح الصورة، ابعتها كمان مرة أو اكتب رقم العملية.');
      c.S.proofImg = img;
      if (text) c.S.proofText = text.slice(0, 120);
      await tgSay(c, '✓ وصلنا سكرين التحويل');
      return tgNext(c);
    }
    if (text.replace(/\s/g, '').length < 3) return tgSay(c, 'ابعت سكرين التحويل كصورة، أو اكتب رقم العملية / الرقم اللي حوّلت منه.');
    c.S.proofText = text.slice(0, 120);
    return tgNext(c);
  }
  if (step[0] === 'a') {
    const x = tgPick(c), a = x && (x.p.ask || [])[+step.slice(1)];
    if (a && a.o && a.o.length) return tgSay(c, 'اختار من الأزرار اللي فوق 👆');
    if (!text) return tgSay(c, 'اكتب الجواب برسالة نصية.');
    c.S.ans = { ...(c.S.ans || {}), [step.slice(1)]: text.slice(0, 300) };
    return tgNext(c);
  }
  if (step === 'email') {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(text)) return tgSay(c, 'الإيميل مش مزبوط، اكتبه كمان مرة (مثلاً name@gmail.com).');
    c.S.email = text.slice(0, 100);
    return tgNext(c);
  }
  if (step === 'phone') {
    if (m.contact && m.contact.phone_number) c.S.phone = '+' + String(m.contact.phone_number).replace(/\D/g, '');
    else if (text === 'تخطّي' || text === 'تخطي') c.S.phone = '';
    else if (text.replace(/\D/g, '').length >= 9) c.S.phone = text.replace(/[^\d+]/g, '').slice(0, 20);
    else return tgSay(c, 'اضغط «📱 شارك رقمي» تحت، أو «تخطّي».');
    await tgSay(c, 'تمام ✓', tgKeys());
    return tgNext(c);
  }
  return tgAsk(c);
}

async function tgSearch(c, text) {
  const words = tgNorm(text).split(' ').filter(Boolean);
  if (!words.length) return tgHome(c, true);
  const cats = c.data.settings.categories || [];
  const hits = c.data.products.filter(p => {
    const cat = cats.find(x => x.id === p.cat);
    const hay = tgNorm([p.name, p.keywords, p.desc, cat && cat.name, ...(p.plans || []).map(x => x.name)].join(' '));
    return words.every(w => hay.includes(w));
  }).slice(0, 10);
  if (!hits.length) return tgSay(c, `ما لقينا «${esc(text.slice(0, 40))}» 🤔\nاسألنا وبنجيبلك أي اشتراك مش موجود.`, [[tgUrl('💬 اسألنا', tgSup(c))], [tgBtn('🛒 كل المنتجات', 'prods')]]);
  c.msgId = 0;
  if (hits.length === 1) return tgProduct(c, hits[0].id, true);
  return tgSay(c, `🔎 لقينا ${hits.length} اشتراكات لـ «${esc(text.slice(0, 40))}» 👇`, [...tgRows(hits.map(p => tgPBtn(c.data, p, 'g:' + p.id)), 2), [tgBtn('🛒 كل المنتجات', 'prods')]]);
}

async function tgPhoto(env, photos) {
  const pick = photos.filter(p => !p.width || p.width <= 900).pop() || photos[0];
  const f = await tg(env, 'getFile', { file_id: pick.file_id });
  if (!f || !f.file_path || (f.file_size && f.file_size > 450e3)) return null;
  const r = await xf('https://api.telegram.org/file/bot' + env.SHOP_BOT_TOKEN + '/' + f.file_path);
  if (!r.ok) return null;
  const bytes = new Uint8Array(await r.arrayBuffer());
  if (bytes.length > 450e3) return null;
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  const type = /\.png$/i.test(f.file_path) ? 'image/png' : 'image/jpeg';
  return 'data:' + type + ';base64,' + btoa(s);
}
function tgOrderNo() { return 'HZ-' + (10000 + Math.floor(Math.random() * 90000)); }
function tgDocId() { const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', r = crypto.getRandomValues(new Uint8Array(20)); return 'tg' + [...r].map(b => a[b % a.length]).join('').slice(0, 18); }

async function tgFinish(c) {
  const x = tgPick(c), m = tgMethods(c).find(y => y.key === c.S.method);
  if (!x || !m) { tgReset(c); return tgSay(c, 'انتهت صلاحية الطلب، ابدأ من جديد 🙏', [[tgBtn('🛒 المنتجات', 'prods')]]); }
  const { fs, env } = c, auto = isUsdt(m) && !!m.auto, id = tgDocId(), no = tgOrderNo();
  const info = (x.p.ask || []).map((a, k) => { const v = String((c.S.ans || {})[k] || '').trim(); return v ? a.l + ': ' + v : ''; }).filter(Boolean).join(' | ').slice(0, 600);
  const item = { productId: x.p.id, productName: tgClean(x.p.name).slice(0, 100), planId: x.pl.id, planName: tgClean(x.pl.name || '').slice(0, 60), price: +x.pl.price, qty: 1 };
  if (info) item.info = info;
  const user = c.from.username || '', deal = await tgDeal(c, x.pl.price), u = await tgU(c);
  const order = { orderNo: no, items: [item], total: deal.total, customer: tgWho(c.from), phone: c.S.phone || '', email: c.S.email || '', payment: String(m.name).slice(0, 60),
    proofText: auto ? '' : String(c.S.proofText || ''), proofImage: auto ? '' : String(c.S.proofImg || ''), status: 'pending', source: 'telegram', tgChat: c.chat, tgUser: user };
  if (c.S.renew) order.renewOf = String(c.S.renew);
  if (u.uid) order.uid = u.uid;
  Object.assign(order, tgDealFields(deal, u));
  await fs.commit([
    fs.wUpdate('orders/' + id, order, null, { exists: false }, [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }]),
    fs.wUpdate('payState/main', { tg: { [id]: Date.now() + 10 * 864e5 } }, ['tg.' + fp(id)]),
    ...tgDealWrites(c, deal),
  ]);
  const img = c.S.proofImg || '', net = c.S.net || (validAddr('bsc', m.number) ? 'bsc' : 'tron');
  c.S = {}; c.dirty = true;
  if (auto) {
    let p;
    try { p = await start(fs, env, { kind: 'order', id, net }); }
    catch (e) { return tgSay(c, `انسجل طلبك <code>${no}</code>، بس ما قدرنا نجهّز دفع USDT هلأ 🙏\nكلّمنا على الدعم وبنكمّل معك.`, [[tgUrl('💬 كلّمنا', tgSup(c))]]); }
    if (p.status !== 'pending' || !p.amt) return tgOrder(c, id, true);
    const po = { orderNo: no, pay: { net: p.net, amt: p.amt, addr: p.addr, exp: p.exp || Date.now() + PAY_MIN * 60e3 } }, now = Date.now();
    const r = await tgSay(c, tgUsdtText(po, now), tgUsdtKb(po, id, now));
    if (r && r.message_id) await fs.commit([fs.wUpdate('orders/' + id, { tgPayMsg: r.message_id, tgPayM: tgUsdtMins(po, now) }, ['tgPayMsg', 'tgPayM'], { exists: true })]).catch(() => {});
    return r;
  }
  const d = { ...order };
  await notifyAdmin(env, '🤖 طلب جديد من بوت تيليجرام ' + no, [...itemLines(d), 'المجموع: ' + money(d.total), 'الدفع: ' + d.payment, d.proofText ? 'الإثبات: ' + d.proofText : img ? 'الإثبات: سكرين (مبعوت تحت)' : '', 'الزبون: ' + d.customer + (user ? ' · @' + user : '') + (d.phone ? ' · ' + d.phone : ''), d.email ? 'الإيميل: ' + d.email : '', info ? 'تفاصيل: ' + info : '', 'الحالة: بانتظار تأكيدك للحوالة'].filter(Boolean), SITE + '/admin.html').catch(e => console.error('notify', e && e.message));
  const toAdmins = await tgAdminNotify(fs, env, id, order, order.renewOf ? '🔄 <b>تجديد من البوت</b>' : '🆕 <b>طلب جديد من البوت</b>').catch(() => 0);
  if (!toAdmins && img && env.TG_TOKEN && env.TG_CHAT) {
    try {
      const b = atob(img.split(',')[1] || ''), bytes = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
      const fd = new FormData();
      fd.append('chat_id', String(env.TG_CHAT)); fd.append('caption', 'سكرين الحوالة · ' + no + ' · ' + money(d.total));
      fd.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'proof.jpg');
      await xf('https://api.telegram.org/bot' + env.TG_TOKEN + '/sendPhoto', { method: 'POST', body: fd });
    } catch (e) { console.error('proof photo', e && e.message); }
  }
  const q = await tgQueue(fs, id, Date.now()).catch(() => null);
  const r = await tgSay(c, tgQueueText({ ...d, createdAt: Date.now() }, q), tgQueueKb(c.data, id));
  if (r && r.message_id && q) await fs.commit([fs.wUpdate('orders/' + id, { tgQMsg: r.message_id, tgQPos: q.pos }, ['tgQMsg', 'tgQPos'], { exists: true })]).catch(() => {});
  return r;
}

function tgStatus(o) {
  if (o.status === 'pending') return /usdt/i.test(o.payment || '') && o.pay ? '⏳ بانتظار دفعة USDT' : '⏳ بنتأكد من الدفع';
  if (o.status === 'paid') return '🔧 تأكد الدفع، قيد التفعيل';
  if (o.status === 'done') return '✅ تم التسليم';
  if (o.status === 'cancelled') return '❌ ملغي';
  return o.status || '';
}
// an order step by step: received → paid → being activated → delivered
function tgTrack(o) {
  const it = (o.items || [])[0] || {}, st = o.status, usdt = /usdt/i.test(o.payment || '') && o.pay;
  const at = x => +x ? ` <i>· ${tgWhen(+x, true)}</i>` : '';
  const L = [`📦 <b>طلب</b> <code>${esc(o.orderNo || '')}</code>`, `<i>${esc(it.productName || '')}${it.planName ? ' · ' + esc(it.planName) : ''} · ${tgN(o.total)} ₪</i>`, ''];
  if (st === 'cancelled') { L.push('❌ <b>انلغى هالطلب</b>'); if (o.cancelNote) L.push(`<i>${esc(String(o.cancelNote).slice(0, 120))}</i>`); return L.join('\n'); }
  const k = st === 'done' ? 4 : st === 'paid' ? 2 : 1;
  L.push(`✅ استلمنا طلبك${at(o.createdAt)}`);
  L.push(k >= 2 ? `✅ تأكد الدفع${at(o.paidAt)}` : `⏳ <b>${usdt ? 'بانتظار دفعة USDT' : 'بنتأكد من الدفع'}…</b>`);
  L.push(k >= 4 ? '✅ تفعّل الاشتراك' : k === 2 ? '⏳ <b>عم نفعّلك هلأ…</b>' : '▫️ التفعيل');
  L.push(k >= 4 ? `✅ تسلّمت${at(o.doneAt)}` : '▫️ تسلّمت');
  const hint = k === 4 ? 'تمام! التفاصيل تحت 👇' : k === 2 ? 'غالباً بيخلص خلال دقائق' : usdt ? 'بيتأكد لحاله أول ما توصل الدفعة' : 'بنراجع الحوالة وبنبلّغك هون';
  L.push(`<blockquote>${'▰'.repeat(k)}${'▱'.repeat(4 - k)}  ${k} من 4 · ${hint}</blockquote>`);
  if (k < 4) L.push('🔔 بنبعتلك رسالة هون أول ما يتحرّك طلبك.');
  return L.join('\n');
}
async function tgOrders(c) {
  const rows = (await c.fs.query('orders', [['tgChat', 'EQUAL', c.chat]], 30)).sort((a, b) => (+b.data.createdAt || 0) - (+a.data.createdAt || 0)).slice(0, 6);
  if (!rows.length) return tgView(c, { text: '📦 <b>طلباتي</b>\nلسا ما عندك طلبات من البوت.\nاختار اشتراكك وبيطلع طلبك هون 👇', kb: [[{ ...tgBtn('🛍 تصفّح الاشتراكات', 'prods'), style: 'primary' }], [tgBtn('🏠 الرئيسية', 'home')]] });
  const text = '📦 <b>طلباتك</b>\n' + rows.map(r => { const o = r.data, it = (o.items || [])[0] || {}; return `<blockquote>🧾 <code>${esc(o.orderNo || '')}</code> · ${esc(it.productName || '')}${it.planName ? ' · ' + esc(it.planName) : ''}\n${tgStatus(o)}</blockquote>`; }).join('') + '\nاكبس على طلب تشوف وين وصل 👇';
  return tgView(c, { text, kb: [...rows.map(r => { const it = (r.data.items || [])[0] || {}; return [tgBtn(`${tgStatus(r.data).split(' ')[0]} ${r.data.orderNo || ''} · ${tgClean(it.productName || '').slice(0, 22)}`, 'o:' + r.id)]; }), [tgBtn('🏠 الرئيسية', 'home')]] });
}
async function tgOrder(c, id, fresh) {
  const doc = await c.fs.get('orders/' + id);
  if (!doc || doc.data.tgChat !== c.chat) { c.alert = 'ما لقينا هالطلب'; return; }
  const o = doc.data;
  let text = tgTrack(o);
  if (o.status === 'done') {
    if (o.delivery) text += `\n\n<b>تفاصيل التفعيل:</b>\n<pre>${esc(String(o.delivery).slice(0, 3000))}</pre>`;
    if (Array.isArray(o.stockIds) && o.stockIds.length) for (const k of await readCodes(c.fs, o)) text += `\n\n<b>${esc(k.name)}</b>\n<pre>${esc(k.value)}</pre>`;
  }
  const kb = [];
  if (o.status === 'pending' && o.pay && o.pay.amt) {
    text += `\n\n🪙 حوّل بالضبط <code>${o.pay.amt}</code> USDT على ${o.pay.net === 'tron' ? 'TRC20' : 'BEP20'}:\n<code>${esc(o.pay.addr || '')}</code>`;
    kb.push([tgCopy('📋 انسخ المبلغ', o.pay.amt), tgCopy('📋 انسخ العنوان', o.pay.addr || '')], [{ ...tgBtn('🔄 حوّلت، افحص الدفع', 'chk:' + id), style: 'success' }]);
  } else if (o.status === 'pending' || o.status === 'paid') kb.push([tgBtn('🔄 تحديث', 'o:' + id)]);
  const nb = o.status === 'paid' && !o.email ? tgNeedBlock(c.data.settings, o) : null;
  if (nb) { text += '\n\n' + nb.text; kb.unshift(...nb.kb); }
  kb.push([tgBtn('« طلباتي', 'orders'), tgUrl('💬 الدعم', tgSup(c))]);
  return tgView(c, { text, kb }, fresh);
}
async function tgCheck(c, id) {
  const doc = await c.fs.get('orders/' + id);
  if (!doc || doc.data.tgChat !== c.chat) { c.alert = 'ما لقينا هالطلب'; return; }
  let r;
  try { r = await check(c.fs, c.env, { kind: 'order', id }, null); } catch (e) { c.alert = 'ما قدرنا نفحص هلأ، جرّب بعد دقيقة'; return; }
  if (r.status === 'pending') {
    c.alert = r.expired ? 'انتهى وقت هالدفعة. إذا حوّلت كلّمنا على الدعم برقم الطلب.' : 'لسا ما وصلت الدفعة. بعد ما تحوّل استنى دقيقة وجرّب، أو خلّيها علينا وبنبلّغك هون أول ما توصل.';
    const o = doc.data, now = Date.now();
    if (o.pay && o.pay.amt && c.msgId && c.msgId === +o.tgPayMsg) await tgCall(c.env, 'editMessageText', { chat_id: c.chat, message_id: c.msgId, text: tgUsdtText(o, now), parse_mode: 'HTML', disable_web_page_preview: true }, tgUsdtKb(o, id, now));
    return;
  }
  const now = await c.fs.get('orders/' + id);
  if (now) await tgNotifyStatus(c.fs, c.env, id, now.data);
}

// tell the customer about the order's new status (once per status; the delivery text once per change)
async function tgNotifyStatus(fs, env, id, d, dlvSig) {
  if (!TGC.products) await tgData(fs).catch(() => {});
  await tgCardsFollow(fs, env, id, d).catch(e => console.error('cards', e && e.message));
  await tgRefSettle(fs, env, id, d).catch(e => console.error('ref', e && e.message));
  const no = `<code>${esc(d.orderNo || '')}</code>`, kb = [];
  let text = '';
  const sup = 'https://t.me/' + (tgUserName(TGC.settings && TGC.settings.tgSupport) || 'hazemstoresupport');
  let photo = '', rate = false;
  if (d.status === 'paid') {
    const nb = tgNeedBlock(TGC.settings, d);
    text = `✅ <b>تأكد دفعك!</b>\n\n${tgTrack(d)}` + (nb ? '\n\n' + nb.text : '');
    if (nb) kb.push(...nb.kb, [tgBtn('🔄 تحديث', 'o:' + id)]);
    else kb.push([tgBtn('🔄 تحديث', 'o:' + id), tgUrl('💬 الدعم', sup)]);
  }
  else if (d.status === 'done') {
    const it = (d.items || [])[0] || {}, L = [`🎉 <b>اشتراكك جاهز!</b>`, `<b>${esc(it.productName || '')}${it.planName ? ' · ' + esc(it.planName) : ''}</b> · ${no}`];
    let box = '';
    if (d.delivery) box += `<pre>${esc(String(d.delivery).slice(0, 3000))}</pre>`;
    if (Array.isArray(d.stockIds) && d.stockIds.length) for (const k of await readCodes(fs, d)) box += `\n<b>${esc(k.name)}</b>\n<pre>${esc(k.value)}</pre>`;
    if (box) L.push('', '<b>تفاصيل التفعيل:</b>', box.trim());
    const end = TGC.products ? tgItemEnd(d, it, TGC.products) : 0;
    if (end > Date.now()) L.push('', `📅 بينتهي تقريباً: <b>${tgWhen(end)}</b>`, '🔔 بنذكّرك قبل ما يخلص بـ 3 أيام عشان تجدّد.');
    L.push('', 'احفظ التفاصيل عندك، ولأي إشي كلّمنا برقم الطلب 🤍');
    rate = !d.tgRate && !d.renewOf;
    if (rate) { L.push('', '⭐ <b>كيف كانت تجربتك؟</b> قيّمنا بكبسة 👇'); kb.push([1, 2, 3, 4, 5].map(n => ({ text: n + '⭐', callback_data: `rv:${id}:${n}`, ...(n === 5 ? { style: 'success' } : {}) }))); }
    kb.push([tgBtn('🛍 اشتراك جديد', 'prods'), tgBtn('📦 طلباتي', 'orders')]);
    text = L.join('\n');
    photo = await tgBan('done');
  } else if (d.status === 'cancelled') { text = `❌ <b>انلغى طلبك</b> ${no}${d.cancelNote ? '\n<i>' + esc(String(d.cancelNote).slice(0, 160)) + '</i>' : ''}\nإذا في أي سؤال كلّمنا 🤍`; kb.push([tgUrl('💬 كلّمنا', sup)]); }
  if (!text) return false;
  const mk = kb.length ? { reply_markup: { inline_keyboard: kb } } : {};
  let sent = photo && tgLen(text) <= 1024 ? await tg(env, 'sendPhoto', { chat_id: d.tgChat, photo: TGPH[photo] || photo, caption: text, parse_mode: 'HTML', ...mk }) : null;
  if (sent) tgKeepPh(photo, sent);
  else sent = await tg(env, 'sendMessage', { chat_id: d.tgChat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...mk });
  if (!sent) return false;
  const f = { tgSent: d.status }, mask = ['tgSent'];
  if (rate) { f.tgRate = 1; mask.push('tgRate'); }
  if (dlvSig || (d.status === 'done' && d.delivery)) { f.dlvTg = dlvSig || (String(d.deliveredAt || '') + ':' + String(d.delivery).length); mask.push('dlvTg'); }
  await fs.commit([fs.wUpdate('orders/' + id, f, mask, { exists: true })]);
  return true;
}
// cron: has a bot order moved on since we last told the customer?
async function tgFollow(fs, env, id, exp) {
  const doc = await fs.get('orders/' + id);
  if (!doc || !doc.data.tgChat) return 'drop';
  const d = doc.data, st = d.status;
  if (st === 'done' && !d.delivery && !(d.stockIds && d.stockIds.length) && Date.now() - (+d.doneAt || 0) < 3 * 60e3) return 'keep'; // the delivery text may still be on its way
  if (st !== d.tgSent && (st === 'paid' || st === 'done' || st === 'cancelled')) await tgNotifyStatus(fs, env, id, d);
  else if (st === 'pending') await tgLive(fs, env, id, d).catch(e => console.error('live', e && e.message));
  if (st === 'done' || st === 'cancelled' || Date.now() > (+exp || 0)) return 'drop';
  return 'keep';
}

// ---------------------------------------------------------------- B1: orders in Hazem's hands from Telegram
// Every admin who talks to the bot is remembered (tgMeta/admins), and new orders reach them here with
// the payment screenshot and buttons: confirm payment, reject, deliver (type the details → the customer gets them).
async function tgAdminChats(fs) {
  if (TGC && TGC.admins && Date.now() - TGC.at < TGC_MS) return Object.keys(TGC.admins);
  const d = await fs.get('tgMeta/admins');
  return Object.keys((d && d.data.chats) || {});
}
const TG_SRC = { site: 'الموقع', wallet: 'الموقع (من الرصيد)', telegram: 'البوت', manual: 'تسجيل يدوي' };
function tgAdminCard(o, id, head) {
  const it = (o.items || [])[0] || {}, more = (o.items || []).length > 1 ? ` + ${(o.items || []).length - 1}` : '';
  const L = [head ? head + ` <code>${esc(o.orderNo || '')}</code>` : `<b>طلب</b> <code>${esc(o.orderNo || '')}</code>`];
  L.push(`📦 ${esc(it.productName || '')}${it.planName ? ' · ' + esc(it.planName) : ''}${more}`);
  L.push(`💵 ${tgN(o.total)} ₪ · ${esc(o.payment || '')}`);
  L.push(`👤 ${esc(o.customer || '')}${o.tgUser ? ' · @' + esc(o.tgUser) : ''}${o.phone ? ' · <code>' + esc(o.phone) + '</code>' : ''}`);
  if (o.email) L.push(`📧 ${esc(o.email)}`);
  if (it.info) L.push(`📝 ${esc(String(it.info).slice(0, 300))}`);
  const need = o.status === 'pending' || o.status === 'paid' ? tgNeeds(TGC.products, o) : [];
  if (need.length && !o.email) L.push(`📩 اطلب منه بعد الدفع: ${esc(need.join('، '))}`);
  if (o.proofText) L.push(`🧾 ${esc(String(o.proofText).slice(0, 200))}`);
  if (+o.walletPart > 0) L.push(`👛 من رصيده: ${tgN(o.walletPart)} ₪`);
  L.push(`🌐 من ${TG_SRC[o.source] || esc(o.source || 'الموقع')} · الحالة: ${tgStatus(o)}`);
  const kb = [];
  if (o.status === 'pending') kb.push([{ ...tgBtn('✅ تأكيد الدفع', 'ap:' + id), style: 'success' }, { ...tgBtn('❌ رفض', 'ax:' + id), style: 'danger' }]);
  if (o.status === 'pending' || o.status === 'paid') kb.push([tgBtn('📝 سلّم وابعت التفاصيل', 'ad:' + id)]);
  if (o.status === 'paid') kb.push([{ ...tgBtn('❌ رفض', 'ax:' + id), style: 'danger' }]);
  if (o.status === 'paid' && o.tgChat && tgNeeds(TGC.products, o).length) kb.push([tgBtn('📩 ذكّره يبعت التفاصيل', 'ai:' + id)]);
  const contact = o.tgUser ? 'https://t.me/' + tgUserName(o.tgUser) : '';
  kb.push([tgBtn('🔄 حدّث', 'av:' + id), ...(contact ? [tgUrl('💬 راسل الزبون', contact)] : [])]);
  return { text: L.join('\n'), kb };
}
// a new order (or a USDT payment) → every admin, with the screenshot when there is one
async function tgAdminNotify(fs, env, id, o, head) {
  if (!env.SHOP_BOT_TOKEN) return 0;
  const chats = (await tgAdminChats(fs)).slice(0, 3);
  if (!chats.length) return 0;
  if (!TGC.products) await tgData(fs).catch(() => {});
  const card = tgAdminCard(o, id, head);
  const img = String(o.proofImage || ''), bytes = img.startsWith('data:image') ? tgB64(img) : null;
  let n = 0;
  for (const chat of chats) {
    if (BUDGET < 3) break;
    if (bytes && card.text.length <= 1000) {
      const fd = new FormData();
      fd.append('chat_id', String(chat)); fd.append('caption', card.text); fd.append('parse_mode', 'HTML');
      fd.append('reply_markup', JSON.stringify(tgMarkup(card.kb).reply_markup));
      fd.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'proof.jpg');
      const r = await xf(TGB + env.SHOP_BOT_TOKEN + '/sendPhoto', { method: 'POST', body: fd }).catch(() => null);
      if (r && r.ok) { n++; continue; }
    }
    if (await tg(env, 'sendMessage', { chat_id: chat, text: card.text, parse_mode: 'HTML', disable_web_page_preview: true, ...tgMarkup(card.kb) })) n++;
  }
  return n;
}
function tgB64(dataUrl) {
  try { const b = atob(String(dataUrl).split(',')[1] || ''), u = new Uint8Array(b.length); for (let i = 0; i < b.length; i++) u[i] = b.charCodeAt(i); return u; } catch (e) { return null; }
}
// wallet money moves only through the admin page, so those orders are finished there
function tgWalletOnly(o, act) {
  if (act === 'deliver') return !!(o.walletDue && +o.walletPart > 0 && o.uid);
  return o.source === 'wallet' || (+o.walletPart > 0 && o.uid && !o.walletDue && !o.walletRefunded);
}
async function tgAdminView(c, id, note) {
  if (!tgIsAdmin(c)) return;
  const doc = await c.fs.get('orders/' + id);
  if (!doc) { c.alert = 'ما لقينا هالطلب'; return; }
  const card = tgAdminCard(doc.data, id, note || '');
  return tgShow(c, card.text, card.kb, true);
}
async function tgAdminSet(c, id, status) {
  if (!tgIsAdmin(c)) return;
  const doc = await c.fs.get('orders/' + id);
  if (!doc) { c.alert = 'ما لقينا هالطلب'; return; }
  const o = doc.data;
  if (status === 'paid' && o.status !== 'pending') { c.alert = 'هالطلب صار: ' + tgStatus(o); return tgAdminView(c, id); }
  if (status === 'cancelled' && (o.status === 'done' || o.status === 'cancelled')) { c.alert = 'هالطلب صار: ' + tgStatus(o); return tgAdminView(c, id); }
  if (status === 'cancelled' && tgWalletOnly(o, 'cancel')) { c.alert = 'هالطلب مدفوع من رصيد الزبون: ألغيه من لوحة الأدمن عشان يرجعله المبلغ'; return; }
  try { await c.fs.commit([c.fs.wUpdate('orders/' + id, { status }, ['status'], { updateTime: doc.updateTime }, status === 'paid' ? [{ fieldPath: 'paidAt', setToServerValue: 'REQUEST_TIME' }] : undefined)]); }
  catch (e) { c.alert = 'تغيّر الطلب هلأ، جرّب كمان مرة'; return tgAdminView(c, id); }
  const d = { ...o, status };
  if (d.tgChat) await tgNotifyStatus(c.fs, c.env, id, d).catch(() => {});
  c.alert = status === 'paid' ? '✅ تأكد الدفع' : '❌ انرفض الطلب';
  return tgAdminView(c, id, status === 'paid' ? '✅ <b>تأكد الدفع</b>' : '❌ <b>انرفض</b>');
}
function tgAdminAskReject(c, id) {
  if (!tgIsAdmin(c)) return;
  return tgShow(c, 'متأكد بدك ترفض هالطلب؟ الزبون بتوصله رسالة إنه انلغى.', [[{ ...tgBtn('❌ آه، ارفضه', 'axy:' + id), style: 'danger' }, tgBtn('« لا', 'av:' + id)]], true);
}
async function tgAdminAskDeliver(c, id) {
  if (!tgIsAdmin(c)) return;
  const doc = await c.fs.get('orders/' + id);
  if (!doc) { c.alert = 'ما لقينا هالطلب'; return; }
  if (doc.data.status === 'done' || doc.data.status === 'cancelled') { c.alert = 'هالطلب صار: ' + tgStatus(doc.data); return; }
  if (tgWalletOnly(doc.data, 'deliver')) { c.alert = 'هالطلب جزء منه من رصيد الزبون: سلّمه من لوحة الأدمن عشان ينخصم الرصيد'; return; }
  c.S = { dlv: id }; c.dirty = true; c.msgId = 0;
  return tgSay(c, `📝 اكتب تفاصيل التسليم لطلب <code>${esc(doc.data.orderNo || '')}</code>، وبتوصل للزبون فوراً.`, [[tgBtn('❌ إلغاء', 'adx')]]);
}
async function tgAdminDeliver(c, text) {
  const id = c.S.dlv; tgReset(c);
  const doc = await c.fs.get('orders/' + id);
  if (!doc) return tgSay(c, 'ما لقينا هالطلب.');
  const o = doc.data;
  if (o.status === 'done' || o.status === 'cancelled') return tgSay(c, 'هالطلب صار: ' + tgStatus(o));
  const at = Date.now();
  try { await c.fs.commit([c.fs.wUpdate('orders/' + id, { status: 'done', delivery: String(text).slice(0, 2000), deliveredAt: at, doneAt: new Date(at) }, ['status', 'delivery', 'deliveredAt', 'doneAt'], { updateTime: doc.updateTime })]); }
  catch (e) { return tgSay(c, 'تغيّر الطلب هلأ، جرّب كمان مرة.', [[tgBtn('🔄 الطلب', 'av:' + id)]]); }
  let r = {};
  try { r = await notifyDelivered(c.fs, c.env, { id }); } catch (e) { r = { sent: false }; }
  const to = o.tgChat ? 'على البوت' : r.sent ? 'على إيميله' : 'بحسابه بالموقع';
  return tgSay(c, `✅ انبعت لـ${esc(o.customer || 'الزبون')} ${to}، والطلب <code>${esc(o.orderNo || '')}</code> صار <b>تم</b>.`);
}
async function tgAdminPending(c) {
  if (!tgIsAdmin(c)) return;
  const rows = (await c.fs.query('orders', [['status', 'EQUAL', 'pending']], 30)).sort((a, b) => (+b.data.createdAt || 0) - (+a.data.createdAt || 0));
  const paid = (await c.fs.query('orders', [['status', 'EQUAL', 'paid']], 20));
  const all = [...paid, ...rows].slice(0, 12);
  if (!all.length) return tgSay(c, '👌 ما في طلبات معلّقة هلأ.');
  c.msgId = 0;
  return tgSay(c, `⏳ <b>الطلبات المعلّقة</b> (${all.length})`, all.map(r => [tgBtn(`${r.data.orderNo || ''} · ${tgClean((r.data.items || [{}])[0].productName || '')} · ${tgN(r.data.total)} ₪${r.data.status === 'paid' ? ' · مدفوع' : ''}`, 'av:' + r.id)]));
}


// ================================================================ v22: the bot's next step
// 1 the store inside Telegram (Mini App) · 2 a home that knows you · 3 the USDT card that counts down and turns
// «وصل» by itself · 4 your place in line · 5 one nudge for an order left at the payment · 6 invite a friend ·
// 7 pay from the site balance (after linking the site account once) · 8 Hazem's panel
const TG_APP = SITE + '/app/';
function tgApp(text) { return { text, web_app: { url: TG_APP } }; }

// ---- per-customer things that must survive the chat's state (tgUsers/<chat>, written with masks only)
async function tgU(c) {
  if (c._u === undefined) { const d = await c.fs.get('tgUsers/' + c.chat).catch(() => null); c._u = d ? d.data : null; }
  return c._u || {};
}
function tgUSet(c, f, transforms) { if (c._u) Object.assign(c._u, f); return c.fs.wUpdate('tgUsers/' + c.chat, f, Object.keys(f), null, transforms); }

// ---- 2: what this customer has going on: an order in progress, a subscription ending within a week, the last one
async function tgMine(c) {
  const rows = await c.fs.query('orders', [['tgChat', 'EQUAL', c.chat]], 25).catch(() => []), now = Date.now();
  rows.sort((a, b) => (+b.data.createdAt || 0) - (+a.data.createdAt || 0));
  const act = rows.find(r => (r.data.status === 'pending' || r.data.status === 'paid') && now - (+r.data.createdAt || 0) < 5 * 864e5);
  let soon = null;
  for (const r of rows) {
    if (r.data.status !== 'done') continue;
    const it = (r.data.items || [])[0]; if (!it) continue;
    const end = tgItemEnd(r.data, it, c.data.products);
    if (!end || end < now - 864e5 || end - now > 7 * 864e5) continue;
    if (rows.some(x => x !== r && x.data.renewOf === r.id && x.data.status !== 'cancelled')) continue; // already renewed
    if (!soon || end < soon.end) {
      const p = c.data.products.find(x => x.id === it.productId), pl = p && p.plans.find(x => x.id === it.planId);
      soon = { id: r.id, it, end, days: Math.max(0, Math.ceil((end - now) / 864e5)), pl: p && pl && !p.soldOut && !pl.out ? pl : null };
    }
  }
  const lastR = rows.find(r => r.data.status === 'done'), it0 = lastR && (lastR.data.items || [])[0];
  const lp = it0 && c.data.products.find(x => x.id === it0.productId);
  const last = lp && lp.plans.some(x => x.id === it0.planId) ? { id: lastR.id } : null;
  return { act, soon, last };
}

// ---- 1: the Mini App reads the catalogue here and sends the chosen plan back to the chat
async function tgAppData(env) {
  const fs = await firestore(env), data = await tgData(fs), m = await tgBanners();
  const cats = (data.settings.categories || []).map(x => ({ id: x.id, name: tgClean(x.name) }));
  const acctT = a => a === 'login' ? 'على إيميلك الشخصي' : a === 'email' ? 'دعوة على إيميلك' : a === 'none' ? 'حساب جاهز من عندنا' : '';
  const products = data.products.map(p => ({
    id: p.id, name: tgClean(p.name), cat: p.cat || '', badge: tgClean(p.badge || ''), desc: String(p.desc || '').slice(0, 400),
    feats: (p.features || []).filter(Boolean).slice(0, 5).map(String), logo: tgLogo(p, 128) || '',
    banner: m[p.id] ? `${SITE}/bot/${p.id}.jpg?v=${m[p.id]}` : '', out: !!p.soldOut, bundle: !!p.bundle, emo: tgIcon(data, p),
    later: tgNeeds([p], { items: [{ productId: p.id, planId: (p.plans[0] || {}).id }] }).length > 0,
    plans: p.plans.map((pl, k) => ({ k, name: tgClean(pl.name), price: +pl.price, compare: +pl.compare > +pl.price ? +pl.compare : 0, out: !!(pl.out || p.soldOut), meta: [acctT(pl.acct || p.acct || ''), String(pl.tgWar || '').trim()].filter(Boolean).join(' · '), instant: !!pl.instant })).filter(x => x.price > 0),
  }));
  return { v: VERSION, store: tgClean(data.settings.storeName) || STORE, cats, products, home: m.home ? `${SITE}/bot/home.jpg?v=${m.home}` : '', pay: tgMethods({ data }).map(x => tgClean(x.name)).slice(0, 6) };
}
// Telegram signs what it hands the Mini App (initData) with the bot's token: check it before trusting the user in it
async function tgAppVerify(env, initData) {
  const p = new URLSearchParams(String(initData || '')), hash = p.get('hash');
  if (!hash || !env.SHOP_BOT_TOKEN) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => k + '=' + v).join('\n');
  const enc = new TextEncoder();
  const k1 = await crypto.subtle.importKey('raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const secret = await crypto.subtle.sign('HMAC', k1, enc.encode(env.SHOP_BOT_TOKEN));
  const k2 = await crypto.subtle.importKey('raw', secret, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = [...new Uint8Array(await crypto.subtle.sign('HMAC', k2, enc.encode(dcs)))].map(b => b.toString(16).padStart(2, '0')).join('');
  if (sig !== hash) return null;
  if (Date.now() / 1000 - (+p.get('auth_date') || 0) > 86400) return null;
  try { const u = JSON.parse(p.get('user') || 'null'); return u && u.id ? u : null; } catch (e) { return null; }
}
async function tgAppOrder(env, body) {
  const user = await tgAppVerify(env, body.initData);
  if (!user) throw fail('not from Telegram', 401);
  const c = await tgCtx(env, user.id, user, 0);
  await tgPlan(c, String(body.pid || ''), Math.max(0, +body.k || 0));
  await tgSave(c);
  return { ok: !c.alert, alert: c.alert || '' };
}

// ---- 3: the USDT card: time left (the cron edits it every 2 minutes), then «وصل» by itself
function tgMinTxt(n) { return n >= 60 && n % 60 === 0 ? (n === 60 ? 'ساعة' : n === 120 ? 'ساعتين' : n / 60 + ' ساعات') : n === 1 ? 'دقيقة' : n === 2 ? 'دقيقتين' : n <= 10 ? n + ' دقائق' : n + ' دقيقة'; }
function tgUsdtMins(o, now) { return Math.max(0, Math.ceil(((+(o.pay || {}).exp || 0) - now) / 60e3)); }
function tgUsdtText(o, now) {
  const p = o.pay || {}, mins = tgUsdtMins(o, now), frac = Math.max(0, Math.min(1, mins / PAY_MIN)), bars = Math.max(mins > 0 ? 1 : 0, Math.round(frac * 10));
  const nw = p.net === 'tron' ? 'TRC20' : 'BEP20';
  return `🪙 <b>الدفع بـ USDT</b> · طلب <code>${esc(o.orderNo || '')}</code>\n<blockquote>حوّل <b>بالضبط</b>: <code>${p.amt}</code> USDT\nالشبكة: <b>${p.net === 'tron' ? 'TRC20 (Tron)' : 'BEP20 (BNB Smart Chain)'}</b>\nالعنوان:\n<code>${esc(p.addr || '')}</code></blockquote>\n` +
    (mins > 0 ? `⏳ <b>باقي ${tgMinTxt(mins)}</b> · بنتأكد لحالنا أول ما يوصل\n${'▰'.repeat(bars)}${'▱'.repeat(10 - bars)}\n`
      : `⌛ <b>خلص الوقت</b>. إذا حوّلت اكبس «حوّلت، افحص الدفع» أو كلّمنا برقم الطلب.\n`) +
    `⚠️ المبلغ لازم يوصل <b>بالضبط</b> لآخر رقم، وعلى ${nw} بس.\n⚠️ من منصة زي بينانس الرسوم بتنخصم، فتأكد إنه اللي بيوصل هو <code>${p.amt}</code>.`;
}
function tgUsdtKb(o, id, now) {
  const p = o.pay || {};
  return [[tgCopy('📋 انسخ المبلغ', String(p.amt)), tgCopy('📋 انسخ العنوان', p.addr || '')], [tgBtn('🔳 QR للعنوان', 'qr:' + id)],
    [{ ...tgBtn('🔄 حوّلت، افحص الدفع', 'chk:' + id), style: 'success' }], [tgBtn('📦 طلباتي', 'orders')]];
}
async function tgUsdtQr(c, id) {
  const doc = await c.fs.get('orders/' + id);
  if (!doc || doc.data.tgChat !== c.chat || !doc.data.pay || !doc.data.pay.addr) { c.alert = 'ما لقينا هالدفعة'; return; }
  const p = doc.data.pay, url = 'https://api.qrserver.com/v1/create-qr-code/?size=480x480&margin=16&data=' + encodeURIComponent(p.addr);
  const r = await tg(c.env, 'sendPhoto', { chat_id: c.chat, photo: url, caption: `🔳 امسح العنوان من تطبيق محفظتك\nالمبلغ بالضبط: <code>${p.amt}</code> USDT · ${p.net === 'tron' ? 'TRC20' : 'BEP20'}`, parse_mode: 'HTML' });
  if (!r) c.alert = 'ما قدرنا نجهّز الـQR هلأ، انسخ العنوان بالزر';
}

// ---- 4: your place in line for a transfer someone has to look at (pending, with a receipt), and roughly how long
let TGETA = { at: 0, m: 0 };
async function tgQueue(fs, id, mine) {
  const rows = await fs.query('orders', [['status', 'EQUAL', 'pending']], 80);
  const proof = rows.filter(r => String(r.data.proofText || '').trim() || r.data.proofImage);
  const me = rows.find(r => r.id === id), t = me ? +me.data.createdAt || mine : mine;
  const pos = proof.filter(r => r.id !== id && (+r.data.createdAt || 0) < t).length + 1;
  if (Date.now() - TGETA.at > 15 * 60e3) {
    TGETA = { at: Date.now(), m: 0 };
    try {
      const recent = await fs.query('orders', [['createdAt', 'GREATER_THAN', new Date(Date.now() - 14 * 864e5)]], 150);
      const waits = recent.map(r => r.data).filter(o => (String(o.proofText || '').trim() || o.proofImage) && !/usdt/i.test(o.payment || ''))
        .map(o => Math.min(+o.paidAt || Infinity, +o.doneAt || Infinity) - (+o.createdAt || 0)).filter(x => x > 0 && x < 12 * 3600e3).sort((a, b) => a - b);
      if (waits.length >= 5) TGETA.m = Math.max(5, Math.min(180, Math.round(waits[Math.floor(waits.length / 2)] / 60e3 / 5) * 5));
    } catch (e) {}
  }
  return { pos, eta: TGETA.m };
}
const TG_ORD = ['الأول', 'الثاني', 'الثالث', 'الرابع', 'الخامس', 'السادس', 'السابع', 'الثامن', 'التاسع', 'العاشر'];
function tgQueueText(o, q) {
  const it = (o.items || [])[0] || {};
  const L = [`📥 <b>وصلنا طلبك، شكراً!</b> · <code>${esc(o.orderNo || '')}</code>`, `<i>${esc(it.productName || '')}${it.planName ? ' · ' + esc(it.planName) : ''} · ${tgN(o.total)} ₪</i>`];
  if (q) {
    const place = q.pos === 1 ? '📍 <b>إنت الأول بالدور</b>' : `📍 <b>طلبك ${q.pos <= 10 ? TG_ORD[q.pos - 1] : 'رقم ' + q.pos} بالدور</b>`;
    L.push(`<blockquote>${place}\n⏱ ${q.eta ? `بنأكده عادة خلال <b>حوالي ${tgMinTxt(q.eta >= 60 ? Math.round(q.eta / 60) * 60 : q.eta)}</b>` : 'بنأكده بأسرع وقت'}</blockquote>`);
  }
  L.push('✅ استلمنا', '⏳ <b>تأكيد الدفع</b> ← إنت هون', '▫️ التفعيل', '▫️ التسليم', '', '<i>هالرسالة بتتحدّث لحالها، مش لازم تسأل 🙂</i>');
  return L.join('\n');
}
function tgQueueKb(data, id) { return [[tgBtn('🔄 تحديث', 'o:' + id), tgUrl('💬 الدعم', 'https://t.me/' + tgSupUser(data))], [tgBtn('📦 طلباتي', 'orders'), tgBtn('🏠 الرئيسية', 'home')]]; }
// cron, for a bot order still waiting: count the USDT card down, move the place in line
async function tgLive(fs, env, id, d) {
  const now = Date.now(), f = {}, mask = [];
  if (d.pay && d.pay.amt && +d.tgPayMsg) {
    const mins = tgUsdtMins(d, now);
    if (mins !== +d.tgPayM && BUDGET > 8) {
      await tgCall(env, 'editMessageText', { chat_id: d.tgChat, message_id: +d.tgPayMsg, text: tgUsdtText(d, now), parse_mode: 'HTML', disable_web_page_preview: true }, tgUsdtKb(d, id, now));
      f.tgPayM = mins; mask.push('tgPayM');
    }
  } else if (+d.tgQMsg && BUDGET > 10) {
    const q = await tgQueue(fs, id, +d.createdAt || now);
    if (q.pos !== +d.tgQPos) {
      if (!TGC.products) await tgData(fs).catch(() => {});
      await tgCall(env, 'editMessageText', { chat_id: d.tgChat, message_id: +d.tgQMsg, text: tgQueueText(d, q), parse_mode: 'HTML', disable_web_page_preview: true }, tgQueueKb(TGC, id));
      if (q.pos === 1 && +d.tgQPos > 1) await tg(env, 'sendMessage', { chat_id: d.tgChat, text: '⏫ <b>صرت الأول بالدور!</b> بنأكد دفعتك هلأ.', parse_mode: 'HTML', reply_to_message_id: +d.tgQMsg, allow_sending_without_reply: true });
      f.tgQPos = q.pos; mask.push('tgQPos');
    }
  }
  if (mask.length) await fs.commit([fs.wUpdate('orders/' + id, f, mask, { exists: true })]);
}
// the status moved on: the USDT card says «وصل», the queue card becomes the order's track
async function tgCardsFollow(fs, env, id, d) {
  if (!d.tgChat) return;
  if (+d.tgPayMsg && d.pay && (d.status === 'paid' || d.status === 'done') && !d.tgPayDone) {
    const tx = d.pay.tx ? [[tgUrl('🔗 شوف التحويل', txLink(d.pay.net, d.pay.tx))]] : [];
    await tgCall(env, 'editMessageText', { chat_id: d.tgChat, message_id: +d.tgPayMsg, text: `✅ <b>وصل تحويلك!</b> <code>${d.pay.amt}</code> USDT · طلب <code>${esc(d.orderNo || '')}</code>\nتأكد الدفع لحاله، والتفاصيل تحت 👇`, parse_mode: 'HTML', disable_web_page_preview: true }, tx);
    await fs.commit([fs.wUpdate('orders/' + id, { tgPayDone: 1 }, ['tgPayDone'], { exists: true })]);
  } else if (+d.tgPayMsg && d.pay && d.status === 'cancelled' && !d.tgPayDone) {
    await tgCall(env, 'editMessageText', { chat_id: d.tgChat, message_id: +d.tgPayMsg, text: `❌ <b>انلغت هالدفعة</b> · طلب <code>${esc(d.orderNo || '')}</code>\nإذا حوّلت كلّمنا برقم الطلب.`, parse_mode: 'HTML' }, []);
    await fs.commit([fs.wUpdate('orders/' + id, { tgPayDone: 1 }, ['tgPayDone'], { exists: true })]);
  }
  if (+d.tgQMsg && d.status !== 'pending' && d.tgQDone !== d.status) {
    await tgCall(env, 'editMessageText', { chat_id: d.tgChat, message_id: +d.tgQMsg, text: tgTrack(d), parse_mode: 'HTML', disable_web_page_preview: true }, [[tgBtn('🔄 تحديث', 'o:' + id), tgBtn('📦 طلباتي', 'orders')]]);
    await fs.commit([fs.wUpdate('orders/' + id, { tgQDone: d.status }, ['tgQDone'], { exists: true })]);
  }
}

// ---- 5: an order left at the payment for an hour gets one gentle message (once a week at most, never after «لا تبعتلي»)
async function tgNudges(fs, env, C, now) {
  if (now - (+C.nud || 0) < 10 * 60e3 || BUDGET < 14) return;
  C.nud = now;
  const rows = await fs.query('tgBot', [['at', 'GREATER_THAN', now - 85 * 60e3]], 40);
  let sent = 0;
  for (const r of rows) {
    if (sent >= 4 || BUDGET < 8) break;
    const S = r.data, age = now - (+S.at || 0);
    if (age < 60 * 60e3 || !S.pid || !S.plan || (S.q && S.q.length && S.q[0] !== 'proof')) continue;
    const u = await fs.get('tgUsers/' + r.id).catch(() => null), ud = (u && u.data) || {};
    if (ud.noNudge || ud.off || now - (+ud.nud || 0) < 7 * 864e5) continue;
    if (!TGC.products) await tgData(fs);
    const p = TGC.products.find(x => x.id === S.pid), pl = p && p.plans.find(x => x.id === S.plan);
    if (!p || !pl || p.soldOut || pl.out) continue;
    const text = `👋 لسا بدك <b>${esc(tgVName(p, pl))}</b>؟\nطلبك محفوظ، بتكمّله من مكان ما وقفت 👇\n<blockquote>💰 ${tgN(pl.price)} ₪ · ⚡ التفعيل خلال دقائق بعد الدفع${pl.tgWar ? '\n🛡 ' + esc(String(pl.tgWar).trim()) : ''}</blockquote>`;
    const kb = [[{ ...tgBtn('✅ كمّل طلبي', 'nk'), style: 'success' }], [tgBtn('💬 عندي سؤال', 'sup'), tgBtn('🕓 مش هلأ', 'nl')], [tgBtn('🔕 لا تبعتلي تذكير زي هيك', 'nn')]];
    await tg(env, 'sendMessage', { chat_id: +r.id, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    await fs.commit([fs.wUpdate('tgUsers/' + r.id, { nud: now }, ['nud'])]);
    sent++;
  }
}

// ---- 6: invite a friend: the friend gets a discount on the first order, the inviter gets credit when the friend buys
const REF_DEF = 1;
function tgRefAmt(data) { const v = ((data && data.settings) || {}).refOff; return v === undefined || v === null || v === '' || isNaN(+v) ? REF_DEF : Math.max(0, Math.min(50, +v)); }
function tgRefCode(chat) { return Math.abs(+chat).toString(36); }
async function tgDeal(c, price) {
  const u = await tgU(c), R = tgRefAmt(c.data), out = { price: +price, ref: 0, credit: 0 };
  if (u.refBy && !u.refUsed && R > 0) out.ref = Math.min(R, Math.max(0, out.price - 1));
  const cr = Math.max(0, +u.credit || 0);
  if (cr > 0) out.credit = Math.round(Math.min(cr, Math.max(0, out.price - out.ref - 1)) * 100) / 100;
  out.total = Math.round((out.price - out.ref - out.credit) * 100) / 100;
  return out;
}
function tgDealLines(d) {
  if (!d.ref && !d.credit) return '';
  return (d.ref ? `\n🎁 خصم الدعوة: <b>${tgN(d.ref)} ₪</b>` : '') + (d.credit ? `\n💰 بينخصم من رصيد دعواتك: <b>${tgN(d.credit)} ₪</b>` : '') + `\n🧾 <b>المجموع: ${tgN(d.total)} ₪</b>`;
}
function tgDealFields(d, u) { return { ...(d.ref ? { refBy: +u.refBy, refOff: d.ref } : {}), ...(d.credit ? { creditUsed: d.credit } : {}) }; }
function tgDealWrites(c, d) {
  const f = {}, tr = [];
  if (d.ref) f.refUsed = 1;
  if (d.credit) tr.push({ fieldPath: 'credit', increment: { doubleValue: -d.credit } });
  if (!d.ref && !d.credit) return [];
  if (c._u && d.credit) c._u.credit = (+c._u.credit || 0) - d.credit;
  return [tgUSet(c, f, tr)];
}
async function tgRefStart(c, code) {
  const by = parseInt(code, 36);
  if (!c.fresh || !by || by === +c.chat || tgRefAmt(c.data) <= 0) return;
  const d = await c.fs.get('tgUsers/' + by).catch(() => null);
  if (!d) return;
  c.newRef = by;
  const R = tgRefAmt(c.data);
  await tgSay(c, `أهلين 👋 صاحبك <b>${esc(tgClean(d.data.name || 'صاحبك').split(' ')[0])}</b> عزمك على <b>${esc(tgClean(c.data.settings.storeName) || STORE)}</b>\n🎁 معك <b>${tgN(R)} ₪ خصم</b> على أول طلب، بينخصموا لحالهم.`);
}
async function tgRefView(c) {
  const R = tgRefAmt(c.data);
  if (R <= 0) { c.alert = 'برنامج الدعوة موقف هلأ'; return; }
  const bot = await tgMe(c.env), u = await tgU(c), link = `https://t.me/${bot || 'Hazem_storebot'}?start=r_${tgRefCode(c.chat)}`;
  let n = 0; try { n = await c.fs.count('tgUsers', [['refBy', 'EQUAL', +c.chat]]); } catch (e) {}
  const text = `🎁 <b>ادعُ صاحبك واكسب</b>\n<blockquote>👤 صاحبك بياخد <b>${tgN(R)} ₪ خصم</b> على أول طلب\n💰 وإنت بتاخد <b>${tgN(R)} ₪ رصيد</b> لما يشتري</blockquote>\n🔗 رابطك:\n<code>${esc(link)}</code>\n<blockquote>📊 دعيت <b>${n}</b> · اشتروا <b>${+u.refN || 0}</b>\n💰 رصيدك من الدعوات: <b>${tgN(+u.credit || 0)} ₪</b></blockquote>\n<i>الرصيد بينخصم لحاله من طلبك الجاي.</i>`;
  const share = 'https://t.me/share/url?url=' + encodeURIComponent(link) + '&text=' + encodeURIComponent(`🎁 خصم ${tgN(R)} ₪ على أول طلب من ${tgClean(c.data.settings.storeName) || STORE}: اشتراكات رسمية بالشيكل`);
  return tgView(c, { text, kb: [[{ ...tgUrl('📤 شارك رابطك مع صاحب', share), style: 'primary' }], [tgCopy('📋 انسخ الرابط', link)], [tgBtn('🛍 تسوّق', 'prods'), tgBtn('🏠 الرئيسية', 'home')]] });
}
// the friend's order was delivered → the inviter gets the credit; a cancelled order gives back what it used
async function tgRefSettle(fs, env, id, d) {
  const w = [];
  if (d.status === 'done' && +d.refBy && +d.refOff > 0 && !d.refPaid) {
    w.push(fs.wUpdate('tgUsers/' + d.refBy, {}, [], null, [{ fieldPath: 'credit', increment: { doubleValue: +d.refOff } }, { fieldPath: 'refN', increment: { integerValue: '1' } }]));
    w.push(fs.wUpdate('orders/' + id, { refPaid: 1 }, ['refPaid'], { exists: true }));
    await fs.commit(w);
    await tg(env, 'sendMessage', { chat_id: d.refBy, text: `🎉 <b>صاحبك اشترى!</b> انضافلك <b>${tgN(d.refOff)} ₪</b> رصيد، وبينخصموا لحالهم من طلبك الجاي 🤍`, parse_mode: 'HTML', reply_markup: { inline_keyboard: [[tgBtn('🎁 دعواتي', 'ref'), tgBtn('🛍 تسوّق', 'prods')]] } });
    return;
  }
  if (d.status === 'cancelled' && !d.creditBack && (+d.creditUsed > 0 || +d.refOff > 0) && d.tgChat) {
    const f = {}, tr = [];
    if (+d.creditUsed > 0) tr.push({ fieldPath: 'credit', increment: { doubleValue: +d.creditUsed } });
    if (+d.refOff > 0) f.refUsed = 0;
    await fs.commit([fs.wUpdate('tgUsers/' + d.tgChat, f, Object.keys(f), null, tr), fs.wUpdate('orders/' + id, { creditBack: 1 }, ['creditBack'], { exists: true })]);
  }
}

// ---- 7: one account with the site: link once (from the site's account page), then pay from the balance here
const FB_WEB_KEY = 'AIzaSyCJ5xs23CeYlxQWuvFxVW_mtuIrvuN5VYY'; // the site's public web key (config.js), only to check a sign-in
async function tgLinkMake(fs, env, body) {
  const tok = String(body.idToken || '');
  if (!tok || tok.length > 5000) throw fail('bad token');
  const r = await xf('https://identitytoolkit.googleapis.com/v1/accounts:lookup?key=' + (env.FB_WEB_KEY || FB_WEB_KEY), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ idToken: tok }) });
  const j = r.ok ? await r.json().catch(() => null) : null, uid = j && j.users && j.users[0] && j.users[0].localId;
  if (!uid) throw fail('not signed in', 401);
  const a = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789', code = [...crypto.getRandomValues(new Uint8Array(20))].map(b => a[b % a.length]).join('');
  await fs.commit([fs.wUpdate('tgLinks/' + code, { uid, exp: Date.now() + 15 * 60e3 }, null, { exists: false })]);
  return { url: `https://t.me/${(await tgMe(env)) || 'Hazem_storebot'}?start=l_${code}` };
}
async function tgLinkUse(c, code) {
  const d = await c.fs.get('tgLinks/' + code);
  if (!d || +d.data.exp < Date.now() || d.data.used) return tgSay(c, '⚠️ رابط الربط انتهى. افتح حسابك على الموقع واكبس «اربط تيليجرام» كمان مرة.', [[tgUrl('🌐 حسابي على الموقع', SITE)], [tgBtn('🏠 الرئيسية', 'home')]]);
  const uid = d.data.uid, wd = await c.fs.get('wallets/' + uid), w = (wd && wd.data) || {};
  const writes = [c.fs.wUpdate('tgLinks/' + code, { used: c.chat }, ['used'], { updateTime: d.updateTime }), tgUSet(c, { uid })];
  if (wd) writes.push(c.fs.wUpdate('wallets/' + uid, { tgChat: c.chat, tgUser: c.from.username || '' }, ['tgChat', 'tgUser'], { exists: true }));
  try { await c.fs.commit(writes); } catch (e) { return tgSay(c, '⚠️ هالرابط انستعمل. افتح حسابك على الموقع واعمل ربط جديد.'); }
  c._w = undefined;
  return tgSay(c, `✅ <b>انربط حسابك بالموقع</b>\n<blockquote>👤 ${esc(tgClean(w.name || '') || 'حسابك')}\n💰 رصيدك: <b>${tgN(+w.balance || 0)} ₪</b>\n📦 طلباتك من البوت بتطلع كمان بحسابك على الموقع</blockquote>\nوقت الدفع بيطلعلك زر «💰 ادفع من رصيدي» 👌`, [[{ ...tgApp('🛍 افتح المتجر'), style: 'primary' }], [tgBtn('🏠 الرئيسية', 'home')]]);
}
async function tgWallet(c) {
  if (c._w !== undefined) return c._w;
  const u = await tgU(c);
  c._w = null;
  if (u.uid) { const d = await c.fs.get('wallets/' + u.uid).catch(() => null); if (d) c._w = { ...d.data, uid: u.uid, _t: d.updateTime }; }
  return c._w;
}
async function tgWalletPay(c) {
  const x = tgPick(c);
  if (!x) { c.alert = 'ابدأ الطلب من جديد'; return tgHome(c); }
  if (tgClosed(c)) { c.alert = 'الطلبات موقفة مؤقتاً، كلّمنا على الدعم'; return; }
  const u = await tgU(c);
  if (!u.uid) { c.alert = 'اربط حسابك بالموقع أول'; return; }
  const deal = await tgDeal(c, x.pl.price), wd = await c.fs.get('wallets/' + u.uid), bal = wd ? +wd.data.balance || 0 : 0;
  if (!wd || bal < deal.total) { c.alert = `رصيدك ${tgN(bal)} ₪ ما بيكفي لهالطلب`; return; }
  const { fs, env } = c, id = tgDocId(), no = tgOrderNo(), user = c.from.username || '';
  const item = { productId: x.p.id, productName: tgClean(x.p.name).slice(0, 100), planId: x.pl.id, planName: tgClean(x.pl.name || '').slice(0, 60), price: +x.pl.price, qty: 1 };
  const order = { orderNo: no, uid: u.uid, items: [item], total: deal.total, customer: tgClean(wd.data.name || '') || tgWho(c.from), phone: String(wd.data.phone || ''), email: '', payment: 'رصيد', walletPart: deal.total,
    status: 'paid', source: 'telegram', tgChat: c.chat, tgUser: user, tgSent: 'paid', ...tgDealFields(deal, u) };
  if (c.S.renew) order.renewOf = String(c.S.renew);
  try {
    await fs.commit([
      fs.wUpdate('wallets/' + u.uid, { balance: Math.round((bal - deal.total) * 100) / 100, lastOrder: id }, ['balance', 'lastOrder'], { updateTime: wd.updateTime }),
      fs.wUpdate('orders/' + id, order, null, { exists: false }, [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }, { fieldPath: 'paidAt', setToServerValue: 'REQUEST_TIME' }]),
      fs.wUpdate('payState/main', { tg: { [id]: Date.now() + 10 * 864e5 } }, ['tg.' + fp(id)]),
      ...tgDealWrites(c, deal),
    ]);
  } catch (e) { if (e.status === 400 || e.status === 409) { c.alert = 'رصيدك تغيّر هلأ، جرّب كمان مرة'; return; } throw e; }
  c.S = {}; c.dirty = true;
  await notifyAdmin(env, '💰 طلب من البوت مدفوع من الرصيد ' + no, [...itemLines(order), 'المجموع: ' + money(order.total), 'الزبون: ' + order.customer + (user ? ' · @' + user : ''), 'الحالة: مدفوع، بانتظار التفعيل'], SITE + '/admin.html').catch(() => {});
  await tgAdminNotify(fs, env, id, order, '💰 <b>طلب مدفوع من الرصيد</b>').catch(() => 0);
  const nb = tgNeedBlock(c.data.settings, order), now = Date.now();
  const kb = [...(nb ? nb.kb : []), [tgBtn('🔄 تحديث', 'o:' + id), tgBtn('📦 طلباتي', 'orders')]];
  c.msgId = 0;
  return tgSay(c, `✅ <b>انخصم ${tgN(deal.total)} ₪ من رصيدك</b> · طلب <code>${no}</code>\n💰 رصيدك هلأ: <b>${tgN(bal - deal.total)} ₪</b>\n\n${tgTrack({ ...order, createdAt: now, paidAt: now })}` + (nb ? '\n\n' + nb.text : ''), kb);
}

// ---- 8: Hazem's panel: today against yesterday, the week, what needs a look, and quick actions
async function tgAdminPanel(c, span) {
  if (!tgIsAdmin(c)) return;
  const now = Date.now(), l = tgLocal(now), days = span === 'month' ? 30 : 7, from = l.day0 - (days - 1) * 864e5;
  const rows = await c.fs.query('orders', [['createdAt', 'GREATER_THAN', new Date(from - 1)]], 600);
  const live = rows.map(r => r.data).filter(o => o.status !== 'cancelled');
  const dayOf = t => Math.floor((t - from) / 864e5), per = Array(days).fill(0);
  for (const o of live) { const k = dayOf(+o.createdAt || 0); if (k >= 0 && k < days) per[k] += +o.total || 0; }
  const today = rows.map(r => r.data).filter(o => (+o.createdAt || 0) >= l.day0), yest = per[days - 2] || 0, tSum = per[days - 1];
  const cnt = st => today.filter(o => o.status === st).length;
  let subs = 0; try { subs = await c.fs.count('tgUsers', [['at', 'GREATER_THAN', l.day0 - 1]]); } catch (e) {}
  const diff = yest > 0 ? Math.round((tSum - yest) / yest * 100) : null;
  const L = [`📊 <b>لوحة حازم</b> · ${tgWhen(now)}`,
    `<blockquote>💵 مبيعات اليوم: <b>${tgN(tSum)} ₪</b>${diff === null ? '' : ` (${diff >= 0 ? '↑' : '↓'} ${Math.abs(diff)}% عن أمس)`}\n📦 طلبات اليوم: <b>${today.length}</b> · ✅ ${cnt('done')} · ⏳ ${cnt('pending') + cnt('paid')} · ❌ ${cnt('cancelled')}\n👥 مشتركين جدد بالبوت: <b>${subs}</b></blockquote>`];
  if (span === 'month') {
    const total = per.reduce((a, b) => a + b, 0), n = live.length;
    L.push(`<b>آخر 30 يوم</b>\n💵 <b>${tgN(total)} ₪</b> من <b>${n}</b> طلب · بالمعدل ${tgN(Math.round(total / 30))} ₪ باليوم`);
  } else {
    const max = Math.max(1, ...per), lines = [];
    for (let k = 0; k < days; k++) {
      const t = from + k * 864e5 + 12 * 3600e3, wd = TG_WD[tgLocal(t).wd] || '';
      lines.push(`${'▇'.repeat(Math.max(per[k] > 0 ? 1 : 0, Math.round(per[k] / max * 10))) || '▫️'} ${tgN(per[k])} ₪ · ${wd}`);
    }
    L.push('<b>هالأسبوع</b>', lines.join('\n'));
  }
  // what needs a look: money that came with no order, plans running out of codes, subscriptions ending tomorrow
  const att = [];
  try {
    const st = await c.fs.get('payState/main'), seen = (st && Array.isArray(st.data.seen)) ? st.data.seen : [];
    for (const t of seen.filter(t => t.k && !t.u && now - (+t.at || 0) < 2 * 864e5).slice(-3)) att.push(`• تحويل USDT ‎${r3(t.a)} بدون طلب`);
  } catch (e) {}
  try {
    const inst = c.data.products.filter(p => p.plans.some(pl => pl.instant));
    await tgCounts(c, inst);
    for (const p of inst) for (const pl of p.plans) if (pl.instant && !pl.out && !p.soldOut) { const n = tgLeft(c.data, p, pl); if (n <= 2) att.push(`• ${esc(tgVName(p, pl))} ضايل منه ${n} بالمخزون`); }
  } catch (e) {}
  const soon = await tgEnding(c, now).catch(() => []);
  if (soon.length) att.push(`• ${soon.length} ${soon.length === 1 ? 'زبون اشتراكه بيخلص' : 'زباين اشتراكاتهم بتخلص'} خلال يومين`);
  if (att.length) L.push(`<blockquote>⚠️ <b>بدها انتباه</b>\n${att.slice(0, 6).join('\n')}</blockquote>`);
  const pend = (await c.fs.query('orders', [['status', 'EQUAL', 'pending']], 40).catch(() => [])).length + (await c.fs.query('orders', [['status', 'EQUAL', 'paid']], 40).catch(() => [])).length;
  const kb = [[{ ...tgBtn(`⏳ الطلبات المعلّقة (${pend})`, 'apend'), style: 'primary' }], [tgBtn('📢 إعلان للمشتركين', 'post'), tgBtn('🔥 عرض لوقت محدود', 'sl')],
    [tgBtn(`🔔 بيخلصوا قريب (${soon.length})`, 'adms'), span === 'month' ? tgBtn('📈 هالأسبوع', 'adm') : tgBtn('📈 آخر 30 يوم', 'admw')], [tgBtn('🔄 تحديث', span === 'month' ? 'admw' : 'adm'), tgBtn('🏠 الرئيسية', 'home')]];
  return tgView(c, { text: L.join('\n'), kb });
}
// subscriptions (site and bot) ending within two days that nobody reminded yet
async function tgEnding(c, now) {
  const rows = await c.fs.query('orders', [['status', 'EQUAL', 'done']], 600), out = [];
  for (const r of rows) {
    const o = r.data;
    (o.items || []).forEach((it, ix) => {
      const end = tgItemEnd(o, it, c.data.products), rem = o.remind && o.remind[ix];
      if (!end || end < now - 864e5 || end - now > 2 * 864e5 || (rem && +rem.end === end) || +o.tgRenew === end) return;
      if (rows.some(x => x.data.renewOf === r.id)) return;
      out.push({ id: r.id, o, it, end });
    });
  }
  return out.sort((a, b) => a.end - b.end);
}
async function tgAdminSoon(c) {
  if (!tgIsAdmin(c)) return;
  const now = Date.now(), list = (await tgEnding(c, now)).slice(0, 12);
  if (!list.length) return tgView(c, { text: '🔔 ما في اشتراكات بتخلص خلال يومين 👌', kb: [[tgBtn('« اللوحة', 'adm')]] });
  const st = tgClean(c.data.settings.storeName) || STORE;
  const kb = list.map(x => {
    const nm = tgClean(x.o.customer || 'زبون').split(' ')[0], when = Math.max(0, Math.ceil((x.end - now) / 864e5));
    const msg = `مرحباً ${nm}، حابب أذكّرك إنه اشتراكك ${tgClean(x.it.productName || '')}${x.it.planName ? ' (' + tgClean(x.it.planName) + ')' : ''} ${when <= 0 ? 'بيخلص اليوم' : when === 1 ? 'بيخلص بكرة' : 'بيخلص بعد يومين'}. إذا حابب تجدّده بلّغني 🤍\n${st}`;
    const ph = String(x.o.phone || '').replace(/\D/g, '');
    const url = x.o.tgChat && x.o.tgUser ? 'https://t.me/' + tgUserName(x.o.tgUser) : ph.length >= 9 ? `https://wa.me/${ph.replace(/^0/, '970')}?text=${encodeURIComponent(msg)}` : '';
    const label = `${when <= 0 ? '🔴' : '🟠'} ${tgShort(tgClean(x.o.customer || 'زبون'), 14)} · ${tgShort(tgClean(x.it.productName || ''), 14)}`;
    return [url ? tgUrl(label, url) : tgBtn(label + ' · بدون رقم', 'av:' + x.id)];
  });
  kb.push([tgBtn('« اللوحة', 'adm')]);
  return tgView(c, { text: `🔔 <b>بيخلصوا خلال يومين</b> (${list.length})\nاكبس على الزبون وبتنفتح المحادثة ورسالة التذكير جاهزة 👇\n<i>زباين البوت بيوصلهم تذكير تلقائي قبل 3 أيام.</i>`, kb });
}
// the customer paid but the details (email etc.) did not come yet: send them the two ways again
async function tgAdminAskInfo(c, id) {
  if (!tgIsAdmin(c)) return;
  const doc = await c.fs.get('orders/' + id), o = doc && doc.data;
  if (!o || !o.tgChat) { c.alert = 'هالطلب مش من البوت'; return; }
  const nb = tgNeedBlock(c.data.settings, o);
  if (!nb) { c.alert = 'هالطلب ما بده تفاصيل'; return; }
  const ok = await tg(c.env, 'sendMessage', { chat_id: o.tgChat, text: `📩 <b>بخصوص طلبك</b> <code>${esc(o.orderNo || '')}</code>\n${nb.text}`, parse_mode: 'HTML', reply_markup: { inline_keyboard: nb.kb } });
  c.alert = ok ? '✅ وصله التذكير' : 'ما وصلته الرسالة (يمكن مسكّر البوت)';
}

// ---------------------------------------------------------------- times in Gaza
function tgLocal(t) {
  const p = {};
  for (const x of new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Gaza', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23', weekday: 'short' }).formatToParts(new Date(t))) p[x.type] = x.value;
  const h = +p.hour % 24, m = +p.minute, s = +p.second;
  return { date: `${p.year}-${p.month}-${p.day}`, hour: h, day0: t - ((h * 60 + m) * 60 + s) * 1e3 - (t % 1e3), d: +p.day, mo: +p.month, wd: p.weekday };
}
const TG_WD = { Sat: 'السبت', Sun: 'الأحد', Mon: 'الإثنين', Tue: 'الثلاثاء', Wed: 'الأربعاء', Thu: 'الخميس', Fri: 'الجمعة' };
function tgWhen(t, withTime) {
  const l = tgLocal(t);
  let s = `${TG_WD[l.wd] || ''} ${l.d}/${l.mo}`;
  if (withTime) { const h = l.hour, m = new Date(t).getUTCMinutes(); s += ` الساعة ${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'ص' : 'م'}`; }
  return s;
}
function tgDays(n) { return n === 1 ? 'يوم' : n === 2 ? 'يومين' : n <= 10 ? n + ' أيام' : n + ' يوم'; }

// the nightly summary for Hazem (after 11 pm Gaza time, once a day)
async function tgDaily(fs, env, C, now) {
  const l = tgLocal(now);
  if (l.hour < 23 || C.day === l.date) return;
  C.day = l.date;
  const chats = await tgAdminChats(fs);
  if (!chats.length) return;
  const rows = await fs.query('orders', [['createdAt', 'GREATER_THAN_OR_EQUAL', new Date(l.day0)]], 300);
  const os = rows.map(r => r.data), live = os.filter(o => o.status !== 'cancelled');
  const cnt = st => os.filter(o => o.status === st).length, top = {};
  for (const o of live) for (const i of o.items || []) top[i.productName] = (top[i.productName] || 0) + (+i.qty || 1);
  const best = Object.entries(top).sort((a, b) => b[1] - a[1])[0];
  let subs = 0;
  try { subs = await fs.count('tgUsers', [['at', 'GREATER_THAN_OR_EQUAL', l.day0]]); } catch (e) {}
  let waits = [];
  try { waits = await tgWaitList(fs); } catch (e) {}
  const L = [`📊 <b>ملخص اليوم</b> · ${tgWhen(now)}`,
    `طلبات: <b>${os.length}</b> (✅ ${cnt('done')} · ⏳ ${cnt('pending') + cnt('paid')} · ❌ ${cnt('cancelled')})`,
    `مبيعات: <b>${tgN(live.reduce((a, o) => a + (+o.total || 0), 0))} ₪</b>`,
    `من البوت: ${os.filter(o => o.source === 'telegram').length} · من الموقع: ${os.filter(o => o.source !== 'telegram').length}`];
  if (best) L.push(`الأكثر بيعاً: ${esc(best[0])} (${best[1]})`);
  L.push(`مشتركين جدد بالبوت: ${subs}`);
  if (waits.length) L.push('', '🔔 <b>مستنيين يرجع:</b>', ...waits.slice(0, 6).map(w => `• ${esc(w.name)} (${w.n})`));
  const kb = cnt('pending') + cnt('paid') ? [[tgBtn('⏳ الطلبات المعلّقة', 'apend')]] : [];
  for (const chat of chats.slice(0, 3)) await tg(env, 'sendMessage', { chat_id: chat, text: L.join('\n'), parse_mode: 'HTML', ...(kb.length ? { reply_markup: { inline_keyboard: kb } } : {}) });
}

// ---------------------------------------------------------------- B2: renewal reminders
// once a day (after 10 am Gaza time): bot orders whose subscription ends within 3 days get a reminder with 🔄
function tgGuessDur(n) {
  n = String(n || '').replace(/[٠-٩]/g, d => d.charCodeAt(0) - 1632).toLowerCase().replace(/[()[\]]/g, ' ');
  let m;
  if ((m = /(\d+)\s*(سنة|سنه|سنوات|سنين|years?)/.exec(n))) return 'y' + (+m[1] || 1);
  if ((m = /(\d+)\s*(شهر|شهور|أشهر|اشهر|months?)/.exec(n))) { const k = +m[1] || 1; return k % 12 === 0 ? 'y' + k / 12 : 'm' + k; }
  if ((m = /(\d+)\s*(أسبوع|اسبوع|أسابيع|اسابيع|weeks?)/.exec(n))) return 'w' + (+m[1] || 1);
  if ((m = /(\d+)\s*(يوم|أيام|ايام|days?)/.exec(n))) return 'd' + (+m[1] || 1);
  if (/سنتين/.test(n)) return 'y2';
  if (/سن(ة|ه|وي)|year|annual/.test(n)) return 'y1';
  if (/ست(ة|ه)\s*(أشهر|اشهر|شهور)/.test(n)) return 'm6';
  if (/ثلاث(ة|ه)?\s*(أشهر|اشهر|شهور)/.test(n)) return 'm3';
  if (/شهرين/.test(n)) return 'm2';
  if (/أسبوعين|اسبوعين/.test(n)) return 'w2';
  if (/أسبوع|اسبوع|week/.test(n)) return 'w1';
  if (/شهر|month/.test(n)) return 'm1';
  return '';
}
function tgAddDur(t, c) {
  const m = /^([dwmy])(\d+)$/.exec(c || '');
  if (!m) return 0;
  const d = new Date(t), k = +m[2], day = d.getUTCDate();
  if (m[1] === 'd') d.setUTCDate(day + k);
  else if (m[1] === 'w') d.setUTCDate(day + 7 * k);
  else { const n = m[1] === 'y' ? 12 * k : k; d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() + n); const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate(); d.setUTCDate(Math.min(day, last)); }
  return d.getTime();
}
function tgItemEnd(o, i, products) {
  if (i.endsAt === 0) return 0;
  if (+i.endsAt) return +i.endsAt;
  const p = products.find(x => x.id === i.productId), pl = p && (p.plans || []).find(x => x.id === i.planId);
  const c = pl && pl.dur ? pl.dur : tgGuessDur(pl ? pl.name : i.planName);
  if (!c || c === 'none') return 0;
  return tgAddDur(+i.startAt || +o.doneAt || +o.createdAt || 0, c);
}
async function tgRenewals(fs, env, C, now) {
  const l = tgLocal(now);
  if (l.hour < 10 || C.rday === l.date || BUDGET < 12) return;
  C.rday = l.date;
  const [rows, prs] = await Promise.all([fs.query('orders', [['source', 'EQUAL', 'telegram'], ['status', 'EQUAL', 'done']], 500), fs.list('products')]);
  const products = prs.map(d => tgBotView({ ...d.data, id: d.id })).filter(Boolean), marks = [];
  let ic = {};
  try { const d = await fs.get('tgMeta/icons'), im = d && d.data; ic = im && im.on !== false && (im.prem || im.force) ? { ...(im.map || {}), ...(im.man || {}) } : {}; } catch (e) {}
  for (const r of rows) {
    if (BUDGET < 5 || marks.length >= 15) break;
    const o = r.data, it = (o.items || [])[0];
    if (!it || !o.tgChat) continue;
    const end = tgItemEnd(o, it, products), left = end - now;
    if (!end || left <= 0 || left > 3.2 * 864e5 || +o.tgRenew === end) continue;
    const p = products.find(x => x.id === it.productId), k = p ? (p.plans || []).findIndex(x => x.id === it.planId) : -1, pl = k >= 0 ? p.plans[k] : null;
    const days = Math.max(1, Math.round(left / 864e5)), data = { settings: {}, icons: ic };
    const emo = p ? tgEmo(data, p) : '📦';
    const text = `⏰ <b>اشتراكك قرّب يخلص</b>\n${emo} ${esc(it.productName || '')}${it.planName ? ' — ' + esc(it.planName) : ''}\n📅 بيخلص بعد <b>${tgDays(days)}</b> (${tgWhen(end)})\nجدّد هلأ وما بينقطع عنك ولا يوم.`;
    const kb = [];
    if (p && pl && !p.soldOut && !pl.out && p.active !== false) kb.push([{ ...tgBtn(`🔄 جدّد بنفس التفاصيل · ${tgN(pl.price)} ₪`, 'rn:' + r.id), style: 'success' }]);
    kb.push([...(p ? [tgBtn('🔁 مدة ثانية', 'g:' + p.id)] : []), tgBtn('💬 اسأل', 'help')]);
    const ok = await tg(env, 'sendMessage', { chat_id: o.tgChat, text, parse_mode: 'HTML', reply_markup: { inline_keyboard: kb } });
    if (ok || TG_GONE.test(TGERR)) marks.push(fs.wUpdate('orders/' + r.id, { tgRenew: end }, ['tgRenew'], { exists: true }));
  }
  if (marks.length) await fs.commit(marks);
}
// 🔄 from a reminder: the same product, duration and details, straight to paying
async function tgRenew(c, id) {
  const doc = await c.fs.get('orders/' + id);
  if (!doc || doc.data.tgChat !== c.chat) { c.alert = 'ما لقينا هالطلب'; return; }
  const o = doc.data, it = (o.items || [])[0] || {};
  const p = c.data.products.find(x => x.id === it.productId), k = p ? p.plans.findIndex(x => x.id === it.planId) : -1;
  if (!p || k < 0) { c.alert = 'هالاشتراك مش متوفر هلأ، اختار من المنتجات'; c.msgId = 0; return tgGrid(c, true); }
  const ans = {};
  (p.ask || []).forEach((a, j) => {
    const seg = String(it.info || '').split(' | ').find(s => s.startsWith(a.l + ': '));
    if (seg) ans[j] = seg.slice(a.l.length + 2);
  });
  c.msgId = 0;
  const r = await tgPlan(c, p.id, k);
  if (c.S && c.S.pid === p.id) { c.S.pre = { ans, email: o.email || '', phone: o.phone || '' }; c.S.renew = id; c.dirty = true; }
  return r;
}

// ---------------------------------------------------------------- B3: ratings after delivery
// reviews/<orderId>, like the site's own: status 'pending' until Hazem approves it in the admin page
async function tgRate(c, id, n) {
  const doc = await c.fs.get('orders/' + id);
  if (!doc || doc.data.tgChat !== c.chat) { c.alert = 'ما لقينا هالطلب'; return; }
  const o = doc.data, it = (o.items || [])[0] || {};
  const prev = await c.fs.get('reviews/' + id);
  if (prev) { c.alert = 'قيّمت قبل، شكراً إلك 🤍'; return; }
  const rv = { name: tgClean(c.from.first_name || 'زبون').slice(0, 40), rating: +n, text: '', product: String(it.productName || '').slice(0, 100), productId: it.productId || '', orderNo: String(o.orderNo || '').slice(0, 16), status: 'pending', source: 'telegram', tgChat: c.chat };
  await c.fs.commit([c.fs.wUpdate('reviews/' + id, rv, null, { exists: false }, [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }])]);
  if (+n <= 3) {
    const chats = (await tgAdminChats(c.fs)).slice(0, 3);
    for (const a of chats) await tg(c.env, 'sendMessage', { chat_id: a, text: `⚠️ تقييم <b>${n}⭐</b> من ${esc(rv.name)}${c.from.username ? ' (@' + esc(c.from.username) + ')' : ''} على طلب <code>${esc(rv.orderNo)}</code> · ${esc(rv.product)}`, parse_mode: 'HTML', ...(c.from.username ? { reply_markup: { inline_keyboard: [[tgUrl('💬 راسله', 'https://t.me/' + c.from.username)]] } } : {}) });
  }
  return tgShow(c, `${'⭐'.repeat(+n)}\nشكراً! 🙏 بدك تكتب كلمتين عن تجربتك؟ بتساعد غيرك يختار (اختياري)`, [[tgBtn('✍️ اكتب رأيك', 'rvt:' + id), tgBtn('تخطّي', 'rvs')]]);
}
// the stars of a product from approved reviews (the site's and the bot's), cached 10 minutes
let TGR = null;
async function tgReviews(c) {
  if (TGR && Date.now() - TGR.at < 10 * 60e3) return TGR.list;
  let list = [];
  try { list = (await c.fs.query('reviews', [['status', 'EQUAL', 'approved']], 300)).map(r => r.data); } catch (e) {}
  TGR = { at: Date.now(), list };
  return list;
}
function tgStars(list, p) {
  const nm = tgClean(p.name).toLowerCase(), first = nm.split(/\s+/)[0];
  const mine = list.filter(r => +r.rating > 0 && (r.productId === p.id || String(r.product || '').toLowerCase().includes(first)));
  if (!mine.length) return null;
  const avg = mine.reduce((a, r) => a + +r.rating, 0) / mine.length;
  const last = mine.filter(r => String(r.text || '').trim()).sort((a, b) => (+b.createdAt || 0) - (+a.createdAt || 0))[0];
  return { avg: Math.round(avg * 10) / 10, n: mine.length, last };
}

// ---------------------------------------------------------------- B7: 🔔 tell me when it's back
// tgWatch/<productId>: { w: { <planId>: [chat, …] } }; the 10-minute look sends them a message of their own
async function tgNotifyMe(c, pid, k) {
  const p = c.data.products.find(x => x.id === pid), pl = p && p.plans[+k];
  if (!p || !pl) { c.alert = 'هالمدة مش موجودة'; return; }
  if (!p.soldOut && !pl.out) return tgVariant(c, pid, k, true);
  const doc = await c.fs.get('tgWatch/' + pid), w = (doc && doc.data.w) || {}, list = (w[pl.id] || []).map(String);
  if (list.includes(String(c.chat))) { c.alert = '✓ إنت مسجّل، بنبلّغك أول ما يرجع'; return; }
  const next = [...list, String(c.chat)].slice(-500);
  await c.fs.commit([c.fs.wUpdate('tgWatch/' + pid, { w: { [pl.id]: next }, name: tgClean(p.name) }, ['w.' + fp(pl.id), 'name'], doc ? { updateTime: doc.updateTime } : { exists: false })]);
  c.msgId = 0;
  return tgSay(c, `🔔 <b>تمام!</b> أول ما يرجع ${esc(tgVName(p, pl))} بنبعتلك رسالة هون، قبل الإعلان العام.`);
}
async function tgWaitList(fs) {
  const rows = await fs.list('tgWatch'), out = [];
  for (const r of rows) for (const [plan, chats] of Object.entries(r.data.w || {})) if ((chats || []).length) out.push({ pid: r.id, plan, name: r.data.name || r.id, n: chats.length });
  return out.sort((a, b) => b.n - a.n);
}
// inside the 10-minute look: durations that are back → a message to the people waiting for them
async function tgWatchers(fs, all, data, now) {
  const rows = await fs.list('tgWatch'), w = [];
  for (const r of rows) {
    const p = all.find(x => x.id === r.id), wmap = r.data.w || {};
    if (!p || p.active === false || p.soldOut) continue;
    for (const [planId, chats] of Object.entries(wmap)) {
      const k = (p.plans || []).findIndex(x => x && x.id === planId);
      if (k < 0 || !(chats || []).length) continue;
      if (p.plans[k].out || !(+p.plans[k].price > 0)) continue;
      const job = tgPostCard(data, p, k, ['✅ <b>رجع متوفر!</b>', 'طلبت إنّا نبلّغك، فبعتنالك قبل الكل 😉']);
      w.push(fs.wUpdate('tgPosts/w' + now + '_' + w.length, { ...job, to: chats.map(String), a: '', n: 0, by: 0, at: now - 1000 + w.length, lock: 0 }, null, { exists: false }));
      w.push(fs.wUpdate('tgWatch/' + r.id, { w: { [planId]: [] } }, ['w.' + fp(planId)]));
    }
  }
  if (w.length) await fs.commit(w);
}

// ---------------------------------------------------------------- B6: a sale for a few hours
// tgMeta/sales: { s: { <pid>|<planId>: { pid, plan, price, old, oldCmp, until, warned } } }
// The price really changes on the product (site and bot); the 10-minute look puts it back when time is up.
function tgSaleMenu(c) {
  if (!tgIsAdmin(c)) return;
  const sales = Object.values((c.data.sales || {}));
  const kb = [...tgRows(c.data.products.filter(p => !tgOut(p)).map(p => tgPBtn(c.data, p, 'sp:' + p.id)), 2)];
  for (const s of sales) {
    const p = c.data.products.find(x => x.id === s.pid);
    kb.unshift([{ ...tgBtn(`⏹ وقّف عرض ${tgClean(p ? p.name : s.pid).slice(0, 20)} (${tgN(s.price)} ₪)`, 'sx:' + s.pid + '|' + s.plan), style: 'danger' }]);
  }
  kb.push([tgBtn('« الرئيسية', 'home')]);
  return tgShow(c, `🔥 <b>عرض لوقت محدود</b>\nاختار المنتج 👇${sales.length ? '\n\nالعروض الشغالة هلأ فوق.' : ''}`, kb);
}
function tgSalePlan(c, pid) {
  if (!tgIsAdmin(c)) return;
  const p = c.data.products.find(x => x.id === pid);
  if (!p) return;
  const live = p.plans.map((pl, k) => ({ pl, k })).filter(x => +x.pl.price > 0 && !x.pl.out);
  if (live.length === 1) return tgSalePrice(c, pid, live[0].k);
  return tgShow(c, `🔥 ${tgEmo(c.data, p)} <b>${esc(tgClean(p.name))}</b>\nعلى أي مدة العرض؟`, [...live.map(x => [tgBtn(`${tgClean(x.pl.name || p.name).slice(0, 26)} · ${tgN(x.pl.price)} ₪`, `sk:${p.id}:${x.k}`)]), [tgBtn('« رجوع', 'sl')]]);
}
function tgSalePrice(c, pid, k) {
  if (!tgIsAdmin(c)) return;
  const p = c.data.products.find(x => x.id === pid), pl = p && p.plans[+k];
  if (!pl) return;
  c.S = { sale: { pid, k: +k } }; c.dirty = true; c.msgId = 0;
  return tgSay(c, `💵 اكتب سعر العرض لـ <b>${esc(tgVName(p, pl))}</b>\nالسعر هلأ: ${tgN(pl.price)} ₪`, [[tgBtn('❌ إلغاء', 'home')]]);
}
function tgSaleGotPrice(c, text) {
  const s = c.S.sale, p = c.data.products.find(x => x.id === s.pid), pl = p && p.plans[s.k];
  const v = +String(text).replace(/[٠-٩]/g, d => d.charCodeAt(0) - 1632).replace(/[^\d.]/g, '');
  if (!pl) { tgReset(c); return tgSay(c, 'المنتج تغيّر، ابدأ من جديد: /sale'); }
  if (!(v > 0) || v >= +pl.price) return tgSay(c, `اكتب رقم أقل من ${tgN(pl.price)} ₪، مثلاً ${tgN(Math.max(1, Math.round(pl.price * 0.8)))}`);
  c.S.sale = { ...s, price: v }; c.dirty = true;
  return tgSay(c, `⏳ قديش مدة العرض؟`, [[tgBtn('6 ساعات', 'sh:6'), tgBtn('12 ساعة', 'sh:12'), tgBtn('24 ساعة', 'sh:24')], [tgBtn('يومين', 'sh:48'), tgBtn('3 أيام', 'sh:72'), tgBtn('أسبوع', 'sh:168')], [tgBtn('❌ إلغاء', 'home')]]);
}
function tgSaleCard(data, p, k, price, until, head) {
  const pl = p.plans[k], old = Math.max(+pl.compare || 0, +pl.price);
  const hrs = Math.max(1, Math.round((until - Date.now()) / 36e5));
  const L = [head || `🔥 <b>عرض لـ ${hrs >= 48 && hrs % 24 === 0 ? tgDays(hrs / 24) : hrs + ' ساعة'} بس!</b>`, `${tgEmo(data, p)} <b>${esc(tgVName(p, pl))}</b>`,
    `💵 السعر: <s>${tgN(old)} ₪</s> <b>${tgN(price)} ₪</b>`, `⏳ لحد ${tgWhen(until, true)}`, '✅ متوفر'];
  return { t: L.join('\n'), k: [[{ ...tgBtn(`🛒 اشتري الآن بـ ${tgN(price)} ₪`, `b:${p.id}:${k}`), style: 'success' }]], img: '', pid: p.id };
}
function tgSalePreview(c, hours) {
  const s = c.S.sale, p = s && c.data.products.find(x => x.id === s.pid);
  if (!p || !s.price) { tgReset(c); return tgSay(c, 'ابدأ من جديد: /sale'); }
  c.S.sale = { ...s, h: +hours }; c.dirty = true;
  const card = tgSaleCard(c.data, p, s.k, s.price, Date.now() + hours * 36e5);
  c.msgId = 0;
  return (async () => {
    await tgSay(c, card.t, card.k);
    return tgSay(c, '👆 هيك رح يوصل للكل، والسعر بيتغيّر بالموقع والبوت لحد ما يخلص الوقت، وبعدها بيرجع لحاله.', [[{ ...tgBtn('🔥 ابدأ العرض وابعته', 'sgo'), style: 'success' }], [{ ...tgBtn('❌ إلغاء', 'home'), style: 'danger' }]]);
  })();
}
async function tgSaleGo(c) {
  const s = c.S.sale;
  if (!tgIsAdmin(c) || !s || !s.price || !s.h) { c.alert = 'ابدأ من جديد: /sale'; return; }
  tgReset(c);
  const doc = await c.fs.get('products/' + s.pid);
  const p = doc && { ...doc.data, id: s.pid }, pl = p && (p.plans || [])[s.k];
  if (!pl) return tgSay(c, 'المنتج تغيّر، ابدأ من جديد: /sale');
  const key = s.pid + '|' + pl.id, until = Date.now() + s.h * 36e5;
  const plans = p.plans.map((x, j) => j === s.k ? { ...x, price: s.price, compare: Math.max(+x.compare || 0, +x.price), deal: { until, bot: 1 }, ...(+x.tgPrice > 0 ? { tgPrice: s.price } : {}) } : x);
  const card = { ...tgSaleCard(c.data, tgBotView(p) || p, s.k, s.price, until), chan: tgChanAuto(c.data.settings) };
  try {
    await c.fs.commit([
      c.fs.wUpdate('products/' + s.pid, { plans }, ['plans'], { updateTime: doc.updateTime }),
      c.fs.wUpdate('tgMeta/sales', { s: { [key]: { pid: s.pid, plan: pl.id, price: s.price, old: +pl.price, oldCmp: +pl.compare || 0, oldTg: +pl.tgPrice || 0, until, warned: s.h < 12 } } }, ['s.' + fp(key)]),
      c.fs.wUpdate('tgPosts/s' + Date.now(), { ...card, a: '', n: 0, by: c.chat, at: Date.now(), lock: 0 }, null, { exists: false }),
    ]);
  } catch (e) { return tgSay(c, 'ما زبط، جرّب كمان مرة: /sale'); }
  TGC.at = 0;
  await tgSay(c, `✅ <b>بدأ العرض</b>: ${esc(tgVName(p, pl))} بـ ${tgN(s.price)} ₪ لحد ${tgWhen(until, true)}.\nبلّشنا نبعته للكل، وبخبرك لما يخلص.`);
  await tgJobRun(c.fs, c.env);
}
async function tgSaleStop(c, key) {
  if (!tgIsAdmin(c)) return;
  const sd = await c.fs.get('tgMeta/sales'), sale = sd && (sd.data.s || {})[key];
  if (!sale) { c.alert = 'هالعرض خلص'; return tgSaleMenu(c); }
  await tgSaleEnd(c.fs, key, sale);
  TGC.at = 0; c.data = await tgData(c.fs);
  c.alert = '⏹ وقّفنا العرض ورجع السعر';
  return tgSaleMenu(c);
}
// deals from the admin page with an end time: when it passes, the price goes back to the price before the discount
async function tgDealsEnd(fs, rows, now) {
  const w = [];
  for (const r of rows) {
    const plans = r.data.plans;
    if (!Array.isArray(plans) || !plans.some(x => x && x.deal && !x.deal.bot && +x.deal.until && +x.deal.until <= now)) continue;
    w.push(fs.wUpdate('products/' + r.id, { plans: plans.map(x => {
      if (!x || !x.deal || x.deal.bot || !(+x.deal.until) || +x.deal.until > now) return x;
      const y = { ...x };
      if (+y.compare > +y.price) { y.price = +y.compare; y.compare = 0; }
      delete y.deal;
      return y;
    }) }, ['plans'], { updateTime: r.updateTime }));
  }
  for (const x of w) await fs.commit([x]).catch(() => {});
}
// put the price back (only if nobody changed it meanwhile) and forget the sale
async function tgSaleEnd(fs, key, sale) {
  const doc = await fs.get('products/' + sale.pid), w = [fs.wUpdate('tgMeta/sales', {}, ['s.' + fp(key)])];
  if (doc) {
    const plans = (doc.data.plans || []).map(x => {
      if (!x || x.id !== sale.plan) return x;
      const y = { ...x };
      if (+x.price === +sale.price) { y.price = sale.old; y.compare = sale.oldCmp; }
      if (y.deal && y.deal.bot) delete y.deal;
      if (+sale.oldTg > 0 && +x.tgPrice === +sale.price) y.tgPrice = sale.oldTg;
      return y;
    });
    w.unshift(fs.wUpdate('products/' + sale.pid, { plans }, ['plans'], { updateTime: doc.updateTime }));
  }
  await fs.commit(w);
}
// inside the 10-minute look: end sales whose time is up; 3 hours before the end of a long one, one reminder
async function tgSales(fs, all, data, now) {
  const sd = await fs.get('tgMeta/sales'), s = (sd && sd.data.s) || {}, w = [];
  for (const [key, sale] of Object.entries(s)) {
    if (now >= +sale.until) { try { await tgSaleEnd(fs, key, sale); } catch (e) {} continue; }
    if (!sale.warned && +sale.until - now <= 3 * 36e5) {
      const p = all.find(x => x.id === sale.pid), k = p ? (p.plans || []).findIndex(x => x && x.id === sale.plan) : -1;
      if (k >= 0) {
        const card = tgSaleCard(data, p, k, sale.price, +sale.until, `⏳ <b>آخر ${Math.max(1, Math.round((+sale.until - now) / 36e5))} ساعات على العرض!</b>`);
        w.push(fs.wUpdate('tgPosts/r' + now + '_' + w.length, { ...card, chan: tgChanAuto(data.settings), a: '', n: 0, by: 0, at: now + w.length, lock: 0 }, null, { exists: false }));
      }
      w.push(fs.wUpdate('tgMeta/sales', { s: { [key]: { ...sale, warned: true } } }, ['s.' + fp(key)]));
    }
  }
  if (w.length) await fs.commit(w);
  return s;
}

async function tgRateText(c, text) {
  const id = c.S.rvw; tgReset(c);
  const t = String(text).trim().slice(0, 500);
  if (t.length < 2) return tgSay(c, 'تمام 🤍');
  const r = await c.fs.get('reviews/' + id);
  if (!r || r.data.tgChat !== c.chat) return tgSay(c, 'تمام 🤍');
  await c.fs.commit([c.fs.wUpdate('reviews/' + id, { text: t }, ['text'], { updateTime: r.updateTime })]).catch(() => {});
  return tgSay(c, '✅ وصل رأيك، شكراً إلك 🤍');
}

// ---------------------------------------------------------------- bot announcements
// Every ~10 minutes the cron compares the products with the last look. A new product, a product or
// duration that is back in stock, new instant codes, or a lower price becomes one message that goes
// to everyone on tgUsers, about 25 people per run. Hazem can switch it off in the admin settings
// (settings.tgCast = false); a customer can switch it off with 🔕.
const CAST_EVERY = 9.5 * 60e3, CAST_GAP = 6 * 3600e3;
async function tgCastRun(fs, env, s, now) {
  let C = {};
  try { C = JSON.parse(s.tgCast || '{}') || {}; } catch (e) {}
  delete C.jobs;
  if (now - (+C.scan || 0) >= CAST_EVERY && BUDGET >= 14) {
    try { await tgCastScan(fs, env, C, now); C.err = ''; } catch (e) { C.err = String(e && e.message).slice(0, 200); }
  }
  try { await tgDaily(fs, env, C, now); } catch (e) { C.err = 'daily: ' + String(e && e.message).slice(0, 180); }
  try { await tgRenewals(fs, env, C, now); } catch (e) { C.err = 'renew: ' + String(e && e.message).slice(0, 180); }
  try { await tgNudges(fs, env, C, now); } catch (e) { C.err = 'nudge: ' + String(e && e.message).slice(0, 180); }
  try { await tgJobRun(fs, env); } catch (e) { C.err = String(e && e.message).slice(0, 200); }
  return JSON.stringify(C);
}
function tgSnap(p) {
  const o = p.soldOut || p.active === false ? 1 : 0, pl = {};
  for (const x of p.plans || []) if (x && x.id && +x.price > 0) pl[x.id] = [+x.price, x.out ? 1 : 0];
  return { o, p: pl };
}
async function tgCastScan(fs, env, C, now) {
  const [rows, sd] = await Promise.all([fs.list('products'), fs.get('settings/main')]);
  const settings = (sd && sd.data) || {}, all = rows.map(d => tgBotView({ ...d.data, id: d.id }) || { ...d.data, id: d.id, active: false });
  const first = !C.base, base = C.base || {}, nb = {}, on = settings.tgCast !== false && settings.siteOrders !== false;
  C.scan = now;
  // sales whose time is up go back to their price; people waiting for a duration that is back get told
  const pre = { settings, stock: {}, icons: {} };
  try { const ic = await fs.get('tgMeta/icons'), im = ic && ic.data; pre.icons = im && im.on !== false && (im.prem || im.force) ? { ...(im.map || {}), ...(im.man || {}) } : {}; } catch (e) {}
  let sales = {};
  try { sales = await tgSales(fs, all, pre, now); } catch (e) { C.err = 'sales: ' + String(e && e.message).slice(0, 180); }
  try { await tgDealsEnd(fs, rows, now); } catch (e) { C.err = 'deals: ' + String(e && e.message).slice(0, 180); }
  try { await tgWatchers(fs, all, pre, now); } catch (e) { C.err = 'watch: ' + String(e && e.message).slice(0, 180); }
  // instant codes added since the last look
  const added = {};
  if (!first && all.some(p => (p.plans || []).some(x => x && x.instant))) {
    const rs = await fs.query('stock', [['createdAt', 'GREATER_THAN', new Date(+C.sc || now)]], 500, 'createdAt', ['pid', 'plan', 'createdAt']);
    for (const r of rs) { const k = r.data.pid + '|' + r.data.plan; added[k] = (added[k] || 0) + 1; C.sc = Math.max(+C.sc || 0, (+r.data.createdAt || 0) + 1); }
  }
  if (!C.sc || first) C.sc = now;
  C.ann = C.ann || {};
  for (const k of Object.keys(C.ann)) if (now - C.ann[k] > CAST_GAP) delete C.ann[k];
  const ev = [];
  for (const p of all) {
    const cur = tgSnap(p), b = base[p.id];
    nb[p.id] = cur;
    if (first || !on || !Array.isArray(p.plans)) continue;
    const live = Object.keys(cur.p).filter(id => !cur.o && !cur.p[id][1]);
    if (!live.length) continue;
    let e = null;
    if (!b) e = { k: 'new' };
    else {
      const codes = live.filter(id => added[p.id + '|' + id]);
      const back = live.filter(id => b.o || !b.p[id] || b.p[id][1]);
      const drop = live.filter(id => b.p[id] && cur.p[id][0] < b.p[id][0] - 0.001 && !sales[p.id + '|' + id]); // a sale has its own announcement
      if (codes.length) e = { k: 'codes', plan: codes[0], n: added[p.id + '|' + codes[0]] };
      else if (back.length) e = { k: back.some(id => !b.p[id]) && !b.o ? 'new' : 'back' };
      else if (drop.length) e = { k: 'price', plan: drop[0], was: b.p[drop[0]][0] };
    }
    if (e && e.k === 'back' && !b.o) { const bk = live.filter(id => b.p[id] && b.p[id][1]); if (bk.length === 1) e.plan = bk[0]; }
    if (!e) continue;
    if (C.ann[p.id] && now - C.ann[p.id] < CAST_GAP) continue; // one announcement per product every 6 hours
    C.ann[p.id] = now;
    ev.push({ ...e, p });
  }
  C.base = nb;
  if (!ev.length) return;
  const data = { settings, stock: {}, icons: pre.icons };
  for (const e of ev.filter(x => x.k === 'codes').slice(0, 3)) {
    try { data.stock[e.p.id + '|' + e.plan] = await fs.count('stock', [['pid', 'EQUAL', e.p.id], ['plan', 'EQUAL', e.plan], ['owner', 'IS_NULL']]); } catch (err) {}
  }
  try { const ic = await fs.get('tgMeta/icons'), im = ic && ic.data; data.icons = im && im.on !== false && (im.prem || im.force) ? { ...(im.map || {}), ...(im.man || {}) } : {}; } catch (err) { data.icons = {}; }
  const w = ev.slice(0, 5).map((e, n) => {
    const k = e.plan ? e.p.plans.findIndex(x => x && x.id === e.plan) : -1, pl = k >= 0 ? e.p.plans[k] : null;
    const deal = pl && pl.deal && !pl.deal.bot ? pl.deal : null;
    const extra = e.k === 'codes' ? [`➕ انضاف: ${e.n}`] : e.k === 'price' && pl ? (deal ? ['🔥 <b>عرض!</b>', ...(+deal.until > now ? [`⏳ لحد ${tgWhen(+deal.until, true)}`] : [])] : [`🔻 نزل السعر (كان ${tgN(e.was)} ₪)`]) : e.k === 'back' ? ['🔄 رجع متوفر'] : ['🆕 جديد عنا'];
    const job = tgPostCard(data, e.p, k >= 0 ? k : null, extra);
    return fs.wUpdate('tgPosts/c' + now + '_' + n, { ...job, chan: tgChanAuto(settings), a: '', n: 0, by: 0, at: now + n, lock: 0 }, null, { exists: false });
  });
  await fs.commit(w);
}

// send the oldest waiting announcement (tgPosts) to the next people on the list; ~25 per run
async function tgJobRun(fs, env) {
  if (BUDGET < 7) return;
  const [doc] = await fs.query('tgPosts', [], 1, 'at');
  if (!doc) return;
  const j = { ...doc.data };
  if (j.lock && Date.now() - j.lock < 90e3) return; // someone else is sending it right now
  try { await fs.commit([fs.wUpdate('tgPosts/' + doc.id, { lock: Date.now() }, ['lock'], { updateTime: doc.updateTime })]); } catch (e) { return; }
  const lim = Math.max(1, Math.min(25, BUDGET - 5));
  if (j.chan && !j.chDone) { // the store's channel first, with buttons that open the bot
    const bot = await tgMe(env);
    const ok = await tgPostTo(env, { ...j, k: tgChanKb(j.k || [], bot) }, j.chan);
    j.chDone = true;
    if (!ok && j.by) await tg(env, 'sendMessage', { chat_id: j.by, text: `⚠️ ما قدرت أنشر بالقناة ${esc(j.chan)}: ${esc(TGERR || '')}\nتأكد إنه البوت أدمن بالقناة وإله صلاحية النشر (ابعت /channel).`, parse_mode: 'HTML' });
    else if (ok && j.by && Array.isArray(j.to) && !j.to.length) await tg(env, 'sendMessage', { chat_id: j.by, text: `✅ انتشر بالقناة ${esc(j.chan)}.` });
    if (Array.isArray(j.to) && !j.to.length) { await fs.commit([{ delete: fs.name('tgPosts/' + doc.id) }]); return; }
    await fs.commit([fs.wUpdate('tgPosts/' + doc.id, { chDone: true }, ['chDone'])]);
  }
  if (Array.isArray(j.to)) { // a message for some people only
    let i = +j.i || 0, stop2 = false;
    for (const chat of j.to.slice(i, i + lim)) {
      if (BUDGET < 4) { stop2 = true; break; }
      const ok = await tgPostTo(env, j, chat);
      if (!ok && /too many|retry after/i.test(TGERR)) { stop2 = true; break; }
      if (ok) j.n = (+j.n || 0) + 1;
      i++;
    }
    const fin = !stop2 && i >= j.to.length;
    await fs.commit([fin ? { delete: fs.name('tgPosts/' + doc.id) } : fs.wUpdate('tgPosts/' + doc.id, { i, n: +j.n || 0, ph: j.ph || '', lock: 0 }, ['i', 'n', 'ph', 'lock'])]);
    if (fin && j.by) await tg(env, 'sendMessage', { chat_id: j.by, text: `✅ <b>خلص الإعلان</b>: وصل لـ ${+j.n || 0} شخص.`, parse_mode: 'HTML' });
    return;
  }
  const rows = await fs.page('tgUsers', j.a || '', lim), off = [];
  let done = 0, stop = false;
  for (const r of rows) {
    if (BUDGET < 4) { stop = true; break; }
    if (!r.data.off) {
      const ok = await tgPostTo(env, j, r.id);
      if (ok) j.n = (+j.n || 0) + 1;
      else if (/too many|retry after/i.test(TGERR)) { stop = true; break; }   // Telegram says slow down: this person again next run
      else if (TG_GONE.test(TGERR)) off.push(r.id);
    }
    j.a = r.id; done++;
  }
  const end = !stop && done === rows.length && rows.length < lim;   // reached the end of the list
  const w = [end ? { delete: fs.name('tgPosts/' + doc.id) } : fs.wUpdate('tgPosts/' + doc.id, { a: j.a || '', n: +j.n || 0, ph: j.ph || '', img: j.img || '', lock: 0 }, ['a', 'n', 'ph', 'img', 'lock'])];
  // people who blocked the bot: stop sending; if they come back, the bot puts them on the list again
  for (const id of off) w.push(fs.wUpdate('tgUsers/' + id, { off: true }, ['off']), fs.wUpdate('tgBot/' + id, { reg: 0 }, ['reg']));
  await fs.commit(w);
  if (end && j.by) await tg(env, 'sendMessage', { chat_id: j.by, text: `✅ <b>خلص الإعلان</b>: وصل لـ ${+j.n || 0} شخص.`, parse_mode: 'HTML' });
}
async function tgPostTo(env, j, chat) {
  const kb = j.k || [];
  if (j.copy) return !!(await tgCall(env, 'copyMessage', { chat_id: chat, from_chat_id: j.copy.fc, message_id: +j.copy.mid }, kb)); // a free post: copied as Hazem wrote it
  if ((j.ph || j.img) && String(j.t).length <= 1000) {
    const r = await tgCall(env, 'sendPhoto', { chat_id: chat, photo: j.ph || j.img, caption: j.t, parse_mode: 'HTML' }, kb);
    if (r) { if (!j.ph && r.photo && r.photo.length) j.ph = r.photo[r.photo.length - 1].file_id; return true; }
    if (TG_GONE.test(TGERR) || /too many|retry after/i.test(TGERR)) return false;
    j.img = ''; j.ph = ''; // the picture did not work: plain text from now on
  }
  return !!(await tgCall(env, 'sendMessage', { chat_id: chat, text: j.t, parse_mode: 'HTML', disable_web_page_preview: true }, kb));
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
  const where = filters => {
    const fl = filters.map(([f, op, v]) => op === 'IS_NULL' ? { unaryFilter: { op: 'IS_NULL', field: { fieldPath: f } } } : { fieldFilter: { field: { fieldPath: f }, op, value: toValue(v) } });
    return fl.length > 1 ? { compositeFilter: { op: 'AND', filters: fl } } : fl[0];
  };
  const run = async body => {
    const r = await xf(api + root + ':runQuery', { method: 'POST', headers: H, body: JSON.stringify(body) });
    if (!r.ok) throw fail('firestore query ' + r.status + ' ' + (await r.text()).slice(0, 300), 502);
    return (await r.json()).filter(x => x.document).map(x => parse(x.document));
  };
  return {
    project, name,
    async get(p) {
      const r = await xf(api + name(p), { headers: H });
      if (r.status === 404) return null;
      if (!r.ok) throw fail('firestore get ' + r.status + ' ' + (await r.text()).slice(0, 200), 502);
      return parse(await r.json());
    },
    async list(col) {
      const out = [];
      let tok = '';
      for (let i = 0; i < 3; i++) {
        const r = await xf(api + root + '/' + col + '?pageSize=300' + (tok ? '&pageToken=' + encodeURIComponent(tok) : ''), { headers: H });
        if (!r.ok) throw fail('firestore list ' + r.status, 502);
        const j = await r.json();
        for (const d of j.documents || []) out.push(parse(d));
        tok = j.nextPageToken;
        if (!tok) break;
      }
      return out;
    },
    async query(col, filters, limit, orderBy, select) {
      const body = { structuredQuery: { from: [{ collectionId: col }], where: where(filters), limit } };
      if (orderBy) body.structuredQuery.orderBy = [{ field: { fieldPath: orderBy }, direction: 'ASCENDING' }];
      if (select) body.structuredQuery.select = { fields: select.map(f => ({ fieldPath: f })) };
      return run(body);
    },
    // one page of a whole collection in id order, starting after the id `after`
    async page(col, after, limit) {
      const q = { from: [{ collectionId: col }], orderBy: [{ field: { fieldPath: '__name__' }, direction: 'ASCENDING' }], limit };
      if (after) q.startAt = { values: [{ referenceValue: name(col + '/' + after) }], before: false };
      return run({ structuredQuery: q });
    },
    // how many documents match (one cheap read instead of reading them all)
    async count(col, filters) {
      const r = await xf(api + root + ':runAggregationQuery', { method: 'POST', headers: H, body: JSON.stringify({ structuredAggregationQuery: { structuredQuery: { from: [{ collectionId: col }], where: where(filters) }, aggregations: [{ alias: 'n', count: {} }] } }) });
      if (!r.ok) throw fail('firestore count ' + r.status + ' ' + (await r.text()).slice(0, 300), 502);
      const j = await r.json(), f = j && j[0] && j[0].result && j[0].result.aggregateFields && j[0].result.aggregateFields.n;
      return f ? +(f.integerValue || 0) : 0;
    },
    wUpdate(p, fields, mask, pre, transforms) {
      const w = { update: { name: name(p), fields: toFields(fields) } };
      if (mask) w.updateMask = { fieldPaths: mask };
      if (pre) w.currentDocument = pre;
      if (transforms && transforms.length) w.updateTransforms = transforms;
      return w;
    },
    async commit(writes) {
      const r = await xf(api + root + ':commit', { method: 'POST', headers: H, body: JSON.stringify({ writes }) });
      if (!r.ok) { const t = await r.text(); console.error('commit', r.status, t.slice(0, 300)); throw fail('commit ' + r.status + ' ' + t.slice(0, 300), r.status); }
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
  const r = await xf('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=' + unsigned + '.' + b64url(sig) });
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
  if (v instanceof Date) return { timestampValue: v.toISOString() };
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
