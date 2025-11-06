// server.js
// ROI API — Auth + Wallets + ROI Settle + FX + Exchange + Investment (1.5%/day + compounding) + Hourly FX (CoinGecko) + Daily Auto-Compound
// Ready for Render (PORT defaults to 10000)

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 10000;                   // Render binds here
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-super-secret';
const DB_FILE = 'db.json';
const DAY_SEC = 86400;
const DAILY_RATE = 0.015; // 1.5% per day

// -------------------------------------
// JSON "DB" helpers
// -------------------------------------
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      fx: { "USD-USD":1, "USDT-USD":1, "TRX-USD":0.1, "BTC-USD":68000 },
      wallets: {},   // userId -> { USD, USDT, TRX, BTC, frozen:{} }
      payouts: [],   // array
      users: [{
        id: 1,
        email: "demo@roi.local",
        password_hash: bcrypt.hashSync("demo123", 8),
        roi_convert_to_usd: true,
        created_at: new Date().toISOString()
      }],
      nextUserId: 2,
      investments: {} // userId -> { principal_usd, auto_compound, last_tick_at }
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}
let db = loadDB();

// -------------------------------------
// SCHEMA MIGRATION / HARDENING
// -------------------------------------
(function migrate() {
  if (!db.fx) db.fx = { "USD-USD":1, "USDT-USD":1, "TRX-USD":0.1, "BTC-USD":68000 };
  if (!db.wallets) db.wallets = {};
  if (!Array.isArray(db.payouts)) db.payouts = [];
  if (!Array.isArray(db.users)) db.users = [];
  if (!db.investments) db.investments = {};

  let demo = db.users.find(u => (u.email || '').toLowerCase() === 'demo@roi.local');
  if (!demo) {
    demo = {
      id: db.nextUserId || 1,
      email: "demo@roi.local",
      password_hash: bcrypt.hashSync("demo123", 8),
      roi_convert_to_usd: true,
      created_at: new Date().toISOString()
    };
    db.users.push(demo);
  } else {
    if (!demo.password_hash) demo.password_hash = bcrypt.hashSync("demo123", 8);
    if (typeof demo.roi_convert_to_usd !== 'boolean') demo.roi_convert_to_usd = true;
    if (!demo.created_at) demo.created_at = new Date().toISOString();
    if (!demo.id) demo.id = 1;
  }

  db.users.forEach((u, i) => { if (!u.id) u.id = i + 1; });
  const maxId = db.users.reduce((m, u) => Math.max(m, Number(u.id || 0)), 0);
  db.nextUserId = Math.max(2, maxId + 1);

  db.users.forEach(u => {
    if (!db.wallets[u.id]) db.wallets[u.id] = { USD:0, USDT:0, TRX:0, BTC:0, frozen:{} };
    if (!db.investments[u.id]) db.investments[u.id] = {
      principal_usd: 0,
      auto_compound: false,
      last_tick_at: new Date().toISOString()
    };
  });

  saveDB(db);
})();

// -------------------------------------
// Utils
// -------------------------------------
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function ensureWallet(userId) {
  db.wallets[userId] = db.wallets[userId] || { USD:0, USDT:0, TRX:0, BTC:0, frozen:{} };
}
function ensureInvest(userId) {
  db.investments[userId] = db.investments[userId] || { principal_usd:0, auto_compound:false, last_tick_at:new Date().toISOString() };
}
function creditAsset(userId, asset, amount) {
  ensureWallet(userId);
  db.wallets[userId][asset] = round2((db.wallets[userId][asset] || 0) + Number(amount || 0));
}
function createPayout(p) {
  db.payouts.push({ ...p, created_at: new Date().toISOString() });
  saveDB(db);
}
function signToken(user) {
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'Missing token' });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload; // { uid, email }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}
function toUSD(asset, amount) {
  if (asset === 'USD' || asset === 'USDT') return Number(amount || 0);
  const r = db.fx[`${asset}-USD`] || 0;
  return Number(amount || 0) * r;
}
function advanceISO(iso, seconds) {
  const t = new Date(iso).getTime() + seconds * 1000;
  return new Date(t).toISOString();
}

// -------------------------------------
// Hourly FX from CoinGecko (BTC, TRX; USDT=1)
// -------------------------------------
async function updateFxFromCoingecko() {
  try {
    const url = 'https://api.coingecko.com/api/v3/simple/price?ids=bitcoin,tron&vs_currencies=usd';
    const r = await fetch(url, { headers: { 'accept': 'application/json' }});
    if (!r.ok) throw new Error('FX fetch ' + r.status);
    const j = await r.json();
    const btc = Number(j?.bitcoin?.usd || 0);
    const trx = Number(j?.tron?.usd || 0);
    if (btc > 0) db.fx['BTC-USD'] = round2(btc);
    if (trx > 0) db.fx['TRX-USD'] = round2(trx);
    db.fx['USDT-USD'] = 1;
    db.fx['USD-USD'] = 1;
    saveDB(db);
  } catch (e) {
    // swallow; transient errors okay
  }
}
// update immediately & hourly
updateFxFromCoingecko();
setInterval(updateFxFromCoingecko, 60 * 60 * 1000);

// -------------------------------------
// DAILY AUTO-COMPOUND SCHEDULER (every 60s)
// -------------------------------------
function sweepAutoCompound() {
  let changed = false;
  const nowMs = Date.now();

  for (const u of db.users) {
    const uid = u.id;
    ensureInvest(uid);
    const inv = db.investments[uid];
    if (!inv || !inv.auto_compound) continue;

    const last = new Date(inv.last_tick_at || new Date().toISOString()).getTime();
    if (!isFinite(last)) {
      inv.last_tick_at = new Date().toISOString();
      changed = true;
      continue;
    }

    const elapsedSec = Math.floor((nowMs - last) / 1000);
    if (elapsedSec < DAY_SEC || (inv.principal_usd || 0) <= 0) continue;

    // Number of full days passed since last tick
    const days = Math.floor(elapsedSec / DAY_SEC);
    // Compound in a single step: P * (1+r)^days
    const p0 = Number(inv.principal_usd || 0);
    const p1 = p0 * Math.pow(1 + DAILY_RATE, days);
    inv.principal_usd = round2(p1);

    // advance last_tick_at by whole days (keep remainder for countdown accuracy)
    inv.last_tick_at = advanceISO(inv.last_tick_at, days * DAY_SEC);

    changed = true;
  }

  if (changed) saveDB(db);
}
// run every minute
setInterval(sweepAutoCompound, 60 * 1000);
// also run once at startup (in case app slept)
sweepAutoCompound();

// -------------------------------------
// Middleware
// -------------------------------------
app.use(cors({
  origin: [
    'https://*.netlify.app',
    'https://roi-dashboard-anele.netlify.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ]
}));
app.use(express.json());

// -------------------------------------
// Public
// -------------------------------------
app.get('/', (_req, res) => {
  res.json({ ok: true, name: 'ROI API', version: 'v1' });
});

// TEMP DEBUG (remove later)
app.get('/__debug_schema', (_req, res) => {
  res.json({
    keys: Object.keys(db),
    users: (db.users || []).map(u => ({ id: u.id, email: u.email, has_hash: !!u.password_hash })),
    wallets_keys: db.wallets ? Object.keys(db.wallets) : [],
    nextUserId: db.nextUserId,
    fx: db.fx,
    investments: db.investments
  });
});

// -------------------------------------
// Auth
// -------------------------------------
app.post('/auth/register', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const exists = db.users.find(u => (u.email || '').toLowerCase() === String(email).toLowerCase());
  if (exists) return res.status(409).json({ error: 'Email already registered' });

  const id = db.nextUserId++;
  const user = {
    id,
    email,
    password_hash: bcrypt.hashSync(password, 8),
    roi_convert_to_usd: true,
    created_at: new Date().toISOString()
  };
  db.users.push(user);
  ensureWallet(id);
  ensureInvest(id);
  saveDB(db);

  const token = signToken(user);
  res.json({ ok: true, token, user: { id: user.id, email: user.email, roi_convert_to_usd: user.roi_convert_to_usd } });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find(u => (u.email || '').toLowerCase() === String(email).toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });

  const ok = bcrypt.compareSync(password || '', user.password_hash || '');
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken(user);
  res.json({ ok: true, token, user: { id: user.id, email: user.email, roi_convert_to_usd: user.roi_convert_to_usd } });
});

// -------------------------------------
// FX (GET public, POST protected)
// -------------------------------------
app.get('/fx', (_req, res) => res.json(db.fx));
app.post('/fx', auth, (req, res) => {
  const { pair, rate } = req.body || {};
  if (!pair || typeof rate !== 'number') return res.status(400).json({ error: 'pair and numeric rate required' });
  db.fx[pair] = rate;
  saveDB(db);
  res.json({ ok: true, pair, rate });
});

// -------------------------------------
// Portfolio & payouts
// -------------------------------------
app.get('/portfolio/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  ensureWallet(userId);

  const w = db.wallets[userId];
  const fx = db.fx;

  const toUSDLocal = (asset, amount) => {
    if (asset === 'USD' || asset === 'USDT') return round2(amount || 0);
    const rate = fx[`${asset}-USD`] || 0;
    return round2((amount || 0) * rate);
  };

  const rows = [
    { asset: 'USD',  available: w.USD  || 0, usd: round2(w.USD  || 0) },
    { asset: 'USDT', available: w.USDT || 0, usd: round2(w.USDT || 0) },
    { asset: 'TRX',  available: w.TRX  || 0, usd: toUSDLocal('TRX', w.TRX || 0) },
    { asset: 'BTC',  available: w.BTC  || 0, usd: toUSDLocal('BTC', w.BTC || 0) },
  ];
  const total = round2(rows.reduce((s, r) => s + r.usd, 0));

  res.json({
    userId,
    totalUsd: total,
    breakdown: rows,
    pie: rows.map(r => ({ asset: r.asset, usd: r.usd, percent: total ? round2((r.usd / total) * 100) : 0 }))
  });
});

app.get('/payouts/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  const out = db.payouts.filter(p => p.user_id === userId);
  res.json(out);
});

// -------------------------------------
// Wallet: deposit / withdraw (withdraw = negative deposit)
// -------------------------------------
app.post('/deposit', auth, (req, res) => {
  const { userId, asset, amount } = req.body || {};
  if (!userId || !asset || typeof amount !== 'number') {
    return res.status(400).json({ error: 'userId, asset, amount required' });
  }
  ensureWallet(userId);

  const cur = Number(db.wallets[userId][asset] || 0);
  const next = round2(cur + amount);
  if (next < 0) return res.status(400).json({ error: 'Insufficient balance' });

  db.wallets[userId][asset] = next;
  saveDB(db);
  res.json({ ok: true, userId, asset, newBalance: db.wallets[userId][asset] });
});

// -------------------------------------
// Exchange (with fee %)
// -------------------------------------
app.post('/exchange/convert', auth, (req, res) => {
  const { userId, fromAsset, toAsset, amount, feePct = 0 } = req.body || {};
  if (!userId || !fromAsset || !toAsset || typeof amount !== 'number') {
    return res.status(400).json({ error: 'missing fields' });
  }
  ensureWallet(userId);
  if ((db.wallets[userId][fromAsset] || 0) < amount) {
    return res.status(400).json({ error: 'Insufficient ' + fromAsset + ' balance' });
  }

  const fx = db.fx;

  const toUSDLocal = (asset, amt) => {
    if (asset === 'USD' || asset === 'USDT') return Number(amt || 0);
    const r = fx[`${asset}-USD`] || 0;
    return Number(amt || 0) * r;
  };
  const fromUSDLocal = (asset, usd) => {
    if (asset === 'USD' || asset === 'USDT') return Number(usd || 0);
    const r = fx[`${asset}-USD`] || 0;
    return r ? Number(usd || 0) / r : 0;
  };

  const grossUsd = toUSDLocal(fromAsset, amount);
  const netUsd = grossUsd * (Number(feePct) ? (1 - (Number(feePct) / 100)) : 1);
  const outAmt = round2(fromUSDLocal(toAsset, netUsd));

  db.wallets[userId][fromAsset] = round2((db.wallets[userId][fromAsset] || 0) - amount);
  db.wallets[userId][toAsset] = round2((db.wallets[userId][toAsset] || 0) + outAmt);
  saveDB(db);

  res.json({
    ok: true,
    userId,
    from: { asset: fromAsset, amount },
    to: { asset: toAsset, amount: outAmt },
    fx: {
      fromPair: `${fromAsset}-USD`,
      fromRate: fx[`${fromAsset}-USD`] || 1,
      toPair: `${toAsset}-USD`,
      toRate: fx[`${toAsset}-USD`] || 1
    },
    feePct: Number(feePct) || 0
  });
});

// -------------------------------------
// Settle ROI (legacy/manual)
// -------------------------------------
app.post('/settle', auth, (req, res) => {
  const { userId, planId, amount, currency } = req.body || {};
  if (!userId || !planId || typeof amount !== 'number' || !currency) {
    return res.status(400).json({ error: 'missing fields' });
  }
  const user = db.users.find(u => u.id === Number(userId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  ensureWallet(userId);

  const convert = !!user.roi_convert_to_usd;
  if (!convert) {
    creditAsset(userId, currency, amount);
    createPayout({
      user_id: userId,
      plan_id: planId,
      original_currency: currency,
      original_amount: amount,
      fx_rate_to_usd: null,
      usd_amount: null,
      converted: false
    });
    return res.json({ ok: true, converted: false, credited: { asset: currency, amount } });
  }

  const pair = `${currency}-USD`;
  const rate = Number(db.fx[pair] || 0);
  const usdAmount = round2(Number(amount) * rate);

  creditAsset(userId, 'USD', usdAmount);
  createPayout({
    user_id: userId,
    plan_id: planId,
    original_currency: currency,
    original_amount: amount,
    fx_rate_to_usd: rate,
    usd_amount: usdAmount,
    converted: true
  });
  res.json({ ok: true, converted: true, credited: { asset: 'USD', amount: usdAmount }, rate });
});

// -------------------------------------
// Investment Engine (1.5% per day)
// -------------------------------------
// POST /invest/deposit { userId, asset, amount } → converts to USD and increases principal
app.post('/invest/deposit', auth, (req, res) => {
  const { userId, asset, amount } = req.body || {};
  if (!userId || !asset || typeof amount !== 'number') return res.status(400).json({ error:'userId, asset, amount required' });
  ensureInvest(userId);
  const addUsd = round2(toUSD(asset, amount));
  db.investments[userId].principal_usd = round2((db.investments[userId].principal_usd || 0) + addUsd);
  if (!db.investments[userId].last_tick_at) db.investments[userId].last_tick_at = new Date().toISOString();
  saveDB(db);
  res.json({ ok:true, principal_usd: db.investments[userId].principal_usd });
});

// GET /invest/status/:userId → principal, accrued (live), seconds_to_next
app.get('/invest/status/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  ensureInvest(userId);
  const inv = db.investments[userId];
  const now = Date.now();
  const last = new Date(inv.last_tick_at || new Date().toISOString()).getTime();
  const elapsedSec = Math.max(0, (now - last) / 1000);
  const accrued = round2((inv.principal_usd || 0) * DAILY_RATE * (elapsedSec / DAY_SEC));
  const secondsToNext = Math.max(0, DAY_SEC - Math.floor(elapsedSec % DAY_SEC));
  res.json({
    ok: true,
    principal_usd: round2(inv.principal_usd || 0),
    daily_rate: DAILY_RATE,
    accrued_usd: accrued,
    last_tick_at: inv.last_tick_at,
    seconds_to_next: secondsToNext,
    auto_compound: !!inv.auto_compound
  });
});

// POST /invest/reinvest { userId } → add accrued to principal (compound now)
app.post('/invest/reinvest', auth, (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error:'userId required' });
  ensureInvest(userId);
  const inv = db.investments[userId];
  const now = Date.now();
  const last = new Date(inv.last_tick_at || new Date().toISOString()).getTime();
  const elapsedSec = Math.max(0, (now - last) / 1000);
  const accrued = (inv.principal_usd || 0) * DAILY_RATE * (elapsedSec / DAY_SEC);
  inv.principal_usd = round2((inv.principal_usd || 0) + accrued);
  inv.last_tick_at = new Date().toISOString();
  saveDB(db);
  res.json({ ok:true, principal_usd: inv.principal_usd });
});

// POST /invest/claim { userId } → credit accrued to USD wallet (do not change principal)
app.post('/invest/claim', auth, (req, res) => {
  const { userId } = req.body || {};
  if (!userId) return res.status(400).json({ error:'userId required' });
  ensureInvest(userId); ensureWallet(userId);
  const inv = db.investments[userId];
  const now = Date.now();
  const last = new Date(inv.last_tick_at || new Date().toISOString()).getTime();
  const elapsedSec = Math.max(0, (now - last) / 1000);
  const accrued = round2((inv.principal_usd || 0) * DAILY_RATE * (elapsedSec / DAY_SEC));
  creditAsset(userId, 'USD', accrued);
  inv.last_tick_at = new Date().toISOString();
  saveDB(db);
  res.json({ ok:true, credited_usd: accrued, new_usd_balance: db.wallets[userId]['USD'] });
});

// POST /invest/config { userId, auto_compound }
app.post('/invest/config', auth, (req, res) => {
  const { userId, auto_compound } = req.body || {};
  if (!userId) return res.status(400).json({ error:'userId required' });
  ensureInvest(userId);
  db.investments[userId].auto_compound = !!auto_compound;
  saveDB(db);
  res.json({ ok:true, auto_compound: db.investments[userId].auto_compound });
});

// -------------------------------------
// Settings
// -------------------------------------
app.post('/settings/roi-conversion', auth, (req, res) => {
  const { userId, enabled } = req.body || {};
  const user = db.users.find(u => u.id === Number(userId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.roi_convert_to_usd = !!enabled;
  saveDB(db);
  res.json({ ok: true, userId: user.id, roi_convert_to_usd: user.roi_convert_to_usd });
});

// -------------------------------------
// Start
// -------------------------------------
app.listen(PORT, () => {
  console.log(`ROI API running on http://localhost:${PORT}`);
});
