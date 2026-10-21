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
const VERSION = 9;
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
    try {
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
async function health(env) {
  if (!env.SA_JSON) return { ok: false, service: 'hazem-pay', error: 'SA_JSON missing', notify: channels(env) };
  const fs = await firestore(env);
  const s = await fs.get('settings/main');
  const m = s && (s.data.payments || []).find(isUsdt);
  const st = await fs.get('payState/main');
  const sd = (st && st.data) || {};
  return { ok: true, service: 'hazem-pay', version: VERSION, project: fs.project, usdt: m ? { auto: !!m.auto, bsc: validAddr('bsc', m.number), tron: validAddr('tron', m.tron) } : null, notify: channels(env), cron: sd.cronAt || 0, cronErr: sd.cronErr || '', cronFail: sd.cronFail || 0 };
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
      const r = await xf(api + name(p), { headers: H });
      if (r.status === 404) return null;
      if (!r.ok) throw fail('firestore get ' + r.status + ' ' + (await r.text()).slice(0, 200), 502);
      return parse(await r.json());
    },
    async query(col, filters, limit, orderBy) {
      const fl = filters.map(([f, op, v]) => op === 'IS_NULL' ? { unaryFilter: { op: 'IS_NULL', field: { fieldPath: f } } } : { fieldFilter: { field: { fieldPath: f }, op, value: toValue(v) } });
      const body = { structuredQuery: { from: [{ collectionId: col }], where: fl.length > 1 ? { compositeFilter: { op: 'AND', filters: fl } } : fl[0], limit } };
      if (orderBy) body.structuredQuery.orderBy = [{ field: { fieldPath: orderBy }, direction: 'ASCENDING' }];
      const r = await xf(api + root + ':runQuery', { method: 'POST', headers: H, body: JSON.stringify(body) });
      if (!r.ok) throw fail('firestore query ' + r.status + ' ' + (await r.text()).slice(0, 300), 502);
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
