(function () {
'use strict';
const API = String(window.RESOURCEX_API || 'http://localhost:4000').replace(/\/$/, '');
const $ = id => document.getElementById(id);
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let token = localStorage.getItem('rx_token');
let me = null, trust = 0, completed = 0, socket = null, online = 0, currentPage = 'home';
const S = { recent: [], mine: [], find: [], matches: { requests: [], suggestions: [], avgScore: null }, convs: [], active: null, impact: null, stats: null, activity: [], badges: { matches: 0, messages: 0, notifications: 0 } };

/* ---------- UI helpers ---------- */
const toastEl = $('toast'), modal = $('modal'), modalContent = $('modalContent');
function showToast(msg) { toastEl.textContent = msg; toastEl.classList.add('show'); clearTimeout(window.__tt); window.__tt = setTimeout(() => toastEl.classList.remove('show'), 2400); }
function openModal(title, body) { modalContent.innerHTML = '<h2>' + esc(title) + '</h2>' + body; modal.classList.add('open'); }
function closeModal() { modal.classList.remove('open'); }
$('modalX').onclick = closeModal;
modal.addEventListener('click', e => { if (e.target === modal) closeModal(); });
function banner(show) { $('netBanner').hidden = !show; }
const debounce = (fn, ms) => { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; };
function ago(ts) {
  const s = Math.max(0, (Date.now() - ts) / 1000);
  if (s < 60) return 'just now'; if (s < 3600) return Math.floor(s / 60) + 'm ago';
  if (s < 86400) return Math.floor(s / 3600) + 'h ago'; if (s < 172800) return 'Yesterday';
  return Math.floor(s / 86400) + 'd ago';
}
const clock = ts => new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const mass = kg => kg >= 1000 ? (kg / 1000).toFixed(1) + ' t' : Math.round(kg) + ' kg';
const inr = v => '₹ ' + (v >= 100000 ? (v / 100000).toFixed(1) + ' L' : Number(v).toLocaleString('en-IN'));
const CAT = {
  Healthcare: { pill: 'medical', label: 'Medical', thumb: 'medicine', icon: '💊', sym: 'blue', sy: '✚' },
  Industrial: { pill: 'industrial', label: 'Industrial', thumb: 'metal', icon: '▰', sym: 'slate', sy: '▰' },
  Agriculture: { pill: 'agriculture', label: 'Agriculture', thumb: 'tools', icon: '⚒', sym: 'green', sy: '⌁' },
  Research: { pill: 'research', label: 'Research', thumb: 'lab', icon: '🧪', sym: 'gray', sy: '♜' }
};
const cat = c => CAT[c] || CAT.Industrial;

/* ---------- API ---------- */
async function api(path, opts) {
  opts = opts || {};
  let res;
  try {
    res = await fetch(API + '/api' + path, { method: opts.method || 'GET', headers: Object.assign({ 'Content-Type': 'application/json' }, token ? { Authorization: 'Bearer ' + token } : {}), body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch (e) { banner(true); throw new Error('Cannot reach the ReSourceX server.'); }
  banner(false);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && token && !path.startsWith('/auth')) { logout(); throw new Error(data.error || 'Please sign in again.'); }
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

/* ---------- navigation ---------- */
function go(page) {
  currentPage = page;
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  const t = $('page-' + page); if (t) t.classList.add('active');
  document.querySelectorAll('.nav-item').forEach(n => n.classList.toggle('active', n.dataset.page === page));
  window.scrollTo({ top: 0, behavior: 'smooth' });
  if (page === 'profile') fillProfile();
  if (page === 'list' && !$('surplusForm').elements.location.value && me) $('surplusForm').elements.location.value = me.location;
  if (page === 'messages') { if (!S.active && S.convs.length) openConv(S.convs[0].id); else renderChat(); }
  if (page === 'find') loadFind();
}
document.addEventListener('click', e => {
  const l = e.target.closest('[data-page],[data-page-link]');
  if (l) go(l.dataset.page || l.dataset.pageLink);
});

/* ---------- data loading ---------- */
async function loadFind() {
  const q = $('resourceSearch').value.trim(), c = $('categoryFilter').value, d = $('distFilter').value;
  const p = new URLSearchParams({ excludeMine: '1' }); if (q) p.set('q', q); if (c) p.set('category', c); if (d) p.set('maxKm', d);
  try { S.find = (await api('/listings?' + p)).listings; renderFind(); } catch (e) { /* surfaced via banner */ }
}
async function loadAll() {
  if (!token) return;
  try {
    const [recent, mine, matches, convs, impact, stats, activity, badges, meRes] = await Promise.all([
      api('/listings/recent'), api('/listings?scope=mine'), api('/matches'), api('/conversations'), api('/impact'), api('/stats'), api('/activity'), api('/badges'), api('/me')
    ]);
    S.recent = recent.listings; S.mine = mine.listings; S.matches = matches; S.convs = convs.conversations; S.impact = impact; S.stats = stats; S.activity = activity.activity; S.badges = badges;
    me = meRes.user; trust = meRes.trustScore; completed = meRes.completedExchanges;
    renderAll();
    if (currentPage === 'find') loadFind();
  } catch (e) { /* banner already shown for network errors */ }
}
const loadAllSoon = debounce(loadAll, 250);

/* ---------- rendering ---------- */
function renderAll() { renderTop(); renderHome(); renderMine(); renderMatches(); renderThreads(); renderImpact(); renderBadges(); renderRules(); if (currentPage === 'find') renderFind(); }
function renderTop() {
  if (!me) return;
  $('userName').textContent = me.name; $('userOrg').textContent = me.org;
  $('userAvatar').textContent = me.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}
function renderBadges() {
  const m = $('badgeMatches'), g = $('badgeMessages');
  m.hidden = !S.badges.matches; m.textContent = S.badges.matches;
  g.hidden = !S.badges.messages; g.textContent = S.badges.messages;
  document.querySelector('.bell i').style.display = S.badges.notifications ? '' : 'none';
}
function renderHome() {
  const st = S.stats; if (!st) return;
  ['Healthcare', 'Agriculture', 'Research'].forEach(c => { $('cnt-' + c).textContent = st.categories[c] || 0; });
  $('fsAvg').textContent = S.matches.avgScore != null ? S.matches.avgScore + '% average compatibility' : 'Scored as matches form';
  $('fsEx').textContent = st.exchangesThisMonth + ' exchange' + (st.exchangesThisMonth === 1 ? '' : 's') + ' this month';
  $('listingBody').innerHTML = S.recent.length ? S.recent.map(l => { const k = cat(l.category); return '<tr><td><div class="resource"><div class="thumb ' + k.thumb + '">' + k.icon + '</div><div><b>' + esc(l.name) + '</b><small>' + esc(l.condition) + '</small></div></div></td><td><span class="pill ' + k.pill + '">' + k.label + '</span></td><td>' + esc(l.quantity) + '</td><td>' + esc(l.location) + '</td><td>' + (l.expiresInDays == null ? '—' : l.expiresInDays + ' days') + '</td><td><button class="view" data-act="view" data-id="' + l.id + '">View</button></td></tr>'; }).join('') : '<tr><td colspan="6" class="empty">No live listings yet.</td></tr>';
  const ic = { listed: ['green-bg', '⌁'], request: ['blue-bg', '✚'], match: ['blue-bg', '✚'], exchange: ['gray-bg', '♜'], joined: ['green-bg', '⌁'] };
  const titles = { listed: 'New surplus listed', request: 'New request', match: 'Match found', exchange: 'Resource exchanged', joined: 'New member' };
  $('activityList').innerHTML = S.activity.length ? S.activity.slice(0, 4).map(a => { const i = ic[a.type] || ic.listed; return '<div class="activity-row"><span class="round ' + i[0] + '">' + i[1] + '</span><div><b>' + (titles[a.type] || 'Update') + '</b><small>' + esc(a.text) + '</small></div><time>' + ago(a.at).replace(' ago', '') + '</time></div>'; }).join('') : '<div class="empty">No activity yet.</div>';
}
function renderRules() {
  const done = !!(me && me.rulesAcceptedAt);
  const b = $('ackRules'); b.textContent = done ? '✓ Accepted' : 'I Understand & Accept'; b.disabled = done;
}
function renderMine() {
  const rows = S.mine, f = $('listingFilter').value;
  const shown = rows.filter(l => !f || l.status === f);
  $('manageBody').innerHTML = shown.map(l => '<tr><td>' + esc(l.name) + '</td><td>' + esc(l.category) + '</td><td><span class="status ' + l.status + '">' + l.status.toUpperCase() + '</span></td><td>' + esc(l.quantity) + '</td><td>' + l.interest + ' request' + (l.interest === 1 ? '' : 's') + '</td><td>' + ago(l.updatedAt) + '</td><td><button class="outline view" data-act="manage" data-id="' + l.id + '">Manage</button></td></tr>').join('');
  $('manageEmpty').hidden = shown.length > 0;
  $('stLive').textContent = rows.filter(l => l.status === 'live').length; $('stMatched').textContent = rows.filter(l => l.status === 'matched').length;
  if (S.impact) { $('stDiverted').textContent = mass(S.impact.reusedKg + S.impact.recycledKg); $('stValue').textContent = inr(S.impact.valueInr); }
}
function renderFind() {
  $('liveChip').textContent = '● LIVE NETWORK · ' + online + ' online';
  $('resourceGrid').innerHTML = S.find.length ? S.find.map(l => { const k = cat(l.category); const st = l.myRequestStatus;
    return '<article class="resource-card card"><span class="resource-symbol ' + k.sym + '">' + k.sy + '</span><div><small>' + esc(l.category.toUpperCase()) + (l.distanceKm != null ? ' · ' + l.distanceKm + ' km' : '') + '</small><h2>' + esc(l.name) + '</h2><p>' + esc(l.quantity) + ' · ' + (l.expiresInDays == null ? esc(l.condition) : 'Expires in ' + l.expiresInDays + ' days') + '</p><b>' + l.match + '% match</b></div>' +
      (st ? '<span class="status ' + st + '">' + st.toUpperCase() + '</span>' : '<button class="outline" data-act="request" data-id="' + l.id + '">Request</button>') + '</article>'; }).join('') : '<div class="empty card" style="grid-column:1/-1">No matching resources right now. New listings appear here instantly.</div>';
}
function reqText(r) {
  const m = { pending: r.direction === 'incoming' ? 'Waiting for your decision' : 'Waiting for the owner', approved: 'Approved — coordinate transfer in Messages', declined: 'Declined', completed: 'Transfer completed' };
  return m[r.status] || r.status;
}
function renderMatches() {
  const M = S.matches; $('avgOrbit').textContent = M.avgScore != null ? M.avgScore : '—';
  $('matchList').innerHTML = M.requests.length ? M.requests.map(r => {
    let btn = '';
    if (r.direction === 'incoming' && r.status === 'pending') btn = '<button class="primary match-action" data-act="review" data-id="' + r.id + '">Review</button>';
    else if (r.direction === 'incoming' && r.status === 'approved') btn = '<button class="primary match-action" data-act="complete" data-id="' + r.id + '">Mark transferred</button>';
    else if (r.conversationId) btn = '<button class="outline match-action" data-act="chat" data-id="' + r.conversationId + '">Open chat</button>';
    return '<article class="match card"><div class="match-score">' + r.score + '%</div><div><small>' + (r.direction === 'incoming' ? 'INCOMING REQUEST' : 'YOUR REQUEST') + (r.distanceKm != null ? ' · ' + r.distanceKm + ' km' : '') + '</small><h2>' + esc(r.counterparty.org) + ' ↔ ' + esc(r.listing.name) + '</h2><p>' + esc(r.listing.quantity) + ' · ' + reqText(r) + '</p><div class="chips"><span>' + esc(r.status) + '</span>' + (r.counterparty.verified ? '<span>Verified</span>' : '') + '<span>' + esc(r.listing.category) + '</span></div></div>' + btn + '</article>';
  }).join('') : '<div class="empty card">No requests yet. Find a resource and send a request, or wait for others to request yours.</div>';
  $('suggestList').innerHTML = M.suggestions.length ? M.suggestions.map(l => '<article class="match card"><div class="match-score">' + l.match + '%</div><div><small>SUGGESTED' + (l.distanceKm != null ? ' · ' + l.distanceKm + ' km' : '') + '</small><h2>' + esc(l.name) + ' — ' + esc(l.owner.org) + '</h2><p>' + esc(l.quantity) + ' · ' + esc(l.location) + '</p><div class="chips"><span>' + esc(l.category) + '</span>' + (l.owner.verified ? '<span>Verified</span>' : '') + '</div></div><button class="primary match-action" data-act="view" data-id="' + l.id + '">View</button></article>').join('') : '<div class="empty card">No high-compatibility suggestions right now.</div>';
}
function renderThreads() {
  $('threadList').innerHTML = S.convs.length ? S.convs.map(c => '<div class="thread' + (S.active && S.active.id === c.id ? ' active' : '') + (c.unread ? ' unread' : '') + '" data-act="chat" data-id="' + c.id + '"><b>' + esc(c.org) + '</b><small>' + esc(c.lastMessage) + '</small><time>' + ago(c.lastAt) + '</time></div>').join('') : '<div class="empty">No conversations yet. Requesting a resource opens one automatically.</div>';
}
function renderChat() {
  const a = S.active;
  $('chatTitle').textContent = a ? a.org : 'Select a conversation';
  $('chatVerified').hidden = !(a && a.verified);
  $('chatBody').innerHTML = a ? a.messages.map(m => m.system ? '<div class="bubble sys">' + esc(m.text) + '</div>' : '<div class="bubble ' + (m.senderId === a.me ? 'me' : 'them') + '">' + esc(m.text) + '<time>' + clock(m.createdAt) + '</time></div>').join('') : '<div class="empty">Pick a conversation on the left.</div>';
  const b = $('chatBody'); b.scrollTop = b.scrollHeight;
}
function renderImpact() {
  const i = S.impact; if (!i) return;
  const sv = (id, v) => { $(id).textContent = v; };
  sv('imRecycled', mass(i.recycledKg)); sv('imReused', mass(i.reusedKg)); sv('imCo2', mass(i.co2Kg)); sv('imValue', inr(i.valueInr));
  sv('imEx', i.exchanges + ' completed exchange' + (i.exchanges === 1 ? '' : 's'));
  sv('isReused', mass(i.reusedKg)); sv('isRecycled', mass(i.recycledKg)); sv('isCo2', mass(i.co2Kg)); sv('isValue', inr(i.valueInr));
  sv('scoreLabel', i.circularityScore + ' / 100');
  $('bars').innerHTML = i.months.map(m => '<i style="height:' + m.score + '%" title="' + m.exchanges + ' exchange(s)"></i>').join('');
  $('months').innerHTML = i.months.map(m => '<span>' + esc(m.label) + '</span>').join('');
}
function fillProfile() {
  if (!me) return;
  $('pfName').value = me.name; $('pfOrg').value = me.org; $('pfType').value = me.orgType; $('pfEmail').value = me.email; $('pfLoc').value = me.location;
  $('pfAvatar').textContent = me.name.split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
  $('pfHead').textContent = me.name; $('pfSub').textContent = me.org + ' · ' + me.orgType;
  $('trustVal').textContent = trust + '/100'; $('trustBar').style.width = trust + '%';
  $('vrEx').textContent = completed + ' completed exchange' + (completed === 1 ? '' : 's');
  $('vrRules').textContent = me.rulesAcceptedAt ? '✓' : '○'; $('vrRulesTxt').textContent = me.rulesAcceptedAt ? 'Accepted' : 'Not yet accepted';
}

/* ---------- details / manage modals ---------- */
function findListing(id) { return [].concat(S.recent, S.find, S.mine, S.matches.suggestions).find(l => l.id === id); }
function listingModal(l) {
  const row = (a, b) => '<div class="row"><span>' + a + '</span><b>' + esc(b) + '</b></div>';
  let action = '';
  if (l.mine) action = '<button class="primary" data-act="manage" data-id="' + l.id + '">Manage listing</button>';
  else if (l.myRequestStatus) action = '<span class="status ' + l.myRequestStatus + '">YOUR REQUEST: ' + l.myRequestStatus.toUpperCase() + '</span>';
  else if (l.status === 'live') action = '<button class="primary" data-act="request" data-id="' + l.id + '">Request this resource</button>';
  openModal(l.name, '<p><b>' + (l.owner.verified ? 'Verified' : 'Unverified') + ' listing</b> by ' + esc(l.owner.org) + '. Review the details and exchange rules before requesting.</p>' +
    row('Category', l.category) + row('Quantity', l.quantity) + row('Condition', l.condition) + row('Location', l.location + (l.distanceKm != null ? ' (' + l.distanceKm + ' km)' : '')) + row('Expiry', l.expiresInDays == null ? 'No expiry stated' : l.expiresInDays + ' days') + (l.match != null ? row('Your match score', l.match + '%') : '') + (l.description ? '<p>' + esc(l.description) + '</p>' : '') + '<div class="actions">' + action + '</div>');
}
function requestModal(l) {
  openModal('Request ' + l.name, '<p>Your request notifies <b>' + esc(l.owner.org) + '</b> and opens a conversation. You must have accepted the Rules &amp; Regulations.</p><textarea id="reqMsg" maxlength="500" placeholder="Add a short note (optional)…"></textarea><div class="actions"><button class="primary" data-act="sendRequest" data-id="' + l.id + '">Send request</button></div>');
}
async function manageModal(id) {
  const l = findListing(id); if (!l) return;
  const { requests } = await api('/listings/' + id + '/requests');
  const body = requests.length ? requests.map(r => '<div class="row"><span>' + esc(r.counterparty.org) + ' · ' + r.score + '% · ' + esc(r.status) + '</span><span>' +
    (r.status === 'pending' ? '<button class="view" data-act="decide" data-d="approve" data-id="' + r.id + '">Approve</button> <button class="danger" data-act="decide" data-d="decline" data-id="' + r.id + '">Decline</button>' : r.status === 'approved' ? '<button class="view" data-act="complete" data-id="' + r.id + '">Mark transferred</button>' : '') + '</span></div>').join('') : '<p>No requests yet. You’ll be notified instantly when one arrives.</p>';
  openModal('Manage: ' + l.name, '<p>Status: <span class="status ' + l.status + '">' + l.status.toUpperCase() + '</span> · ' + esc(l.quantity) + ' · ' + esc(l.location) + '</p>' + body + (l.status !== 'completed' ? '<div class="actions"><button class="danger" data-act="delListing" data-id="' + l.id + '">Delete listing</button></div>' : ''));
}
function reviewModal(id) {
  const r = S.matches.requests.find(x => x.id === id); if (!r) return;
  openModal('Match review', '<p><b>' + esc(r.counterparty.org) + '</b> requested <b>' + esc(r.listing.name) + '</b> (' + esc(r.listing.quantity) + ').</p>' + (r.message ? '<p>“' + esc(r.message) + '”</p>' : '') +
    '<div class="modal-list"><div>Compatibility: ' + r.score + '%</div><div>Identity: ' + (r.counterparty.verified ? '✓ Verified' : 'Unverified') + '</div>' + (r.distanceKm != null ? '<div>Distance: ' + r.distanceKm + ' km</div>' : '') + '</div>' +
    '<div class="actions"><button class="primary" data-act="decide" data-d="approve" data-id="' + id + '">Approve match</button><button class="danger" data-act="decide" data-d="decline" data-id="' + id + '">Decline</button></div>');
}

/* ---------- actions (delegated) ---------- */
document.addEventListener('click', async e => {
  const el = e.target.closest('[data-act]'); if (!el) return;
  const act = el.dataset.act, id = el.dataset.id;
  if (el.dataset.busy) return; el.dataset.busy = '1';
  try {
    if (act === 'view') { const l = findListing(id); if (l) listingModal(l); }
    else if (act === 'request') { const l = findListing(id); if (l) requestModal(l); }
    else if (act === 'sendRequest') {
      await api('/listings/' + id + '/requests', { method: 'POST', body: { message: ($('reqMsg') || {}).value || '' } });
      closeModal(); showToast('Request sent — the owner has been notified'); await loadAll(); if (currentPage === 'find') loadFind();
    }
    else if (act === 'manage') await manageModal(id);
    else if (act === 'review') reviewModal(id);
    else if (act === 'decide') { await api('/requests/' + id + '/decision', { method: 'POST', body: { decision: el.dataset.d } }); closeModal(); showToast(el.dataset.d === 'approve' ? 'Match approved' : 'Request declined'); await loadAll(); }
    else if (act === 'complete') { await api('/requests/' + id + '/complete', { method: 'POST' }); closeModal(); showToast('Transfer marked complete — impact updated'); await loadAll(); }
    else if (act === 'delListing') { if (confirm('Delete this listing? Pending requests will be declined.')) { await api('/listings/' + id, { method: 'DELETE' }); closeModal(); showToast('Listing deleted'); await loadAll(); } }
    else if (act === 'chat') { go('messages'); await openConv(id); }
  } catch (err) {
    showToast(err.message);
    if (/Rules & Regulations/.test(err.message)) { closeModal(); go('rules'); }
  } finally { delete el.dataset.busy; }
});

/* ---------- messaging ---------- */
async function openConv(id) {
  try {
    const d = await api('/conversations/' + id);
    S.active = { id, org: d.conversation.org, verified: d.conversation.verified, messages: d.messages, me: d.me };
    renderChat(); renderThreads();
  } catch (e) { showToast(e.message); }
}
async function sendMessage(text) {
  if (!S.active) return showToast('Select a conversation first');
  text = text.trim(); if (!text) return;
  try { await api('/conversations/' + S.active.id + '/messages', { method: 'POST', body: { text } }); }
  catch (e) { showToast(e.message); }
}
$('sendMsg').onclick = () => { const i = $('messageInput'); const t = i.value; i.value = ''; sendMessage(t); };
$('messageInput').addEventListener('keydown', e => { if (e.key === 'Enter') $('sendMsg').click(); });
document.querySelectorAll('.quick button').forEach(b => b.onclick = () => sendMessage(b.textContent === 'Send docs' ? 'I have shared the batch documentation.' : b.textContent === 'Propose pickup' ? 'Can we schedule pickup for Thursday?' : 'Sharing the listing details with you.'));

/* ---------- forms & static controls ---------- */
$('surplusForm').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target, btn = f.querySelector('button[type=submit]'); btn.disabled = true;
  const g = n => f.elements[n].value;
  try {
    const d = await api('/listings', { method: 'POST', body: { resource: g('resource'), category: g('category'), quantity: g('quantity'), condition: g('condition'), expiry: g('expiry'), location: g('location'), description: g('description'), rulesAccepted: $('ruleCheck').checked } });
    $('aiRingVal').textContent = d.ai.confidence + '%'; $('aiConf').textContent = d.ai.confidence + '%'; $('aiSafety').textContent = d.ai.safety;
    $('aiPot').textContent = d.ai.potentialMatches + ' registered org' + (d.ai.potentialMatches === 1 ? '' : 's');
    showToast('Listing published • ' + d.ai.confidence + '% classification confidence' + (d.ai.categoryMatchesChoice ? '' : ' • detected category: ' + d.ai.detectedCategory));
    f.reset(); await loadAll(); setTimeout(() => go('listings'), 700);
  } catch (err) { showToast(err.message); } finally { btn.disabled = false; }
});
$('listingFilter').addEventListener('change', renderMine);
const findSoon = debounce(loadFind, 250);
$('resourceSearch').addEventListener('input', findSoon); $('categoryFilter').addEventListener('change', loadFind); $('distFilter').addEventListener('change', loadFind);
$('findBtn').onclick = async () => { await loadFind(); showToast(S.find.length + ' resource' + (S.find.length === 1 ? '' : 's') + ' found'); };
document.querySelectorAll('.category').forEach(c => c.onclick = () => { $('resourceSearch').value = ''; $('categoryFilter').value = c.dataset.filter; go('find'); });
$('globalSearch').addEventListener('keydown', e => { if (e.key === 'Enter') { $('resourceSearch').value = e.target.value; $('categoryFilter').value = ''; go('find'); } });
$('profileTop').onclick = () => go('profile');
$('saveProfile').onclick = async () => {
  try { const d = await api('/me', { method: 'PUT', body: { name: $('pfName').value, org: $('pfOrg').value, orgType: $('pfType').value, email: $('pfEmail').value, location: $('pfLoc').value } }); me = d.user; trust = d.trustScore; renderTop(); fillProfile(); showToast('Profile saved'); loadAllSoon(); }
  catch (e) { showToast(e.message); }
};
$('logoutBtn').onclick = logout;
$('ackRules').onclick = async () => { try { const d = await api('/me/rules', { method: 'POST' }); me = d.user; trust = d.trustScore; renderRules(); fillProfile(); showToast('Rules acknowledgement saved'); } catch (e) { showToast(e.message); } };
$('bellBtn').onclick = async () => {
  try {
    const { notifications } = await api('/notifications');
    openModal('Notification Center', '<div class="modal-list">' + (notifications.length ? notifications.map(n => '<div class="nitem ' + (n.read ? '' : 'unread') + '"><span>' + esc(n.text) + '</span><time>' + ago(n.createdAt) + '</time></div>').join('') : '<div>No notifications yet.</div>') + '</div>');
    if (notifications.some(n => !n.read)) { await api('/notifications/read', { method: 'POST' }); }
  } catch (e) { showToast(e.message); }
};
$('activityBtn').onclick = async () => {
  try { const { activity } = await api('/activity'); openModal('Network Activity', '<div class="modal-list">' + activity.map(a => '<div class="nitem"><span>' + esc(a.text) + '</span><time>' + ago(a.at) + '</time></div>').join('') + '</div>'); } catch (e) { showToast(e.message); }
};
$('mapBtn').onclick = () => {
  const st = S.stats || { categories: {}, cities: [] };
  openModal('Live Resource Map', '<p>Live resource counts across the network. Map-tile rendering needs a map provider key; counts below update in real time.</p><div class="modal-list">' + ['Healthcare', 'Agriculture', 'Research', 'Industrial'].map(c => '<div>● ' + (st.categories[c] || 0) + ' ' + c.toLowerCase() + ' resources</div>').join('') + st.cities.map(c => '<div>📍 ' + esc(c.city) + ': ' + c.count + ' live listing' + (c.count === 1 ? '' : 's') + '</div>').join('') + '</div>');
};
$('exportImpact').onclick = () => {
  const i = S.impact; if (!i) return;
  const q = v => '"' + String(v).replace(/"/g, '""') + '"';
  const lines = ['ReSourceX impact report', 'Organization,' + q(me.org), 'Generated,' + new Date().toISOString(), 'Completed exchanges,' + i.exchanges, 'Materials recycled (kg),' + i.recycledKg, 'Food & medical reused (kg),' + i.reusedKg, 'CO2 avoided est. (kg),' + i.co2Kg, 'Value created est. (INR),' + i.valueInr, '', 'Date,Resource,Quantity,Category'].concat(i.exchangeList.map(x => [x.date, q(x.resource), q(x.quantity), x.category].join(',')));
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' })); a.download = 'resourcex-impact-report.csv'; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  showToast('Impact report downloaded');
};
document.querySelectorAll('footer button:not([data-page-link])').forEach(b => b.onclick = () => openModal(b.textContent.trim(), b.textContent.trim() === 'Contact' ? '<p>Reach the ReSourceX team at support@resourcex.com.</p>' : '<p>ReSourceX uses organization and contact data only for legitimate exchange purposes. See Rules &amp; Regulations, section 07.</p>'));

/* ---------- auth ---------- */
let regMode = false;
function setMode(reg) {
  regMode = reg; $('regFields').hidden = !reg; $('tabLogin').classList.toggle('active', !reg); $('tabReg').classList.toggle('active', reg);
  $('authSubmit').textContent = reg ? 'Create account' : 'Sign in'; $('authErr').textContent = '';
  $('auPass').autocomplete = reg ? 'new-password' : 'current-password';
  ['auName', 'auOrg', 'auLoc'].forEach(i => { $(i).required = reg; });
}
$('tabLogin').onclick = () => setMode(false); $('tabReg').onclick = () => setMode(true);
$('authForm').addEventListener('submit', async e => {
  e.preventDefault(); $('authErr').textContent = ''; const b = $('authSubmit'); b.disabled = true;
  try {
    const d = regMode ? await api('/auth/register', { method: 'POST', body: { name: $('auName').value, org: $('auOrg').value, orgType: $('auType').value, location: $('auLoc').value, email: $('auEmail').value, password: $('auPass').value } })
      : await api('/auth/login', { method: 'POST', body: { email: $('auEmail').value, password: $('auPass').value } });
    token = d.token; localStorage.setItem('rx_token', token); me = d.user; $('authForm').reset(); start();
  } catch (err) { $('authErr').textContent = err.message; } finally { b.disabled = false; }
});
function logout() {
  token = null; me = null; S.active = null; localStorage.removeItem('rx_token');
  if (socket) { socket.disconnect(); socket = null; }
  closeModal(); $('auth').hidden = false;
}

/* ---------- real-time ---------- */
function connectSocket() {
  if (socket) return;
  const s = document.createElement('script');
  s.src = API + '/socket.io/socket.io.js';
  s.onload = () => {
    socket = window.io(API, { auth: cb => cb({ token }) });
    socket.on('connect', () => { banner(false); loadAllSoon(); });
    socket.on('connect_error', err => { if (err && err.message === 'unauthorized') logout(); else banner(true); });
    socket.on('presence', d => { online = d.online; if (currentPage === 'find') $('liveChip').textContent = '● LIVE NETWORK · ' + online + ' online'; });
    ['listings:changed', 'stats:changed', 'activity:new', 'inbox:changed'].forEach(ev => socket.on(ev, loadAllSoon));
    socket.on('notification:new', n => showToast('🔔 ' + n.text));
    socket.on('message:new', d => { if (S.active && S.active.id === d.conversationId && currentPage === 'messages') openConv(d.conversationId); else loadAllSoon(); });
  };
  s.onerror = () => banner(true);
  document.head.appendChild(s);
}

/* ---------- boot ---------- */
async function start() {
  $('auth').hidden = true;
  await loadAll(); connectSocket(); go('home');
}
(async function boot() {
  setMode(false);
  if (!token) { $('auth').hidden = false; return; }
  try { await api('/me'); start(); } catch (e) { if (token) { $('auth').hidden = false; } }
})();
})();
