'use strict';
// End-to-end API + realtime test. Run: npm test  (starts its own server on a temp data dir)
const os = require('os'), path = require('path'), fs = require('fs');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rx-'));
process.env.PORT = '0';
const assert = require('assert');
const { server } = require('./server');
const { io: ioc } = require('socket.io-client');

(async () => {
  await new Promise(r => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (m, p, body, tok) => {
    const r = await fetch(base + '/api' + p, { method: m, headers: { 'Content-Type': 'application/json', ...(tok ? { Authorization: 'Bearer ' + tok } : {}) }, body: body ? JSON.stringify(body) : undefined });
    return { s: r.status, j: await r.json() };
  };
  let n = 0; const ok = (c, m) => { assert(c, m); console.log('  ✓', m); n++; };

  // auth
  let r = await call('GET', '/listings'); ok(r.s === 401, 'unauthenticated blocked');
  r = await call('POST', '/auth/register', { name: 'A', org: 'CityCare Hospital', email: 'a@x.com', password: 'short', location: 'Mumbai, MH', orgType: 'Healthcare' }); ok(r.s === 400, 'weak password rejected');
  const A = (await call('POST', '/auth/register', { name: 'Asha', org: 'CityCare Hospital', email: 'a@x.com', password: 'password123', location: 'Mumbai, MH', orgType: 'Healthcare' })).j;
  const B = (await call('POST', '/auth/register', { name: 'Ben', org: 'Pune Pharma', email: 'b@x.com', password: 'password123', location: 'Pune, MH', orgType: 'Healthcare' })).j;
  ok(A.token && B.token, 'two users registered');
  r = await call('POST', '/auth/register', { name: 'A', org: 'X', email: 'a@x.com', password: 'password123', location: 'Pune', orgType: 'Healthcare' }); ok(r.s === 409, 'duplicate email rejected');
  r = await call('POST', '/auth/login', { email: 'a@x.com', password: 'wrongwrong' }); ok(r.s === 401, 'bad login rejected');
  r = await call('POST', '/auth/login', { email: 'a@x.com', password: 'password123' }); ok(r.s === 200 && r.j.token, 'login works');

  // realtime sockets
  const bad = ioc(base, { auth: { token: 'nope' }, reconnection: false });
  await new Promise(res => bad.on('connect_error', res)); ok(true, 'socket rejects bad token'); bad.close();
  const sA = ioc(base, { auth: { token: A.token } }), sB = ioc(base, { auth: { token: B.token } });
  await Promise.all([new Promise(r => sA.on('connect', r)), new Promise(r => sB.on('connect', r))]);
  const got = {}; for (const [k, s] of [['A', sA], ['B', sB]]) for (const ev of ['listings:changed', 'message:new', 'notification:new', 'presence']) s.on(ev, d => (got[k + ev] = d));

  // seed data + listing creation
  r = await call('GET', '/listings?excludeMine=1', null, A.token); ok(r.j.listings.length === 4, 'seed listings visible');
  r = await call('POST', '/listings', { resource: 'Surgical gloves', category: 'Healthcare', quantity: '2,000 units', expiry: '', location: 'Pune, MH', rulesAccepted: true }, B.token); ok(r.s === 422, 'healthcare without expiry rejected');
  r = await call('POST', '/listings', { resource: 'Old explosive material', category: 'Industrial', quantity: '1 kg', location: 'Pune', rulesAccepted: true }, B.token); ok(r.s === 422, 'prohibited material rejected');
  r = await call('POST', '/listings', { resource: 'Surgical gloves', category: 'Healthcare', quantity: '2,000 units', expiry: '90 days', location: 'Pune, MH' }, B.token); ok(r.s === 400, 'rules confirmation required');
  r = await call('POST', '/listings', { resource: 'Surgical gloves', category: 'Healthcare', quantity: '2,000 units', expiry: '90 days', location: 'Pune, MH', condition: 'New / Sealed', description: 'Sealed boxes of surgical gloves', rulesAccepted: true }, B.token);
  ok(r.s === 201 && r.j.ai.confidence >= 80, 'listing created with AI classification');
  const L = r.j.listing;
  await new Promise(r => setTimeout(r, 200)); ok(got.Alistings_changed !== undefined || 'Alistings:changed' in got, 'listing broadcast in real time to other user');

  // request flow
  r = await call('POST', `/listings/${L.id}/requests`, {}, A.token); ok(r.s === 403, 'must accept rules before requesting');
  await call('POST', '/me/rules', null, A.token);
  r = await call('POST', `/listings/${L.id}/requests`, { message: 'We need these urgently' }, B.token); ok(r.s === 400, 'cannot request own listing');
  r = await call('POST', `/listings/${L.id}/requests`, { message: 'We need these urgently' }, A.token); ok(r.s === 201 && r.j.request.score > 60, 'request created');
  const R = r.j.request;
  r = await call('POST', `/listings/${L.id}/requests`, {}, A.token); ok(r.s === 409, 'duplicate request blocked');
  await new Promise(r => setTimeout(r, 200));
  ok(got['Bnotification:new'], 'owner notified in real time'); ok(got['Bmessage:new'] && got['Bmessage:new'].message.text === 'We need these urgently', 'first message delivered in real time');
  r = await call('GET', '/badges', null, B.token); ok(r.j.matches === 1 && r.j.messages === 1, 'owner badges: 1 pending match, 1 unread');

  // security: A cannot approve
  r = await call('POST', `/requests/${R.id}/decision`, { decision: 'approve' }, A.token); ok(r.s === 404, 'only owner can approve');
  r = await call('POST', `/requests/${R.id}/decision`, { decision: 'approve' }, B.token); ok(r.s === 200 && r.j.request.status === 'approved', 'owner approves');
  r = await call('GET', '/listings?scope=mine', null, B.token); ok(r.j.listings.find(l => l.id === L.id).status === 'matched', 'listing becomes matched');

  // messaging
  const convs = (await call('GET', '/conversations', null, B.token)).j.conversations; ok(convs.length === 1, 'conversation exists');
  r = await call('GET', '/conversations/' + convs[0].id, null, A.token); ok(r.j.messages.length === 2, 'thread has request + system message');
  r = await call('POST', `/conversations/${convs[0].id}/messages`, { text: 'Pickup Thursday?' }, B.token); ok(r.s === 201, 'message sent');
  await new Promise(r => setTimeout(r, 200)); ok(got['Amessage:new'].message.text === 'Pickup Thursday?', 'message real-time to recipient');
  const third = (await call('POST', '/auth/register', { name: 'C', org: 'C Org', email: 'c@x.com', password: 'password123', location: 'Delhi', orgType: 'Research' })).j;
  r = await call('GET', '/conversations/' + convs[0].id, null, third.token); ok(r.s === 404, 'outsider cannot read conversation');

  // completion + impact
  r = await call('POST', `/requests/${R.id}/complete`, null, B.token); ok(r.s === 200 && r.j.request.status === 'completed', 'transfer completed');
  r = await call('GET', '/impact', null, A.token); ok(r.j.exchanges === 1 && r.j.co2Kg > 0 && r.j.months.length === 8, 'impact computed from completed exchange');
  r = await call('GET', '/stats', null, A.token); ok(r.j.exchangesThisMonth === 1 && r.j.online === 2, 'stats + online presence');
  r = await call('GET', '/me', null, A.token); ok(r.j.trustScore >= 65, 'trust score updated');

  // profile
  r = await call('PUT', '/me', { name: 'Asha K', org: 'CityCare Hospital', email: 'a@x.com', location: 'Thane, MH', orgType: 'Healthcare' }, A.token); ok(r.s === 200 && r.j.user.location === 'Thane, MH', 'profile update');

  // persistence
  await new Promise(r => setTimeout(r, 400)); ok(JSON.parse(fs.readFileSync(path.join(process.env.DATA_DIR, 'db.json'))).users.length === 7, 'data persisted to disk');
  console.log(`\nAll ${n} checks passed`); sA.close(); sB.close(); process.exit(0);
})().catch(e => { console.error('FAIL', e); process.exit(1); });
