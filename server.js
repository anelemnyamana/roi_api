// server.js
// ROI API — auth + wallets + ROI settle + FX + exchange
// Works on Render (PORT defaults to 10000)

const express = require('express');
const cors = require('cors');
const fs = require('fs');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 10000;              // Render binds here
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-super-secret';
const DB_FILE = 'db.json';

// -------------------------------
// DB helpers (lightweight JSON DB)
// -------------------------------
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      fx: { "USD-USD":1, "USDT-USD":1, "TRX-USD":0.1, "BTC-USD":68000 },
      wallets: {},         // userId -> { USD, USDT, TRX, BTC, frozen:{} }
      payouts: [],         // array of payout objects
      users: [             // seed demo user
        {
          id: 1,
          email: "demo@roi.local",
          password_hash: bcrypt.hashSync("demo123", 8),
          roi_convert_to_usd: true,
          created_at: new Date().toISOString()
        }
      ],
      nextUserId: 2
    }, null, 2));
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

// -------------------------------
// SCHEMA MIGRATION (important!)
// Ensures old db.json works with new auth/users structure
// -------------------------------
if (!db.fx) db.fx = { "USD-USD":1, "USDT-USD":1, "TRX-USD":0.1, "BTC-USD":68000 };
if (!db.wallets) db.wallets = {};
if (!Array.isArray(db.payouts)) db.payouts = [];

if (!Array.isArray(db.users)) {
  db.users = [{
    id: 1,
    email: "demo@roi.local",
    password_hash: bcrypt.hashSync("demo123", 8),
    roi_convert_to_usd: true,
    created_at: new Date().toISOString()
  }];
  db.nextUserId = 2;
}
if (!db.nextUserId) {
  db.nextUserId = Math.max(0, ...db.users.map(u => u.id)) + 1;
}
if (!db.wallets[1]) db.wallets[1] = { USD:0, USDT:0, TRX:0, BTC:0, frozen:{} };
saveDB(db);

// -------------------------------
// Utils
// -------------------------------
function round2(n) { return Math.round(Number(n || 0) * 100) / 100; }
function ensureWallet(uid) {
  db.wallets[uid] = db.wallets[uid] || { USD:0, USDT:0, TRX:0, BTC:0, frozen:{} };
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
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// -------------------------------
// Middleware
// -------------------------------
app.use(cors({
  origin: [
    'https://*.netlify.app',
    'https://roi-dashboard-anele.netlify.app',
    'http://localhost:3000',
    'http://localhost:5173'
  ]
}));
app.use(express.json());

// -------------------------------
// Public
// -------------------------------
app.get('/', (_req, res) => {
  res.json({ ok: true, name: 'ROI API', version: 'v1' });
});

// Auth
app.post('/auth/register', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });

  const exists = db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
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
  saveDB(db);

  const token = signToken(user);
  res.json({ ok: true, token, user: { id: user.id, email: user.email, roi_convert_to_usd: user.roi_convert_to_usd } });
});

app.post('/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const user = db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if (!user) return res.status(401).json({ error: 'Invalid credentials' });
  const ok = bcrypt.compareSync(password || '', user.password_hash || '');
  if (!ok) return res.status(401).json({ error: 'Invalid credentials' });

  const token = signToken(user);
  res.json({ ok: true, token, user: { id: user.id, email: user.email, roi_convert_to_usd: user.roi_convert_to_usd } });
});

// FX (GET public, POST protected)
app.get('/fx', (_req, res) => res.json(db.fx));
app.post('/fx', auth, (req, res) => {
  const { pair, rate } = req.body || {};
  if (!pair || typeof rate !== 'number') return res.status(400).json({ error: 'pair and numeric rate required' });
  db.fx[pair] = rate;
  saveDB(db);
  res.json({ ok: true, pair, rate });
});

// -------------------------------
// Portfolio & payouts
// -------------------------------
app.get('/portfolio/:userId', (req, res) => {
  const userId = Number(req.params.userId);
  ensureWallet(userId);

  const w = db.wallets[userId];
  const fx = db.fx;

  const toUSD = (asset, amount) => {
    if (asset === 'USD' || asset === 'USDT') return round2(amount || 0);
    const rate = fx[`${asset}-USD`] || 0;
    return round2((amount || 0) * rate);
  };

  const rows = [
    { asset: 'USD',  available: w.USD  || 0, usd: round2(w.USD  || 0) },
    { asset: 'USDT', available: w.USDT || 0, usd: round2(w.USDT || 0) },
    { asset: 'TRX',  available: w.TRX  || 0, usd: toUSD('TRX', w.TRX || 0) },
    { asset: 'BTC',  available: w.BTC  || 0, usd: toUSD('BTC', w.BTC || 0) },
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

// -------------------------------
// Wallet: deposit/withdraw (withdraw = negative deposit)
// -------------------------------
app.post('/deposit', auth, (req, res) => {
  const { userId, asset, amount } = req.body || {};
  if (!userId || !asset || typeof amount !== 'number') return res.status(400).json({ error: 'userId, asset, amount required' });

  ensureWallet(userId);
  const cur = Number(db.wallets[userId][asset] || 0);
  const next = round2(cur + amount);
  if (next < 0) return res.status(400).json({ error: 'Insufficient balance' });

  db.wallets[userId][asset] = next;
  saveDB(db);
  res.json({ ok: true, userId, asset, newBalance: db.wallets[userId][asset] });
});

// -------------------------------
// Exchange (with fee %)
// -------------------------------
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

  const toUSD = (asset, amt) => {
    if (asset === 'USD' || asset === 'USDT') return Number(amt || 0);
    const r = fx[`${asset}-USD`] || 0;
    return Number(amt || 0) * r;
  };
  const fromUSD = (asset, usd) => {
    if (asset === 'USD' || asset === 'USDT') return Number(usd || 0);
    const r = fx[`${asset}-USD`] || 0;
    return r ? Number(usd || 0) / r : 0;
  };

  const grossUsd = toUSD(fromAsset, amount);
  const netUsd = grossUsd * (Number(feePct) ? (1 - (Number(feePct) / 100)) : 1);
  const outAmt = round2(fromUSD(toAsset, netUsd));

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

// -------------------------------
// Settle ROI
// -------------------------------
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
    db.wallets[userId][currency] = round2((db.wallets[userId][currency] || 0) + amount);
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

  db.wallets[userId]['USD'] = round2((db.wallets[userId]['USD'] || 0) + usdAmount);
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

// -------------------------------
// Settings
// -------------------------------
app.post('/settings/roi-conversion', auth, (req, res) => {
  const { userId, enabled } = req.body || {};
  const user = db.users.find(u => u.id === Number(userId));
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.roi_convert_to_usd = !!enabled;
  saveDB(db);
  res.json({ ok: true, userId: user.id, roi_convert_to_usd: user.roi_convert_to_usd });
});

// -------------------------------
// Start
// -------------------------------
app.listen(PORT, () => {
  console.log(`ROI API running on http://localhost:${PORT}`);
});
