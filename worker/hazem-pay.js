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
const HOLD_H = 24;              // hours an exact amount belongs to one payment, and we keep accepting it
const CHUNKS = 8; // getLogs calls per check (each covers SPAN blocks, SPAN shrinks by itself if a node refuses)

const SITE = 'https://hazem-store.com';
let BUDGET = 45; // outside calls left in this run (Cloudflare allows 50 on the free plan)
function xf(url, init) { if (BUDGET <= 0) { const e = fail('busy, try again', 503); e.budget = true; throw e; } BUDGET--; return fetch(url, init); }
const VERSION = 12;
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
async function health(env) {
  if (!env.SA_JSON) return { ok: false, service: 'hazem-pay', error: 'SA_JSON missing', notify: channels(env) };
  const fs = await firestore(env);
  const s = await fs.get('settings/main');
  const m = s && (s.data.payments || []).find(isUsdt);
  const st = await fs.get('payState/main');
  const sd = (st && st.data) || {};
  return { ok: true, service: 'hazem-pay', version: VERSION, project: fs.project, usdt: m ? { auto: !!m.auto, bsc: validAddr('bsc', m.number), tron: validAddr('tron', m.tron) } : null, notify: channels(env), bot: !!env.SHOP_BOT_TOKEN, ...(env.SHOP_BOT_TOKEN ? { botNews: castInfo(sd.tgCast, s && s.data, await fs.count('tgPosts', []).catch(() => -1)) } : {}), cron: sd.cronAt || 0, cronErr: sd.cronErr || '', cronFail: sd.cronFail || 0 };
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
    // part paid from the customer's balance (taken when the order was made) is not asked again
    const ils = kind === 'topup' ? +d.amount : Math.round((await orderTotal(fs, d) - (+d.walletPart > 0 ? +d.walletPart : 0)) * 100) / 100;
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
        const wk = watchKey(kind, id);
        await fs.commit([
          fs.wUpdate(`payLocks/${lockId}`, { ref, exp: pay.lockExp }, null, lock ? { updateTime: lock.updateTime } : { exists: false }),
          fs.wUpdate(ref, { pay }, ['pay'], { updateTime: doc.updateTime }),
          fs.wUpdate('payState/main', { w: { [wk]: pay.lockExp } }, ['w.' + fp(wk)]), // the cron keeps checking it
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
async function check(fs, env, b, ctx, chunks) {
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
    const to = Math.min(latest, from + SPAN * (chunks || CHUNKS) - 1);
    if (to >= from) { const r = await bscFind(p.addr, p.amt, from, to); hits = r.hits; if (r.upto >= from) scanned = r.upto; }
  } else {
    hits = await tronFind(env, p.addr, p.amt, p.startTs);
  }
  for (const h of hits) {
    const res = await settle(fs, env, kind, ref, id, h, ctx);
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

async function settle(fs, env, kind, ref, id, hit, ctx, again) {
  const doc = await fs.get(ref);
  if (!doc) return null;
  const d = doc.data;
  if (d.status !== 'pending') return finished(fs, d);
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
  if (claims) out.codes = await readCodes(fs, { ...d, stockIds: claims.map(c => c.id) });
  await later(ctx, notifyPaid(fs, env, kind, id, d, out));
  return out;
}
// in a request: send after answering; in the cron: wait for it
function later(ctx, p) { const q = p.catch(e => console.error('notify', e && e.message)); if (ctx && ctx.waitUntil) { ctx.waitUntil(q); return Promise.resolve(); } return q; }
function watchKey(kind, id) { return (kind === 'topup' ? 't_' : 'o_') + id; }
function fp(seg) { return /^[A-Za-z_][A-Za-z0-9_]*$/.test(seg) ? seg : '`' + seg.replace(/[`\\]/g, '\\$&') + '`'; }

// ---------------------------------------------------------------- cron: every 2 minutes
async function cron(env) {
  const fs = await firestore(env), now = Date.now();
  const st = await fs.get('payState/main'), s = (st && st.data) || {};
  const fields = { cronAt: now }, mask = ['cronAt'], errs = [];
  // 1. payments still waiting: keep checking them even if the customer closed the page
  const w = s.w || {};
  for (const key of shuffle(Object.keys(w)).slice(0, 4)) {
    if (BUDGET < 22) break; // keep enough for new-order messages and saving
    let done = w[key] < now;
    if (!done) {
      try {
        const r = await check(fs, env, { kind: key[0] === 't' ? 'topup' : 'order', id: key.slice(2) }, null, 2);
        done = r.status !== 'pending' || r.nopay || r.expired;
      } catch (e) { done = e.status === 404 || e.status === 400; errs.push('check ' + key + ': ' + (e && e.message)); }
    }
    if (done) mask.push('w.' + fp(key));
  }
  // 1b. orders from the Telegram bot: tell the customer there when Hazem confirms, delivers or cancels
  if (env.SHOP_BOT_TOKEN) {
    const tw = s.tg || {};
    for (const id of Object.keys(tw).slice(0, 6)) {
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
  await fs.commit([fs.wUpdate('payState/main', fields, mask)]);
  return { checked: Object.keys(w).length };
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
  await notifyAdmin(env, '✅ وصلت دفعة USDT — طلب ' + (d.orderNo || ''), [...itemLines(d), ...mixLine(d), ...(r.walletShort ? ['⚠️ رصيد الزبون ما كفى للجزء ' + money(d.walletPart) + '، اطلب منه الباقي قبل التسليم'] : []), 'وصل: ' + paid, 'الزبون: ' + who(d) + (d.email ? ' · ' + d.email : ''), done ? 'الحالة: تسلّم تلقائياً بكود ✓' : 'الحالة: قيد التسليم — سلّمه الاشتراك'], SITE + '/admin.html');
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
let RPCS = BSC_PUBLIC, rpcI = 0, SPAN = 200;
const RANGE_ERR = /range|too (large|big|wide)|block limit|max(imum)? .{0,20}block|more than \d+ (blocks|results)|10000 results|response size/i;
const rest = {}; // node → time it may be tried again (it said it is busy or needs a key)
function useRpcs(env) {
  const own = String((env && env.BSC_RPC) || '').split(',').map(x => x.trim()).filter(x => /^https:\/\//.test(x));
  const list = own.concat(BSC_PUBLIC.filter(u => !own.includes(u)));
  if (list.join() !== RPCS.join()) { RPCS = list; rpcI = 0; if (own.length && SPAN === 200) SPAN = 1000; } // a private node answers bigger ranges
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
// returns the matches and the last block fully looked at (stops early if few calls are left)
async function bscFind(addr, amt, from, to) {
  const topic = '0x000000000000000000000000' + addr.toLowerCase().replace(/^0x/, ''), hits = [];
  let a = from;
  while (a <= to && BUDGET > 12) {
    const b = Math.min(to, a + SPAN - 1);
    let logs;
    try { logs = await rpc('eth_getLogs', [{ address: USDT_BSC, fromBlock: '0x' + a.toString(16), toBlock: '0x' + b.toString(16), topics: [TRANSFER, null, topic] }]); }
    catch (e) { if (SPAN > 25 && RANGE_ERR.test(String(e && e.message))) { SPAN = Math.max(25, Math.floor(SPAN / 2)); continue; } if (a > from) break; throw e; }
    for (const l of logs || []) {
      const v = Number(BigInt(l.data) / 10n ** 12n) / 1e6; // 18 decimals → 6, no float drift
      if (Math.abs(v - amt) < 0.0005) hits.push({ tx: l.transactionHash, amt: r3(v) });
    }
    a = b + 1;
  }
  return { hits, upto: a - 1 };
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
async function tronFind(env, addr, amt, sinceTs) {
  const u = `https://api.trongrid.io/v1/accounts/${addr}/transactions/trc20?only_to=true&only_confirmed=true&limit=200&contract_address=${USDT_TRON}&min_timestamp=${Math.floor(sinceTs)}`;
  const r = await xf(u, { headers: env.TRONGRID_KEY ? { 'TRON-PRO-API-KEY': env.TRONGRID_KEY } : {}, signal: AbortSignal.timeout ? AbortSignal.timeout(10000) : undefined });
  if (!r.ok) throw new Error('trongrid ' + r.status);
  const j = await r.json(), hits = [], want = Math.round(amt * 1e6);
  for (const t of j.data || []) {
    if (t.to !== addr || (t.token_info && t.token_info.address !== USDT_TRON)) continue;
    const v = Number(t.value);
    if (Math.abs(v - want) < 500) hits.push({ tx: t.transaction_id, amt: r3(v / 1e6) });
  }
  return hits;
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
  const set = await tg(env, 'setWebhook', { url: hook, secret_token: await tgSecret(env), allowed_updates: ['message', 'callback_query'], drop_pending_updates: true, max_connections: 10 });
  await tg(env, 'setMyCommands', { commands: [{ command: 'start', description: 'الصفحة الرئيسية' }, { command: 'products', description: 'المنتجات' }, { command: 'orders', description: 'طلباتي' }, { command: 'help', description: 'مساعدة وتواصل' }] });
  await tg(env, 'setMyDescription', { description: STORE + ': كل اشتراكاتك الرقمية بالشيكل. ChatGPT وClaude وCanva وCapCut وشاهد وغيرهم، دفع بجوال باي أو بال باي أو بنك فلسطين أو USDT، وتسليم خلال دقائق.' });
  await tg(env, 'setMyShortDescription', { short_description: 'اشتراكات رقمية بالشيكل، اطلب وادفع واستلم هون خلال دقائق' });
  return { ok: !!set, bot: '@' + me.username, link: 'https://t.me/' + me.username, webhook: hook };
}

// POST /tg/hook : every message and button press from Telegram
async function tgHook(req, env) {
  const ok = new Response('ok');
  if (req.method !== 'POST' || !env.SHOP_BOT_TOKEN) return ok;
  if (req.headers.get('x-telegram-bot-api-secret-token') !== await tgSecret(env)) return new Response('forbidden', { status: 403 });
  let u;
  try { u = await req.json(); } catch (e) { return ok; }
  try { await tgUpdate(env, u); } catch (e) {
    console.error('tg update', e && (e.stack || e.message));
    const cb = u.callback_query, chat = (u.message && u.message.chat && u.message.chat.id) || (cb && cb.message && cb.message.chat.id);
    if (chat) { try { await tg(env, 'sendMessage', { chat_id: chat, text: 'صار خطأ عندنا 🙏 جرّب كمان مرة بعد شوي، أو كلّمنا على الدعم.', reply_markup: { inline_keyboard: [[{ text: '🏠 الرئيسية', callback_data: 'home' }]] } }); } catch (e2) {} }
  }
  return ok;
}

async function tgData(fs) {
  if (TGC.products && Date.now() - TGC.at < 60e3) return TGC;
  const [rows, s, ic] = await Promise.all([fs.list('products'), fs.get('settings/main'), fs.get('tgMeta/icons')]);
  const settings = (s && s.data) || {};
  const products = rows.map(d => ({ ...d.data, id: d.id }))
    .filter(p => p.active !== false && Array.isArray(p.plans) && p.plans.some(pl => +pl.price > 0))
    .sort((a, b) => (+a.sort || 0) - (+b.sort || 0));
  TGC = { at: Date.now(), products, settings, icons: ic && ic.data.on !== false ? ic.data.map || {} : {}, ph: (TGC && TGC.ph) || {} };
  return TGC;
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
  const cb = u.callback_query, m = u.message;
  const chatObj = cb ? cb.message && cb.message.chat : m && m.chat;
  if (!chatObj || chatObj.type !== 'private') return;
  const fs = await firestore(env), data = await tgData(fs);
  const sd = await fs.get('tgBot/' + chatObj.id);
  const c = { env, fs, data, chat: chatObj.id, from: (cb ? cb.from : m.from) || {}, S: (sd && sd.data) || {}, msgId: cb && cb.message ? cb.message.message_id : 0, dirty: false, alert: '' };
  c.isPhoto = !!(cb && cb.message && (cb.message.photo || cb.message.caption != null));
  if (cb) {
    await tgOnButton(c, String(cb.data || ''));
    await tg(env, 'answerCallbackQuery', c.alert ? { callback_query_id: cb.id, text: c.alert, show_alert: true } : { callback_query_id: cb.id });
  } else await tgOnMessage(c, m);
  // everyone who talks to the bot goes on the list for announcements (tgUsers), once
  const fresh = !sd || !sd.data.reg;
  if (c.dirty || fresh) {
    const w = [fs.wUpdate('tgBot/' + c.chat, { ...c.S, at: Date.now(), reg: 1 })];
    if (fresh) w.push(fs.wUpdate('tgUsers/' + c.chat, { name: tgWho(c.from), user: c.from.username || '', at: Date.now(), off: false }, ['name', 'user', 'at', 'off']));
    await fs.commit(w);
  }
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
    if (keep && text.length <= 1000) { const r = await tgCall(c.env, 'editMessageCaption', { chat_id: c.chat, message_id: c.msgId, caption: text, parse_mode: 'HTML' }, kb || []); if (r) return r; }
    c.msgId = 0;
    return tgSay(c, text, kb);
  }
  if (c.msgId) { const r = await tgCall(c.env, 'editMessageText', { chat_id: c.chat, message_id: c.msgId, text, parse_mode: 'HTML', disable_web_page_preview: true }, kb || []); if (r) return r; }
  return tgSay(c, text, kb);
}
// a product card with its logo on top; plain text when there is no logo or the picture does not work
async function tgSayCard(c, p, text, kb) {
  const logo = text.length <= 1000 && (c.data.ph[p.id] || tgLogo(p));
  if (logo) {
    const r = await tgCall(c.env, 'sendPhoto', { chat_id: c.chat, photo: logo, caption: text, parse_mode: 'HTML' }, kb);
    if (r) { if (r.photo && r.photo.length) c.data.ph[p.id] = r.photo[r.photo.length - 1].file_id; return r; }
    if (TG_GONE.test(TGERR)) return null;
    delete c.data.ph[p.id];
  }
  return tgSay(c, text, kb);
}
function tgReset(c) { if (Object.keys(c.S).length) { c.S = {}; c.dirty = true; } }
function tgClosed(c) { return c.data.settings.siteOrders === false; }

async function tgHome(c, fresh) {
  const names = c.data.products.slice(0, 5).map(p => tgClean(p.name)).join(' و');
  const hi = c.from.first_name ? ' ' + esc(c.from.first_name) : '';
  const text = `أهلين${hi} في <b>${esc(c.data.settings.storeName || STORE)}</b> 👋\nكل اشتراكاتك الرقمية بالشيكل: ${esc(names)} وغيرهم.\nادفع بـ${esc(tgPayList(c))}، واستلم هون خلال دقائق.\n\nاختار من تحت 👇`;
  const kb = [[tgBtn('🛒 المنتجات', 'prods')], [tgBtn('🔎 بحث', 'find'), tgBtn('📦 طلباتي', 'orders')], [tgBtn('❓ كيف بشتري', 'help'), tgUrl('💬 الدعم', tgSup(c))]];
  if (tgIsAdmin(c)) kb.push([tgBtn('📢 إعلان للمشتركين', 'post')]);
  return fresh ? tgSay(c, text, kb) : tgShow(c, text, kb);
}
// an emoji for each product: from its name, else from its section (the stand-in when there is no brand icon)
const TG_ICON = [[/chatgpt|openai/i, '🤖'], [/claude/i, '🧠'], [/grok/i, '⚡'], [/gemini/i, '✨'], [/perplexity/i, '🔎'], [/canva/i, '🎨'], [/capcut/i, '🎬'], [/adobe/i, '🅰️'], [/autodesk/i, '📐'],
  [/duolingo/i, '🦉'], [/office|word|excel/i, '📄'], [/notion/i, '📝'], [/pdf/i, '📑'], [/jetbrains/i, '💻'], [/miro/i, '🧩'], [/lovable/i, '💜'], [/wispr/i, '🎙️'], [/muse/i, '🎵'],
  [/shahid|شاهد|netflix|نتفلكس/i, '🎬'], [/esim|شرائح|شريحة|انترنت|إنترنت/i, '📶'], [/توثيق/, '☑️'], [/إعلان|اعلان|ممول/, '📣'], [/تيليجرام|تلغرام|telegram/i, '✈️'],
  [/انستغرام|انستجرام|إنستغرام|instagram/i, '📸'], [/فيسبوك|facebook/i, '📘'], [/تويتر|twitter/i, '🐦'], [/snap|سناب/i, '👻'], [/youtube|يوتيوب/i, '▶️'], [/spotify|سبوتيفاي/i, '🎧']];
const TG_CAT_ICON = [[/ذكاء/, '🤖'], [/تصميم|مونتاج/, '🎨'], [/تعليم|إنتاج|انتاج/, '📚'], [/انترنت|إنترنت/, '📶'], [/سوشال|تواصل/, '📱'], [/برمج/, '💻'], [/افلام|أفلام|مسلسل/, '🎬'], [/العاب|ألعاب/, '🎮']];
function tgIcon(data, p) {
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
// all products as buttons, two in a row
function tgGrid(c, fresh) {
  const ps = c.data.products, kb = [...tgRows(ps.map(p => tgPBtn(c.data, p, 'g:' + p.id)), 2), [tgBtn('🔎 بحث', 'find'), tgBtn('🏠 الرئيسية', 'home')]];
  const text = `🛒 <b>المنتجات</b>\nاختار المنتج 👇${ps.some(tgOut) ? '\n🔴 = خلصت كميته هلأ' : ''}`;
  return fresh ? tgSay(c, text, kb) : tgShow(c, text, kb);
}
// how many instant codes are left for the instant plans of these products (cached a minute)
async function tgCounts(c, list) {
  const st = c.data.stock || (c.data.stock = {}), want = [];
  for (const p of list) for (const pl of p.plans || []) if (pl.instant && pl.id && +pl.price > 0 && !((p.id + '|' + pl.id) in st)) want.push([p.id, pl.id]);
  await Promise.all(want.slice(0, 6).map(async ([pid, plan]) => {
    try { st[pid + '|' + plan] = await c.fs.count('stock', [['pid', 'EQUAL', pid], ['plan', 'EQUAL', plan], ['owner', 'IS_NULL']]); } catch (e) {}
  }));
}
// the product card: name, prices, what is left
function tgCard(data, p, head, extra) {
  const st = data.stock || {}, nm = tgClean(p.name), plans = p.plans.filter(x => +x.price > 0), one = plans.length === 1;
  const gone = pl => !!p.soldOut || !!pl.out, live = plans.filter(x => !gone(x));
  const cnt = pl => pl.instant ? +st[p.id + '|' + pl.id] || 0 : 0;
  const price = pl => gone(pl) ? `<s>${tgN(pl.price)} ₪</s> نفدت` : (+pl.compare > +pl.price ? `<s>${tgN(pl.compare)} ₪</s> ` : '') + `<b>${tgN(pl.price)} ₪</b>`;
  const auto = (data.settings.payments || []).some(m => m.active !== false && isUsdt(m) && m.auto);
  const L = [];
  if (head) L.push(head, '');
  const pn = one ? tgClean(plans[0].name || '') : '';
  L.push(`${tgEmo(data, p)} <b>${esc(pn && pn !== nm ? nm + ' — ' + pn : nm)}</b>${p.badge ? ' · ' + esc(p.badge) : ''}`);
  if (extra && extra.length) L.push(...extra);
  if (one) {
    const pl = plans[0];
    L.push(`💵 السعر: ${price(pl)}`);
    L.push(gone(pl) ? '🔴 خلصت الكمية هلأ' : cnt(pl) ? `📦 المتوفر: ${cnt(pl)}` : '✅ متوفر');
    if (!gone(pl) && pl.war === 'yes') L.push('🛡 مضمون طول مدة الاشتراك');
  } else {
    L.push('💵 الأسعار:');
    for (const pl of plans.slice(0, 10)) L.push(`▫️ ${esc(tgClean(pl.name || nm))} — ${price(pl)}${!gone(pl) && cnt(pl) ? ' · 📦 ' + cnt(pl) : ''}${!gone(pl) && pl.war === 'yes' ? ' 🛡' : ''}`);
    if (!live.length) L.push('🔴 خلصت الكمية هلأ');
    else if (live.some(x => x.war === 'yes')) L.push('🛡 = مضمون طول مدة الاشتراك');
  }
  if (auto && live.some(cnt)) L.push('⚡ تسليم فوري لما تدفع USDT');
  return L.join('\n');
}
function tgProductView(c, p) {
  const desc = String(p.desc || '').trim().split('\n').filter(Boolean).slice(0, 2).join('\n').slice(0, 300);
  const extra = [...(desc ? [esc(desc)] : []), ...(p.features || []).filter(Boolean).slice(0, 3).map(f => '• ' + esc(f))];
  const plans = p.plans.map((pl, i) => ({ pl, i })).filter(x => +x.pl.price > 0), live = plans.filter(x => !p.soldOut && !x.pl.out);
  let text = tgCard(c.data, p, '', extra.length ? [...extra, ''] : []);
  const kb = !live.length ? [[tgBtn('🔔 نفدت، بنبلّغك أول ما يرجع', 'out')]]
    : plans.length === 1 ? [[tgBtn('🛒 اشتري الآن', `pl:${p.id}:${live[0].i}`)]]
    : live.map(x => [tgBtn(`🛒 ${tgClean(x.pl.name || p.name).slice(0, 24)} · ${tgN(x.pl.price)} ₪`, `pl:${p.id}:${x.i}`)]);
  if (plans.length > 1 && live.length) text += '\n\n👇 اختار المدة واكبس عليها';
  kb.push([tgBtn('« المنتجات', 'prods'), tgUrl('💬 اسأل', tgSup(c))]);
  return { text, kb };
}
async function tgProduct(c, id, fresh) {
  const p = c.data.products.find(x => x.id === id);
  if (!p) { c.alert = 'هالاشتراك مش متوفر هلأ'; return tgGrid(c); }
  await tgCounts(c, [p]);
  const v = tgProductView(c, p);
  return fresh || !c.msgId ? tgSayCard(c, p, v.text, v.kb) : tgShow(c, v.text, v.kb, true);
}
// 🛒 from an announcement: keep the announcement, carry on in a new message under it
function tgBuy(c, pid) {
  const p = c.data.products.find(x => x.id === pid);
  if (!p) { c.alert = 'هالاشتراك مش متوفر هلأ'; return; }
  if (tgOut(p)) { c.alert = 'خلصت كميته هلأ، وأول ما يرجع بنبعتلك إعلان هون 🔔'; return; }
  c.msgId = 0;
  const plans = p.plans.map((pl, i) => ({ pl, i })).filter(x => +x.pl.price > 0);
  if (plans.length === 1) return tgPlan(c, p.id, plans[0].i);
  return tgProduct(c, p.id, true);
}
async function tgHelp(c, edit) {
  const u = await c.fs.get('tgUsers/' + c.chat), muted = !!(u && u.data.mute);
  const text = `<b>كيف بتشتري؟</b>\n1. اكبس 🛒 المنتجات واختار اللي بدك\n2. اختار المدة، وادفع بـ${esc(tgPayList(c))}\n3. ابعت سكرين التحويل هون\n4. بنفعّلك وبنبعتلك التفاصيل هون بالبوت\n\n🔔 الإعلانات ${muted ? '<b>موقفة</b>' : '<b>شغالة</b>'}: بنبعتلك لما ينزل منتج جديد أو كمية جديدة أو عرض.\n💬 لأي سؤال كلّمنا على @${tgSupUser(c.data)}`;
  const kb = [[tgBtn('🛒 المنتجات', 'prods'), tgUrl('💬 كلّمنا', tgSup(c))], [tgBtn(muted ? '🔔 شغّل الإعلانات' : '🔕 وقّف الإعلانات', muted ? 'unmute:h' : 'mute:h')]];
  if (tgIsAdmin(c)) kb.push([tgBtn('📢 إعلان للمشتركين', 'post')]);
  return edit ? tgShow(c, text, kb) : tgSay(c, text, kb);
}

// ---------------------------------------------------------------- admin in the bot (usernames in admin settings → بوت تيليجرام)
// 📢 /post: pick a product → see the card exactly as people will get it → send it to everyone
function tgPostMenu(c) {
  if (!tgIsAdmin(c)) return tgHome(c, !c.msgId);
  const ps = c.data.products.filter(p => !tgOut(p));
  const kb = [...tgRows(ps.map(p => tgPBtn(c.data, p, 'ps:' + p.id)), 2), [tgBtn('« الرئيسية', 'home')]];
  return tgShow(c, '📢 <b>إعلان لكل مشتركين البوت</b>\nاختار المنتج اللي بدك تعلن عنه 👇\n(بيوصل لكل حدا فات على البوت، إلا اللي وقّف الإعلانات)', kb);
}
// the card that goes out for a product (also used by the automatic announcements)
function tgPostCard(data, p, head, extra) {
  return { t: tgCard(data, p, head, extra), k: [[tgBtn('🛒 اشتري الآن', 'b:' + p.id)], [tgBtn('🔕 وقّف الإعلانات', 'mute')]], img: tgLogo(p), pid: p.id };
}
async function tgSubs(fs) {
  const [all, muted] = await Promise.all([fs.count('tgUsers', [['off', 'EQUAL', false]]), fs.count('tgUsers', [['mute', 'EQUAL', true]])]);
  return Math.max(0, all - muted);
}
async function tgPostPreview(c, pid) {
  if (!tgIsAdmin(c)) return;
  const p = c.data.products.find(x => x.id === pid);
  if (!p || tgOut(p)) { c.alert = 'هالمنتج مش متوفر هلأ'; return; }
  await tgCounts(c, [p]);
  const j = tgPostCard(c.data, p, '🔥 <b>متوفر عنا هلأ!</b>');
  c.msgId = 0;
  await tgSayCard(c, p, j.t, j.k);
  let n = 0;
  try { n = await tgSubs(c.fs); } catch (e) {}
  return tgSay(c, `👆 هيك رح يوصل.\nالمشتركين: <b>${n}</b>\nأبعته للكل؟`, [[tgBtn('📢 آه، ابعته للكل', 'pc:' + p.id)], [tgBtn('« منتج ثاني', 'post'), tgBtn('❌ لا', 'home')]]);
}
async function tgPostSend(c, pid) {
  if (!tgIsAdmin(c)) return;
  const p = c.data.products.find(x => x.id === pid);
  if (!p) { c.alert = 'هالمنتج مش موجود'; return; }
  await tgCounts(c, [p]);
  const j = tgPostCard(c.data, p, '🔥 <b>متوفر عنا هلأ!</b>');
  if (c.data.ph[p.id]) j.ph = c.data.ph[p.id];
  const id = 'p_' + p.id + '_' + Math.floor(Date.now() / 60e3); // pressing twice in the same minute sends once
  // tgSent keeps a small mark per post, so a second press can't send it again even after the first one finished
  try { await c.fs.commit([c.fs.wUpdate('tgPosts/' + id, { ...j, a: '', n: 0, by: c.chat, at: Date.now(), lock: 0 }, null, { exists: false }), c.fs.wUpdate('tgSent/' + id, { at: Date.now() }, null, { exists: false })]); }
  catch (e) { c.alert = 'هاد الإعلان انبعت قبل شوي ✓'; return; }
  await tgShow(c, `✅ <b>بلّشنا نبعت إعلان ${esc(tgClean(p.name))}</b>\nبيوصل للكل خلال دقايق (حوالي 25 شخص كل دقيقتين)، وبخبرك هون لما يخلص.`, [[tgBtn('📢 إعلان ثاني', 'post'), tgBtn('🏠 الرئيسية', 'home')]]);
  await tgJobRun(c.fs, c.env); // the first people right away
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
  await fs.commit([fs.wUpdate('tgMeta/icons', { on: true, map, set: name, at: Date.now() })]);
  TGC.at = 0; ICON_OFF = 0;
  const miss = list.length - ok.length;
  await tgSay(c, `✅ جهزت ${Object.keys(map).length} أيقونة رسمية${miss ? ` (${miss} ما زبطوا)` : ''}.\nلو ما بيّنت بالأزرار، لازم الحساب اللي عمل البوت من BotFather يكون عليه Telegram Premium.\nلتوقيفها: /icons off`);
  c.data = await tgData(fs);
  return tgGrid(c, true);
}
function tgPick(c) {
  const p = c.data.products.find(x => x.id === c.S.pid);
  const pl = p && p.plans.find(x => x.id === c.S.plan);
  return p && pl && +pl.price > 0 ? { p, pl } : null;
}
function tgSummary(c, x) {
  const acct = x.pl.acct || x.p.acct || '';
  return `🧾 <b>ملخص الطلب</b>\n${esc(tgClean(x.p.name))} — ${esc(tgClean(x.pl.name || ''))}\nالسعر: <b>${tgN(x.pl.price)} ₪</b>` +
    (x.pl.war === 'yes' ? '\n🛡 مضمون طول مدة الاشتراك' : x.pl.war === 'no' ? '\n⚠️ بدون ضمان' : '') +
    (acct === 'login' ? '\n📧 بيتفعّل على إيميلك الشخصي' : acct === 'email' ? '\n📧 بتوصلك دعوة على إيميلك' : '');
}
function tgPlan(c, pid, i) {
  if (tgClosed(c)) { c.alert = 'الطلبات موقفة مؤقتاً، كلّمنا على الدعم'; return; }
  const p = c.data.products.find(x => x.id === pid), pl = p && p.plans[+i];
  if (!p || !pl || !(+pl.price > 0)) { c.alert = 'هالمدة مش متوفرة هلأ'; return tgProduct(c, pid); }
  if (p.soldOut || pl.out) { c.alert = 'هالمدة خلصت كميتها هلأ'; return; }
  c.S = { pid: p.id, plan: pl.id }; c.dirty = true;
  const ms = tgMethods(c);
  const kb = [...tgRows(ms.map(m => tgBtn(isUsdt(m) && m.auto ? 'USDT ⚡ تأكيد تلقائي' : m.name, 'm:' + m.key)), 2), [tgBtn('« رجوع', 'p:' + p.id)]];
  return tgShow(c, tgSummary(c, { p, pl }) + '\n\nاختار طريقة الدفع 👇', kb, true);
}
async function tgMethod(c, key) {
  const x = tgPick(c), m = tgMethods(c).find(y => y.key === key);
  if (!x || !m) { c.alert = 'ابدأ الطلب من جديد'; return tgHome(c); }
  const auto = isUsdt(m) && !!m.auto, acct = x.pl.acct || x.p.acct || '';
  const asks = (x.p.ask || []).map((a, k) => 'a' + k);
  const tail = [...asks, ...(acct === 'login' || acct === 'email' ? ['email'] : []), 'phone'];
  Object.assign(c.S, { method: m.key, q: auto ? [...tail, 'net'] : ['proof', ...tail], ans: {}, proofText: '', proofImg: '', email: '', phone: '' });
  c.dirty = true;
  await tgShow(c, tgSummary(c, x) + `\n\nطريقة الدفع: <b>${esc(auto ? 'USDT (تأكيد تلقائي)' : m.name)}</b> ✓`, [], true);
  return tgAsk(c);
}
async function tgAsk(c) {
  const x = tgPick(c), step = (c.S.q || [])[0];
  if (!x || !step) return tgFinish(c);
  const cancel = [tgBtn('❌ إلغاء الطلب', 'cancel')];
  if (step === 'proof') {
    const m = tgMethods(c).find(y => y.key === c.S.method) || {};
    const lines = [`💳 <b>حوّل ${tgN(x.pl.price)} ₪ على ${esc(m.name || '')}</b>`];
    if (m.number) lines.push(`${esc(m.label || 'الرقم')}: <code>${esc(m.number)}</code>`);
    if (m.holder) lines.push(`الاسم: <b>${esc(m.holder)}</b>`);
    if (m.note) lines.push(esc(m.note));
    lines.push('', 'بعد ما تحوّل، <b>ابعت هون سكرين التحويل</b> 📸', `أو اكتب ${esc(m.proofLabel || 'رقم العملية')}.`);
    return tgSay(c, lines.join('\n'), [cancel]);
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
  const nav = ['home', 'prods', 'cats', 'best', 'find', 'orders', 'help', 'post'].includes(d) || /^(c|p|g|b|o|ps):/.test(d);
  if (nav && (c.S.q || []).length) tgReset(c);           // browsing again ends a half-done order
  if (d === 'home') return tgHome(c);
  if (d === 'prods' || d === 'cats' || d === 'best' || /^c:/.test(d)) return tgGrid(c);   // cats/best/c: are buttons from the first version
  if (d === 'find') return tgSay(c, '🔎 اكتب اسم الاشتراك اللي بتدوّر عليه، مثلاً: <b>كانفا</b> أو <b>ChatGPT</b> أو <b>شاهد</b>');
  if (d === 'orders') return tgOrders(c);
  if (d === 'help') { c.msgId = 0; return tgHelp(c); }
  if (d === 'post') return tgPostMenu(c);
  if (d === 'out') { c.alert = 'هالمدة خلصت كميتها هلأ، وأول ما ترجع بنبعتلك إعلان هون 🔔'; return; }
  if (d === 'cancel') { tgReset(c); return tgSay(c, 'تمام، لغينا الطلب 👍\nاضغط /start لترجع للرئيسية.', { remove_keyboard: true }); }
  let k;
  if ((k = d.match(/^(un)?mute(:h)?$/))) {
    const mute = !k[1];
    await c.fs.commit([c.fs.wUpdate('tgUsers/' + c.chat, { mute }, ['mute'])]);
    if (k[2]) return tgHelp(c, true);
    c.alert = mute ? '🔕 تمام، وقّفنا الإعلانات. بترجّعها من /help' : '🔔 رجعنا نبعتلك الإعلانات';
    return;
  }
  if ((k = d.match(/^g:(.+)$/))) { c.msgId = 0; return tgProduct(c, k[1], true); }   // from the grid: the card comes under it
  if ((k = d.match(/^b:(.+)$/))) return tgBuy(c, k[1]);
  if ((k = d.match(/^ps:(.+)$/))) return tgPostPreview(c, k[1]);
  if ((k = d.match(/^pc:(.+)$/))) return tgPostSend(c, k[1]);
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
  if (cmd) {
    const name = cmd[1].toLowerCase();
    if (['start', 'products', 'shop', 'orders', 'help', 'post'].includes(name)) tgReset(c);
    if (name === 'post') return tgPostMenu(c);
    if (name === 'icons') return tgIconsMake(c, String(cmd[2] || '').trim().toLowerCase());
    if (name === 'start' && cmd[2] && /^p_[A-Za-z0-9_-]+$/.test(cmd[2])) return tgProduct(c, cmd[2].slice(2), true);
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
    await tgSay(c, 'تمام ✓', { remove_keyboard: true });
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
  return tgSay(c, `🔎 لقينا ${hits.length} اشتراكات لـ «${esc(text.slice(0, 40))}» 👇`, [...tgRows(hits.map(p => tgBtn(tgName(c.data, p), 'g:' + p.id)), 2), [tgBtn('🛒 كل المنتجات', 'prods')]]);
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
  const user = c.from.username || '';
  const order = { orderNo: no, items: [item], total: +x.pl.price, customer: tgWho(c.from), phone: c.S.phone || '', email: c.S.email || '', payment: String(m.name).slice(0, 60),
    proofText: auto ? '' : String(c.S.proofText || ''), proofImage: auto ? '' : String(c.S.proofImg || ''), status: 'pending', source: 'telegram', tgChat: c.chat, tgUser: user };
  await fs.commit([
    fs.wUpdate('orders/' + id, order, null, { exists: false }, [{ fieldPath: 'createdAt', setToServerValue: 'REQUEST_TIME' }]),
    fs.wUpdate('payState/main', { tg: { [id]: Date.now() + 10 * 864e5 } }, ['tg.' + fp(id)]),
  ]);
  const img = c.S.proofImg || '', net = c.S.net || (validAddr('bsc', m.number) ? 'bsc' : 'tron');
  c.S = {}; c.dirty = true;
  if (auto) {
    let p;
    try { p = await start(fs, env, { kind: 'order', id, net }); }
    catch (e) { return tgSay(c, `انسجل طلبك <code>${no}</code>، بس ما قدرنا نجهّز دفع USDT هلأ 🙏\nكلّمنا على الدعم وبنكمّل معك.`, [[tgUrl('💬 كلّمنا', tgSup(c))]]); }
    if (p.status !== 'pending' || !p.amt) return tgOrder(c, id, true);
    return tgSay(c, `💰 <b>حوّل بالضبط:</b>\n<code>${p.amt}</code> USDT\nعلى شبكة <b>${p.net === 'tron' ? 'TRC20 (Tron)' : 'BEP20 (BNB Smart Chain)'}</b> لهالعنوان:\n<code>${esc(p.addr)}</code>\n\n⏱ خلال ${PAY_MIN} دقيقة. لازم المبلغ يكون <b>بالضبط</b> عشان يتأكد لحاله.\nأول ما يوصل بنبعتلك هون ✓\n\nرقم طلبك: <code>${no}</code>`, [[tgBtn('🔄 حوّلت، افحص الدفع', 'chk:' + id)], [tgBtn('📦 طلباتي', 'orders')]]);
  }
  const d = { ...order };
  await notifyAdmin(env, '🤖 طلب جديد من بوت تيليجرام ' + no, [...itemLines(d), 'المجموع: ' + money(d.total), 'الدفع: ' + d.payment, d.proofText ? 'الإثبات: ' + d.proofText : img ? 'الإثبات: سكرين (مبعوت تحت)' : '', 'الزبون: ' + d.customer + (user ? ' · @' + user : '') + (d.phone ? ' · ' + d.phone : ''), d.email ? 'الإيميل: ' + d.email : '', info ? 'تفاصيل: ' + info : '', 'الحالة: بانتظار تأكيدك للحوالة'].filter(Boolean), SITE + '/admin.html').catch(e => console.error('notify', e && e.message));
  if (img && env.TG_TOKEN && env.TG_CHAT) {
    try {
      const b = atob(img.split(',')[1] || ''), bytes = new Uint8Array(b.length);
      for (let i = 0; i < b.length; i++) bytes[i] = b.charCodeAt(i);
      const fd = new FormData();
      fd.append('chat_id', String(env.TG_CHAT)); fd.append('caption', 'سكرين الحوالة · ' + no + ' · ' + money(d.total));
      fd.append('photo', new Blob([bytes], { type: 'image/jpeg' }), 'proof.jpg');
      await xf('https://api.telegram.org/bot' + env.TG_TOKEN + '/sendPhoto', { method: 'POST', body: fd });
    } catch (e) { console.error('proof photo', e && e.message); }
  }
  return tgSay(c, `✅ <b>انسجل طلبك</b> رقم <code>${no}</code>\n${esc(item.productName)} — ${esc(item.planName)}\nالمجموع: <b>${tgN(d.total)} ₪</b> · ${esc(d.payment)}\n\nبنتأكد من الحوالة وبنفعّلك الاشتراك عادةً خلال دقائق، وبنبعتلك التفاصيل <b>هون</b> أول ما يجهز.`, [[tgBtn('📦 طلباتي', 'orders'), tgBtn('🏠 الرئيسية', 'home')]]);
}

function tgStatus(o) {
  if (o.status === 'pending') return /usdt/i.test(o.payment || '') && o.pay ? '⏳ بانتظار دفعة USDT' : '⏳ بنتأكد من الدفع';
  if (o.status === 'paid') return '🔧 تأكد الدفع، قيد التفعيل';
  if (o.status === 'done') return '✅ تم التسليم';
  if (o.status === 'cancelled') return '❌ ملغي';
  return o.status || '';
}
async function tgOrders(c) {
  const rows = (await c.fs.query('orders', [['tgChat', 'EQUAL', c.chat]], 30)).sort((a, b) => (+b.data.createdAt || 0) - (+a.data.createdAt || 0)).slice(0, 6);
  if (!rows.length) return tgShow(c, '📦 لسا ما عندك طلبات من البوت.\nاختار اشتراكك وبيطلع طلبك هون 👇', [[tgBtn('🛒 المنتجات', 'prods')], [tgBtn('« الرئيسية', 'home')]]);
  const text = '📦 <b>طلباتك</b>\n\n' + rows.map(r => { const o = r.data, it = (o.items || [])[0] || {}; return `<code>${esc(o.orderNo || '')}</code> · ${esc(it.productName || '')}${it.planName ? ' (' + esc(it.planName) + ')' : ''}\n${tgStatus(o)}`; }).join('\n\n') + '\n\nاضغط على طلب لتشوف تفاصيله 👇';
  return tgShow(c, text, [...rows.map(r => [tgBtn(`${r.data.orderNo || ''} · ${tgStatus(r.data)}`, 'o:' + r.id)]), [tgBtn('« الرئيسية', 'home')]]);
}
async function tgOrder(c, id, fresh) {
  const doc = await c.fs.get('orders/' + id);
  if (!doc || doc.data.tgChat !== c.chat) { c.alert = 'ما لقينا هالطلب'; return; }
  const o = doc.data;
  let text = `<b>طلب ${esc(o.orderNo || '')}</b>\n${itemLines(o).map(esc).join('\n')}\nالمجموع: <b>${tgN(o.total)} ₪</b> · ${esc(o.payment || '')}\nالحالة: ${tgStatus(o)}`;
  if (o.status === 'done') {
    if (o.delivery) text += `\n\n<b>تفاصيل التفعيل:</b>\n<pre>${esc(String(o.delivery).slice(0, 3000))}</pre>`;
    if (Array.isArray(o.stockIds) && o.stockIds.length) for (const k of await readCodes(c.fs, o)) text += `\n\n<b>${esc(k.name)}</b>\n<pre>${esc(k.value)}</pre>`;
  }
  const kb = [];
  if (o.status === 'pending' && o.pay && o.pay.amt) {
    text += `\n\nحوّل بالضبط <code>${o.pay.amt}</code> USDT على ${o.pay.net === 'tron' ? 'TRC20' : 'BEP20'}:\n<code>${esc(o.pay.addr || '')}</code>`;
    kb.push([tgBtn('🔄 افحص الدفع', 'chk:' + id)]);
  }
  kb.push([tgBtn('« طلباتي', 'orders'), tgUrl('💬 كلّمنا', tgSup(c))]);
  return fresh ? tgSay(c, text, kb) : tgShow(c, text, kb);
}
async function tgCheck(c, id) {
  const doc = await c.fs.get('orders/' + id);
  if (!doc || doc.data.tgChat !== c.chat) { c.alert = 'ما لقينا هالطلب'; return; }
  let r;
  try { r = await check(c.fs, c.env, { kind: 'order', id }, null); } catch (e) { c.alert = 'ما قدرنا نفحص هلأ، جرّب بعد دقيقة'; return; }
  if (r.status === 'pending') { c.alert = r.expired ? 'انتهى وقت هالدفعة. إذا حوّلت كلّمنا على الدعم برقم الطلب.' : 'لسا ما وصلت الدفعة. بعد ما تحوّل استنى دقيقة وجرّب، أو خلّيها علينا وبنبلّغك هون أول ما توصل.'; return; }
  const now = await c.fs.get('orders/' + id);
  if (now) await tgNotifyStatus(c.fs, c.env, id, now.data);
}

// tell the customer about the order's new status (once per status; the delivery text once per change)
async function tgNotifyStatus(fs, env, id, d, dlvSig) {
  const no = `<code>${esc(d.orderNo || '')}</code>`, kb = [];
  let text = '';
  if (d.status === 'paid') text = `✅ <b>تأكد دفعك</b> لطلب ${no}\nهلأ قيد التفعيل، وبنبعتلك التفاصيل هون أول ما يجهز.`;
  else if (d.status === 'done') {
    text = `🎉 <b>تم تسليم طلبك</b> ${no}\n${itemLines(d).map(esc).join('\n')}`;
    if (d.delivery) text += `\n\n<b>تفاصيل التفعيل:</b>\n<pre>${esc(String(d.delivery).slice(0, 3000))}</pre>`;
    if (Array.isArray(d.stockIds) && d.stockIds.length) for (const k of await readCodes(fs, d)) text += `\n\n<b>${esc(k.name)}</b>\n<pre>${esc(k.value)}</pre>`;
    text += '\n\nاحفظ التفاصيل عندك، وإذا احتجت أي اشي كلّمنا برقم الطلب 🤍';
    kb.push([tgBtn('🛒 اشتراك جديد', 'prods'), tgBtn('📦 طلباتي', 'orders')]);
  } else if (d.status === 'cancelled') { text = `❌ انلغى طلبك ${no}\nإذا في أي سؤال كلّمنا.`; kb.push([tgUrl('💬 كلّمنا', 'https://t.me/' + (tgUserName(TGC.settings && TGC.settings.tgSupport) || 'hazemstoresupport'))]); }
  if (!text) return false;
  const sent = await tg(env, 'sendMessage', { chat_id: d.tgChat, text, parse_mode: 'HTML', disable_web_page_preview: true, ...(kb.length ? { reply_markup: { inline_keyboard: kb } } : {}) });
  if (!sent) return false;
  const f = { tgSent: d.status }, mask = ['tgSent'];
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
  if (st === 'done' || st === 'cancelled' || Date.now() > (+exp || 0)) return 'drop';
  return 'keep';
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
  const settings = (sd && sd.data) || {}, all = rows.map(d => ({ ...d.data, id: d.id }));
  const first = !C.base, base = C.base || {}, nb = {}, on = settings.tgCast !== false && settings.siteOrders !== false;
  C.scan = now;
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
      const drop = live.filter(id => b.p[id] && cur.p[id][0] < b.p[id][0] - 0.001);
      if (codes.length) e = { k: 'codes', plan: codes[0], n: added[p.id + '|' + codes[0]] };
      else if (back.length) e = { k: back.some(id => !b.p[id]) && !b.o ? 'new' : 'back' };
      else if (drop.length) e = { k: 'price', plan: drop[0], was: b.p[drop[0]][0] };
    }
    if (!e) continue;
    if (C.ann[p.id] && now - C.ann[p.id] < CAST_GAP) continue; // one announcement per product every 6 hours
    C.ann[p.id] = now;
    ev.push({ ...e, p: { ...p, plans: p.plans.filter(x => x && +x.price > 0) } });
  }
  C.base = nb;
  if (!ev.length) return;
  const data = { settings, stock: {} };
  for (const e of ev.filter(x => x.k === 'codes').slice(0, 3)) {
    try { data.stock[e.p.id + '|' + e.plan] = await fs.count('stock', [['pid', 'EQUAL', e.p.id], ['plan', 'EQUAL', e.plan], ['owner', 'IS_NULL']]); } catch (err) {}
  }
  try { const ic = await fs.get('tgMeta/icons'); data.icons = ic && ic.data.on !== false ? ic.data.map || {} : {}; } catch (err) { data.icons = {}; }
  let job;
  if (ev.length === 1) {
    const e = ev[0], pl = e.plan && e.p.plans.find(x => x.id === e.plan), many = e.p.plans.length > 1;
    const head = { new: '🆕 <b>جديد عنا!</b>', codes: '📢 <b>نزلت كمية جديدة!</b>', back: '✅ <b>رجع متوفر!</b>', price: '🔻 <b>نزل السعر!</b>' }[e.k];
    const extra = e.k === 'codes' ? [`➕ انضاف: ${e.n}${many && pl ? ' (' + esc(tgClean(pl.name)) + ')' : ''}`]
      : e.k === 'price' && pl ? [`💥 ${many ? esc(tgClean(pl.name)) + ': ' : ''}كان ${tgN(e.was)} ₪ وصار <b>${tgN(pl.price)} ₪</b>`] : [];
    job = tgPostCard(data, e.p, head, extra);
  } else {
    const icon = { new: '🆕', codes: '➕', back: '✅', price: '🔻' };
    const list = ev.slice(0, 8);
    const t = `📢 <b>جديد عنا!</b>\n\n` + list.map(e => {
      const pl = e.plan && e.p.plans.find(x => x.id === e.plan);
      const tail = e.k === 'codes' ? ` · انضاف ${e.n}` : e.k === 'price' && pl ? ` · كان ${tgN(e.was)} ₪` : e.k === 'back' ? ' · رجع متوفر' : ' · جديد';
      return `${icon[e.k]} ${tgEmo(data, e.p)} <b>${esc(tgClean(e.p.name))}</b> — ${e.k === 'price' && pl ? tgN(pl.price) + ' ₪' : tgPrice(e.p)}${tail}`;
    }).join('\n') + '\n\nاختار واكبس 🛒 👇';
    job = { t, k: [...tgRows(list.map(e => tgPBtn(data, e.p, 'b:' + e.p.id)), 2), [tgBtn('🔕 وقّف الإعلانات', 'mute')]], img: '' };
  }
  await fs.commit([fs.wUpdate('tgPosts/c' + now, { ...job, a: '', n: 0, by: 0, at: now, lock: 0 }, null, { exists: false })]);
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
  const rows = await fs.page('tgUsers', j.a || '', lim), off = [];
  let done = 0, stop = false;
  for (const r of rows) {
    if (BUDGET < 4) { stop = true; break; }
    if (!r.data.mute && !r.data.off) {
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
