// server.js
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.PORT || 10000; // Render uses 10000
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-super-secret';

// ---- Simple JSON "DB"
const DB_FILE = 'db.json';
function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      fx: { "USD-USD":1, "USDT-USD":1, "TRX-USD":0.1, "BTC-USD":68000 },
      wallets: {}, // userId -> { USD, USDT, TRX, BTC }
      payouts: [], // array
      users: [
        // seed demo user (password: demo123)
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
function saveDB(db){ fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

let db = loadDB();

// ---- Helpers
function round2(n){ return Math.round(n * 100) / 100; }
function ensureWallet(uid){
  db.wallets[uid] = db.wallets[uid] || { USD:0, USDT:0, TRX:0, BTC:0, frozen: {} };
}
function createPayout(p){
  db.payouts.push({ ...p, created_at: new Date().toISOString() });
  saveDB(db);
}

// ---- Middleware
app.use(cors({
  origin: [
    "https://*.netlify.app",
    "https://roi-dashboard-anele.netlify.app",
    "http://localhost:3000"
  ]
}));
app.use(express.json());

// ---- Auth utils
function signToken(user){
  return jwt.sign({ uid: user.id, email: user.email }, JWT_SECRET, { expiresIn: '7d' });
}
function auth(req, res, next){
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : null;
  if(!token) return res.status(401).json({ error: 'Missing token' });
  try{
    const payload = jwt.verify(token, JWT_SECRET);
    req.user = payload;
    next();
  }catch(e){
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ---- Public
app.get('/', (req,res)=>{ res.json({ ok:true, name:'ROI API', version:'v1' }); });

// ---- Auth endpoints
app.post('/auth/register', (req,res)=>{
  const { email, password } = req.body;
  if(!email || !password) return res.status(400).json({ error:'email and password required' });
  if(db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase())){
    return res.status(409).json({ error:'Email already registered' });
  }
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
  res.json({ ok:true, token, user: { id:user.id, email:user.email, roi_convert_to_usd:user.roi_convert_to_usd } });
});

app.post('/auth/login', (req,res)=>{
  const { email, password } = req.body;
  const user = db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase());
  if(!user) return res.status(401).json({ error:'Invalid credentials' });
  if(!bcrypt.compareSync(password, user.password_hash)) return res.status(401).json({ error:'Invalid credentials' });
  const token = signToken(user);
  res.json({ ok:true, token, user: { id:user.id, email:user.email, roi_convert_to_usd:user.roi_convert_to_usd } });
});

// ---- Protected endpoints

// FX get/update
app.get('/fx', (req,res)=> res.json(db.fx));
app.post('/fx', auth, (req,res)=>{
  let { pair, rate } = req.body;
  if(!pair || typeof rate !== 'number') return res.status(400).json({ error:'pair and numeric rate required' });
  db.fx[pair] = rate;
  saveDB(db);
  res.json({ ok:true, pair, rate });
});

// Settings
app.post('/settings/roi-conversion', auth, (req,res)=>{
  const { userId, enabled } = req.body;
  const user = db.users.find(u => u.id === Number(userId));
  if(!user) return res.status(404).json({ error:'User not found' });
  user.roi_convert_to_usd = !!enabled;
  saveDB(db);
  res.json({ ok:true, userId:user.id, roi_convert_to_usd:user.roi_convert_to_usd });
});

// Portfolio
app.get('/portfolio/:userId', (req,res)=>{
  const userId = Number(req.params.userId);
  ensureWallet(userId);
  const w = db.wallets[userId];
  const fx = db.fx;
  const toUSD = (asset, amount)=>{
    if(asset==='USD' || asset==='USDT') return amount;
    const pair = `${asset}-USD`;
    return round2((amount||0) * (fx[pair] || 0));
  };
  const rows = [
    { asset:'USD', available: w.USD||0, usd: round2(w.USD||0) },
    { asset:'USDT', available: w.USDT||0, usd: round2(w.USDT||0) },
    { asset:'TRX', available: w.TRX||0, usd: round2(toUSD('TRX', w.TRX||0)) },
    { asset:'BTC', available: w.BTC||0, usd: round2(toUSD('BTC', w.BTC||0)) }
  ];
  const total = round2(rows.reduce((s,r)=>s + r.usd, 0));
  res.json({
    userId,
    totalUsd: total,
    breakdown: rows,
    pie: rows.map(r => ({ asset:r.asset, usd:r.usd, percent: total ? round2((r.usd/total)*100) : 0 }))
  });
});

// Payouts
app.get('/payouts/:userId', (req,res)=>{
  const userId = Number(req.params.userId);
  const out = db.payouts.filter(p => p.user_id === userId);
  res.json(out);
});

// Deposit (+/- for withdraw demo)
app.post('/deposit', auth, (req,res)=>{
  const { userId, asset, amount } = req.body;
  if(!userId || !asset || typeof amount !== 'number') return res.status(400).json({ error:'userId, asset, amount required' });
  ensureWallet(userId);
  if(!db.wallets[userId][asset]) db.wallets[userId][asset] = 0;
  const next = (db.wallets[userId][asset] + amount);
  if(next < 0) return res.status(400).json({ error:'Insufficient balance' });
  db.wallets[userId][asset] = round2(next);
  saveDB(db);
  res.json({ ok:true, userId, asset, newBalance: db.wallets[userId][asset] });
});

// Exchange
app.post('/exchange/convert', auth, (req,res)=>{
  const { userId, fromAsset, toAsset, amount, feePct=0 } = req.body;
  if(!userId || !fromAsset || !toAsset || typeof amount !== 'number') return res.status(400).json({ error:'missing fields' });
  ensureWallet(userId);
  if((db.wallets[userId][fromAsset]||0) < amount) return res.status(400).json({ error:'Insufficient '+fromAsset+' balance' });

  const fx = db.fx;
  const toUSD = (asset, amt)=>{
    if(asset==='USD' || asset==='USDT') return amt;
    const pair = `${asset}-USD`;
    return (amt||0) * (fx[pair] || 0);
  };
  const fromUSD = (asset, usd)=>{
    if(asset==='USD' || asset==='USDT') return usd;
    const pair = `${asset}-USD`;
    const r = fx[pair] || 0;
    return r ? (usd/r) : 0;
  };

  const grossUsd = toUSD(fromAsset, amount);
  const netUsd = grossUsd * (1 - (Number(feePct)||0)/100);
  const out = fromUSD(toAsset, netUsd);

  db.wallets[userId][fromAsset] = round2((db.wallets[userId][fromAsset]||0) - amount);
  db.wallets[userId][toAsset] = round2((db.wallets[userId][toAsset]||0) + out);
  saveDB(db);

  res.json({ ok:true, userId,
    from:{ asset:fromAsset, amount },
    to:{ asset:toAsset, amount: out },
    fx:{ fromPair:`${fromAsset}-USD`, fromRate: fx[`${fromAsset}-USD`]||1, toPair:`${toAsset}-USD`, toRate: fx[`${toAsset}-USD`]||1 },
    feePct: Number(feePct)||0
  });
});

// Settle ROI
app.post('/settle', auth, (req,res)=>{
  const { userId, planId, amount, currency } = req.body;
  if(!userId || !planId || typeof amount !== 'number' || !currency) return res.status(400).json({ error:'missing fields' });
  const user = db.users.find(u => u.id === Number(userId));
  if(!user) return res.status(404).json({ error:'User not found' });
  ensureWallet(userId);

  const convert = !!user.roi_convert_to_usd;
  if(!convert){
    db.wallets[userId][currency] = round2((db.wallets[userId][currency]||0) + amount);
    createPayout({
      user_id:userId, plan_id:planId,
      original_currency: currency, original_amount: amount,
      fx_rate_to_usd: null, usd_amount:null, converted:false
    });
    return res.json({ ok:true, converted:false, credited:{ asset:currency, amount } });
  }
  const pair = `${currency}-USD`;
  const rate = db.fx[pair] || 0;
  const usdAmount = round2(amount * rate);
  db.wallets[userId]['USD'] = round2((db.wallets[userId]['USD']||0) + usdAmount);
  createPayout({
    user_id:userId, plan_id:planId,
    original_currency: currency, original_amount: amount,
    fx_rate_to_usd: rate, usd_amount: usdAmount, converted:true
  });
  res.json({ ok:true, converted:true, credited: { asset:'USD', amount: usdAmount }, rate });
});

// ---- Start
app.listen(PORT, ()=> {
  console.log(`ROI API running on http://localhost:${PORT}`);
});
