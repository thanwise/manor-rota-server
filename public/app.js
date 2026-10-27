'use strict';
/* Rota app (server edition). Talks to the server's /api with PIN sign-in, live updates and an offline copy. */

const THEME_KEY = 'manorRota.theme';
const VERSION = '4.0';
const COLOURS = [['early', 'Orange'], ['late', 'Blue'], ['night', 'Indigo'], ['eve', 'Teal'], ['mid', 'Purple']];
const KIND_LABEL = { early: 'Early', late: 'Late', night: 'Night', eve: 'Evening', mid: 'Afternoon', hol: 'Holiday', custom: 'Other' };
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const DAYS_LONG = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const VIEWS = ['rota', 'hours', 'timeoff', 'staff', 'settings'];
const CHEV = '<svg class="chev" viewBox="0 0 8 13"><path d="M1.5 1.5 6.5 6.5 1.5 11.5"/></svg>';
const WARN = '<svg class="warnic" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3.5 2.5 20h19L12 3.5z"/><path d="M12 10v4.5M12 17.2v.3"/></svg>';
const ICON = {
  back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
  fwd: '<svg viewBox="0 0 24 24"><path d="M9 5l7 7-7 7"/></svg>',
  plus: '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>',
};
const DEFAULT_SETTINGS = {
  siteName: 'Manor', open24: true, opens: '06:00', closes: '23:00', defaultRate: 12.21, showPay: true,
  presets: [
    { id: 'p1', label: 'Early', s: '06:30', e: '14:30', k: 'early' },
    { id: 'p2', label: 'Late', s: '14:30', e: '22:30', k: 'late' },
    { id: 'p3', label: 'Night', s: '22:30', e: '06:30', k: 'night' },
    { id: 'p4', label: 'Evening', s: '18:30', e: '22:30', k: 'eve' },
    { id: 'p5', label: 'Afternoon', s: '14:30', e: '18:30', k: 'mid' },
    { id: 'p6', label: 'Early (Fri)', s: '06:30', e: '13:30', k: 'early' },
  ],
  roles: [
    { id: 'r1', label: 'Manager', k: 'night' },
    { id: 'r2', label: 'Supervisor', k: 'late' },
    { id: 'r3', label: 'Sales Assistant', k: 'early' },
  ],
  minStaff: [{ id: 'm1', allDay: true, from: '06:00', to: '22:00', count: 1, days: [0, 1, 2, 3, 4, 5, 6] }],
  breaks: { on: true, after: 6, mins: 20 },
  maxWeek: 48, rest: 11, budgetHours: 0, budgetPay: 0,
};

const pad = n => String(n).padStart(2, '0');
const iso = d => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
const parseISO = s => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
const toMin = t => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };
const fmtMin = m => m >= 1440 ? '24:00' : pad(Math.floor(m / 60) % 24) + ':' + pad(m % 60);
const durMin = c => (!c || c.t === 'hol' || !c.s || !c.e || c.s === c.e) ? 0 : ((toMin(c.e) - toMin(c.s)) + 1440) % 1440;
const fmtH = m => (Math.round(m / 60 * 100) / 100).toString();
const money = v => '£' + v.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const money0 = v => '£' + Math.round(v).toLocaleString('en-GB');
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = o => JSON.parse(JSON.stringify(o));
const $ = id => document.getElementById(id);
const shortD = d => `${MONTHS[d.getMonth()].slice(0, 3)} ${d.getDate()}`;
const niceDate = s => { const d = parseISO(s); return `${DAYS[(d.getDay() + 6) % 7]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; };
const uid = p => p + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const store = {
  get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } },
  del(k) { try { localStorage.removeItem(k); } catch (e) { } },
};

/* ---------------------------------------------------------------- state */
let data = null;      // {role, staff, weeks, settings, notes, requests}
let online = false, lastSync = null, role = 'viewer';
const S = () => data.settings;
const isManager = () => !!data && data.role === 'manager';
const canEdit = () => isManager() && online;
const ui = {
  view: 'rota', weekStart: mondayOf(new Date()), day: (new Date().getDay() + 6) % 7,
  month: { y: new Date().getFullYear(), m: new Date().getMonth() }, confirm: null, sheet: null,
};
try { const u = JSON.parse(sessionStorage.getItem('manorRota.ui') || 'null'); if (u && u.w) { ui.weekStart = mondayOf(parseISO(u.w)); ui.day = u.d | 0; } } catch (e) { }
const rememberUI = () => { try { sessionStorage.setItem('manorRota.ui', JSON.stringify({ w: iso(ui.weekStart), d: ui.day })); } catch (e) { } };
const HOST_THEME = document.documentElement.getAttribute('data-theme');
function applyTheme() {
  const t = store.get(THEME_KEY) || 'system';
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t);
  else if (HOST_THEME) document.documentElement.setAttribute('data-theme', HOST_THEME);
  else document.documentElement.removeAttribute('data-theme');
}
applyTheme();

/* ---------------------------------------------------------------- server */
const TOKEN_KEY = 'manorRota.token', CACHE_KEY = 'manorRota.cache';
let token = store.get(TOKEN_KEY);
class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
async function api(method, path, body) {
  let res;
  try {
    res = await fetch('api/' + path, {
      method, cache: 'no-store',
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    setOnline(false);
    throw new ApiError(0, "Can't reach the rota server. Check your connection and that the server is running.");
  }
  setOnline(true);
  let json = null; try { json = await res.json(); } catch (e) { }
  if (res.status === 401 && path !== 'login') { signOutLocal("You've been signed out. Enter your PIN again."); throw new ApiError(401, 'Signed out'); }
  if (!res.ok) throw new ApiError(res.status, (json && json.error) || 'The server could not do that.');
  return json;
}
function setOnline(v) { if (online === v) return; online = v; if (data) render(); }
function mergeSettings(s) {
  const out = Object.assign(clone(DEFAULT_SETTINGS), s || {});
  out.breaks = Object.assign(clone(DEFAULT_SETTINGS.breaks), (s && s.breaks) || {});
  for (const k of ['presets', 'roles']) if (!Array.isArray(out[k]) || !out[k].length) out[k] = clone(DEFAULT_SETTINGS[k]);
  if (!Array.isArray(out.minStaff)) out.minStaff = clone(DEFAULT_SETTINGS.minStaff);
  return out;
}
function normalise(st) {
  st.settings = mergeSettings(st.settings);
  st.notes = st.notes || {}; st.requests = st.requests || [];
  return st;
}
async function refresh() {
  try {
    const st = normalise(await api('GET', 'state'));
    data = st; lastSync = new Date();
    store.set(CACHE_KEY, JSON.stringify({ data: st, at: lastSync.toISOString() }));
    render();
  } catch (e) {
    if (e.status === 401) return;
    if (!data) { const c = store.get(CACHE_KEY); if (c) { try { const p = JSON.parse(c); data = normalise(p.data); lastSync = new Date(p.at); } catch (x) { } } }
    if (data) render(); else renderNoServer(e.message);
  }
}
// One change: update the screen first, send it to the server, then pull the new state. Rolls back on failure.
async function change({ optimistic, work, ok, needManager = true }) {
  if (needManager && !canEdit()) { toast(online ? 'Only a manager can change the rota.' : "You're offline. Changes need the server."); return false; }
  if (!online) { toast("You're offline. Changes need the server."); return false; }
  const snapshot = clone(data);
  if (optimistic) { optimistic(); render(); }
  try {
    await work();
    if (ok) toast(ok);
    await refresh();
    return true;
  } catch (e) {
    data = snapshot; render();
    if (e.status !== 401) toast(e.message || 'Something went wrong.');
    return false;
  }
}
const enc = encodeURIComponent;

/* live updates */
let events = null, retryT = null;
function connectEvents() {
  if (events) events.close();
  if (!token || !('EventSource' in window)) return;
  events = new EventSource('api/events?token=' + enc(token));
  events.addEventListener('change', ev => {
    setOnline(true);
    try { const { version } = JSON.parse(ev.data); if (!data || version !== data.version) refresh(); } catch (e) { }
  });
  events.onerror = () => {
    setOnline(false);
    if (events.readyState === 2) { clearTimeout(retryT); retryT = setTimeout(() => { api('GET', 'health').then(connectEvents).catch(() => connectEvents()); }, 8000); }
  };
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && token) refresh(); });
window.addEventListener('online', () => { if (token) { refresh(); connectEvents(); } });
function signOutLocal(msg) {
  token = null; store.del(TOKEN_KEY); store.del(CACHE_KEY); data = null;
  if (events) { events.close(); events = null; }
  closeSheet(); renderLogin(msg || '');
}

let downloadsCap = null;
const dayLabel = (week, day) => { const d = addDays(parseISO(week), day); return `${DAYS[day]} ${d.getDate()} ${MONTHS[d.getMonth()].slice(0, 3)}`; };

/* ---------------------------------------------------------------- rules: hours, breaks, staffing, working time */
const cellOf = (wid, sid, d) => data.weeks[wid]?.shifts?.[sid]?.[String(d)];
const sortedStaff = () => [...data.staff].sort((a, b) => (a.order ?? 99) - (b.order ?? 99) || String(a.name).localeCompare(b.name));
const staffForWeek = wid => { const sh = data.weeks[wid]?.shifts || {}; return sortedStaff().filter(s => s.active !== false || Object.keys(sh[s.id] || {}).length); };
const roleOf = p => S().roles.find(r => r.id === p.roleId);
function paidMin(c) {
  const m = durMin(c), b = S().breaks;
  return b.on && m > b.after * 60 ? Math.max(0, m - b.mins) : m;
}
const weekMin = (wid, sid) => { let t = 0; for (let d = 0; d < 7; d++) t += durMin(cellOf(wid, sid, d)); return t; };
const weekPaid = (wid, sid) => { let t = 0; for (let d = 0; d < 7; d++) t += paidMin(cellOf(wid, sid, d)); return t; };
function describe(c) {
  if (!c) return null;
  if (c.t === 'hol') return { k: 'hol', label: 'Holiday' };
  if (!durMin(c)) return null;
  const p = S().presets.find(p => p.s === c.s && p.e === c.e); if (p) return { k: p.k, label: p.label };
  const s = toMin(c.s);
  const k = (s >= 21 * 60 || s < 4 * 60) ? 'night' : s < 10 * 60 ? 'early' : s < 12 * 60 ? 'custom' : s < 14 * 60 ? 'mid' : s < 17 * 60 ? 'late' : 'eve';
  return { k, label: k === 'custom' ? 'Other' : KIND_LABEL[k] };
}
function openWindows() {
  if (S().open24) return [[0, 1440]];
  const o = toMin(S().opens), c = toMin(S().closes);
  if (o === c) return [[0, 1440]];
  return o < c ? [[o, c]] : [[0, c], [o, 1440]];
}
const SLOT = 15, SLOTS = 1440 / SLOT;
// Head count and required staff for every 15 minutes of a day.
function dayProfile(wid, d) {
  const count = new Array(SLOTS).fill(0), need = new Array(SLOTS).fill(0);
  const add = (a, b) => { for (let i = Math.floor(a / SLOT); i < Math.ceil(b / SLOT) && i < SLOTS; i++) count[i]++; };
  const prevW = d > 0 ? wid : iso(addDays(parseISO(wid), -7)), prevD = d > 0 ? d - 1 : 6;
  for (const sid in (data.weeks[wid]?.shifts || {})) { const c = cellOf(wid, sid, d), m = durMin(c); if (m) { const s = toMin(c.s); add(s, Math.min(s + m, 1440)); } }
  for (const sid in (data.weeks[prevW]?.shifts || {})) { const c = cellOf(prevW, sid, prevD), m = durMin(c); if (m) { const s = toMin(c.s); if (s + m > 1440) add(0, s + m - 1440); } }
  const open = new Array(SLOTS).fill(false);
  for (const [a, b] of openWindows()) for (let i = a / SLOT; i < b / SLOT; i++) open[i] = true;
  for (const r of S().minStaff) {
    if (!(r.days || []).includes(d)) continue;
    const wins = r.allDay ? [[0, 1440]] : (() => { const a = toMin(r.from), b = toMin(r.to); return a < b ? [[a, b]] : [[a, 1440], [0, b]]; })();
    for (const [a, b] of wins) for (let i = Math.floor(a / SLOT); i < Math.ceil(b / SLOT); i++) if (open[i]) need[i] = Math.max(need[i], Number(r.count) || 0);
  }
  return { count, need };
}
// Runs of the day: ok, short (someone on but below minimum), none (nobody on when someone is needed).
function dayRuns(wid, d) {
  const { count, need } = dayProfile(wid, d), runs = [];
  for (let i = 0; i < SLOTS; i++) {
    const st = need[i] === 0 ? (count[i] ? 'ok' : 'idle') : count[i] === 0 ? 'none' : count[i] < need[i] ? 'short' : 'ok';
    const last = runs[runs.length - 1];
    if (last && last.st === st && last.need === need[i]) last.b = (i + 1) * SLOT;
    else runs.push({ st, a: i * SLOT, b: (i + 1) * SLOT, need: need[i], have: count[i] });
  }
  return runs;
}
const dayProblems = (wid, d) => dayRuns(wid, d).filter(r => r.st === 'none' || r.st === 'short');

function weekChecks(wid) {
  const out = [], s = S();
  for (const p of staffForWeek(wid)) {
    const list = [];
    for (let d = -1; d < 7; d++) {
      const w = d < 0 ? iso(addDays(parseISO(wid), -7)) : wid, dd = d < 0 ? 6 : d;
      const c = cellOf(w, p.id, dd), m = durMin(c);
      if (m) list.push({ d, a: d * 1440 + toMin(c.s), b: d * 1440 + toMin(c.s) + m, m, c });
    }
    const mine = list.filter(x => x.d >= 0);
    const total = mine.reduce((t, x) => t + x.m, 0);
    const msg = (text, level = 'warn') => out.push({ sid: p.id, name: p.name, text, level });
    if (total > s.maxWeek * 60) msg(`${fmtH(total)} h this week, over the ${s.maxWeek} h limit`);
    const contract = Number(p.contract) || 0;
    if (contract && total < contract * 60 - 1) msg(`${fmtH(contract * 60 - total)} h short of ${contract} h contract`, 'info');
    if (contract && total > contract * 60 + 1) msg(`${fmtH(total - contract * 60)} h over ${contract} h contract`, 'info');
    for (let i = 1; i < list.length; i++) {
      const gap = list[i].a - list[i - 1].b;
      if (list[i].d < 0) continue;
      if (gap < 0) msg(`Shifts overlap on ${DAYS[list[i].d]}`);
      else if (gap < s.rest * 60) msg(`Only ${fmtH(gap)} h rest before ${DAYS[list[i].d]} shift (needs ${s.rest} h)`);
    }
    if (p.under18) {
      if (total > 40 * 60) msg(`Under 18: ${fmtH(total)} h this week, limit is 40 h`);
      for (const x of mine) {
        if (x.m > 8 * 60) msg(`Under 18: ${DAYS[x.d]} shift is over 8 h`);
        const st = toMin(x.c.s), en = st + x.m;
        if (st < 6 * 60 || en > 22 * 60) msg(`Under 18: ${DAYS[x.d]} shift runs between 22:00 and 06:00`);
      }
    }
  }
  for (let d = 0; d < 7; d++) for (const r of dayProblems(wid, d)) {
    out.push({ sid: null, name: DAYS_LONG[d], text: r.st === 'none' ? `Nobody on ${fmtMin(r.a)}–${fmtMin(r.b)}` : `Only ${r.have} on ${fmtMin(r.a)}–${fmtMin(r.b)}, needs ${r.need}`, level: 'warn', day: d });
  }
  return out;
}
function weekCost(wid) {
  let hrs = 0, cost = 0;
  for (const p of staffForWeek(wid)) { const m = weekPaid(wid, p.id); hrs += m; cost += m / 60 * (Number(p.rate) || 0); }
  return { hrs, cost };
}

/* ---------------------------------------------------------------- shell */
const nav = $('nav'), main = $('main');
let toastT; function toast(m) { const t = $('toast'); t.textContent = m; t.hidden = false; clearTimeout(toastT); toastT = setTimeout(() => t.hidden = true, 2800); }
let io;
function watchTitle() {
  if (io) io.disconnect();
  const h = main.querySelector('.large');
  if (!h || !('IntersectionObserver' in window)) { nav.classList.add('solid'); return; }
  nav.classList.remove('solid');
  io = new IntersectionObserver(([en]) => nav.classList.toggle('scrolled', !en.isIntersecting), { rootMargin: '-60px 0px 0px 0px' });
  io.observe(h);
}
function navBar({ left = '', title = '', right = '', extra = '', solid = false }) {
  nav.innerHTML = `<div class="navrow"><div class="l">${left}</div><div class="ntitle">${esc(title)}</div><div class="r">${right}</div></div>${extra}`;
  nav.classList.toggle('solid', solid);
}
const pendingCount = () => data ? data.requests.filter(r => r.status === 'pending').length : 0;
function render() {
  if (!data) return;
  document.body.classList.remove('signed-out');
  for (const v of VIEWS) $('tab-' + v).setAttribute('aria-current', ui.view === v ? 'page' : 'false');
  const badge = $('toBadge'), n = isManager() ? pendingCount() : 0;
  badge.hidden = !n; badge.textContent = n;
  ({ rota: renderRota, hours: renderHours, timeoff: renderTimeOff, staff: renderStaff, settings: renderSettings })[ui.view]();
  if (ui.view !== 'rota') watchTitle();
}
const syncAgo = () => {
  if (!lastSync) return 'never';
  const m = Math.round((Date.now() - lastSync) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : lastSync.toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};
const banner = () => online ? '' : `<div class="banner">Lost the live connection. Showing the copy from ${esc(syncAgo())}. Reload the page to reconnect.</div>`;

/* ---------------------------------------------------------------- sign in */
function renderLogin(msg) {
  document.body.classList.add('signed-out');
  ui.pin = '';
  main.innerHTML = `<div class="login">
    <img src="icon-180.png" alt="">
    <h1>Manor Rota</h1>
    <p>Enter your PIN</p>
    <div class="dots" id="dots" aria-live="polite"></div>
    <div class="err" id="loginErr" role="alert">${esc(msg || '')}</div>
    <div class="keypad" id="keypad">
      ${[1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `<button class="key" data-key="${n}" aria-label="${n}">${n}</button>`).join('')}
      <button class="key text" data-key="del" aria-label="Delete">Delete</button>
      <button class="key" data-key="0" aria-label="0">0</button>
      <button class="key go" data-key="go" id="goKey">Sign In</button>
    </div>
    <p class="server">Ask your manager for the PIN.</p>
  </div>`;
  drawDots();
}
function drawDots() {
  const n = Math.max(4, ui.pin.length);
  $('dots').innerHTML = Array.from({ length: n }, (_, i) => `<i class="${i < ui.pin.length ? 'on' : ''}"></i>`).join('');
  $('dots').setAttribute('aria-label', `${ui.pin.length} digits entered`);
  $('goKey').disabled = ui.pin.length < 4;
}
async function pressKey(k) {
  if (k === 'del') ui.pin = ui.pin.slice(0, -1);
  else if (k === 'go') return submitPin();
  else if (ui.pin.length < 8) ui.pin += k;
  $('loginErr').textContent = ''; drawDots();
}
async function submitPin() {
  if (ui.pin.length < 4) return;
  const pin = ui.pin;
  $('goKey').disabled = true;
  try {
    const r = await api('POST', 'login', { pin });
    token = r.token; store.set(TOKEN_KEY, token);
    main.innerHTML = '<div class="loading">Loading the rota…</div>';
    await refresh(); connectEvents();
    toast(r.role === 'manager' ? 'Signed in as manager' : 'Signed in. You can view the rota and request time off.');
  } catch (e) {
    ui.pin = ''; drawDots();
    $('loginErr').textContent = e.message;
    const d = $('dots'); d.classList.remove('shake'); void d.offsetWidth; d.classList.add('shake');
  }
}
document.addEventListener('keydown', ev => {
  if (!document.body.classList.contains('signed-out') || !$('keypad')) return;
  if (/^\d$/.test(ev.key)) pressKey(ev.key);
  else if (ev.key === 'Backspace') pressKey('del');
  else if (ev.key === 'Enter') pressKey('go');
});
function renderNoServer(msg) {
  document.body.classList.add('signed-out');
  main.innerHTML = `<div class="login"><img src="icon-180.png" alt=""><h1>Manor Rota</h1><p>${esc(msg)}</p>
    <div class="keypad" style="grid-template-columns:1fr"><button class="key go" style="width:200px;border-radius:14px;height:50px" data-act="retry">Try Again</button></div></div>`;
}

/* ---------------------------------------------------------------- Rota */
function pillHTML(c) {
  const ds = describe(c);
  if (!ds) return `<span class="pill off"><span class="t">Off</span></span>`;
  if (ds.k === 'hol') return `<span class="pill k-hol"><span class="t">Holiday</span><span class="k">Annual leave</span></span>`;
  return `<span class="pill k-${ds.k}"><span class="t">${c.s}–${c.e}</span><span class="k">${esc(ds.label)} · ${fmtH(durMin(c))}h</span></span>`;
}
function coverBar(wid, d) {
  const runs = dayRuns(wid, d);
  return runs.filter(r => r.st !== 'idle').map(r => `<i class="cv-${r.st}" style="left:${r.a / 14.4}%;width:${(r.b - r.a) / 14.4}%"></i>`).join('');
}
function renderRota() {
  const ws = ui.weekStart, wid = iso(ws), today = iso(new Date());
  const strip = `<div class="strip">${[...Array(7)].map((_, i) => {
    const d = addDays(ws, i), g = dayProblems(wid, i).length, n = data.notes[iso(d)];
    return `<button class="dchip ${iso(d) === today ? 'today' : ''}" data-day="${i}" aria-pressed="${ui.day === i}" aria-label="${DAYS_LONG[i]} ${d.getDate()}${g ? ', staffing gaps' : ''}${n ? ', has a note' : ''}"><span class="w">${DAYS[i].slice(0, 1)}</span><span class="n">${d.getDate()}</span><span class="flags"><span class="flag ${g ? 'bad' : ''}"></span>${n ? '<span class="flag note"></span>' : ''}</span></button>`;
  }).join('')}</div>`;
  navBar({
    left: `<button class="nbtn" data-act="wprev" aria-label="Previous week">${ICON.back}</button>`,
    title: `${shortD(ws)} – ${shortD(addDays(ws, 6))}`,
    right: `<button class="nbtn" data-act="wtoday">Today</button><button class="nbtn" data-act="wnext" aria-label="Next week">${ICON.fwd}</button>`,
    extra: strip, solid: true,
  });
  const d = ui.day, date = addDays(ws, d), dIso = iso(date), people = staffForWeek(wid);
  const dayMin = people.reduce((t, p) => t + durMin(cellOf(wid, p.id, d)), 0);
  const onShift = people.filter(p => durMin(cellOf(wid, p.id, d))).length;
  const problems = dayProblems(wid, d), checks = weekChecks(wid), warnBy = {};
  checks.forEach(c => { if (c.sid && c.level === 'warn') warnBy[c.sid] = (warnBy[c.sid] || 0) + 1; });
  const edit = canEdit(), note = data.notes[dIso];
  let h = banner() + `<h1 class="large">${DAYS_LONG[d]}</h1><p class="largesub">${esc(S().siteName)} · ${date.getDate()} ${MONTHS[date.getMonth()]} · ${onShift} on shift · ${fmtH(dayMin)} hours</p>`;
  if (note || edit) {
    h += `<div class="sh">Note</div><div class="group">${edit
      ? `<button class="cellrow tall" data-act="note"><span class="main"><span class="t1" style="white-space:normal;${note ? '' : 'color:var(--label2)'}">${note ? esc(note) : 'Add a note for this day, like a delivery or visit'}</span></span>${CHEV}</button>`
      : `<div class="cellrow tall static"><span class="main"><span class="t1" style="white-space:normal">${esc(note)}</span></span></div>`}</div>`;
  }
  const rules = S().minStaff.filter(r => (r.days || []).includes(d));
  h += `<div class="sh">Cover${S().open24 ? ' · open 24 hours' : ` · open ${S().opens}–${S().closes}`}</div>
  <div class="group"><div class="covwrap">
    <div class="cov" role="img" aria-label="${problems.length ? 'Staffing gaps' : 'Fully staffed'}">${coverBar(wid, d)}</div>
    <div class="ticks"><span>00</span><span>06</span><span>12</span><span>18</span><span>24</span></div>
    <div class="covtxt ${problems.length ? 'bad' : ''}">${problems.length ? problems.map(r => r.st === 'none' ? `Nobody on ${fmtMin(r.a)}–${fmtMin(r.b)}` : `Only ${r.have} on ${fmtMin(r.a)}–${fmtMin(r.b)} (needs ${r.need})`).join('<br>') : 'Fully staffed'}</div>
    <div class="covkey"><span><i class="cv-ok"></i>Enough staff</span><span><i class="cv-short"></i>Below minimum</span><span><i class="cv-none"></i>Nobody on</span></div>
    ${rules.length ? `<div class="covrule">Minimum: ${rules.map(r => `${r.allDay ? 'all day' : r.from + '–' + r.to} ${r.count}`).join(' · ')}</div>` : ''}
  </div></div><div class="sh">Shifts</div>`;
  if (!people.length) h += `<div class="group"><div class="cellrow static"><span class="main"><span class="t1" style="color:var(--label2)">No staff on the rota yet</span></span></div></div>`;
  else {
    h += `<div class="group">`;
    for (const p of people) {
      const r = roleOf(p), w = warnBy[p.id];
      const inner = `<span class="main"><span class="t1">${esc(p.name)}${w ? ` <span class="wcount">${WARN}</span>` : ''}</span><span class="t2">${r ? `<span class="rdot d-${r.k}"></span>${esc(r.label)} · ` : ''}${fmtH(weekMin(wid, p.id))} h this week</span></span>${pillHTML(cellOf(wid, p.id, d))}`;
      h += edit ? `<button class="cellrow tall" data-act="edit" data-sid="${esc(p.id)}">${inner}${CHEV}</button>` : `<div class="cellrow tall static">${inner}</div>`;
    }
    h += `</div>`;
  }
  // week summary
  const warnCount = checks.filter(c => c.level === 'warn').length, infoCount = checks.length - warnCount;
  const { hrs, cost } = weekCost(wid), s = S();
  h += `<div class="sh">This week</div><div class="group">
    <button class="cellrow" data-act="checks"><span class="main"><span class="t1">Checks</span><span class="t2">Working time, rest breaks, under 18s and staffing</span></span><span class="val ${warnCount ? 'bad' : 'good'}">${warnCount ? `${warnCount} to fix` : 'All clear'}${infoCount ? ` · ${infoCount} note${infoCount > 1 ? 's' : ''}` : ''}</span>${CHEV}</button>
    <div class="cellrow static"><span class="main"><span class="t1">Paid hours</span>${s.budgetHours ? `<span class="meter"><i style="width:${Math.min(100, hrs / 60 / s.budgetHours * 100)}%" class="${hrs / 60 > s.budgetHours ? 'over' : ''}"></i></span>` : ''}</span><span class="val">${fmtH(hrs)}${s.budgetHours ? ` of ${s.budgetHours}` : ''} h</span></div>
    ${isManager() && s.showPay ? `<div class="cellrow static"><span class="main"><span class="t1">Labour cost</span>${s.budgetPay ? `<span class="meter"><i style="width:${Math.min(100, cost / s.budgetPay * 100)}%" class="${cost > s.budgetPay ? 'over' : ''}"></i></span>` : ''}</span><span class="val">${money0(cost)}${s.budgetPay ? ` of ${money0(s.budgetPay)}` : ''}</span></div>` : ''}
    <button class="cellrow tintrow" data-act="sharetext">Share Week as Text</button>
    ${edit ? `<button class="cellrow tintrow" data-act="copy" ${data.weeks[iso(addDays(ws, -7))] ? '' : 'disabled style="opacity:.4"'}>${ui.confirm === 'copy' ? 'Tap again to replace this week' : 'Copy Last Week'}</button>
    <button class="cellrow tintrow" data-act="clearweek">${ui.confirm === 'clearweek' ? 'Tap again to clear every shift' : 'Clear This Week'}</button>` : ''}
  </div>`;
  h += edit ? `<p class="sf">Tap a name to change their shift. Everyone with the link sees changes straight away.${s.breaks.on ? ` Paid hours take off a ${s.breaks.mins} min unpaid break on shifts over ${s.breaks.after} h.` : ''}</p>` : `<p class="sf">${online ? "You're signed in with the staff PIN, so the rota is view only. You can still request time off." : ''}</p>`;
  main.innerHTML = h;
}

/* ---------------------------------------------------------------- Hours */
function monthData() {
  const { y, m } = ui.month, first = new Date(y, m, 1), last = new Date(y, m + 1, 0), weeks = [];
  for (let w = mondayOf(first); w <= last; w = addDays(w, 7)) { const ds = []; for (let d = 0; d < 7; d++) if (addDays(w, d).getMonth() === m) ds.push(d); weeks.push({ wid: iso(w), start: w, days: ds }); }
  const people = sortedStaff().filter(p => p.active !== false || weeks.some(w => w.days.some(d => durMin(cellOf(w.wid, p.id, d)))));
  const rows = people.map(p => {
    const per = weeks.map(w => w.days.reduce((t, d) => t + paidMin(cellOf(w.wid, p.id, d)), 0));
    const worked = weeks.reduce((t, w) => t + w.days.reduce((u, d) => u + durMin(cellOf(w.wid, p.id, d)), 0), 0);
    const tot = per.reduce((a, b) => a + b, 0), rate = Number(p.rate) || 0;
    const hol = weeks.reduce((n, w) => n + w.days.filter(d => cellOf(w.wid, p.id, d)?.t === 'hol').length, 0);
    const shifts = weeks.reduce((n, w) => n + w.days.filter(d => durMin(cellOf(w.wid, p.id, d))).length, 0);
    return { p, per, tot, worked, rate, hol, shifts, pay: tot / 60 * rate };
  });
  return { y, m, weeks, rows };
}
function renderHours() {
  const { y, m, weeks, rows } = monthData(), pay = S().showPay && isManager();
  navBar({ left: `<button class="nbtn" data-act="mprev" aria-label="Previous month">${ICON.back}</button>`, title: `${MONTHS[m]} ${y}`, right: `<button class="nbtn" data-act="mnext" aria-label="Next month">${ICON.fwd}</button>` });
  const grand = rows.reduce((t, r) => t + r.tot, 0), wages = rows.reduce((t, r) => t + r.pay, 0), hol = rows.reduce((t, r) => t + r.hol, 0);
  const range = w => { const a = addDays(w.start, w.days[0]), b = addDays(w.start, w.days[w.days.length - 1]); return a.getDate() === b.getDate() ? String(a.getDate()) : a.getDate() + '–' + b.getDate(); };
  let h = banner() + `<h1 class="large">${MONTHS[m]} ${y}</h1><p class="largesub">Paid hours${pay ? ' and estimated pay' : ''}</p>
  <div class="stats"><div class="stat"><b>${fmtH(grand)}</b><span>paid hours</span></div>${pay ? `<div class="stat"><b>${money(wages)}</b><span>estimated wages</span></div>` : `<div class="stat"><b>${hol}</b><span>holiday days</span></div>`}</div>
  <div class="sh">By person</div><div class="group">`;
  for (const r of rows) {
    const role = roleOf(r.p);
    h += `<div class="cellrow tall static"><span class="main"><span class="t1">${esc(r.p.name)}</span><span class="t2">${role ? esc(role.label) + ' · ' : ''}${r.shifts} shifts${r.hol ? ` · ${r.hol} holiday` : ''}${r.p.contract ? ` · contract ${r.p.contract} h/wk` : ''}</span><span class="t2">${r.per.map((v, i) => `${range(weeks[i])}: ${v ? fmtH(v) : '0'}`).join(' · ')}</span></span><span class="val" style="text-align:right"><span style="color:var(--label);display:block">${fmtH(r.tot)} h</span>${pay ? `<span style="font-size:13px">${money(r.pay)}</span>` : ''}</span></div>`;
  }
  const b = S().breaks;
  h += `</div><p class="sf">Only days inside ${MONTHS[m]} count, so a week that crosses months is split.${b.on ? ` Paid hours take off a ${b.mins} min unpaid break on shifts over ${b.after} h.` : ''}${pay ? ' Pay is paid hours times each rate, before tax, holiday pay or premiums.' : ''}</p>
  <div class="sh">Export</div><div class="group"><button class="cellrow tintrow" data-act="csv">Download ${MONTHS[m]} for Payroll (CSV)</button></div>`;
  main.innerHTML = h;
}

/* ---------------------------------------------------------------- Time off */
function renderTimeOff() {
  navBar({ title: 'Time Off', right: online ? `<button class="nbtn" data-act="newreq" aria-label="Request time off">${ICON.plus}</button>` : '' });
  const today = iso(new Date());
  const byName = id => (data.staff.find(p => p.id === id) || {}).name || 'Former staff';
  const reqs = [...data.requests].sort((a, b) => a.from.localeCompare(b.from));
  const pending = reqs.filter(r => r.status === 'pending');
  const upcoming = reqs.filter(r => r.status === 'approved' && r.to >= today);
  const past = reqs.filter(r => !(r.status === 'pending' || (r.status === 'approved' && r.to >= today))).reverse().slice(0, 20);
  const days = r => Math.round((parseISO(r.to) - parseISO(r.from)) / 864e5) + 1;
  const row = r => {
    const inner = `<span class="main"><span class="t1">${esc(byName(r.staffId))}</span><span class="t2">${niceDate(r.from)}${r.to !== r.from ? ' – ' + niceDate(r.to) : ''} · ${days(r)} day${days(r) > 1 ? 's' : ''}${r.reason ? ' · ' + esc(r.reason) : ''}</span></span><span class="status st-${r.status}">${r.status === 'pending' ? 'Waiting' : r.status === 'approved' ? 'Approved' : 'Declined'}</span>`;
    return isManager() && online ? `<button class="cellrow tall" data-act="req" data-rid="${esc(r.id)}">${inner}${CHEV}</button>` : `<div class="cellrow tall static">${inner}</div>`;
  };
  let h = banner() + `<h1 class="large">Time Off</h1><p class="largesub">${pending.length} waiting for a decision</p>`;
  h += `<div class="sh">Waiting</div><div class="group">${pending.map(row).join('') || '<div class="cellrow static"><span class="main"><span class="t1" style="color:var(--label2)">No requests waiting</span></span></div>'}</div>`;
  if (upcoming.length) h += `<div class="sh">Approved</div><div class="group">${upcoming.map(row).join('')}</div>`;
  if (past.length) h += `<div class="sh">Past and declined</div><div class="group">${past.map(row).join('')}</div>`;
  h += `<div class="group" style="margin-top:22px"><button class="cellrow tintrow" data-act="newreq" style="justify-content:center">Request Time Off</button></div>
  <p class="sf">${isManager() ? 'Approving a request marks those days as Holiday on the rota.' : 'Your manager approves requests. Approved days show as Holiday on the rota.'}</p>`;
  main.innerHTML = h;
}

/* ---------------------------------------------------------------- Staff */
function renderStaff() {
  const edit = canEdit();
  navBar({ title: 'Staff', right: edit ? `<button class="nbtn" data-act="addstaff" aria-label="Add staff">${ICON.plus}</button>` : '' });
  const list = sortedStaff(), act = list.filter(p => p.active !== false), old = list.filter(p => p.active === false);
  const row = p => {
    const r = roleOf(p);
    const inner = `<span class="main"><span class="t1">${esc(p.name)}${p.under18 ? ' <span class="tag">Under 18</span>' : ''}</span><span class="t2">${r ? `<span class="rdot d-${r.k}"></span>${esc(r.label)}` : 'No role'}${p.contract ? ` · ${p.contract} h/wk contract` : ''}</span></span>${isManager() && S().showPay ? `<span class="val">${money(Number(p.rate) || 0)}/h</span>` : ''}`;
    return edit ? `<button class="cellrow tall" data-act="staff" data-sid="${esc(p.id)}">${inner}${CHEV}</button>` : `<div class="cellrow tall static">${inner}</div>`;
  };
  let h = banner() + `<h1 class="large">Staff</h1><p class="largesub">${act.length} on the rota</p>`;
  const groups = {};
  for (const p of act) { const k = p.roleId && roleOf(p) ? p.roleId : '_'; (groups[k] = groups[k] || []).push(p); }
  const order = [...S().roles.map(r => r.id), '_'];
  for (const k of order) if (groups[k]) h += `<div class="sh">${k === '_' ? 'No role' : esc(S().roles.find(r => r.id === k).label)}</div><div class="group">${groups[k].map(row).join('')}</div>`;
  if (!act.length) h += `<div class="group"><div class="cellrow static"><span class="main"><span class="t1" style="color:var(--label2)">No staff yet</span></span></div></div>`;
  if (edit) h += `<div class="group" style="margin-top:22px"><button class="cellrow tintrow" data-act="addstaff" style="justify-content:center">Add Staff Member</button></div>`;
  if (old.length) h += `<div class="sh">Former staff</div><div class="group">${old.map(row).join('')}</div><p class="sf">Former staff keep their past shifts and hours.</p>`;
  main.innerHTML = h;
}

/* ---------------------------------------------------------------- Settings */
function renderSettings() {
  navBar({ title: 'Settings' });
  const s = S(), mgr = isManager(), edit = canEdit(), theme = store.get(THEME_KEY) || 'system';
  const dis = edit ? '' : 'disabled';
  const sw = (key, on, label) => `<div class="cellrow"><span class="main"><span class="t1">${label}</span></span><label class="switch"><input type="checkbox" id="set-${key.replace('.', '-')}" data-set="${key}" ${on ? 'checked' : ''} aria-label="${label}" ${dis}><span></span></label></div>`;
  const num = (key, val, label, unit, step = 1) => `<label class="cellrow"><span class="main"><span class="t1">${label}</span></span><input class="inl" type="number" min="0" step="${step}" inputmode="decimal" id="set-${key.replace('.', '-')}" data-set="${key}" value="${val}" style="width:22%" ${dis}><span class="val unit">${unit}</span></label>`;
  let h = banner() + `<h1 class="large">Settings</h1>
  <div class="sh">Account</div><div class="group">
    <div class="cellrow static"><span class="main"><span class="t1">Signed in as</span></span><span class="val">${mgr ? 'Manager' : 'Staff (view only)'}</span></div>
    <div class="cellrow static"><span class="main"><span class="t1">Server</span></span><span class="sync ${online ? '' : 'off'}"><i></i>${online ? 'Connected' : 'Offline'}</span></div>
    <div class="cellrow static"><span class="main"><span class="t1">Last synced</span></span><span class="val">${esc(syncAgo())}</span></div>
    <button class="cellrow tintrow" data-act="signout">Sign Out</button>
  </div>
  <div class="sh">Appearance on this phone</div><div class="segwrap"><div class="seg" role="group" aria-label="Appearance">
    ${['system', 'light', 'dark'].map(t => `<button data-act="theme" data-v="${t}" aria-pressed="${theme === t}">${t === 'system' ? 'Automatic' : t[0].toUpperCase() + t.slice(1)}</button>`).join('')}
  </div></div>`;
  if (mgr) {
    h += `<div class="sh">Business</div><div class="group">
      <label class="cellrow"><span class="main"><span class="t1">Store name</span></span><input class="inl" id="setSite" data-set="siteName" value="${esc(s.siteName)}" autocomplete="off" enterkeyhint="done" ${dis}></label>
      ${sw('open24', s.open24, 'Open 24 hours')}
      ${s.open24 ? '' : `<label class="cellrow"><span class="main"><span class="t1">Opens</span></span><input class="inl" type="time" id="setOpens" data-set="opens" value="${s.opens}" ${dis}></label>
      <label class="cellrow"><span class="main"><span class="t1">Closes</span></span><input class="inl" type="time" id="setCloses" data-set="closes" value="${s.closes}" ${dis}></label>`}
    </div>

    <div class="sh">Minimum staffing</div><div class="group">
      ${s.minStaff.map(r => `<button class="cellrow" data-act="rule" data-id="${esc(r.id)}" ${dis}><span class="main"><span class="t1">${r.allDay ? 'All opening hours' : `${r.from}–${r.to}`}</span><span class="t2">${daysText(r.days)}</span></span><span class="val">at least ${r.count}</span>${CHEV}</button>`).join('')}
      <button class="cellrow tintrow" data-act="addrule" ${dis}>Add Staffing Rule</button>
    </div><p class="sf">The cover bar shows amber when fewer people are on than these rules ask for, and red when nobody is on. Add a busier window, such as 2 people from 07:00 to 09:00 on weekdays.</p>

    <div class="sh">Job roles</div><div class="group">
      ${s.roles.map(r => `<button class="cellrow" data-act="role" data-id="${esc(r.id)}" ${dis}><span class="dotc d-${r.k}"></span><span class="main"><span class="t1">${esc(r.label)}</span></span><span class="val">${data.staff.filter(p => p.roleId === r.id && p.active !== false).length}</span>${CHEV}</button>`).join('')}
      <button class="cellrow tintrow" data-act="addrole" ${dis}>Add Role</button>
    </div>

    <div class="sh">Shift types</div><div class="group">
      ${s.presets.map(p => `<button class="cellrow" data-act="preset" data-pid="${esc(p.id)}" ${dis}><span class="dotc d-${p.k}"></span><span class="main"><span class="t1">${esc(p.label)}</span></span><span class="val" style="font-family:var(--mono);font-size:15px">${p.s}–${p.e}</span>${CHEV}</button>`).join('')}
      <button class="cellrow tintrow" data-act="addpreset" ${dis}>Add Shift Type</button>
    </div><p class="sf">These appear as quick picks when you change a shift.</p>

    <div class="sh">Breaks</div><div class="group">
      ${sw('breaks.on', s.breaks.on, 'Take off unpaid breaks')}
      ${s.breaks.on ? `${num('breaks.after', s.breaks.after, 'For shifts longer than', 'h', 0.5)}${num('breaks.mins', s.breaks.mins, 'Unpaid break', 'min', 5)}` : ''}
    </div><p class="sf">UK law gives adults a 20 minute break on shifts over 6 hours. Turn this off if your breaks are paid.</p>

    <div class="sh">Working time checks</div><div class="group">
      ${num('maxWeek', s.maxWeek, 'Weekly hours limit', 'h')}
      ${num('rest', s.rest, 'Rest between shifts', 'h')}
    </div><p class="sf">The Checks list warns when someone goes over these, and applies the stricter under-18 limits to anyone marked Under 18: 8 h a day, 40 h a week, no work between 22:00 and 06:00. Rules vary, so confirm them for your business.</p>

    <div class="sh">Labour budget per week</div><div class="group">
      ${num('budgetHours', s.budgetHours, 'Paid hours', 'h')}
      ${num('budgetPay', s.budgetPay, 'Labour cost', '£')}
    </div><p class="sf">Set to 0 to hide. The Rota shows this week against the budget.</p>

    <div class="sh">Pay</div><div class="group">
      ${sw('showPay', s.showPay, 'Show pay estimates')}
      <label class="cellrow"><span class="main"><span class="t1">Default rate for new staff</span></span><input class="inl" type="number" step="0.01" min="0" inputmode="decimal" id="setRate" data-set="defaultRate" value="${Number(s.defaultRate).toFixed(2)}" style="width:30%" ${dis}></label>
    </div><p class="sf">Pay rates are only sent to phones signed in as manager.</p>

    <div class="sh">Security</div><div class="group">
      <button class="cellrow" data-act="pinmanager" ${dis}><span class="main"><span class="t1">Change Manager PIN</span></span>${CHEV}</button>
      <button class="cellrow" data-act="pinstaff" ${dis}><span class="main"><span class="t1">Staff PIN</span></span>${CHEV}</button>
      <button class="cellrow" data-act="activity" ${dis}><span class="main"><span class="t1">Change Log</span></span>${CHEV}</button>
    </div><p class="sf">Anyone with the staff PIN can view the rota and hours and request time off, but can't change anything or see pay.</p>

    <div class="sh">Data</div><div class="group">
      <button class="cellrow tintrow" data-act="export" ${dis}>Download Backup</button>
      <button class="cellrow tintrow" data-act="import" ${dis}>Restore from Backup</button>
    </div><p class="sf">The server also saves a backup every day and keeps the last 30.</p>`;
  }
  h += `<p class="sf" style="text-align:center;margin:22px 16px 10px">Rota ${VERSION}</p>`;
  main.innerHTML = h;
}
const daysText = days => {
  const d = [...(days || [])].sort();
  if (d.length === 7) return 'Every day';
  if (d.join() === '0,1,2,3,4') return 'Weekdays';
  if (d.join() === '5,6') return 'Weekends';
  return d.map(i => DAYS[i]).join(', ') || 'No days';
};

/* ---------------------------------------------------------------- sheets */
const scrim = $('scrim'), sheet = $('sheet');
function openSheet({ title, sub = '', left = '<button class="nbtn" data-act="close">Cancel</button>', right = '', body }) {
  sheet.innerHTML = `<div class="sheethead"><span class="grab"></span><div class="l">${left}</div><h3 id="sheetTitle">${esc(title)}</h3><div class="r">${right}</div></div>${sub ? `<p class="sheetsub">${esc(sub)}</p>` : ''}${body}`;
  scrim.hidden = false; sheet.scrollTop = 0;
}
function closeSheet() { scrim.hidden = true; ui.sheet = null; sheet.innerHTML = ''; }
scrim.addEventListener('click', ev => { if (ev.target === scrim) closeSheet(); });
document.addEventListener('keydown', ev => { if (ev.key === 'Escape' && !scrim.hidden) closeSheet(); });
const colourPicker = k => `<div class="sh">Colour</div><div class="colours" id="colours">${COLOURS.map(([c, n]) => `<button class="d-${c}" data-act="colour" data-k="${c}" aria-label="${n}" aria-pressed="${k === c}"></button>`).join('')}</div>`;
const delBtn = (act, key, label) => `<div class="group" style="margin-top:22px"><button class="cellrow danger" data-act="${act}">${ui.confirm === key ? 'Tap Again to Delete' : label}</button></div>`;

function shiftSheet(sid) {
  const wid = iso(ui.weekStart), d = ui.day, p = data.staff.find(x => x.id === sid), c = cellOf(wid, sid, d), date = addDays(ui.weekStart, d);
  ui.sheet = { type: 'shift', wid, sid, d };
  const ds = describe(c);
  const mine = weekChecks(wid).filter(x => x.sid === sid);
  openSheet({
    title: p.name, sub: `${DAYS_LONG[d]} ${date.getDate()} ${MONTHS[date.getMonth()]} · ${!ds ? 'off' : ds.k === 'hol' ? 'holiday' : c.s + '–' + c.e}`,
    body: `${mine.length ? `<div class="checklist">${mine.map(x => `<div class="chk ${x.level}">${x.level === 'warn' ? WARN : ''}${esc(x.text)}</div>`).join('')}</div>` : ''}
    <div class="presets">${S().presets.map(pr => `<button type="button" class="k-${pr.k} ${c && c.s === pr.s && c.e === pr.e ? 'cur' : ''}" data-act="pick" data-s="${pr.s}" data-e="${pr.e}"><b>${esc(pr.label)}</b><span>${pr.s}–${pr.e}</span></button>`).join('')}</div>
    <div class="sh">Custom times</div><div class="group">
      <label class="cellrow"><span class="main"><span class="t1">Starts</span></span><input class="inl" type="time" id="cStart" value="${c && c.s ? c.s : '06:30'}"></label>
      <label class="cellrow"><span class="main"><span class="t1">Ends</span></span><input class="inl" type="time" id="cEnd" value="${c && c.e ? c.e : '14:30'}"></label>
      <button class="cellrow tintrow" data-act="usecustom">Use These Times</button>
    </div>
    <div class="group" style="margin-top:22px">
      <button class="cellrow tintrow" data-act="pickoff">Day Off</button>
      <button class="cellrow tintrow" data-act="pickhol">Holiday</button>
    </div>`,
  });
}
function staffSheet(sid) {
  const p = sid ? data.staff.find(x => x.id === sid) : null;
  ui.sheet = { type: 'staff', sid };
  const list = sortedStaff(), i = p ? list.findIndex(x => x.id === sid) : -1;
  openSheet({
    title: p ? p.name : 'New Staff', right: `<button class="nbtn bold" data-act="savestaff">${p ? 'Done' : 'Add'}</button>`,
    body: `<div class="group">
      <label class="cellrow"><span class="main"><span class="t1">Name</span></span><input class="inl" id="stName" value="${esc(p ? p.name : '')}" placeholder="Required" autocomplete="off"></label>
      <label class="cellrow"><span class="main"><span class="t1">Role</span></span><select class="inl" id="stRole"><option value="">No role</option>${S().roles.map(r => `<option value="${esc(r.id)}" ${p && p.roleId === r.id ? 'selected' : ''}>${esc(r.label)}</option>`).join('')}</select></label>
      <label class="cellrow"><span class="main"><span class="t1">Contract hours a week</span></span><input class="inl" id="stContract" type="number" step="0.5" min="0" inputmode="decimal" value="${p && p.contract ? p.contract : ''}" placeholder="None" style="width:25%"></label>
      <label class="cellrow"><span class="main"><span class="t1">Hourly rate £</span></span><input class="inl" id="stRate" type="number" step="0.01" min="0" inputmode="decimal" value="${(p ? Number(p.rate) || 0 : Number(S().defaultRate) || 0).toFixed(2)}" style="width:28%"></label>
      <div class="cellrow"><span class="main"><span class="t1">Under 18</span></span><label class="switch"><input type="checkbox" id="stU18" ${p && p.under18 ? 'checked' : ''} aria-label="Under 18"><span></span></label></div>
    </div><p class="sf">Under 18s get stricter checks: 8 h a day, 40 h a week, and no work between 22:00 and 06:00.</p>
    ${p ? `<div class="sh">Order on the rota</div><div class="group">
      <button class="cellrow tintrow" data-act="moveup" ${i <= 0 ? 'disabled style="opacity:.4"' : ''}>Move Up</button>
      <button class="cellrow tintrow" data-act="movedown" ${i >= list.length - 1 ? 'disabled style="opacity:.4"' : ''}>Move Down</button></div>
      <div class="group" style="margin-top:22px">${p.active === false
          ? `<button class="cellrow tintrow" data-act="restorestaff" style="justify-content:center">Put Back on the Rota</button>`
          : `<button class="cellrow danger" data-act="removestaff">${ui.confirm === 'rm' ? 'Tap Again to Remove' : 'Remove from Rota'}</button>`}</div>
      <p class="sf">Removing keeps past shifts and hours.</p>` : ''}`,
  });
}
function presetSheet(pid) {
  const p = pid ? S().presets.find(x => x.id === pid) : null;
  ui.sheet = { type: 'preset', pid, k: p ? p.k : 'early' };
  openSheet({
    title: p ? 'Shift Type' : 'New Shift Type', right: `<button class="nbtn bold" data-act="savepreset">${p ? 'Done' : 'Add'}</button>`,
    body: `<div class="group">
      <label class="cellrow"><span class="main"><span class="t1">Name</span></span><input class="inl" id="prName" value="${esc(p ? p.label : '')}" placeholder="e.g. Mid" autocomplete="off"></label>
      <label class="cellrow"><span class="main"><span class="t1">Starts</span></span><input class="inl" type="time" id="prStart" value="${p ? p.s : '10:00'}"></label>
      <label class="cellrow"><span class="main"><span class="t1">Ends</span></span><input class="inl" type="time" id="prEnd" value="${p ? p.e : '18:00'}"></label>
    </div>${colourPicker(ui.sheet.k)}
    ${p ? delBtn('delpreset', 'delp', 'Delete Shift Type') + '<p class="sf">Shifts already on the rota keep their times.</p>' : ''}`,
  });
}
function roleSheet(id) {
  const r = id ? S().roles.find(x => x.id === id) : null;
  ui.sheet = { type: 'role', id, k: r ? r.k : 'late' };
  openSheet({
    title: r ? 'Role' : 'New Role', right: `<button class="nbtn bold" data-act="saverole">${r ? 'Done' : 'Add'}</button>`,
    body: `<div class="group"><label class="cellrow"><span class="main"><span class="t1">Name</span></span><input class="inl" id="roName" value="${esc(r ? r.label : '')}" placeholder="e.g. Barista" autocomplete="off"></label></div>${colourPicker(ui.sheet.k)}
    ${r ? delBtn('delrole', 'delr', 'Delete Role') + '<p class="sf">Staff with this role will show as No role.</p>' : ''}`,
  });
}
function ruleSheet(id) {
  const r = id ? S().minStaff.find(x => x.id === id) : null;
  ui.sheet = { type: 'rule', id, days: r ? [...r.days] : [0, 1, 2, 3, 4], allDay: r ? !!r.allDay : false };
  openSheet({
    title: r ? 'Staffing Rule' : 'New Staffing Rule', right: `<button class="nbtn bold" data-act="saverule">${r ? 'Done' : 'Add'}</button>`,
    body: `<div class="group">
      <div class="cellrow"><span class="main"><span class="t1">All opening hours</span></span><label class="switch"><input type="checkbox" id="ruAll" ${ui.sheet.allDay ? 'checked' : ''} aria-label="All opening hours"><span></span></label></div>
      <label class="cellrow" id="ruFromRow" ${ui.sheet.allDay ? 'hidden' : ''}><span class="main"><span class="t1">From</span></span><input class="inl" type="time" id="ruFrom" value="${r ? r.from : '07:00'}"></label>
      <label class="cellrow" id="ruToRow" ${ui.sheet.allDay ? 'hidden' : ''}><span class="main"><span class="t1">To</span></span><input class="inl" type="time" id="ruTo" value="${r ? r.to : '09:00'}"></label>
      <label class="cellrow"><span class="main"><span class="t1">At least</span></span><input class="inl" type="number" id="ruCount" min="1" max="50" step="1" inputmode="numeric" value="${r ? r.count : 2}" style="width:20%"><span class="val unit">staff</span></label>
    </div>
    <div class="sh">Days</div><div class="daypick" id="daypick">${DAYS.map((n, i) => `<button data-act="ruday" data-d="${i}" aria-pressed="${ui.sheet.days.includes(i)}">${n}</button>`).join('')}</div>
    ${r ? delBtn('delrule', 'delru', 'Delete Rule') : ''}`,
  });
}
function noteSheet() {
  const dIso = iso(addDays(ui.weekStart, ui.day));
  ui.sheet = { type: 'note', date: dIso };
  openSheet({
    title: 'Note', sub: niceDate(dIso), right: `<button class="nbtn bold" data-act="savenote">Save</button>`,
    body: `<div class="group"><textarea id="noteText" class="ta" rows="5" maxlength="500" placeholder="Delivery at 07:00, area manager visit, stock count…">${esc(data.notes[dIso] || '')}</textarea></div><p class="sf">Everyone who can see the rota sees this note. Leave it empty to remove it.</p>`,
  });
  setTimeout(() => $('noteText') && $('noteText').focus(), 250);
}
function checksSheet() {
  const wid = iso(ui.weekStart), list = weekChecks(wid);
  openSheet({
    title: 'Checks', sub: `Week of ${shortD(ui.weekStart)}`, left: '', right: '<button class="nbtn bold" data-act="close">Done</button>',
    body: list.length ? ['warn', 'info'].map(l => {
      const xs = list.filter(x => x.level === l); if (!xs.length) return '';
      return `<div class="sh">${l === 'warn' ? 'To fix' : 'Worth knowing'}</div><div class="group">${xs.map(x => `<div class="cellrow tall static"><span class="main"><span class="t1">${esc(x.name)}</span><span class="t2" style="font-size:15px;color:${l === 'warn' ? 'var(--red)' : 'var(--label2)'}">${esc(x.text)}</span></span></div>`).join('')}</div>`;
    }).join('') + '<p class="sf">These checks follow your Settings. They help you spot problems but are not legal advice.</p>' : '<p class="sf" style="text-align:center;margin-top:20px">Nothing to fix this week.</p>',
  });
}
function shareSheet() {
  const ws = ui.weekStart, wid = iso(ws), people = staffForWeek(wid);
  const lines = [`${S().siteName} rota, week of ${shortD(ws)}`];
  for (let d = 0; d < 7; d++) {
    const date = addDays(ws, d), on = [];
    for (const p of people) { const c = cellOf(wid, p.id, d); if (durMin(c)) on.push(`${p.name} ${c.s}-${c.e}`); else if (c && c.t === 'hol') on.push(`${p.name} holiday`); }
    lines.push('', `${DAYS[d]} ${date.getDate()} ${MONTHS[date.getMonth()].slice(0, 3)}`);
    lines.push(on.length ? on.join('\n') : 'No shifts');
    const n = data.notes[iso(date)]; if (n) lines.push(`Note: ${n}`);
  }
  const text = lines.join('\n');
  ui.sheet = { type: 'share', text };
  openSheet({
    title: 'Share Week', left: '', right: '<button class="nbtn bold" data-act="close">Done</button>',
    body: `<div class="group"><textarea id="shareText" class="ta mono" rows="14" readonly>${esc(text)}</textarea></div>
    <button class="bigbtn" data-act="copytext">Copy Text</button><p class="sf">Paste it into WhatsApp, a text message or an email.</p>`,
  });
}
function requestSheet() {
  const today = iso(new Date());
  ui.sheet = { type: 'newreq' };
  const act = sortedStaff().filter(p => p.active !== false);
  openSheet({
    title: 'Request Time Off', right: `<button class="nbtn bold" data-act="sendreq">Send</button>`,
    body: `<div class="group">
      <label class="cellrow"><span class="main"><span class="t1">Who</span></span><select class="inl" id="rqWho"><option value="">Choose</option>${act.map(p => `<option value="${esc(p.id)}">${esc(p.name)}</option>`).join('')}</select></label>
      <label class="cellrow"><span class="main"><span class="t1">From</span></span><input class="inl" type="date" id="rqFrom" value="${today}" min="${today}"></label>
      <label class="cellrow"><span class="main"><span class="t1">To</span></span><input class="inl" type="date" id="rqTo" value="${today}" min="${today}"></label>
      <label class="cellrow"><span class="main"><span class="t1">Reason</span></span><input class="inl" id="rqWhy" maxlength="80" placeholder="Optional" autocomplete="off"></label>
    </div><p class="sf">The manager sees the request in Time Off and approves or declines it.</p>`,
  });
}
function decideSheet(rid) {
  const r = data.requests.find(x => x.id === rid); if (!r) return;
  const p = data.staff.find(x => x.id === r.staffId);
  ui.sheet = { type: 'decide', rid };
  const days = Math.round((parseISO(r.to) - parseISO(r.from)) / 864e5) + 1;
  const clashes = [];
  for (let i = 0; i < days && i < 62; i++) { const dt = addDays(parseISO(r.from), i), c = cellOf(iso(mondayOf(dt)), r.staffId, (dt.getDay() + 6) % 7); if (durMin(c)) clashes.push(`${niceDate(iso(dt))} ${c.s}–${c.e}`); }
  openSheet({
    title: p ? p.name : 'Request', sub: `${niceDate(r.from)}${r.to !== r.from ? ' – ' + niceDate(r.to) : ''} · ${days} day${days > 1 ? 's' : ''}`, left: '', right: '<button class="nbtn bold" data-act="close">Done</button>',
    body: `${r.reason ? `<div class="group"><div class="cellrow tall static"><span class="main"><span class="t2">Reason</span><span class="t1" style="white-space:normal">${esc(r.reason)}</span></span></div></div>` : ''}
    ${clashes.length ? `<div class="sh">Already rostered</div><div class="group">${clashes.map(c => `<div class="cellrow static"><span class="main"><span class="t1">${esc(c)}</span></span></div>`).join('')}</div><p class="sf">Approving replaces these shifts with Holiday.</p>` : ''}
    <div class="group" style="margin-top:22px">
      ${r.status !== 'approved' ? '<button class="cellrow tintrow" data-act="approve" style="justify-content:center;font-weight:600">Approve</button>' : ''}
      ${r.status !== 'declined' ? '<button class="cellrow danger" data-act="decline">Decline</button>' : ''}
    </div>
    ${delBtn('delreq', 'delq', 'Delete Request')}`,
  });
}
async function pinSheet(which) {
  ui.sheet = { type: 'pin', which };
  let staffSet = false;
  if (which === 'staff') { try { staffSet = (await api('GET', 'security')).staffPinSet; } catch (e) { } }
  openSheet({
    title: which === 'manager' ? 'Manager PIN' : 'Staff PIN', right: `<button class="nbtn bold" data-act="savepin">Save</button>`,
    sub: which === 'manager' ? 'Other phones signed in as manager will need the new PIN.' : (staffSet ? 'Staff sign-in is on. Saving a new PIN signs staff phones out.' : 'Staff sign-in is off. Set a PIN to let staff view the rota.'),
    body: `<div class="group">
      <label class="cellrow"><span class="main"><span class="t1">New PIN</span></span><input class="inl" id="pin1" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" placeholder="4–8 digits"></label>
      <label class="cellrow"><span class="main"><span class="t1">Confirm</span></span><input class="inl" id="pin2" type="password" inputmode="numeric" pattern="[0-9]*" maxlength="8" autocomplete="new-password" placeholder="Repeat"></label>
    </div>
    ${which === 'staff' && staffSet ? `<div class="group" style="margin-top:22px"><button class="cellrow danger" data-act="staffoff">${ui.confirm === 'staffoff' ? 'Tap Again to Turn Off' : 'Turn Off Staff Sign-in'}</button></div>` : ''}`,
  });
}
async function activitySheet() {
  ui.sheet = { type: 'activity' };
  openSheet({ title: 'Change Log', left: '', right: '<button class="nbtn bold" data-act="close">Done</button>', body: '<div class="loading">Loading…</div>' });
  try {
    const rows = await api('GET', 'activity?limit=100');
    if (!ui.sheet || ui.sheet.type !== 'activity') return;
    sheet.querySelector('.loading').outerHTML = rows.length ? `<div class="group activity">${rows.map(r => `<div class="cellrow tall static"><span class="main"><span class="t1" style="white-space:normal">${esc(r.text)}</span><span class="t2">${new Date(r.at).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })} · ${r.role === 'manager' ? 'Manager' : 'Staff'}</span></span></div>`).join('')}</div>` : '<p class="sf">No changes yet.</p>';
  } catch (e) { const l = sheet.querySelector('.loading'); if (l) l.textContent = e.message; }
}

/* ---------------------------------------------------------------- actions */
function putShift(val) {
  const e = ui.sheet; if (!e || e.type !== 'shift') return;
  closeSheet();
  const p = data.staff.find(x => x.id === e.sid);
  change({
    optimistic: () => {
      const w = data.weeks[e.wid] || (data.weeks[e.wid] = { start: e.wid, shifts: {} });
      const s = w.shifts[e.sid] || (w.shifts[e.sid] = {});
      if (val) s[String(e.d)] = val; else delete s[String(e.d)];
    },
    work: () => api('PUT', `shifts/${e.wid}/${enc(e.sid)}/${e.d}`, val || {}),
    log: `${p.name} · ${dayLabel(e.wid, e.d)} → ${val && val.t === 'hol' ? 'holiday' : val ? `${val.s}–${val.e}` : 'day off'}`,
  });
}
function moveStaff(sid, dir) {
  const list = sortedStaff(), i = list.findIndex(x => x.id === sid), j = i + dir;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  const changed = [];
  change({
    optimistic: () => list.forEach((p, k) => { const x = data.staff.find(s => s.id === p.id); if (x.order !== k) { x.order = k; changed.push(x.id); } }),
    work: () => api('POST', 'staff/order', { ids: list.map(p => p.id) }),
    log: 'Changed staff order',
  }).then(() => { if (ui.sheet && ui.sheet.sid === sid) staffSheet(sid); });
}
const saveSettings = patch => change({ optimistic: () => Object.assign(data.settings, patch), work: () => api('PUT', 'settings', data.settings) });
function setPath(obj, path, v) { const ks = path.split('.'); let o = obj; while (ks.length > 1) o = o[ks.shift()]; o[ks[0]] = v; }
async function approve(r, status) {
  const p = data.staff.find(x => x.id === r.staffId);
  const touched = new Set();
  await change({
    optimistic: () => {
      data.requests.find(x => x.id === r.id).status = status;
      if (status === 'approved') {
        const days = Math.min(62, Math.round((parseISO(r.to) - parseISO(r.from)) / 864e5) + 1);
        for (let i = 0; i < days; i++) {
          const dt = addDays(parseISO(r.from), i), wid = iso(mondayOf(dt)), d = (dt.getDay() + 6) % 7;
          const w = data.weeks[wid] || (data.weeks[wid] = { start: wid, shifts: {} });
          (w.shifts[r.staffId] = w.shifts[r.staffId] || {})[String(d)] = { t: 'hol' };
          touched.add(wid);
        }
      }
    },
    work: () => api('PATCH', 'requests/' + enc(r.id), { status }),
    log: `${status === 'approved' ? 'Approved' : 'Declined'} time off for ${p ? p.name : 'staff'}, ${niceDate(r.from)}${r.to !== r.from ? ' – ' + niceDate(r.to) : ''}`,
    ok: status === 'approved' ? 'Approved. Days marked as Holiday.' : 'Declined',
  });
}

const csvCell = v => { v = String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
async function saveFile(name, text, type) {
  if (downloadsCap) { try { await downloadsCap.save({ filename: name, data: text }); return; } catch (e) { if (e && e.code === 'declined') return; } }
  try {
    const url = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a'); a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  } catch (e) { toast("Couldn't download the file."); }
}
$('importFile').addEventListener('change', ev => {
  const f = ev.target.files[0]; ev.target.value = ''; if (!f) return;
  const r = new FileReader();
  r.onload = () => {
    let d; try { d = JSON.parse(r.result); } catch (e) { toast("That file isn't a rota backup."); return; }
    change({ work: () => api('POST', 'import', d), ok: 'Backup restored. The server kept a copy of the old rota first.' });
  };
  r.readAsText(f);
});

let confirmT;
function askTwice(key, rerender) {
  if (ui.confirm === key) { ui.confirm = null; clearTimeout(confirmT); return true; }
  ui.confirm = key; rerender(); clearTimeout(confirmT);
  confirmT = setTimeout(() => { if (ui.confirm === key) { ui.confirm = null; rerender(); } }, 4000);
  return false;
}
const pickedColour = () => { const b = document.querySelector('#colours [aria-pressed="true"]'); return b ? b.dataset.k : 'early'; };

document.addEventListener('click', async ev => {
  const key = ev.target.closest('[data-key]'); if (key) { pressKey(key.dataset.key); return; }
  const chip = ev.target.closest('.dchip'); if (chip) { ui.day = Number(chip.dataset.day); rememberUI(); render(); return; }
  const b = ev.target.closest('[data-act]'); if (!b || b.disabled) return;
  const a = b.dataset.act, sh = ui.sheet;
  switch (a) {
    case 'wprev': case 'wnext': ui.weekStart = addDays(ui.weekStart, a === 'wprev' ? -7 : 7); ui.confirm = null; rememberUI(); render(); break;
    case 'wtoday': ui.weekStart = mondayOf(new Date()); ui.day = (new Date().getDay() + 6) % 7; rememberUI(); render(); break;
    case 'mprev': case 'mnext': { let { y, m } = ui.month; m += a === 'mprev' ? -1 : 1; if (m < 0) { m = 11; y--; } if (m > 11) { m = 0; y++; } ui.month = { y, m }; render(); break; }
    case 'close': closeSheet(); break;
    case 'edit': shiftSheet(b.dataset.sid); break;
    case 'pick': putShift({ s: b.dataset.s, e: b.dataset.e }); break;
    case 'usecustom': { const s = $('cStart').value, e = $('cEnd').value; if (!s || !e) { toast('Enter a start and end time'); return; } putShift(s === e ? null : { s, e }); break; }
    case 'pickoff': putShift(null); break;
    case 'pickhol': putShift({ t: 'hol' }); break;
    case 'note': noteSheet(); break;
    case 'savenote': {
      const text = $('noteText').value.trim().slice(0, 500), date = sh.date; closeSheet();
      change({
        optimistic: () => { if (text) data.notes[date] = text; else delete data.notes[date]; },
        work: () => api('PUT', 'notes/' + date, { text }),
        log: `${text ? 'Note on' : 'Removed note on'} ${niceDate(date)}${text ? ': ' + text.slice(0, 60) : ''}`,
      });
      break;
    }
    case 'checks': checksSheet(); break;
    case 'sharetext': shareSheet(); break;
    case 'copytext': {
      const t = $('shareText');
      try { await navigator.clipboard.writeText(sh.text); toast('Copied'); }
      catch (e) { t.removeAttribute('readonly'); t.focus(); t.select(); t.setSelectionRange(0, 99999); t.setAttribute('readonly', ''); toast('Text selected. Tap Copy to copy it.'); }
      break;
    }
    case 'copy': {
      if (!askTwice('copy', render)) return;
      const wid = iso(ui.weekStart), prev = data.weeks[iso(addDays(ui.weekStart, -7))];
      change({ optimistic: () => { data.weeks[wid] = { start: wid, shifts: clone(prev?.shifts || {}) }; }, work: () => api('POST', `weeks/${wid}/copy-previous`, {}), log: `Copied last week into w/c ${dayLabel(wid, 0)}`, ok: 'Copied last week' });
      break;
    }
    case 'clearweek': { if (!askTwice('clearweek', render)) return; const wid = iso(ui.weekStart); change({ optimistic: () => { delete data.weeks[wid]; }, work: () => api('DELETE', 'weeks/' + wid), log: `Cleared w/c ${dayLabel(wid, 0)}`, ok: 'Week cleared' }); break; }
    case 'csv': {
      const { y, m, weeks, rows } = monthData(), pay = S().showPay && isManager();
      const out = [['Staff', 'Role', 'Contract h/wk', ...weeks.map((w, i) => `Week ${i + 1} (w/c ${w.wid}) paid h`), 'Worked hours', 'Paid hours', 'Shifts', 'Holiday days', ...(pay ? ['Rate', 'Est. pay'] : [])]];
      rows.forEach(r => out.push([r.p.name, roleOf(r.p)?.label || '', r.p.contract || '', ...r.per.map(fmtH), fmtH(r.worked), fmtH(r.tot), r.shifts, r.hol, ...(pay ? [r.rate.toFixed(2), r.pay.toFixed(2)] : [])]));
      saveFile(`rota-payroll-${y}-${pad(m + 1)}.csv`, out.map(r => r.map(csvCell).join(',')).join('\r\n'), 'text/csv');
      break;
    }
    case 'addstaff': ui.confirm = null; staffSheet(null); break;
    case 'staff': ui.confirm = null; staffSheet(b.dataset.sid); break;
    case 'savestaff': {
      const name = $('stName').value.trim().slice(0, 60);
      if (!name) { toast('Enter a name'); $('stName').focus(); return; }
      const f = { name, roleId: $('stRole').value || null, contract: Math.max(0, Number($('stContract').value) || 0), under18: $('stU18').checked };
      const rate = Math.round((Number($('stRate').value) || 0) * 100) / 100;
      let sid = sh.sid; const isNew = !sid; closeSheet();
      if (isNew) {
        const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'staff';
        sid = base; let n = 2; while (data.staff.some(s => s.id === sid)) sid = `${base}-${n++}`;
      }
      change({
        optimistic: () => {
          if (isNew) data.staff.push({ id: sid, ...f, rate, order: data.staff.reduce((m, s) => Math.max(m, s.order ?? 0), -1) + 1, active: true });
          else Object.assign(data.staff.find(x => x.id === sid), f, { rate });
        },
        work: () => isNew ? api('POST', 'staff', { ...f, rate }) : api('PATCH', 'staff/' + enc(sid), { ...f, rate }),
        log: isNew ? `Added ${name}` : `Updated ${name}`, ok: isNew ? `Added ${name}` : null,
      });
      break;
    }
    case 'moveup': moveStaff(sh.sid, -1); break;
    case 'movedown': moveStaff(sh.sid, 1); break;
    case 'removestaff': { const sid = sh.sid; if (!askTwice('rm', () => staffSheet(sid))) return; closeSheet(); const p = data.staff.find(x => x.id === sid); change({ optimistic: () => { p.active = false; }, work: () => api('PATCH', 'staff/' + enc(sid), { active: false }), log: `${p.name} removed from rota`, ok: 'Removed from rota' }); break; }
    case 'restorestaff': { const sid = sh.sid; closeSheet(); const p = data.staff.find(x => x.id === sid); change({ optimistic: () => { p.active = true; }, work: () => api('PATCH', 'staff/' + enc(sid), { active: true }), log: `${p.name} back on the rota` }); break; }
    case 'theme': store.set(THEME_KEY, b.dataset.v); applyTheme(); render(); break;
    case 'colour': document.querySelectorAll('#colours button').forEach(x => x.setAttribute('aria-pressed', x === b)); break;
    case 'preset': ui.confirm = null; presetSheet(b.dataset.pid); break;
    case 'addpreset': ui.confirm = null; presetSheet(null); break;
    case 'savepreset': {
      const label = $('prName').value.trim().slice(0, 30), s = $('prStart').value, e = $('prEnd').value, k = pickedColour();
      if (!label) { toast('Give the shift type a name'); return; }
      if (!s || !e || s === e) { toast('Start and end must be different times'); return; }
      const presets = clone(S().presets);
      if (sh.pid) Object.assign(presets.find(x => x.id === sh.pid), { label, s, e, k }); else presets.push({ id: uid('p'), label, s, e, k });
      closeSheet(); saveSettings({ presets }, `Shift type ${label} ${s}–${e}`);
      break;
    }
    case 'delpreset': {
      if (S().presets.length <= 1) { toast('Keep at least one shift type'); return; }
      const pid = sh.pid; if (!askTwice('delp', () => presetSheet(pid))) return;
      closeSheet(); saveSettings({ presets: S().presets.filter(x => x.id !== pid) }, 'Deleted a shift type');
      break;
    }
    case 'role': ui.confirm = null; roleSheet(b.dataset.id); break;
    case 'addrole': ui.confirm = null; roleSheet(null); break;
    case 'saverole': {
      const label = $('roName').value.trim().slice(0, 30), k = pickedColour();
      if (!label) { toast('Give the role a name'); return; }
      const roles = clone(S().roles);
      if (sh.id) Object.assign(roles.find(x => x.id === sh.id), { label, k }); else roles.push({ id: uid('r'), label, k });
      closeSheet(); saveSettings({ roles }, `Role ${label}`);
      break;
    }
    case 'delrole': {
      if (S().roles.length <= 1) { toast('Keep at least one role'); return; }
      const id = sh.id; if (!askTwice('delr', () => roleSheet(id))) return;
      closeSheet(); saveSettings({ roles: S().roles.filter(x => x.id !== id) }, 'Deleted a role');
      break;
    }
    case 'rule': ui.confirm = null; ruleSheet(b.dataset.id); break;
    case 'addrule': ui.confirm = null; ruleSheet(null); break;
    case 'ruday': { const d = Number(b.dataset.d), i = sh.days.indexOf(d); if (i >= 0) sh.days.splice(i, 1); else sh.days.push(d); b.setAttribute('aria-pressed', i < 0); break; }
    case 'saverule': {
      const allDay = $('ruAll').checked, from = $('ruFrom').value, to = $('ruTo').value, count = Math.round(Number($('ruCount').value));
      if (!(count >= 1)) { toast('Enter how many staff are needed'); return; }
      if (!allDay && (!from || !to || from === to)) { toast('Enter different start and end times'); return; }
      if (!sh.days.length) { toast('Pick at least one day'); return; }
      const rule = { allDay, from: from || '06:00', to: to || '22:00', count, days: [...sh.days].sort() };
      const minStaff = clone(S().minStaff);
      if (sh.id) Object.assign(minStaff.find(x => x.id === sh.id), rule); else minStaff.push({ id: uid('m'), ...rule });
      closeSheet(); saveSettings({ minStaff }, `Staffing rule: ${allDay ? 'all day' : from + '–' + to}, at least ${count}`);
      break;
    }
    case 'delrule': { const id = sh.id; if (!askTwice('delru', () => ruleSheet(id))) return; closeSheet(); saveSettings({ minStaff: S().minStaff.filter(x => x.id !== id) }, 'Deleted a staffing rule'); break; }
    case 'newreq': requestSheet(); break;
    case 'sendreq': {
      const staffId = $('rqWho').value, from = $('rqFrom').value, to = $('rqTo').value, reason = $('rqWhy').value.trim().slice(0, 80);
      if (!staffId) { toast('Choose who the time off is for'); return; }
      if (!from || !to || to < from) { toast('The end date must be on or after the start date'); return; }
      if ((parseISO(to) - parseISO(from)) / 864e5 > 61) { toast('Requests can cover up to 62 days'); return; }
      closeSheet();
      const id = uid('q'), doc = { staffId, from, to, reason, status: 'pending', at: new Date().toISOString() };
      change({
        needManager: false,
        optimistic: () => data.requests.push({ id, ...doc }),
        work: () => api('POST', 'requests', { staffId, from, to, reason }),
        ok: 'Request sent',
      });
      break;
    }
    case 'req': ui.confirm = null; decideSheet(b.dataset.rid); break;
    case 'approve': { const r = data.requests.find(x => x.id === sh.rid); closeSheet(); approve(r, 'approved'); break; }
    case 'decline': { const r = data.requests.find(x => x.id === sh.rid); closeSheet(); approve(r, 'declined'); break; }
    case 'delreq': { const rid = sh.rid; if (!askTwice('delq', () => decideSheet(rid))) return; closeSheet(); change({ optimistic: () => { data.requests = data.requests.filter(x => x.id !== rid); }, work: () => api('DELETE', 'requests/' + enc(rid)), log: 'Deleted a time-off request' }); break; }
    case 'activity': activitySheet(); break;
    case 'export': try { const d = await api('GET', 'export'); saveFile(`rota-backup-${iso(new Date())}.json`, JSON.stringify(d, null, 1), 'application/json'); } catch (e) { if (e.status !== 401) toast(e.message); } break;
    case 'signout': try { await api('POST', 'logout'); } catch (e) { } signOutLocal('Signed out.'); break;
    case 'retry': main.innerHTML = '<div class="loading">Connecting…</div>'; await refresh(); if (data) connectEvents(); break;
    case 'pinmanager': ui.confirm = null; pinSheet('manager'); break;
    case 'pinstaff': ui.confirm = null; pinSheet('staff'); break;
    case 'savepin': {
      const p1 = $('pin1').value, p2 = $('pin2').value;
      if (!/^\d{4,8}$/.test(p1)) { toast('PINs must be 4 to 8 digits'); return; }
      if (p1 !== p2) { toast("The two PINs don't match"); return; }
      const which = ui.sheet.which;
      try { await api('PUT', 'pins', { [which]: p1 }); closeSheet(); toast(which === 'manager' ? 'Manager PIN changed' : 'Staff PIN saved'); }
      catch (e) { if (e.status !== 401) toast(e.message); }
      break;
    }
    case 'staffoff': {
      if (!askTwice('staffoff', () => pinSheet('staff'))) return;
      try { await api('PUT', 'pins', { staff: null }); closeSheet(); toast('Staff sign-in turned off'); } catch (e) { if (e.status !== 401) toast(e.message); }
      break;
    }
    case 'import': $('importFile').click(); break;
  }
});
document.addEventListener('change', ev => {
  const t = ev.target;
  if (t.id === 'ruAll') { $('ruFromRow').hidden = t.checked; $('ruToRow').hidden = t.checked; return; }
  const k = t.dataset && t.dataset.set; if (!k) return;
  const patch = clone(data.settings);
  if (t.type === 'checkbox') setPath(patch, k, t.checked);
  else if (t.type === 'number') { const v = Number(t.value); if (!(isFinite(v) && v >= 0)) { render(); return; } setPath(patch, k, k === 'defaultRate' ? Math.round(v * 100) / 100 : v); }
  else if (k === 'siteName') { const v = t.value.trim().slice(0, 60); if (!v) { render(); return; } patch.siteName = v; }
  else if (t.value) setPath(patch, k, t.value);
  saveSettings(patch);
});

function route() {
  const h = location.hash.slice(1);
  ui.view = VIEWS.includes(h) ? h : 'rota';
  ui.confirm = null; closeSheet(); render(); window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

/* ---------------------------------------------------------------- boot */
(async function boot() {
  const h = location.hash.slice(1); if (VIEWS.includes(h)) ui.view = h;
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => { });
  if (!token) { renderLogin(''); return; }
  main.innerHTML = '<div class="loading">Loading the rota…</div>';
  await refresh();
  if (token) connectEvents();
})();
setInterval(() => { if (data && ui.view === 'settings' && scrim.hidden && !/INPUT|SELECT|TEXTAREA/.test(document.activeElement?.tagName || '')) render(); }, 60000);
