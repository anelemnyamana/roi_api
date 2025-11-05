// server.js — ROI Tracker Backend v1 (JSON DB)
// Features:
// - Multi-asset balances: USD, USDT, TRX, BTC
// - ROI payouts with optional auto-conversion to USD
// - Portfolio endpoint with pie-chart-ready data
// - Payout history endpoint
// - FX cache & admin update
// - Lightweight JSON persistence (db.json)

const fs = require('fs');
const path = require('path');
const express = require('express');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

const DB_FILE = path.join(__dirname, 'db.json');
const ASSETS = ['USD', 'USDT', 'TRX', 'BTC'];

// ---------------- DB helpers ----------------
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    const seed = {
      meta: { version: 'v1', created_at: new Date().toISOString() },
      users: [
        { id: 1, name: 'User A', roi_convert_to_usd: true },
        { id: 2, name: 'User B', roi_convert_to_usd: false }
      ],
      wallets: [
        // Seed base rows so portfolio renders immediately
        ...[1, 2].flatMap(userId =>
          ASSETS.map(a => ({ userId, asset: a, available: 0, frozen: 0 }))
        )
      ],
      payouts: [],
      fx: {
        'USD-USD': 1,
        'USDT-USD': 1,
        'TRX-USD': 0.0955,   // sample; update via /fx
        'BTC-USD': 64000     // sample; update via /fx
      }
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(seed, null, 2));
    return seed;
  }
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf8') || '{}');
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// ---------------- Utils ----------------
const round2 = x => Math.round(Number(x) * 100) / 100;
const round6 = x => Math.round(Number(x) * 1e6) / 1e6;

function findUser(db, userId) {
  return db.users.find(u => u.id === Number(userId));
}

function getWallet(db, userId, asset) {
  if (!ASSETS.includes(asset)) throw new Error('Unsupported asset: ' + asset);
  let w = db.wallets.find(
    w => w.userId === Number(userId) && w.asset === asset
  );
  if (!w) {
    w = { userId: Number(userId), asset, available: 0, frozen: 0 };
    db.wallets.push(w);
  }
  return w;
}

function credit(db, userId, asset, amount) {
  const w = getWallet(db, userId, asset);
  w.available = round6(Number(w.available) + Number(amount));
  return w.available;
}

function debit(db, userId, asset, amount) {
  const w = getWallet(db, userId, asset);
  const a = Number(amount);
  if (Number(w.available) < a) throw new Error(`Insufficient ${asset} balance`);
  w.available = round6(Number(w.available) - a);
  return w.available;
}

function getFx(db, pair) {
  const r = db.fx[pair];
  if (r == null) throw new Error('Missing FX rate for ' + pair);
  return Number(r);
}

function toUsd(db, asset, amount) {
  const rate = getFx(db, `${asset}-USD`);
  return { usd: round2(Number(amount) * rate), rate };
}

// ---------------- Routes ----------------

// Health
app.get('/', (req, res) => {
  res.json({ ok: true, name: 'ROI API', version: 'v1' });
});

// Get FX cache
app.get('/fx', (req, res) => {
  const db = loadDB();
  res.json(db.fx);
});

// Admin: set/update FX rate (e.g., {"pair":"TRX-USD","rate":0.097})
app.post('/fx', (req, res) => {
  const { pair, rate } = req.body || {};
  if (!pair || typeof rate !== 'number') {
    return res.status(400).json({ error: 'Provide { pair, rate:number }' });
  }
  const db = loadDB();
  db.fx[pair] = rate;
  saveDB(db);
  res.json({ ok: true, pair, rate });
});

// Toggle auto-conversion of ROI to USD
// Body: { userId:number, enabled:boolean }
app.post('/settings/roi-conversion', (req, res) => {
  const { userId, enabled } = req.body || {};
  if (userId == null || typeof enabled !== 'boolean') {
    return res.status(400).json({ error: 'Provide { userId, enabled:boolean }' });
  }
  const db = loadDB();
  const user = findUser(db, userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  user.roi_convert_to_usd = enabled;
  saveDB(db);
  res.json({ ok: true, userId: Number(userId), roi_convert_to_usd: enabled });
});

// Portfolio with USD equivalents + pie
// GET /portfolio/:userId
app.get('/portfolio/:userId', (req, res) => {
  const db = loadDB();
  const userId = Number(req.params.userId);
  if (!findUser(db, userId)) return res.status(404).json({ error: 'User not found' });

  // Ensure all wallets exist
  const rows = ASSETS.map(a => getWallet(db, userId, a));

  // Compute USD equivalents
  const breakdown = rows.map(w => {
    const { usd } = toUsd(db, w.asset, w.available);
    return {
      asset: w.asset,
      available: Number(w.available),
      frozen: Number(w.frozen),
      usd
    };
  });

  const totalUsd = round2(breakdown.reduce((s, r) => s + r.usd, 0));
  const pie = breakdown.map(r => ({
    asset: r.asset,
    usd: r.usd,
    percent: totalUsd > 0 ? round2((r.usd / totalUsd) * 100) : 0
  }));

  res.json({
    userId,
    totalUsd,
    breakdown, // table-friendly
    pie        // chart-friendly
  });
});

// Payout history
// GET /payouts/:userId
app.get('/payouts/:userId', (req, res) => {
  const db = loadDB();
  const userId = Number(req.params.userId);
  if (!findUser(db, userId)) return res.status(404).json({ error: 'User not found' });
  const list = db.payouts
    .filter(p => p.user_id === userId)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  res.json(list);
});

// Manual top-up/deposit (optional helper to simulate funds)
// Body: { userId, asset, amount }
app.post('/deposit', (req, res) => {
  const { userId, asset, amount } = req.body || {};
  const db = loadDB();
  try {
    if (!userId || !asset || typeof amount !== 'number') {
      return res.status(400).json({ error: 'Provide { userId, asset, amount:number }' });
    }
    if (!findUser(db, userId)) return res.status(404).json({ error: 'User not found' });
    credit(db, userId, asset, amount);
    saveDB(db);
    res.json({ ok: true, userId: Number(userId), asset, newBalance: getWallet(db, userId, asset).available });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Exchange/convert (manual) — simple market convert with optional fee
// Body: { userId, fromAsset, toAsset, amount, feePct? }
// Example: { userId:1, fromAsset:'USDT', toAsset:'USD', amount:100, feePct:0.2 }
app.post('/exchange/convert', (req, res) => {
  const { userId, fromAsset, toAsset, amount, feePct } = req.body || {};
  const db = loadDB();
  try {
    if (!userId || !fromAsset || !toAsset || typeof amount !== 'number') {
      return res.status(400).json({ error: 'Provide { userId, fromAsset, toAsset, amount:number }' });
    }
    if (fromAsset === toAsset) return res.status(400).json({ error: 'fromAsset and toAsset cannot match' });
    if (!findUser(db, userId)) return res.status(404).json({ error: 'User not found' });

    // Debit source
    debit(db, userId, fromAsset, amount);

    // Convert to USD using from-asset rate, then to target via inverse
    const { usd: usdValue, rate: fromRate } = toUsd(db, fromAsset, amount);
    let targetAmount;
    if (toAsset === 'USD') {
      targetAmount = usdValue;
    } else {
      const toRate = getFx(db, `${toAsset}-USD`); // toAsset-USD
      // amount_in_toAsset = usd / toRate
      targetAmount = usdValue / toRate;
      // Keep reasonable precision for crypto
      targetAmount = ['BTC', 'TRX'].includes(toAsset) ? round6(targetAmount) : round2(targetAmount);
    }

    // Apply optional fee on target amount
    const feePctNum = feePct ? Number(feePct) : 0;
    const fee = targetAmount * (feePctNum / 100);
    const credited = ['BTC', 'TRX'].includes(toAsset) ? round6(targetAmount - fee) : round2(targetAmount - fee);

    credit(db, userId, toAsset, credited);
    saveDB(db);

    res.json({
      ok: true,
      userId: Number(userId),
      from: { asset: fromAsset, amount },
      to: { asset: toAsset, amount: credited },
      fx: { fromPair: `${fromAsset}-USD`, fromRate, toPair: `${toAsset}-USD`, toRate: getFx(db, `${toAsset}-USD`) },
      feePct: feePctNum
    });
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// Settle ROI payout (core)
// Body: { userId, planId, amount:number, currency:'USDT'|'TRX'|'BTC'|'USD' }
// When user's setting roi_convert_to_usd=true, credit USD instead (at current FX)
app.post('/settle', (req, res) => {
  const { userId, planId, amount, currency } = req.body || {};
  const db = loadDB();
  const created_at = new Date().toISOString();

  try {
    if (!userId || !planId || typeof amount !== 'number' || !currency) {
      return res.status(400).json({ error: 'Provide { userId, planId, amount:number, currency }' });
    }
    if (!ASSETS.includes(currency)) return res.status(400).json({ error: 'Unsupported currency: ' + currency });

    const user = findUser(db, userId);
    if (!user) return res.status(404).json({ error: 'User not found' });

    if (user.roi_convert_to_usd) {
      // Convert to USD and credit USD
      const { usd, rate } = toUsd(db, currency, amount);
      credit(db, userId, 'USD', usd);
      db.payouts.push({
        user_id: Number(userId),
        plan_id: planId,
        original_currency: currency,
        original_amount: amount,
        fx_rate_to_usd: rate,
        usd_amount: usd,
        converted: true,
        created_at
      });
      saveDB(db);
      return res.json({ ok: true, converted: true, credited: { asset: 'USD', amount: usd }, rate });
    } else {
      // Credit in native currency
      credit(db, userId, currency, amount);
      db.payouts.push({
        user_id: Number(userId),
        plan_id: planId,
        original_currency: currency,
        original_amount: amount,
        fx_rate_to_usd: null,
        usd_amount: null,
        converted: false,
        created_at
      });
      saveDB(db);
      return res.json({ ok: true, converted: false, credited: { asset: currency, amount } });
    }
  } catch (e) {
    res.status(400).json({ error: String(e.message || e) });
  }
});

// --------------- Start Server ---------------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ROI API running on http://localhost:${PORT}`));
