'use strict';
/*
 * Manor Rota server
 * Serves the iPhone web app from /public and keeps the rota in a SQLite database.
 * Settings come from environment variables (see README.md):
 *   PORT, HOST, DATA_DIR, MANAGER_PIN, STAFF_PIN, BACKUP_KEEP, TRUST_PROXY
 */
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const DATA_DIR = path.resolve(process.env.DATA_DIR || path.join(__dirname, 'data'));
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const BACKUP_KEEP = Number(process.env.BACKUP_KEEP) || 30;
const SESSION_DAYS = 90;
// Behind a hosting proxy (Render, Railway, Fly, Caddy) set TRUST_PROXY=1 so sign-in limits see the real address.
const TRUST_PROXY = process.env.TRUST_PROXY;

fs.mkdirSync(BACKUP_DIR, { recursive: true });

/* ------------------------------------------------------------------ database */
const db = new Database(path.join(DATA_DIR, 'rota.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS staff (
  id      TEXT PRIMARY KEY,
  name    TEXT NOT NULL,
  rate    REAL NOT NULL DEFAULT 0,
  sort    INTEGER NOT NULL DEFAULT 0,
  active  INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS shifts (
  week      TEXT NOT NULL,            -- Monday of the week, YYYY-MM-DD
  staff_id  TEXT NOT NULL REFERENCES staff(id) ON DELETE CASCADE,
  day       INTEGER NOT NULL CHECK (day BETWEEN 0 AND 6),  -- 0 = Monday
  kind      TEXT NOT NULL DEFAULT 'shift' CHECK (kind IN ('shift','hol')),
  start     TEXT,
  finish    TEXT,
  PRIMARY KEY (week, staff_id, day)
);
CREATE INDEX IF NOT EXISTS shifts_week ON shifts(week);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS secrets  (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  role       TEXT NOT NULL CHECK (role IN ('manager','staff')),
  created    TEXT NOT NULL,
  expires    TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notes (
  day   TEXT PRIMARY KEY,               -- YYYY-MM-DD
  text  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS requests (
  id        TEXT PRIMARY KEY,
  staff_id  TEXT NOT NULL,
  from_day  TEXT NOT NULL,
  to_day    TEXT NOT NULL,
  reason    TEXT NOT NULL DEFAULT '',
  status    TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','declined')),
  created   TEXT NOT NULL,
  decided   TEXT
);
CREATE TABLE IF NOT EXISTS activity (
  id     INTEGER PRIMARY KEY AUTOINCREMENT,
  at     TEXT NOT NULL,
  role   TEXT NOT NULL,
  text   TEXT NOT NULL
);
`);
// Upgrade databases created by version 1.
{
  const cols = db.prepare('PRAGMA table_info(staff)').all().map(c => c.name);
  if (!cols.includes('role_id')) db.exec('ALTER TABLE staff ADD COLUMN role_id TEXT');
  if (!cols.includes('contract')) db.exec('ALTER TABLE staff ADD COLUMN contract REAL NOT NULL DEFAULT 0');
  if (!cols.includes('under18')) db.exec('ALTER TABLE staff ADD COLUMN under18 INTEGER NOT NULL DEFAULT 0');
}

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
const COLOURS = ['early', 'late', 'night', 'eve', 'mid'];

const q = {
  getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
  setSetting: db.prepare('INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  getSecret: db.prepare('SELECT value FROM secrets WHERE key = ?'),
  setSecret: db.prepare('INSERT INTO secrets(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  delSecret: db.prepare('DELETE FROM secrets WHERE key = ?'),
  allStaff: db.prepare('SELECT * FROM staff ORDER BY sort, name'),
  oneStaff: db.prepare('SELECT * FROM staff WHERE id = ?'),
  addStaff: db.prepare(`INSERT INTO staff(id, name, rate, sort, active, role_id, contract, under18)
    VALUES (@id, @name, @rate, @sort, @active, @role_id, @contract, @under18)`),
  updStaff: db.prepare(`UPDATE staff SET name = @name, rate = @rate, sort = @sort, active = @active,
    role_id = @role_id, contract = @contract, under18 = @under18 WHERE id = @id`),
  allNotes: db.prepare('SELECT * FROM notes'),
  setNote: db.prepare('INSERT INTO notes(day, text) VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET text = excluded.text'),
  delNote: db.prepare('DELETE FROM notes WHERE day = ?'),
  allReqs: db.prepare('SELECT * FROM requests ORDER BY from_day'),
  oneReq: db.prepare('SELECT * FROM requests WHERE id = ?'),
  addReq: db.prepare(`INSERT INTO requests(id, staff_id, from_day, to_day, reason, status, created, decided)
    VALUES (@id, @staff_id, @from_day, @to_day, @reason, @status, @created, @decided)`),
  setReq: db.prepare('UPDATE requests SET status = ?, decided = ? WHERE id = ?'),
  delReq: db.prepare('DELETE FROM requests WHERE id = ?'),
  maxSort: db.prepare('SELECT COALESCE(MAX(sort), -1) AS m FROM staff'),
  allShifts: db.prepare('SELECT * FROM shifts'),
  weekShifts: db.prepare('SELECT * FROM shifts WHERE week = ?'),
  upShift: db.prepare(`INSERT INTO shifts(week, staff_id, day, kind, start, finish) VALUES (@week, @staff_id, @day, @kind, @start, @finish)
    ON CONFLICT(week, staff_id, day) DO UPDATE SET kind = excluded.kind, start = excluded.start, finish = excluded.finish`),
  delShift: db.prepare('DELETE FROM shifts WHERE week = ? AND staff_id = ? AND day = ?'),
  delWeek: db.prepare('DELETE FROM shifts WHERE week = ?'),
  addSession: db.prepare('INSERT INTO sessions(token_hash, role, created, expires) VALUES (?, ?, ?, ?)'),
  getSession: db.prepare('SELECT * FROM sessions WHERE token_hash = ? AND expires > ?'),
  delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  delRoleSessions: db.prepare('DELETE FROM sessions WHERE role = ?'),
  purgeSessions: db.prepare('DELETE FROM sessions WHERE expires <= ?'),
  log: db.prepare('INSERT INTO activity(at, role, text) VALUES (?, ?, ?)'),
  recent: db.prepare('SELECT at, role, text FROM activity ORDER BY id DESC LIMIT ?'),
  trimLog: db.prepare('DELETE FROM activity WHERE id <= (SELECT id FROM activity ORDER BY id DESC LIMIT 1 OFFSET 5000)'),
};

function getSettings() {
  const row = q.getSetting.get('app');
  const saved = row ? JSON.parse(row.value) : {};
  const s = Object.assign(JSON.parse(JSON.stringify(DEFAULT_SETTINGS)), saved);
  s.breaks = Object.assign({}, DEFAULT_SETTINGS.breaks, saved.breaks || {});
  for (const k of ['presets', 'roles']) if (!Array.isArray(s[k]) || !s[k].length) s[k] = JSON.parse(JSON.stringify(DEFAULT_SETTINGS[k]));
  if (!Array.isArray(s.minStaff)) s.minStaff = JSON.parse(JSON.stringify(DEFAULT_SETTINGS.minStaff));
  return s;
}
function getVersion() { const r = q.getSetting.get('version'); return r ? Number(r.value) : 0; }
function bumpVersion() { const v = getVersion() + 1; q.setSetting.run('version', String(v)); return v; }

/* ------------------------------------------------------------------ PINs */
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString('hex');
  const h = crypto.scryptSync(String(pin), salt, 32).toString('hex');
  return `${salt}:${h}`;
}
function checkPin(pin, stored) {
  if (!stored) return false;
  const [salt, h] = stored.split(':');
  const test = crypto.scryptSync(String(pin), salt, 32);
  const want = Buffer.from(h, 'hex');
  return want.length === test.length && crypto.timingSafeEqual(want, test);
}
const validPin = p => typeof p === 'string' && /^\d{4,8}$/.test(p);

/* ------------------------------------------------------------------ first run */
function firstRun() {
  const notes = [];
  if (!q.getSecret.get('managerPin')) {
    const pin = validPin(process.env.MANAGER_PIN) ? process.env.MANAGER_PIN : String(crypto.randomInt(100000, 1000000));
    q.setSecret.run('managerPin', hashPin(pin));
    notes.push(`Manager PIN: ${pin}${process.env.MANAGER_PIN ? ' (from MANAGER_PIN)' : ''}`);
  }
  if (!q.getSecret.get('staffPin') && validPin(process.env.STAFF_PIN)) {
    q.setSecret.run('staffPin', hashPin(process.env.STAFF_PIN));
    notes.push(`Staff PIN: ${process.env.STAFF_PIN} (from STAFF_PIN)`);
  }
  if (!q.getSetting.get('app')) {
    q.setSetting.run('app', JSON.stringify(DEFAULT_SETTINGS));
    const seedFile = path.join(__dirname, 'seed.json');
    if (fs.existsSync(seedFile)) {
      importData(JSON.parse(fs.readFileSync(seedFile, 'utf8')), { keepSettings: true });
      notes.push('Loaded starting rota from seed.json');
    }
  }
  if (notes.length) {
    const banner = ['', '='.repeat(60), ' Manor Rota first start', ...notes.map(n => ' ' + n),
      ' Change PINs any time in the app under Settings > Security.', '='.repeat(60), ''].join('\n');
    console.log(banner);
    fs.writeFileSync(path.join(DATA_DIR, 'FIRST-RUN-PINS.txt'),
      notes.join('\n') + '\n\nDelete this file once you have noted the PIN.\n');
  }
}

/* ------------------------------------------------------------------ state */
function buildState(role) {
  const settings = getSettings();
  const staff = q.allStaff.all().map(r => ({
    id: r.id, name: r.name, order: r.sort, active: !!r.active,
    roleId: r.role_id || null, contract: r.contract || 0, under18: !!r.under18,
    ...(role === 'manager' ? { rate: r.rate } : {}),
  }));
  const notes = {};
  for (const n of q.allNotes.all()) notes[n.day] = n.text;
  const requests = q.allReqs.all().map(r => ({ id: r.id, staffId: r.staff_id, from: r.from_day, to: r.to_day, reason: r.reason, status: r.status, at: r.created, decidedAt: r.decided }));
  const weeks = {};
  for (const r of q.allShifts.all()) {
    const w = weeks[r.week] || (weeks[r.week] = { start: r.week, shifts: {} });
    const s = w.shifts[r.staff_id] || (w.shifts[r.staff_id] = {});
    s[String(r.day)] = r.kind === 'hol' ? { t: 'hol' } : { s: r.start, e: r.finish };
  }
  if (role !== 'manager') { settings.showPay = false; settings.budgetPay = 0; delete settings.defaultRate; }
  return { staff, weeks, settings, notes, requests, role, version: getVersion(), serverTime: new Date().toISOString() };
}

function exportData() {
  const st = buildState('manager');
  return { app: 'manor-rota', exportedAt: new Date().toISOString(), staff: st.staff, weeks: st.weeks, settings: st.settings, notes: st.notes, requests: st.requests };
}

const isWeek = w => typeof w === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(w) && !isNaN(Date.parse(w + 'T00:00:00Z'))
  && new Date(w + 'T00:00:00Z').getUTCDay() === 1;
const isTime = t => typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
const isDay = d => typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z'));
const num = (v, lo, hi) => { const n = Number(v); return isFinite(n) && n >= lo && n <= hi ? n : null; };
function staffFields(b, base) {
  const out = {};
  if ('roleId' in b) out.role_id = b.roleId ? String(b.roleId).slice(0, 30) : null;
  if ('contract' in b) { const v = num(b.contract || 0, 0, 168); if (v === null) throw new HttpError(400, 'Contract hours must be between 0 and 168.'); out.contract = v; }
  if ('under18' in b) out.under18 = b.under18 ? 1 : 0;
  return Object.assign({ role_id: null, contract: 0, under18: 0 }, base || {}, out);
}
const cleanName = n => typeof n === 'string' ? n.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
const cleanRate = r => { const v = Number(r); return isFinite(v) && v >= 0 && v < 1000 ? Math.round(v * 100) / 100 : null; };

const importData = db.transaction((d, { keepSettings = false } = {}) => {
  if (!d || !Array.isArray(d.staff) || typeof d.weeks !== 'object') throw new HttpError(400, "That file isn't a Manor Rota backup.");
  db.exec('DELETE FROM shifts; DELETE FROM staff; DELETE FROM notes; DELETE FROM requests;');
  const ids = new Set();
  d.staff.forEach((p, i) => {
    const id = String(p.id || '').slice(0, 60), name = cleanName(p.name);
    if (!id || !name || ids.has(id)) return;
    ids.add(id);
    q.addStaff.run({ id, name, rate: cleanRate(p.rate) ?? 0, sort: Number.isInteger(p.order) ? p.order : i, active: p.active === false ? 0 : 1,
      ...staffFields({ roleId: p.roleId, contract: num(p.contract || 0, 0, 168) ?? 0, under18: p.under18 }) });
  });
  for (const [week, w] of Object.entries(d.weeks || {})) {
    if (!isWeek(week) || !w || typeof w.shifts !== 'object') continue;
    for (const [sid, days] of Object.entries(w.shifts)) {
      if (!ids.has(sid) || typeof days !== 'object') continue;
      for (const [day, c] of Object.entries(days || {})) {
        const di = Number(day);
        if (!(di >= 0 && di <= 6) || !c) continue;
        if (c.t === 'hol') q.upShift.run({ week, staff_id: sid, day: di, kind: 'hol', start: null, finish: null });
        else if (isTime(c.s) && isTime(c.e) && c.s !== c.e) q.upShift.run({ week, staff_id: sid, day: di, kind: 'shift', start: c.s, finish: c.e });
      }
    }
  }
  for (const [day, text] of Object.entries(d.notes || {})) if (isDay(day) && typeof text === 'string' && text.trim()) q.setNote.run(day, text.trim().slice(0, 500));
  for (const r of Array.isArray(d.requests) ? d.requests : []) {
    if (!r || !ids.has(r.staffId) || !isDay(r.from) || !isDay(r.to) || r.to < r.from) continue;
    q.addReq.run({ id: String(r.id || crypto.randomUUID()).slice(0, 40), staff_id: r.staffId, from_day: r.from, to_day: r.to, reason: String(r.reason || '').slice(0, 80),
      status: ['pending', 'approved', 'declined'].includes(r.status) ? r.status : 'pending', created: r.at || new Date().toISOString(), decided: r.decidedAt || null });
  }
  if (!keepSettings && d.settings && typeof d.settings === 'object') q.setSetting.run('app', JSON.stringify(sanitiseSettings(d.settings, getSettings())));
});

function sanitiseSettings(input, base) {
  const s = Object.assign({}, base);
  if ('siteName' in input) { const v = cleanName(input.siteName); if (v) s.siteName = v; }
  if ('open24' in input) s.open24 = !!input.open24;
  if ('showPay' in input) s.showPay = !!input.showPay;
  if ('opens' in input && isTime(input.opens)) s.opens = input.opens;
  if ('closes' in input && isTime(input.closes)) s.closes = input.closes;
  if ('defaultRate' in input) { const v = cleanRate(input.defaultRate); if (v !== null) s.defaultRate = v; }
  if (Array.isArray(input.presets)) {
    const list = input.presets.slice(0, 20).map((p, i) => ({
      id: String(p.id || 'p' + i).slice(0, 30), label: cleanName(p.label).slice(0, 30),
      s: p.s, e: p.e, k: COLOURS.includes(p.k) ? p.k : 'early',
    })).filter(p => p.label && isTime(p.s) && isTime(p.e) && p.s !== p.e);
    if (list.length) s.presets = list;
  }
  if (Array.isArray(input.roles)) {
    const list = input.roles.slice(0, 30).map((r, i) => ({ id: String(r.id || 'r' + i).slice(0, 30), label: cleanName(r.label).slice(0, 30), k: COLOURS.includes(r.k) ? r.k : 'late' })).filter(r => r.label);
    if (list.length) s.roles = list;
  }
  if (Array.isArray(input.minStaff)) {
    s.minStaff = input.minStaff.slice(0, 30).map((r, i) => ({
      id: String(r.id || 'm' + i).slice(0, 30), allDay: !!r.allDay, from: isTime(r.from) ? r.from : '06:00', to: isTime(r.to) ? r.to : '22:00',
      count: Math.round(num(r.count, 1, 50) || 1), days: [...new Set((Array.isArray(r.days) ? r.days : []).map(Number).filter(d => d >= 0 && d <= 6))].sort(),
    })).filter(r => r.days.length && (r.allDay || r.from !== r.to));
  }
  if (input.breaks && typeof input.breaks === 'object') {
    const b = input.breaks;
    s.breaks = { on: 'on' in b ? !!b.on : s.breaks.on, after: num(b.after, 0, 24) ?? s.breaks.after, mins: Math.round(num(b.mins, 0, 180) ?? s.breaks.mins) };
  }
  for (const [k, lo, hi] of [['maxWeek', 1, 168], ['rest', 0, 24], ['budgetHours', 0, 100000], ['budgetPay', 0, 10000000]]) {
    if (k in input) { const v = num(input[k], lo, hi); if (v !== null) s[k] = v; }
  }
  return s;
}

/* ------------------------------------------------------------------ backups */
function writeBackup(reason) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const file = path.join(BACKUP_DIR, `rota-${stamp}${reason ? '-' + reason : ''}.json`);
  fs.writeFileSync(file, JSON.stringify(exportData(), null, 1));
  const files = fs.readdirSync(BACKUP_DIR).filter(f => f.endsWith('.json')).sort();
  for (const f of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) fs.unlinkSync(path.join(BACKUP_DIR, f));
  return file;
}

/* ------------------------------------------------------------------ live updates (Server-Sent Events) */
const clients = new Set();
function broadcast(version) {
  const msg = `event: change\ndata: ${JSON.stringify({ version })}\n\n`;
  for (const res of clients) res.write(msg);
}
setInterval(() => { for (const res of clients) res.write(': ping\n\n'); }, 25000).unref();

/* ------------------------------------------------------------------ helpers */
class HttpError extends Error { constructor(status, message) { super(message); this.status = status; } }
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function dayLabel(week, day) {
  const d = new Date(week + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + day);
  return `${DAYS[day]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`;
}
function dayName(day) { const d = new Date(day + 'T00:00:00Z'); return `${DAYS[(d.getUTCDay() + 6) % 7]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}`; }
const tokenHash = t => crypto.createHash('sha256').update(String(t)).digest('hex');

function changed(role, text) {
  q.log.run(new Date().toISOString(), role, text);
  const v = bumpVersion();
  broadcast(v);
  return v;
}

/* ------------------------------------------------------------------ app */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', TRUST_PROXY ? (/^\d+$/.test(TRUST_PROXY) ? Number(TRUST_PROXY) : TRUST_PROXY) : 'loopback, linklocal, uniquelocal');
app.use(express.json({ limit: '5mb' }));
app.use((req, res, next) => {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; manifest-src 'self'; frame-ancestors 'none'",
  });
  next();
});

function auth(required) {
  return (req, res, next) => {
    const h = req.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : (req.query.token || '');
    const s = token && q.getSession.get(tokenHash(token), new Date().toISOString());
    if (!s) return res.status(401).json({ error: 'Please sign in again.' });
    if (required === 'manager' && s.role !== 'manager') return res.status(403).json({ error: 'Only a manager can do that.' });
    req.role = s.role; req.tokenHash = tokenHash(token);
    next();
  };
}
const manager = auth('manager'), anyone = auth('any');

// Simple brute-force guard for PIN sign-in: 8 tries per 10 minutes per address.
const attempts = new Map();
function loginLimited(ip) {
  const now = Date.now(), a = attempts.get(ip);
  if (!a || a.reset < now) { attempts.set(ip, { n: 0, reset: now + 10 * 60 * 1000 }); return false; }
  return a.n >= 8;
}

app.get('/api/health', (req, res) => res.json({ ok: true, version: getVersion() }));

app.post('/api/login', (req, res) => {
  const ip = req.ip;
  if (loginLimited(ip)) return res.status(429).json({ error: 'Too many wrong PINs. Wait 10 minutes and try again.' });
  const pin = String((req.body || {}).pin || '');
  let role = null;
  if (checkPin(pin, q.getSecret.get('managerPin')?.value)) role = 'manager';
  else if (checkPin(pin, q.getSecret.get('staffPin')?.value)) role = 'staff';
  if (!role) { attempts.get(ip).n++; return res.status(401).json({ error: "That PIN isn't right." }); }
  attempts.delete(ip);
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date(), exp = new Date(now.getTime() + SESSION_DAYS * 864e5);
  q.addSession.run(tokenHash(token), role, now.toISOString(), exp.toISOString());
  res.json({ token, role });
});

app.post('/api/logout', anyone, (req, res) => { q.delSession.run(req.tokenHash); res.json({ ok: true }); });

app.get('/api/state', anyone, (req, res) => res.json(buildState(req.role)));

app.get('/api/events', anyone, (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
  res.flushHeaders();
  res.write(`event: change\ndata: ${JSON.stringify({ version: getVersion() })}\n\n`);
  clients.add(res);
  req.on('close', () => clients.delete(res));
});

// Set or clear one shift. Body: {s:"06:30", e:"14:30"} | {t:"hol"} | {} (day off)
app.put('/api/shifts/:week/:staffId/:day', manager, (req, res) => {
  const { week, staffId } = req.params, day = Number(req.params.day);
  if (!isWeek(week)) throw new HttpError(400, 'Week must be the Monday date, like 2026-10-26.');
  if (!(Number.isInteger(day) && day >= 0 && day <= 6)) throw new HttpError(400, 'Day must be 0 (Mon) to 6 (Sun).');
  const p = q.oneStaff.get(staffId);
  if (!p) throw new HttpError(404, 'That staff member no longer exists.');
  const b = req.body || {};
  let text;
  if (b.t === 'hol') { q.upShift.run({ week, staff_id: staffId, day, kind: 'hol', start: null, finish: null }); text = 'holiday'; }
  else if (b.s || b.e) {
    if (!isTime(b.s) || !isTime(b.e) || b.s === b.e) throw new HttpError(400, 'Use 24-hour times like 06:30, with different start and end.');
    q.upShift.run({ week, staff_id: staffId, day, kind: 'shift', start: b.s, finish: b.e }); text = `${b.s}–${b.e}`;
  } else { q.delShift.run(week, staffId, day); text = 'day off'; }
  res.json({ version: changed(req.role, `${p.name} · ${dayLabel(week, day)} → ${text}`) });
});

app.post('/api/weeks/:week/copy-previous', manager, (req, res) => {
  const { week } = req.params;
  if (!isWeek(week)) throw new HttpError(400, 'Week must be the Monday date.');
  const prev = new Date(week + 'T00:00:00Z'); prev.setUTCDate(prev.getUTCDate() - 7);
  const prevWeek = prev.toISOString().slice(0, 10);
  const rows = q.weekShifts.all(prevWeek);
  if (!rows.length) throw new HttpError(400, 'Last week has no shifts to copy.');
  db.transaction(() => { q.delWeek.run(week); for (const r of rows) q.upShift.run({ ...r, week }); })();
  res.json({ version: changed(req.role, `Copied w/c ${dayLabel(prevWeek, 0)} into w/c ${dayLabel(week, 0)}`) });
});

app.delete('/api/weeks/:week', manager, (req, res) => {
  const { week } = req.params;
  if (!isWeek(week)) throw new HttpError(400, 'Week must be the Monday date.');
  q.delWeek.run(week);
  res.json({ version: changed(req.role, `Cleared w/c ${dayLabel(week, 0)}`) });
});

app.post('/api/staff', manager, (req, res) => {
  const name = cleanName((req.body || {}).name);
  if (!name) throw new HttpError(400, 'Enter a name.');
  const rate = cleanRate(req.body.rate) ?? getSettings().defaultRate;
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'staff';
  let id = base, n = 2; while (q.oneStaff.get(id)) id = `${base}-${n++}`;
  q.addStaff.run({ id, name, rate, sort: q.maxSort.get().m + 1, active: 1, ...staffFields(req.body) });
  res.status(201).json({ id, version: changed(req.role, `Added ${name}`) });
});

app.patch('/api/staff/:id', manager, (req, res) => {
  const p = q.oneStaff.get(req.params.id);
  if (!p) throw new HttpError(404, 'That staff member no longer exists.');
  const b = req.body || {}, next = { ...p };
  const notes = [];
  if ('name' in b) { const v = cleanName(b.name); if (!v) throw new HttpError(400, 'Enter a name.'); if (v !== p.name) notes.push(`renamed to ${v}`); next.name = v; }
  if ('rate' in b) { const v = cleanRate(b.rate); if (v === null) throw new HttpError(400, 'Enter a rate like 12.21.'); if (v !== p.rate) notes.push(`rate £${v.toFixed(2)}`); next.rate = v; }
  if ('active' in b) { next.active = b.active ? 1 : 0; if (next.active !== p.active) notes.push(next.active ? 'back on the rota' : 'removed from rota'); }
  Object.assign(next, staffFields(b, { role_id: p.role_id, contract: p.contract, under18: p.under18 }));
  if (next.role_id !== p.role_id) notes.push('role changed');
  if (next.contract !== p.contract) notes.push(`contract ${next.contract} h`);
  if (next.under18 !== p.under18) notes.push(next.under18 ? 'marked under 18' : 'no longer under 18');
  q.updStaff.run(next);
  res.json({ version: changed(req.role, `${p.name}: ${notes.join(', ') || 'updated'}`) });
});

app.post('/api/staff/order', manager, (req, res) => {
  const ids = (req.body || {}).ids;
  if (!Array.isArray(ids)) throw new HttpError(400, 'Send the staff ids in order.');
  db.transaction(() => ids.forEach((id, i) => { const p = q.oneStaff.get(id); if (p) q.updStaff.run({ ...p, sort: i }); }))();
  res.json({ version: changed(req.role, 'Changed staff order') });
});

app.put('/api/notes/:day', manager, (req, res) => {
  const { day } = req.params;
  if (!isDay(day)) throw new HttpError(400, 'Use a date like 2026-10-27.');
  const text = String((req.body || {}).text || '').trim().slice(0, 500);
  if (text) q.setNote.run(day, text); else q.delNote.run(day);
  res.json({ version: changed(req.role, text ? `Note on ${dayName(day)}: ${text.slice(0, 60)}` : `Removed note on ${dayName(day)}`) });
});

// Anyone signed in (manager or staff PIN) can ask for time off.
app.post('/api/requests', anyone, (req, res) => {
  const b = req.body || {};
  const p = q.oneStaff.get(String(b.staffId || ''));
  if (!p) throw new HttpError(400, 'Choose who the time off is for.');
  if (!isDay(b.from) || !isDay(b.to) || b.to < b.from) throw new HttpError(400, 'The end date must be on or after the start date.');
  if ((Date.parse(b.to) - Date.parse(b.from)) / 864e5 > 61) throw new HttpError(400, 'Requests can cover up to 62 days.');
  const id = crypto.randomUUID();
  q.addReq.run({ id, staff_id: p.id, from_day: b.from, to_day: b.to, reason: String(b.reason || '').trim().slice(0, 80), status: 'pending', created: new Date().toISOString(), decided: null });
  res.status(201).json({ id, version: changed(req.role, `${p.name} asked for time off ${dayName(b.from)}${b.to !== b.from ? ' – ' + dayName(b.to) : ''}`) });
});

// Approve or decline. Approving marks each day as Holiday on the rota.
app.patch('/api/requests/:id', manager, (req, res) => {
  const r = q.oneReq.get(req.params.id);
  if (!r) throw new HttpError(404, 'That request no longer exists.');
  const status = (req.body || {}).status;
  if (!['approved', 'declined', 'pending'].includes(status)) throw new HttpError(400, 'Status must be approved, declined or pending.');
  const p = q.oneStaff.get(r.staff_id);
  db.transaction(() => {
    q.setReq.run(status, new Date().toISOString(), r.id);
    if (status === 'approved' && p) {
      const start = new Date(r.from_day + 'T00:00:00Z'), days = Math.min(62, Math.round((Date.parse(r.to_day) - Date.parse(r.from_day)) / 864e5) + 1);
      for (let i = 0; i < days; i++) {
        const d = new Date(start); d.setUTCDate(d.getUTCDate() + i);
        const dow = (d.getUTCDay() + 6) % 7, mon = new Date(d); mon.setUTCDate(mon.getUTCDate() - dow);
        q.upShift.run({ week: mon.toISOString().slice(0, 10), staff_id: p.id, day: dow, kind: 'hol', start: null, finish: null });
      }
    }
  })();
  res.json({ version: changed(req.role, `${status === 'approved' ? 'Approved' : status === 'declined' ? 'Declined' : 'Reopened'} time off for ${p ? p.name : 'former staff'}, ${dayName(r.from_day)}${r.to_day !== r.from_day ? ' – ' + dayName(r.to_day) : ''}`) });
});

app.delete('/api/requests/:id', manager, (req, res) => {
  q.delReq.run(req.params.id);
  res.json({ version: changed(req.role, 'Deleted a time-off request') });
});

app.put('/api/settings', manager, (req, res) => {
  const s = sanitiseSettings(req.body || {}, getSettings());
  q.setSetting.run('app', JSON.stringify(s));
  res.json({ settings: s, version: changed(req.role, 'Changed settings') });
});

app.put('/api/pins', manager, (req, res) => {
  const b = req.body || {};
  if ('manager' in b) {
    if (!validPin(b.manager)) throw new HttpError(400, 'PINs must be 4 to 8 digits.');
    q.setSecret.run('managerPin', hashPin(b.manager));
    db.prepare('DELETE FROM sessions WHERE role = ? AND token_hash != ?').run('manager', req.tokenHash);
    changed(req.role, 'Changed the manager PIN');
  }
  if ('staff' in b) {
    if (b.staff === null) { q.delSecret.run('staffPin'); q.delRoleSessions.run('staff'); changed(req.role, 'Turned off staff sign-in'); }
    else {
      if (!validPin(b.staff)) throw new HttpError(400, 'PINs must be 4 to 8 digits.');
      if (checkPin(b.staff, q.getSecret.get('managerPin')?.value)) throw new HttpError(400, 'The staff PIN must be different from the manager PIN.');
      q.setSecret.run('staffPin', hashPin(b.staff)); q.delRoleSessions.run('staff'); changed(req.role, 'Changed the staff PIN');
    }
  }
  res.json({ ok: true, staffPinSet: !!q.getSecret.get('staffPin') });
});

app.get('/api/security', manager, (req, res) => res.json({ staffPinSet: !!q.getSecret.get('staffPin') }));

app.get('/api/activity', manager, (req, res) => res.json(q.recent.all(Math.min(Number(req.query.limit) || 50, 500))));

app.get('/api/export', manager, (req, res) => res.json(exportData()));

app.post('/api/import', manager, (req, res) => {
  writeBackup('before-import');
  importData(req.body);
  res.json({ version: changed(req.role, 'Restored from a backup file') });
});

app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders(res, file) {
    if (/\.(html|js|webmanifest)$/.test(file)) res.set('Cache-Control', 'no-cache');
  },
}));

app.use((err, req, res, next) => {
  const status = err.status || (err.type === 'entity.parse.failed' ? 400 : 500);
  if (status >= 500) console.error(err);
  res.status(status).json({ error: status >= 500 ? 'Something went wrong on the server.' : err.message });
});

/* ------------------------------------------------------------------ start */
firstRun();
q.purgeSessions.run(new Date().toISOString());
q.trimLog.run();
writeBackup('startup');
setInterval(() => { try { writeBackup('daily'); q.purgeSessions.run(new Date().toISOString()); q.trimLog.run(); } catch (e) { console.error('Backup failed', e); } }, 24 * 3600 * 1000).unref();

const server = app.listen(PORT, HOST, () => {
  const nets = require('os').networkInterfaces();
  const addrs = Object.values(nets).flat().filter(n => n && n.family === 'IPv4' && !n.internal).map(n => `http://${n.address}:${PORT}`);
  console.log(`Manor Rota is running.\n  On this computer: http://localhost:${PORT}\n${addrs.map(a => '  On your network:  ' + a).join('\n')}\n  Data folder: ${DATA_DIR}`);
});

function shutdown() { server.close(); for (const r of clients) r.end(); db.close(); process.exit(0); }
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
