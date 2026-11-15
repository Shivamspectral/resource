'use strict';
/**
 * ReSourceX backend — Express REST API + Socket.IO real-time.
 * Storage: a single JSON file (DATA_DIR/db.json), written atomically.
 * Auth: scrypt password hashing + HMAC-signed bearer tokens (no extra deps).
 */
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = Number(process.env.PORT) || 4000;
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'db.json');
const CORS_ORIGIN = (process.env.CORS_ORIGIN || '*').split(',').map(s => s.trim()).filter(Boolean);
const TOKEN_TTL_MS = 7 * 24 * 3600 * 1000;
const DAY = 86400000;

/* ------------------------------ secrets ------------------------------ */
function getSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const f = path.join(DATA_DIR, '.secret');
  if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8');
  const s = crypto.randomBytes(48).toString('hex');
  fs.writeFileSync(f, s, { mode: 0o600 });
  console.warn('[warn] JWT_SECRET not set — generated one in', f, '(set JWT_SECRET in production)');
  return s;
}
const SECRET = getSecret();

/* ------------------------------ storage ------------------------------ */
const uid = () => crypto.randomUUID();
let db;
function load() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return null; }
}
let saveTimer = null;
function flush() {
  clearTimeout(saveTimer); saveTimer = null;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db));
  fs.renameSync(tmp, DB_FILE);
}
function save() { if (!saveTimer) saveTimer = setTimeout(flush, 150); }
['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { try { flush(); } catch {} process.exit(0); }));

/* ------------------------------ helpers ------------------------------ */
const CATEGORIES = ['Healthcare', 'Agriculture', 'Research', 'Industrial'];
const CITIES = {
  'mumbai': [19.076, 72.878], 'navi mumbai': [19.033, 73.03], 'thane': [19.218, 72.978],
  'pune': [18.52, 73.857], 'pimpri-chinchwad': [18.627, 73.8], 'pimpri chinchwad': [18.627, 73.8], 'pcmc': [18.627, 73.8],
  'kolhapur': [16.705, 74.243], 'nagpur': [21.146, 79.088], 'nashik': [19.998, 73.79],
  'aurangabad': [19.876, 75.343], 'solapur': [17.66, 75.906], 'delhi': [28.61, 77.209], 'new delhi': [28.61, 77.209],
  'bengaluru': [12.972, 77.594], 'bangalore': [12.972, 77.594], 'hyderabad': [17.385, 78.487],
  'chennai': [13.083, 80.27], 'kolkata': [22.572, 88.364], 'ahmedabad': [23.023, 72.572],
  'jaipur': [26.912, 75.787], 'surat': [21.17, 72.831], 'lucknow': [26.847, 80.947],
  'indore': [22.72, 75.857], 'bhopal': [23.26, 77.41], 'panaji': [15.49, 73.828], 'goa': [15.49, 73.828],
  'kochi': [9.93, 76.267], 'chandigarh': [30.73, 76.78], 'vadodara': [22.307, 73.181]
};
function cityCoords(loc) {
  if (!loc) return null;
  for (const part of String(loc).toLowerCase().split(',')) {
    const k = part.trim();
    if (CITIES[k]) return CITIES[k];
  }
  return null;
}
function distanceKm(a, b) {
  const p = cityCoords(a), q = cityCoords(b);
  if (!p || !q) return null;
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(q[0] - p[0]), dLon = rad(q[1] - p[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(p[0])) * Math.cos(rad(q[0])) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(h)));
}
const clean = (v, max) => String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, max);
const emailOk = e => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(e);

function parseExpiryDays(text) {
  const t = clean(text, 60).toLowerCase();
  if (!t || t === '—' || t === '-') return null;
  let m = t.match(/(\d+)\s*(day|week|month|year)s?/);
  if (m) return Number(m[1]) * { day: 1, week: 7, month: 30, year: 365 }[m[2]];
  if (/^\d+$/.test(t)) return Number(t);
  const d = Date.parse(t);
  if (!isNaN(d)) return Math.ceil((d - Date.now()) / DAY);
  return null;
}
function parseQtyKg(q) {
  const m = String(q).replace(/,/g, '').match(/([\d.]+)\s*([a-zA-Z]*)/);
  if (!m) return 0;
  const n = parseFloat(m[1]) || 0, u = m[2].toLowerCase();
  if (['t', 'ton', 'tons', 'tonne', 'tonnes'].includes(u)) return n * 1000;
  if (['kg', 'kgs', 'l', 'lt', 'ltr', 'litre', 'litres', 'liter', 'liters'].includes(u)) return n;
  if (['g', 'gm', 'gms'].includes(u)) return n / 1000;
  if (['ml'].includes(u)) return n / 1000;
  return n * 0.2; // units / sets / pieces — rough estimate
}

/* "AI" classification: transparent keyword model */
const KW = {
  Healthcare: ['tablet', 'paracetamol', 'medicine', 'surgical', 'glove', 'mask', 'syringe', 'bandage', 'hospital', 'vaccine', 'ppe', 'sanitizer', 'medical', 'capsule', 'ointment'],
  Agriculture: ['seed', 'fertiliz', 'harvest', 'tractor', 'irrigation', 'crop', 'farm', 'grain', 'feed', 'sprayer', 'plough', 'sickle'],
  Research: ['reagent', 'chemical', 'lab', 'beaker', 'microscope', 'centrifuge', 'pipette', 'solvent', 'glassware', 'petri'],
  Industrial: ['steel', 'aluminium', 'aluminum', 'sheet', 'pipe', 'metal', 'machinery', 'pallet', 'cable', 'wood', 'plastic', 'furniture', 'office', 'copper']
};
const PROHIBITED = ['explosive', 'weapon', 'firearm', 'ammunition', 'narcotic', 'cocaine', 'heroin', 'radioactive', 'uranium', 'asbestos', 'counterfeit', 'stolen', 'bomb'];
function classify(name, desc, chosen) {
  const text = (name + ' ' + desc).toLowerCase();
  const hits = {};
  for (const c of CATEGORIES) hits[c] = KW[c].filter(k => text.includes(k)).length;
  const best = CATEGORIES.slice().sort((a, b) => hits[b] - hits[a])[0];
  const h = hits[best];
  const detected = h ? best : chosen;
  const confidence = h ? Math.min(99, 72 + h * 9) : 64;
  const flagged = PROHIBITED.filter(k => text.includes(k));
  return { detected, confidence, flagged, categoryMatchesChoice: detected === chosen };
}

/* ------------------------------ seed ------------------------------ */
function seed() {
  const now = Date.now();
  const mk = (org, orgType, location, email) => ({ id: uid(), name: org, org, email, orgType, location, verified: true, seed: true, passwordHash: null, rulesAcceptedAt: now, createdAt: now - 30 * DAY });
  const users = [
    mk('Sunrise Pharma Distributors', 'Healthcare', 'Navi Mumbai, MH', 'ops@sunrise-pharma.example'),
    mk('SteelWorks Pune', 'Industrial', 'Pune, MH', 'ops@steelworks.example'),
    mk('Rural Agro Farms', 'Agriculture', 'Kolhapur, MH', 'ops@ruralagro.example'),
    mk('Green Labs', 'Research', 'Nagpur, MH', 'ops@greenlabs.example')
  ];
  const L = (u, name, category, quantity, condition, days, description, ageH) => ({
    id: uid(), ownerId: u.id, name, category, quantity, condition, expiry: days ? days + ' days' : '—',
    expiresAt: days ? now + days * DAY : null, location: u.location, description, status: 'live',
    createdAt: now - ageH * 3600000, updatedAt: now - ageH * 3600000
  });
  const listings = [
    L(users[0], 'Paracetamol Tablets', 'Healthcare', '5,000 units', 'New / Sealed', 45, 'Sealed strips, batch documentation available.', 26),
    L(users[1], 'Aluminium Sheets', 'Industrial', '500 kg', 'Unused', 30, 'Unused 2 mm sheets on pallets.', 30),
    L(users[2], 'Harvesting Tools', 'Agriculture', '20 sets', 'Good Condition', 0, 'Sickles and hand tools, good condition.', 40),
    L(users[3], 'Chemical Reagents', 'Research', '50 L', 'Surplus', 60, 'Sealed lab-grade reagents with documentation.', 50)
  ];
  const activity = [
    { id: uid(), type: 'listed', text: 'Rural Agro Farms added 20 sets harvesting tools', at: now - 2 * 3600000 },
    { id: uid(), type: 'match', text: 'Green Labs requested 50 L reagents', at: now - 3 * 3600000 },
    { id: uid(), type: 'exchange', text: '500 kg aluminium sheets transferred', at: now - 5 * 3600000 },
    { id: uid(), type: 'request', text: 'City Hospital requested 1,000 units', at: now - 6 * 3600000 }
  ];
  return { users, listings, requests: [], conversations: [], messages: [], notifications: [], activity };
}
db = load() || seed();
flush();

/* ------------------------------ auth ------------------------------ */
const b64 = b => Buffer.from(b).toString('base64url');
function sign(payload) {
  const body = b64(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
function verifyToken(t) {
  if (!t || typeof t !== 'string' || !t.includes('.')) return null;
  const [body, sig] = t.split('.');
  const exp = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
  const a = Buffer.from(sig || ''), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch { return null; }
}
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return salt.toString('hex') + ':' + crypto.scryptSync(pw, salt, 64).toString('hex');
}
function checkPassword(pw, stored) {
  if (!stored) return false;
  const [s, h] = stored.split(':');
  const hash = crypto.scryptSync(pw, Buffer.from(s, 'hex'), 64);
  const want = Buffer.from(h, 'hex');
  return hash.length === want.length && crypto.timingSafeEqual(hash, want);
}
const userById = id => db.users.find(u => u.id === id);
const pubUser = u => ({ id: u.id, name: u.name, org: u.org, email: u.email, location: u.location, orgType: u.orgType, verified: u.verified, rulesAcceptedAt: u.rulesAcceptedAt || null, createdAt: u.createdAt });
function auth(req, res, next) {
  const h = req.headers.authorization || '';
  const p = verifyToken(h.startsWith('Bearer ') ? h.slice(7) : '');
  const u = p && userById(p.uid);
  if (!u) return res.status(401).json({ error: 'Please sign in again.' });
  req.user = u; next();
}

/* ------------------------------ domain logic ------------------------------ */
function score(listing, user) {
  let s = 58;
  if (user.orgType === listing.category) s += 16; else if (user.orgType === 'Industrial' || listing.category === 'Industrial') s += 6;
  const d = distanceKm(listing.location, user.location);
  s += d == null ? 5 : d <= 50 ? 14 : d <= 150 ? 10 : d <= 400 ? 6 : d <= 1000 ? 3 : 0;
  s += (!listing.expiresAt || listing.expiresAt - Date.now() > 30 * DAY) ? 6 : 2;
  const owner = userById(listing.ownerId);
  if (owner && owner.verified) s += 4;
  return Math.min(99, s);
}
function sweepExpired() {
  const now = Date.now(); let changed = false;
  for (const l of db.listings) if (l.status === 'live' && l.expiresAt && l.expiresAt < now) { l.status = 'expired'; l.updatedAt = now; changed = true; }
  if (changed) { save(); io.emit('listings:changed'); io.emit('stats:changed'); }
}
function listingView(l, viewer) {
  const owner = userById(l.ownerId) || {};
  const mine = l.ownerId === viewer.id;
  const myReq = db.requests.find(r => r.listingId === l.id && r.requesterId === viewer.id && r.status !== 'declined');
  return {
    id: l.id, name: l.name, category: l.category, quantity: l.quantity, condition: l.condition,
    expiry: l.expiry, expiresInDays: l.expiresAt ? Math.max(0, Math.ceil((l.expiresAt - Date.now()) / DAY)) : null,
    location: l.location, description: l.description, status: l.status,
    owner: { id: owner.id, org: owner.org, verified: !!owner.verified }, mine,
    distanceKm: distanceKm(l.location, viewer.location), match: mine ? null : score(l, viewer),
    interest: db.requests.filter(r => r.listingId === l.id).length,
    myRequestStatus: myReq ? myReq.status : null, createdAt: l.createdAt, updatedAt: l.updatedAt
  };
}
function requestView(r, viewer) {
  const l = db.listings.find(x => x.id === r.listingId) || {};
  const other = userById(viewer.id === r.ownerId ? r.requesterId : r.ownerId) || {};
  const conv = db.conversations.find(c => c.requestId === r.id);
  return {
    id: r.id, status: r.status, score: r.score, message: r.message, createdAt: r.createdAt, updatedAt: r.updatedAt,
    direction: viewer.id === r.ownerId ? 'incoming' : 'outgoing',
    listing: { id: l.id, name: l.name, quantity: l.quantity, category: l.category, location: l.location },
    counterparty: { org: other.org, verified: !!other.verified, location: other.location },
    distanceKm: distanceKm(l.location, other.location), conversationId: conv ? conv.id : null
  };
}
function addActivity(type, text) {
  db.activity.unshift({ id: uid(), type, text, at: Date.now() });
  db.activity = db.activity.slice(0, 200);
  io.emit('activity:new');
}
function notify(userId, type, text, link) {
  db.notifications.unshift({ id: uid(), userId, type, text, link: link || null, read: false, createdAt: Date.now() });
  db.notifications = db.notifications.slice(0, 2000);
  io.to('u:' + userId).emit('notification:new', { type, text });
  io.to('u:' + userId).emit('inbox:changed');
}
function unreadFor(convs, userId) {
  return convs.filter(c => c.participants.includes(userId)).reduce((n, c) => {
    const last = (c.reads || {})[userId] || 0;
    return n + db.messages.filter(m => m.conversationId === c.id && m.senderId !== userId && m.createdAt > last).length;
  }, 0);
}
function badgesFor(u) {
  return {
    matches: db.requests.filter(r => r.ownerId === u.id && r.status === 'pending').length,
    messages: unreadFor(db.conversations, u.id),
    notifications: db.notifications.filter(n => n.userId === u.id && !n.read).length
  };
}
function addMessage(conv, senderId, text, system) {
  const m = { id: uid(), conversationId: conv.id, senderId: system ? null : senderId, system: !!system, text, createdAt: Date.now() };
  db.messages.push(m);
  conv.lastMessageAt = m.createdAt;
  if (!system) { conv.reads = conv.reads || {}; conv.reads[senderId] = m.createdAt; }
  for (const p of conv.participants) {
    io.to('u:' + p).emit('message:new', { conversationId: conv.id, message: msgView(m) });
    io.to('u:' + p).emit('inbox:changed');
  }
  return m;
}
const msgView = m => ({ id: m.id, conversationId: m.conversationId, senderId: m.senderId, system: m.system, text: m.text, createdAt: m.createdAt });
function userImpact(u) {
  const done = db.requests.filter(r => r.status === 'completed' && (r.ownerId === u.id || r.requesterId === u.id));
  let reusedKg = 0, recycledKg = 0, totalKg = 0;
  const byMonth = {};
  for (const r of done) {
    const l = db.listings.find(x => x.id === r.listingId); if (!l) continue;
    const kg = parseQtyKg(l.quantity); totalKg += kg;
    if (l.category === 'Healthcare' || l.category === 'Agriculture') reusedKg += kg; else recycledKg += kg;
    const d = new Date(r.updatedAt); const k = d.getFullYear() + '-' + d.getMonth();
    byMonth[k] = (byMonth[k] || 0) + 1;
  }
  const months = [];
  const now = new Date();
  for (let i = 7; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    const n = byMonth[d.getFullYear() + '-' + d.getMonth()] || 0;
    months.push({ label: d.toLocaleString('en', { month: 'short' }), exchanges: n, score: Math.round(15 + 85 * (1 - Math.exp(-n / 3))) });
  }
  return {
    exchanges: done.length, reusedKg: Math.round(reusedKg), recycledKg: Math.round(recycledKg),
    co2Kg: Math.round(totalKg * 2.5), valueInr: Math.round(totalKg * 55), months,
    circularityScore: months[months.length - 1].score,
    exchangeList: done.map(r => { const l = db.listings.find(x => x.id === r.listingId) || {}; return { date: new Date(r.updatedAt).toISOString().slice(0, 10), resource: l.name, quantity: l.quantity, category: l.category }; })
  };
}
function trustScore(u) {
  const done = db.requests.filter(r => r.status === 'completed' && (r.ownerId === u.id || r.requesterId === u.id)).length;
  return Math.min(100, 50 + Math.min(30, done * 5) + (u.rulesAcceptedAt ? 10 : 0) + (u.org && u.email && u.location ? 10 : 0));
}

/* ------------------------------ app ------------------------------ */
const app = express();
const server = http.createServer(app);
const corsOpts = { origin: CORS_ORIGIN.includes('*') ? true : CORS_ORIGIN, credentials: false };
const io = new Server(server, { cors: { origin: corsOpts.origin, methods: ['GET', 'POST'] } });
app.disable('x-powered-by');
app.use(cors(corsOpts));
app.use(express.json({ limit: '50kb' }));
app.use((req, res, next) => { res.set({ 'X-Content-Type-Options': 'nosniff', 'Cache-Control': 'no-store' }); next(); });

// tiny in-memory rate limiter
const hits = new Map();
function limiter(max, windowMs) {
  return (req, res, next) => {
    const k = req.ip + '|' + req.baseUrl + req.path.split('/')[1];
    const now = Date.now(); const arr = (hits.get(k) || []).filter(t => now - t < windowMs);
    arr.push(now); hits.set(k, arr);
    if (arr.length > max) return res.status(429).json({ error: 'Too many requests. Please slow down.' });
    next();
  };
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 120000)) hits.delete(k); }, 60000).unref();
app.set('trust proxy', 1);
app.use('/api', limiter(400, 60000));
const authLimit = limiter(15, 60000);

const wrap = fn => (req, res) => { try { fn(req, res); } catch (e) { console.error(e); res.status(500).json({ error: 'Server error.' }); } };
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

app.get('/api/health', (req, res) => res.json({ ok: true, time: Date.now() }));

/* ---- auth ---- */
app.post('/api/auth/register', authLimit, wrap((req, res) => {
  const b = req.body || {};
  const name = clean(b.name, 80), org = clean(b.org, 120), email = clean(b.email, 120).toLowerCase();
  const location = clean(b.location, 80), orgType = CATEGORIES.includes(b.orgType) ? b.orgType : null;
  const pw = String(b.password || '');
  if (!name || !org) return bad(res, 'Name and organization are required.');
  if (!emailOk(email)) return bad(res, 'Enter a valid email address.');
  if (!location) return bad(res, 'Location is required (City, State).');
  if (!orgType) return bad(res, 'Choose your organization type.');
  if (pw.length < 8 || pw.length > 200) return bad(res, 'Password must be at least 8 characters.');
  if (db.users.some(u => u.email === email)) return bad(res, 'An account with this email already exists.', 409);
  const u = { id: uid(), name, org, email, orgType, location, verified: true, passwordHash: hashPassword(pw), rulesAcceptedAt: null, createdAt: Date.now() };
  db.users.push(u); save();
  addActivity('joined', org + ' joined the network');
  io.emit('stats:changed');
  res.json({ token: sign({ uid: u.id, exp: Date.now() + TOKEN_TTL_MS }), user: pubUser(u) });
}));
app.post('/api/auth/login', authLimit, wrap((req, res) => {
  const email = clean(req.body && req.body.email, 120).toLowerCase();
  const u = db.users.find(x => x.email === email);
  if (!u || !checkPassword(String(req.body.password || ''), u.passwordHash)) return bad(res, 'Incorrect email or password.', 401);
  res.json({ token: sign({ uid: u.id, exp: Date.now() + TOKEN_TTL_MS }), user: pubUser(u) });
}));

/* ---- me ---- */
app.get('/api/me', auth, wrap((req, res) => res.json({ user: pubUser(req.user), trustScore: trustScore(req.user), completedExchanges: userImpact(req.user).exchanges, badges: badgesFor(req.user) })));
app.put('/api/me', auth, wrap((req, res) => {
  const b = req.body || {}, u = req.user;
  const name = clean(b.name, 80), org = clean(b.org, 120), email = clean(b.email, 120).toLowerCase(), location = clean(b.location, 80);
  if (!name || !org || !location) return bad(res, 'Name, organization and location are required.');
  if (!emailOk(email)) return bad(res, 'Enter a valid email address.');
  if (email !== u.email && db.users.some(x => x.email === email)) return bad(res, 'That email is already in use.', 409);
  u.name = name; u.org = org; u.email = email; u.location = location;
  if (CATEGORIES.includes(b.orgType)) u.orgType = b.orgType;
  save();
  res.json({ user: pubUser(u), trustScore: trustScore(u) });
}));
app.post('/api/me/rules', auth, wrap((req, res) => { req.user.rulesAcceptedAt = Date.now(); save(); res.json({ user: pubUser(req.user), trustScore: trustScore(req.user) }); }));
app.get('/api/badges', auth, wrap((req, res) => res.json(badgesFor(req.user))));

/* ---- listings ---- */
app.get('/api/listings', auth, wrap((req, res) => {
  sweepExpired();
  const q = clean(req.query.q, 80).toLowerCase(), cat = clean(req.query.category, 30);
  const maxKm = Number(req.query.maxKm) || 0, scope = req.query.scope === 'mine' ? 'mine' : 'all';
  const limit = Math.min(200, Number(req.query.limit) || 100);
  let rows = db.listings.filter(l => scope === 'mine' ? l.ownerId === req.user.id : (l.status === 'live' && (req.query.excludeMine !== '1' || l.ownerId !== req.user.id)));
  if (cat && CATEGORIES.includes(cat)) rows = rows.filter(l => l.category === cat);
  if (q) rows = rows.filter(l => (l.name + ' ' + l.category + ' ' + l.description + ' ' + l.location + ' ' + ((userById(l.ownerId) || {}).org || '')).toLowerCase().includes(q));
  let views = rows.map(l => listingView(l, req.user));
  if (maxKm) views = views.filter(v => v.mine || (v.distanceKm != null && v.distanceKm <= maxKm));
  views.sort(scope === 'mine' ? (a, b) => b.updatedAt - a.updatedAt : (a, b) => (b.match || 0) - (a.match || 0) || b.createdAt - a.createdAt);
  res.json({ listings: views.slice(0, limit) });
}));
app.get('/api/listings/recent', auth, wrap((req, res) => {
  sweepExpired();
  const rows = db.listings.filter(l => l.status === 'live').sort((a, b) => b.createdAt - a.createdAt).slice(0, 5);
  res.json({ listings: rows.map(l => listingView(l, req.user)) });
}));
app.post('/api/listings', auth, wrap((req, res) => {
  const b = req.body || {}, u = req.user;
  const name = clean(b.resource, 100), quantity = clean(b.quantity, 40), condition = clean(b.condition, 40);
  const location = clean(b.location, 80), description = clean(b.description, 1000), expiry = clean(b.expiry, 40);
  const category = CATEGORIES.includes(b.category) ? b.category : null;
  if (!name || !quantity || !location || !category) return bad(res, 'Resource name, category, quantity and location are required.');
  if (!b.rulesAccepted) return bad(res, 'You must confirm the listing follows the platform rules.');
  const cls = classify(name, description, category);
  if (cls.flagged.length) return bad(res, 'Safety scan failed: this material appears to be restricted/prohibited and cannot be listed.', 422);
  const days = parseExpiryDays(expiry);
  if (days != null && days <= 0) return bad(res, 'Expired materials cannot be listed.', 422);
  if (category === 'Healthcare' && days == null) return bad(res, 'Healthcare listings must state an expiry (e.g. "45 days").', 422);
  const now = Date.now();
  const l = { id: uid(), ownerId: u.id, name, category, quantity, condition: condition || 'Surplus', expiry: days == null ? '—' : expiry, expiresAt: days == null ? null : now + days * DAY, location, description, status: 'live', createdAt: now, updatedAt: now };
  db.listings.push(l); save();
  addActivity('listed', u.org + ' added ' + quantity + ' ' + name);
  io.emit('listings:changed'); io.emit('stats:changed');
  const potential = db.users.filter(x => x.id !== u.id && x.orgType === category).length;
  res.status(201).json({ listing: listingView(l, u), ai: { confidence: cls.confidence, detectedCategory: cls.detected, categoryMatchesChoice: cls.categoryMatchesChoice, safety: 'Passed', potentialMatches: potential } });
}));
app.delete('/api/listings/:id', auth, wrap((req, res) => {
  const l = db.listings.find(x => x.id === req.params.id);
  if (!l || l.ownerId !== req.user.id) return bad(res, 'Listing not found.', 404);
  if (db.requests.some(r => r.listingId === l.id && r.status === 'approved')) return bad(res, 'This listing has an approved exchange in progress. Complete or decline it first.', 409);
  db.listings = db.listings.filter(x => x.id !== l.id);
  const dropped = db.requests.filter(r => r.listingId === l.id && r.status === 'pending');
  db.requests.forEach(r => { if (r.listingId === l.id && r.status === 'pending') { r.status = 'declined'; r.updatedAt = Date.now(); } });
  dropped.forEach(r => notify(r.requesterId, 'match', l.name + ' was withdrawn by the owner.', 'matches'));
  save(); io.emit('listings:changed'); io.emit('stats:changed');
  res.json({ ok: true });
}));
app.get('/api/listings/:id/requests', auth, wrap((req, res) => {
  const l = db.listings.find(x => x.id === req.params.id);
  if (!l || l.ownerId !== req.user.id) return bad(res, 'Listing not found.', 404);
  res.json({ requests: db.requests.filter(r => r.listingId === l.id).map(r => requestView(r, req.user)) });
}));

/* ---- requests / matches ---- */
app.post('/api/listings/:id/requests', auth, wrap((req, res) => {
  const l = db.listings.find(x => x.id === req.params.id), u = req.user;
  if (!l || l.status !== 'live') return bad(res, 'This listing is no longer available.', 404);
  if (l.ownerId === u.id) return bad(res, 'You cannot request your own listing.');
  if (!u.rulesAcceptedAt) return bad(res, 'Please accept the Rules & Regulations (Rules page) before requesting a resource.', 403);
  if (db.requests.some(r => r.listingId === l.id && r.requesterId === u.id && (r.status === 'pending' || r.status === 'approved'))) return bad(res, 'You already have an active request for this listing.', 409);
  const now = Date.now(), msg = clean(req.body && req.body.message, 500) || ('Hi, we would like to request ' + l.name + '.');
  const r = { id: uid(), listingId: l.id, ownerId: l.ownerId, requesterId: u.id, status: 'pending', score: score(l, u), message: msg, createdAt: now, updatedAt: now };
  db.requests.push(r);
  const conv = { id: uid(), requestId: r.id, listingId: l.id, participants: [l.ownerId, u.id], lastMessageAt: now, reads: {} };
  db.conversations.push(conv);
  addMessage(conv, u.id, msg, false);
  l.updatedAt = now; save();
  notify(l.ownerId, 'request', u.org + ' requested ' + l.name + ' (' + r.score + '% match)', 'matches');
  addActivity('request', u.org + ' requested ' + l.quantity + ' ' + l.name);
  io.emit('listings:changed');
  res.status(201).json({ request: requestView(r, u) });
}));
app.get('/api/matches', auth, wrap((req, res) => {
  sweepExpired();
  const u = req.user;
  const mine = db.requests.filter(r => r.ownerId === u.id || r.requesterId === u.id).sort((a, b) => b.updatedAt - a.updatedAt).map(r => requestView(r, u));
  const sugg = db.listings.filter(l => l.status === 'live' && l.ownerId !== u.id && !db.requests.some(r => r.listingId === l.id && r.requesterId === u.id && r.status !== 'declined'))
    .map(l => listingView(l, u)).filter(v => v.match >= 70).sort((a, b) => b.match - a.match).slice(0, 6);
  const scores = [...mine.map(m => m.score), ...sugg.map(s => s.match)];
  res.json({ requests: mine, suggestions: sugg, avgScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null });
}));
app.post('/api/requests/:id/decision', auth, wrap((req, res) => {
  const r = db.requests.find(x => x.id === req.params.id);
  if (!r || r.ownerId !== req.user.id) return bad(res, 'Request not found.', 404);
  if (r.status !== 'pending') return bad(res, 'This request has already been ' + r.status + '.', 409);
  const approve = req.body && req.body.decision === 'approve';
  if (!approve && !(req.body && req.body.decision === 'decline')) return bad(res, 'Invalid decision.');
  const l = db.listings.find(x => x.id === r.listingId), now = Date.now();
  if (approve && (!l || l.status !== 'live')) return bad(res, 'The listing is not live anymore.', 409);
  r.status = approve ? 'approved' : 'declined'; r.updatedAt = now;
  const conv = db.conversations.find(c => c.requestId === r.id);
  if (approve) {
    l.status = 'matched'; l.updatedAt = now;
    db.requests.filter(x => x.listingId === l.id && x.status === 'pending').forEach(x => { x.status = 'declined'; x.updatedAt = now; notify(x.requesterId, 'match', 'Your request for ' + l.name + ' was not selected.', 'matches'); });
    addActivity('match', req.user.org + ' approved a match for ' + l.name);
  }
  if (conv) addMessage(conv, null, approve ? 'Match approved. Agree on pickup, handling and documentation here.' : 'Request declined by the owner.', true);
  notify(r.requesterId, 'match', (approve ? 'Approved: ' : 'Declined: ') + (l ? l.name : 'your request'), 'matches');
  save(); io.emit('listings:changed'); io.to('u:' + r.ownerId).emit('inbox:changed');
  res.json({ request: requestView(r, req.user) });
}));
app.post('/api/requests/:id/complete', auth, wrap((req, res) => {
  const r = db.requests.find(x => x.id === req.params.id);
  if (!r || r.ownerId !== req.user.id) return bad(res, 'Request not found.', 404);
  if (r.status !== 'approved') return bad(res, 'Only approved matches can be completed.', 409);
  const l = db.listings.find(x => x.id === r.listingId), now = Date.now();
  r.status = 'completed'; r.updatedAt = now; if (l) { l.status = 'completed'; l.updatedAt = now; }
  const conv = db.conversations.find(c => c.requestId === r.id);
  if (conv) addMessage(conv, null, 'Transfer marked complete. Thank you for keeping resources in circulation.', true);
  notify(r.requesterId, 'exchange', 'Transfer completed: ' + (l ? l.quantity + ' ' + l.name : ''), 'impact');
  addActivity('exchange', (l ? l.quantity + ' ' + l.name : 'Resource') + ' transferred');
  save(); io.emit('listings:changed'); io.emit('stats:changed'); io.to('u:' + r.ownerId).emit('inbox:changed');
  res.json({ request: requestView(r, req.user) });
}));

/* ---- messages ---- */
app.get('/api/conversations', auth, wrap((req, res) => {
  const u = req.user;
  const rows = db.conversations.filter(c => c.participants.includes(u.id)).sort((a, b) => b.lastMessageAt - a.lastMessageAt).map(c => {
    const other = userById(c.participants.find(p => p !== u.id)) || {};
    const l = db.listings.find(x => x.id === c.listingId) || {};
    const msgs = db.messages.filter(m => m.conversationId === c.id);
    const last = msgs[msgs.length - 1];
    const lastRead = (c.reads || {})[u.id] || 0;
    return { id: c.id, org: other.org, verified: !!other.verified, listing: l.name, lastMessage: last ? last.text : '', lastAt: c.lastMessageAt, unread: msgs.filter(m => m.senderId !== u.id && m.createdAt > lastRead).length };
  });
  res.json({ conversations: rows });
}));
app.get('/api/conversations/:id', auth, wrap((req, res) => {
  const c = db.conversations.find(x => x.id === req.params.id);
  if (!c || !c.participants.includes(req.user.id)) return bad(res, 'Conversation not found.', 404);
  c.reads = c.reads || {}; c.reads[req.user.id] = Date.now(); save();
  io.to('u:' + req.user.id).emit('inbox:changed');
  const other = userById(c.participants.find(p => p !== req.user.id)) || {};
  res.json({ conversation: { id: c.id, org: other.org, verified: !!other.verified }, messages: db.messages.filter(m => m.conversationId === c.id).map(msgView), me: req.user.id });
}));
app.post('/api/conversations/:id/messages', auth, wrap((req, res) => {
  const c = db.conversations.find(x => x.id === req.params.id);
  if (!c || !c.participants.includes(req.user.id)) return bad(res, 'Conversation not found.', 404);
  const text = clean(req.body && req.body.text, 2000);
  if (!text) return bad(res, 'Message cannot be empty.');
  const m = addMessage(c, req.user.id, text, false); save();
  const other = c.participants.find(p => p !== req.user.id);
  if (other) notify(other, 'message', 'New message from ' + req.user.org, 'messages');
  res.status(201).json({ message: msgView(m) });
}));

/* ---- notifications / activity / stats / impact ---- */
app.get('/api/notifications', auth, wrap((req, res) => {
  const rows = db.notifications.filter(n => n.userId === req.user.id).slice(0, 30);
  res.json({ notifications: rows.map(n => ({ id: n.id, type: n.type, text: n.text, link: n.link, read: n.read, createdAt: n.createdAt })) });
}));
app.post('/api/notifications/read', auth, wrap((req, res) => {
  db.notifications.forEach(n => { if (n.userId === req.user.id) n.read = true; }); save();
  io.to('u:' + req.user.id).emit('inbox:changed'); res.json({ ok: true });
}));
app.get('/api/activity', auth, wrap((req, res) => res.json({ activity: db.activity.slice(0, 8) })));
app.get('/api/stats', auth, wrap((req, res) => {
  sweepExpired();
  const live = db.listings.filter(l => l.status === 'live');
  const categories = {}; CATEGORIES.forEach(c => categories[c] = live.filter(l => l.category === c).length);
  const cities = {}; live.forEach(l => { const k = clean(l.location.split(',')[0], 40); cities[k] = (cities[k] || 0) + 1; });
  const startOfMonth = new Date(); startOfMonth.setDate(1); startOfMonth.setHours(0, 0, 0, 0);
  res.json({
    categories, totalLive: live.length,
    exchangesThisMonth: db.requests.filter(r => r.status === 'completed' && r.updatedAt >= startOfMonth.getTime()).length,
    exchangesTotal: db.requests.filter(r => r.status === 'completed').length,
    cities: Object.entries(cities).map(([city, count]) => ({ city, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    online: onlineCount()
  });
}));
app.get('/api/impact', auth, wrap((req, res) => res.json(userImpact(req.user))));

app.use('/api', (req, res) => bad(res, 'Not found.', 404));
app.use((err, req, res, next) => { if (err && err.type === 'entity.parse.failed') return bad(res, 'Invalid JSON.'); console.error(err); res.status(500).json({ error: 'Server error.' }); });

/* ------------------------------ real-time ------------------------------ */
const online = new Map(); // userId -> socket count
const onlineCount = () => online.size;
io.use((socket, next) => {
  const p = verifyToken(socket.handshake.auth && socket.handshake.auth.token);
  const u = p && userById(p.uid);
  if (!u) return next(new Error('unauthorized'));
  socket.data.uid = u.id; next();
});
io.on('connection', socket => {
  const id = socket.data.uid;
  socket.join('u:' + id);
  online.set(id, (online.get(id) || 0) + 1);
  io.emit('presence', { online: onlineCount() });
  socket.on('disconnect', () => {
    const n = (online.get(id) || 1) - 1;
    if (n <= 0) online.delete(id); else online.set(id, n);
    io.emit('presence', { online: onlineCount() });
  });
});

setInterval(sweepExpired, 60000).unref();

if (require.main === module) {
  server.listen(PORT, () => console.log('ReSourceX backend listening on :' + PORT + ' (data: ' + DATA_DIR + ')'));
}
module.exports = { app, server, io };
