/* eslint-disable no-console */
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const multer = require('multer');
const rateLimit = require('express-rate-limit');
const crypto = require('crypto');
const PgSession = require('connect-pg-simple')(session);
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const PORT = process.env.PORT || 3000;
const DAYS_SERVER = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

// ---------- email notifications ----------
// Set SMTP_USER + SMTP_PASS (Gmail app password) + NOTIFY_EMAILS in Railway
// to enable email alerts. Changes are batched into a single email every 60s.
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const EMAIL_FROM = process.env.EMAIL_FROM || SMTP_USER;
const NOTIFY_EMAILS = (process.env.NOTIFY_EMAILS || process.env.OWNER_EMAILS || '')
  .split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
const EMAIL_ENABLED = !!(SMTP_USER && SMTP_PASS && NOTIFY_EMAILS.length);

// SMTP config. Defaults to Microsoft 365 (Outlook/Exchange).
// Override with SMTP_HOST / SMTP_PORT env vars for other providers.
const SMTP_HOST = process.env.SMTP_HOST || 'smtp.office365.com';
const SMTP_PORT = parseInt(process.env.SMTP_PORT, 10) || 587;

let smtpTransport = null;
if (EMAIL_ENABLED) {
  smtpTransport = nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_PORT === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
  console.log(`[email] enabled — ${SMTP_HOST}:${SMTP_PORT} → ${NOTIFY_EMAILS.join(', ')}`);
} else {
  console.log('[email] disabled — set SMTP_USER, SMTP_PASS, and NOTIFY_EMAILS to enable');
}

const emailBuffer = [];
let emailFlushTimer = null;
const EMAIL_BATCH_MS = 60 * 1000; // 60 seconds

function queueEmail(userLabel, action, details) {
  if (!EMAIL_ENABLED) return;
  emailBuffer.push({ userLabel, action, details, time: new Date() });
  if (!emailFlushTimer) {
    emailFlushTimer = setTimeout(() => {
      emailFlushTimer = null;
      flushEmail().catch(err => console.error('[email] flush error', err.message));
    }, EMAIL_BATCH_MS);
  }
}

async function flushEmail() {
  if (!emailBuffer.length || !smtpTransport) return;
  const events = emailBuffer.splice(0);

  // Build subject: Location — Manager Name — action
  const first = events[0];
  const clubName = (first.details && first.details.club_name) || 'FBC NEFL';
  const managerName = first.userLabel || 'A manager';
  const action = first.action === 'schedule_submitted' ? 'sent schedule for review' : 'made changes';
  const weekStart = (first.details && first.details.week_start) || '';
  const subject = `${clubName} — ${managerName} ${action}${weekStart ? ' (week of ' + weekStart + ')' : ''}`;

  // Build body
  const lines = events.map(e => {
    const t = e.time.toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true });
    return `<li><strong>${t}</strong> — ${describeEmailEvent(e)}</li>`;
  }).join('');
  const msg = (first.details && first.details.message) ? `<p style="margin:12px 0;padding:10px;background:#f0f4fa;border-radius:6px;"><strong>Note from ${managerName}:</strong> "${first.details.message}"</p>` : '';
  const html = `
    <h2 style="margin:0 0 4px;color:#1a2233;">${clubName}</h2>
    <p style="margin:0 0 12px;color:#5a6a80;">${managerName} ${action}${weekStart ? ' for the week of ' + weekStart : ''}</p>
    ${msg}
    <h3 style="margin:16px 0 8px;font-size:14px;color:#5a6a80;">Changes:</h3>
    <ul style="padding-left:20px;color:#1a2233;">${lines}</ul>
    <p style="margin-top:20px;">
      <a href="https://schedule.fbcnefl.com" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">View Schedule</a>
    </p>
  `;
  try {
    await smtpTransport.sendMail({
      from: EMAIL_FROM,
      to: NOTIFY_EMAILS.join(', '),
      subject,
      html,
    });
    console.log(`[email] sent ${events.length} change(s) to ${NOTIFY_EMAILS.join(', ')}`);
  } catch (err) {
    console.error('[email] send failed', err.message);
  }
}

function describeEmailEvent(e) {
  const d = e.details || {};
  switch (e.action) {
    case 'cell_edit': {
      const day = DAYS_SERVER[d.day_index] || 'day';
      const week = d.week_start || '';
      if (!d.new_value && d.old_value) return `removed ${d.employee_name}'s ${day} shift (was "${d.old_value}") — week of ${week}`;
      if (d.new_value && !d.old_value) return `set ${d.employee_name}'s ${day} shift to "${d.new_value}" — week of ${week}`;
      return `changed ${d.employee_name}'s ${day} shift: "${d.old_value || ''}" → "${d.new_value || ''}" — week of ${week}`;
    }
    case 'notes_edit': return `updated notes for week of ${d.week_start || '?'}`;
    case 'total_edit': {
      const day = DAYS_SERVER[d.day_index] || 'day';
      return `set ${d.location} ${day} count to "${d.count_text || '(empty)'}" — week of ${d.week_start || '?'}`;
    }
    case 'employee_add': return `added ${d.employee_name} to ${d.team || 'roster'}`;
    case 'employee_update': return `updated ${d.employee_name}`;
    case 'employee_archive': return `archived ${d.employee_name}`;
    case 'schedule_submitted': {
      const msg = d.message ? ` — "${d.message}"` : '';
      return `sent ${d.club_name || 'club'} schedule for review — week of ${d.week_start || '?'}${msg}`;
    }
    case 'schedule_published': {
      return `approved ${d.club_name || 'club'} schedule — week of ${d.week_start || '?'}`;
    }
    case 'schedule_cleared': return `cleared all shifts for ${d.club_name || 'club'} — week of ${d.week_start || '?'}`;
    case 'schedule_imported': return `imported ${d.imported_count || 0} entries for ${d.club_name || 'club'} — week of ${d.week_start || '?'}`;
    case 'notice_edit': return `updated the shift notice`;
    case 'time_off_applied': return `applied time-off for ${d.employee_name} (${(d.dates || []).join(', ')}) from Slack`;
    case 'user_create': return `created user ${d.email} (${d.role || '?'})`;
    case 'user_update': return `updated user #${d.target_user_id}`;
    case 'user_delete': return `deleted user #${d.deleted_user_id}`;
    default: return e.action;
  }
}

const useSsl = String(process.env.PGSSL || '').toLowerCase() === 'true'
  || /railway|render|heroku|amazonaws/i.test(process.env.DATABASE_URL || '');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
});

const app = express();
app.set('trust proxy', 1);

// ---------- security middleware ----------

// #1: Login rate limiting — 10 attempts per 15 min per IP
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many login attempts. Try again in 15 minutes.' },
});

// #2: AI parsing throttle — 20 per hour per user session
const parseLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 20,
  keyGenerator: (req) => req.session?.userId || req.ip,
  message: { error: 'Too many parse requests. Try again later.' },
});

// #4: Content Security Policy
app.use((req, res, next) => {
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self';");
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// #5: Origin check on state-changing requests (CSRF protection)
app.use('/api', (req, res, next) => {
  if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
  const origin = req.headers.origin || '';
  const host = req.headers.host || '';
  // Allow: no origin (same-origin), origin matches host, localhost, known domains, Railway
  if (!origin || origin.includes(host) ||
      origin.includes('localhost') || origin.includes('127.0.0.1') ||
      origin.includes('fbcnefl.com') || origin.includes('railway.app')) {
    return next();
  }
  console.log(`[security] blocked CSRF: origin=${origin} host=${host} method=${req.method} path=${req.path}`);
  return res.status(403).json({ error: 'Forbidden: origin mismatch' });
});

// #9: Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const userId = req.session?.userId || '-';
    if (!req.path.startsWith('/api/health') && !req.path.includes('.')) {
      console.log(`[req] ${req.method} ${req.path} ${res.statusCode} ${ms}ms user=${userId} ip=${req.ip}`);
    }
  });
  next();
});

app.use(express.json({ limit: '1mb' }));

// CORS for fbcnefl.com hub
app.use('/api', (req, res, next) => {
  const origin = req.headers.origin;
  if (origin === 'https://fbcnefl.com' || origin === 'http://fbcnefl.com' || origin === 'https://www.fbcnefl.com') {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('index.html')) {
      res.setHeader('Cache-Control', 'no-store, must-revalidate');
    }
  },
}));

app.use(session({
  store: new PgSession({ pool, tableName: 'session', createTableIfMissing: true }),
  secret: process.env.SESSION_SECRET || 'dev-insecure-secret',
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 24 * 30, // 30 days
  },
}));

// ---------- helpers ----------
// Express 4 doesn't auto-forward async handler rejections to the error
// middleware. Wrap every async handler with ah() so rejections are caught.
const ah = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// Look up the current logged-in user by session.userId. Returns null when
// the session is anonymous or the user no longer exists.
async function loadUser(req) {
  if (!req.session.userId) return null;
  const { rows } = await pool.query(
    'SELECT id, email, role, club_id, team, name FROM users WHERE id = $1',
    [req.session.userId]
  );
  return rows[0] || null;
}

function isOwner(user) {
  return user && (user.role === 'owner' || user.role === 'admin');
}

// Any signed-in user (owner or manager) can edit every club and every
// team. Per-team restrictions were removed on request so managers are no
// longer locked to their home location. Owner-only capabilities (user
// management, activity log) are still gated by isOwner().
function canEditEmployee(user, employee) {
  if (!user || !employee) return false;
  return user.role === 'owner' || user.role === 'admin' || user.role === 'manager';
}
function canEditTeam(user /*, clubId, team */) {
  if (!user) return false;
  return user.role === 'owner' || user.role === 'admin' || user.role === 'manager';
}
function canEditClub(user /*, clubId */) {
  if (!user) return false;
  return user.role === 'owner' || user.role === 'admin' || user.role === 'manager';
}

function userLabel(user) {
  if (!user) return 'unknown';
  return user.name && user.name.trim() ? user.name : user.email;
}

// Insert an audit log row. Never throws — failure to write the log should
// not break the actual write operation that triggered it.
async function audit(user, action, clubId, team, details) {
  try {
    await pool.query(
      `INSERT INTO audit_log (user_id, user_label, action, club_id, team, details)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [user ? user.id : null, userLabel(user), action, clubId || null, team || null, JSON.stringify(details || {})]
    );
  } catch (e) {
    console.error('[audit] failed to record', action, e.message);
  }
  // Only email on Send for Review — not on every cell edit
  if (action === 'schedule_submitted' || action === 'schedule_published') {
    queueEmail(userLabel(user), action, details || {});
  }
}

// Authoritative list of manual-total locations per club. The frontend uses
// the same list; the server validates writes against it.
const CLUB_LOCATIONS = {
  'Jacksonville': ['Jacksonville Beach', 'Creek East', 'Creek West'],
  'St. Augustine': ['Camachee Cove', 'Shipyard'],
};

function locationsForClubName(name) {
  return CLUB_LOCATIONS[name] || [];
}

// Normalize a date (string or Date) to the Monday of its week as YYYY-MM-DD
// Safely convert a pg DATE (Date object) or string to YYYY-MM-DD
function toDateStr(d) {
  if (d instanceof Date) return d.toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

function mondayOf(dateLike) {
  const d = new Date(toDateStr(dateLike) + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new Error('bad date');
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

function publicUser(u) {
  if (!u) return null;
  return { id: u.id, email: u.email, role: u.role, club_id: u.club_id, team: u.team, name: u.name };
}

// ---------- auth ----------
app.post('/api/login', loginLimiter, ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const { rows } = await pool.query(
    'SELECT id, email, password_hash, role, club_id, team, name FROM users WHERE email = $1',
    [String(email).toLowerCase().trim()]
  );
  const u = rows[0];
  if (!u) {
    console.log(`[security] failed login: unknown user "${String(email).toLowerCase().trim()}" from IP ${req.ip}`);
    await audit(null, 'login_failed', null, null, { email: String(email).toLowerCase().trim(), ip: req.ip, reason: 'unknown user' });
    return res.status(401).json({ error: 'invalid email or password' });
  }
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) {
    console.log(`[security] failed login: bad password for "${u.email}" from IP ${req.ip}`);
    await audit(null, 'login_failed', null, null, { email: u.email, ip: req.ip, reason: 'bad password' });
    return res.status(401).json({ error: 'invalid email or password' });
  }
  await audit(u, 'login_success', null, null, { ip: req.ip });
  req.session.userId = u.id;
  res.json(publicUser(u));
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.json({ id: null });
  res.json(publicUser(user));
}));

app.post('/api/me/password', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 4) {
    return res.status(400).json({ error: 'new password must be at least 4 characters' });
  }
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [user.id]);
  const ok = await bcrypt.compare(current_password || '', rows[0].password_hash);
  if (!ok) return res.status(400).json({ error: 'current password is wrong' });
  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, user.id]);
  res.json({ ok: true });
}));

// ---------- users (owner-only) ----------
app.get('/api/users', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.role, u.club_id, u.team, u.name, c.name AS club_name
       FROM users u LEFT JOIN clubs c ON c.id = u.club_id
      ORDER BY u.role DESC, u.email`
  );
  res.json(rows);
}));

app.post('/api/users', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  const { email, name, password, role, club_id, team } = req.body || {};
  if (!email || !password || !role) return res.status(400).json({ error: 'email, password, role required' });
  if (!['owner', 'manager'].includes(role)) return res.status(400).json({ error: 'role must be owner or manager' });
  if (role === 'manager' && !club_id) {
    return res.status(400).json({ error: 'managers require a club' });
  }
  if (password.length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      `INSERT INTO users (email, password_hash, role, club_id, team, name)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, email, role, club_id, team, name`,
      [String(email).toLowerCase().trim(), hash, role,
       role === 'manager' ? club_id : null,
       role === 'manager' ? team : null,
       name || null]
    );
    await audit(user, 'user_create', null, null, { created_user_id: rows[0].id, email: rows[0].email, role, team: rows[0].team });
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
}));

app.patch('/api/users/:id', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  const id = Number(req.params.id);
  const { email, password, role, club_id, team, name } = req.body || {};
  const sets = [];
  const vals = [];
  if (email) {
    vals.push(String(email).toLowerCase().trim()); sets.push(`email = $${vals.length}`);
  }
  if (password) {
    if (password.length < 4) return res.status(400).json({ error: 'password must be at least 4 characters' });
    const hash = await bcrypt.hash(password, 10);
    vals.push(hash); sets.push(`password_hash = $${vals.length}`);
  }
  if (role) {
    if (!['owner', 'manager'].includes(role)) return res.status(400).json({ error: 'bad role' });
    vals.push(role); sets.push(`role = $${vals.length}`);
  }
  if (club_id !== undefined) {
    vals.push(club_id || null); sets.push(`club_id = $${vals.length}`);
  }
  if (team !== undefined) {
    vals.push(team || null); sets.push(`team = $${vals.length}`);
  }
  if (name !== undefined) {
    vals.push(name || null); sets.push(`name = $${vals.length}`);
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length}
     RETURNING id, email, role, club_id, team, name`,
    vals
  );
  await audit(user, 'user_update', null, null, { target_user_id: id, fields: Object.keys(req.body || {}) });
  res.json(rows[0]);
}));

app.delete('/api/users/:id', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  const id = Number(req.params.id);
  if (id === user.id) return res.status(400).json({ error: 'cannot delete yourself' });
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  await audit(user, 'user_delete', null, null, { deleted_user_id: id });
  res.json({ ok: true });
}));

// ---------- audit log (owner-only) ----------
app.get('/api/audit', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500);
  const offset = Math.max(parseInt(req.query.offset, 10) || 0, 0);
  const { rows } = await pool.query(
    `SELECT a.id, a.user_id, a.user_label, a.action, a.club_id, a.team, a.details, a.created_at,
            c.name AS club_name
       FROM audit_log a
       LEFT JOIN clubs c ON c.id = a.club_id
      WHERE a.created_at >= NOW() - INTERVAL '30 days'
      ORDER BY a.created_at DESC
      LIMIT $1 OFFSET $2`,
    [limit, offset]
  );
  const { rows: countRows } = await pool.query(
    "SELECT COUNT(*)::int AS total FROM audit_log WHERE created_at >= NOW() - INTERVAL '30 days'"
  );
  res.json({ entries: rows, total: countRows[0].total, limit, offset });
}));

// Revert an audit entry — reverses cell edits and total edits back to their old value
app.post('/api/audit/:id/revert', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const id = Number(req.params.id);
  const { rows } = await pool.query('SELECT * FROM audit_log WHERE id = $1', [id]);
  const entry = rows[0];
  if (!entry) return res.status(404).json({ error: 'entry not found' });
  const d = entry.details || {};

  if (entry.action === 'cell_edit') {
    // Find the schedule for this club + week
    const weekStart = d.week_start;
    if (!weekStart) return res.status(400).json({ error: 'no week_start on entry' });
    const { rows: schedRows } = await pool.query(
      'SELECT id FROM schedules WHERE club_id = $1 AND week_start = $2',
      [entry.club_id, weekStart]
    );
    if (!schedRows[0]) return res.status(404).json({ error: 'schedule not found' });
    const scheduleId = schedRows[0].id;
    const oldValue = d.old_value || '';
    await pool.query(
      `INSERT INTO shifts (schedule_id, employee_id, day_index, shift_text)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (schedule_id, employee_id, day_index)
       DO UPDATE SET shift_text = EXCLUDED.shift_text`,
      [scheduleId, d.employee_id, d.day_index, oldValue]
    );
    await pool.query('UPDATE schedules SET updated_at = NOW() WHERE id = $1', [scheduleId]);
    await audit(user, 'cell_edit', entry.club_id, null, {
      ...d, new_value: oldValue, old_value: d.new_value || '', reverted_from: id,
    });
    return res.json({ ok: true });
  }

  if (entry.action === 'total_edit') {
    const weekStart = d.week_start;
    const { rows: schedRows } = await pool.query(
      'SELECT id FROM schedules WHERE club_id = $1 AND week_start = $2',
      [entry.club_id, weekStart]
    );
    if (!schedRows[0]) return res.status(404).json({ error: 'schedule not found' });
    const scheduleId = schedRows[0].id;
    const oldValue = d.old_value || '';
    await pool.query(
      `INSERT INTO location_totals (schedule_id, location, day_index, count_text)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (schedule_id, location, day_index)
       DO UPDATE SET count_text = EXCLUDED.count_text`,
      [scheduleId, d.location, d.day_index, oldValue]
    );
    await audit(user, 'total_edit', entry.club_id, null, {
      ...d, count_text: oldValue, reverted_from: id,
    });
    return res.json({ ok: true });
  }

  return res.status(400).json({ error: 'this action cannot be reverted' });
}));

// Recent schedule_published notifications for the signed-in user.
// Owners see every publish; signed-in managers see publishes for their own
// club (useful when switching between devices).
app.get('/api/notifications', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const params = [['schedule_published', 'schedule_submitted']];
  let where = "action = ANY($1) AND created_at >= NOW() - INTERVAL '14 days'";
  if (!isOwner(user) && user.club_id) {
    params.push(user.club_id);
    where += ' AND club_id = $2';
  }
  const { rows } = await pool.query(
    `SELECT a.id, a.user_label, a.details, a.created_at, c.name AS club_name
       FROM audit_log a
       LEFT JOIN clubs c ON c.id = a.club_id
      WHERE ${where}
      ORDER BY a.created_at DESC
      LIMIT 20`,
    params
  );
  res.json(rows);
}));

// Public shift notice, stored in app_state so owners can edit it from the UI.
app.get('/api/notice', ah(async (req, res) => {
  const { rows } = await pool.query("SELECT value FROM app_state WHERE key = 'shift_notice'");
  res.json({ text: rows[0] ? rows[0].value : '' });
}));

app.put('/api/notice', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  const { text } = req.body || {};
  const value = (text || '').slice(0, 2000);
  await pool.query(
    `INSERT INTO app_state (key, value) VALUES ('shift_notice', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [value]
  );
  await audit(user, 'notice_edit', null, null, { preview: value.slice(0, 80) });
  res.json({ ok: true, text: value });
}));

// Manager sends schedule for review. Does NOT clear amber — only owner
// approval (schedule_published) does that. Triggers email notification.
app.post('/api/clubs/:id/publish', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const clubId = Number(req.params.id);
  if (!canEditClub(user, clubId)) {
    return res.status(403).json({ error: 'you do not manage this club' });
  }
  const { week_start, message } = req.body || {};
  if (!week_start) return res.status(400).json({ error: 'week_start required' });
  const { rows: clubRows } = await pool.query('SELECT name FROM clubs WHERE id = $1', [clubId]);
  const clubName = clubRows[0] ? clubRows[0].name : '';
  await audit(user, 'schedule_submitted', clubId, user.team || null, {
    week_start,
    club_name: clubName,
    team: user.team || null,
    message: (message || '').slice(0, 300),
  });
  res.json({ ok: true });
}));

// Owner approves the entire schedule for a week. Works the same way as
// schedule_published from a baseline perspective — resets the amber state.
app.post('/api/clubs/:id/approve', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  const clubId = Number(req.params.id);
  const { week_start } = req.body || {};
  if (!week_start) return res.status(400).json({ error: 'week_start required' });
  const { rows: clubRows } = await pool.query('SELECT name FROM clubs WHERE id = $1', [clubId]);
  await audit(user, 'schedule_published', clubId, null, {
    week_start,
    club_name: clubRows[0] ? clubRows[0].name : '',
    message: 'Approved by owner',
  });
  res.json({ ok: true });
}));

// Owner approves a single cell (clears amber for just that shift).
app.post('/api/schedules/:id/approve-cell', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  const scheduleId = Number(req.params.id);
  const { employee_id, day_index } = req.body || {};
  if (employee_id == null || day_index == null) return res.status(400).json({ error: 'employee_id and day_index required' });
  const { rows: schedRows } = await pool.query(
    'SELECT club_id, week_start FROM schedules WHERE id = $1', [scheduleId]);
  if (!schedRows[0]) return res.status(404).json({ error: 'schedule not found' });
  const sched = schedRows[0];
  const weekStart = sched.week_start instanceof Date
    ? sched.week_start.toISOString().slice(0, 10) : sched.week_start;
  await audit(user, 'cell_approved', sched.club_id, null, {
    employee_id, day_index, week_start: weekStart,
  });
  res.json({ ok: true });
}));

// ---------- Slack connection ----------
const _env = (k) => process.env[k] || '';
const SLACK_BOT_TOKEN = _env('SLACK_TOKEN');
const SLACK_CHANNEL_ID = _env('SLACK_CHANNEL');
// Channel where staff post time-off requests (falls back to SLACK_CHANNEL)
const SLACK_TIMEOFF_CHANNEL = _env('SLACK_TIMEOFF_CHANNEL') || SLACK_CHANNEL_ID;

// Small in-memory cache so we don't hammer the Slack API
const _slackCache = { timeoff: { data: null, ts: 0 } };
const _slackUserCache = new Map(); // user_id -> { name, real_name }

async function slackGet(method, params) {
  const fetch = globalThis.fetch || require('node-fetch');
  const url = 'https://slack.com/api/' + method + '?' + new URLSearchParams(params);
  const r = await fetch(url, {
    headers: { 'Authorization': 'Bearer ' + SLACK_BOT_TOKEN }
  });
  const data = await r.json();
  if (!data.ok) throw new Error('slack ' + method + ': ' + (data.error || 'unknown'));
  return data;
}

async function lookupSlackUser(userId) {
  if (!userId) return null;
  if (_slackUserCache.has(userId)) return _slackUserCache.get(userId);
  try {
    const d = await slackGet('users.info', { user: userId });
    const u = d.user || {};
    const info = {
      name: u.profile && (u.profile.display_name || u.profile.real_name) || u.name || 'Unknown',
      avatar: u.profile && u.profile.image_48 || null,
    };
    _slackUserCache.set(userId, info);
    return info;
  } catch (e) { return { name: 'Unknown', avatar: null }; }
}

// Public read-only feed of the Slack time-off channel — used by fbcnefl.com hub
app.get('/api/slack-timeoff/public', ah(async (req, res) => {
  if (!SLACK_BOT_TOKEN || !SLACK_TIMEOFF_CHANNEL) {
    return res.json({ configured: false, messages: [] });
  }
  // Cache for 60s
  const now = Date.now();
  if (_slackCache.timeoff.data && (now - _slackCache.timeoff.ts) < 60000) {
    return res.json(_slackCache.timeoff.data);
  }
  try {
    const history = await slackGet('conversations.history', {
      channel: SLACK_TIMEOFF_CHANNEL,
      limit: '30',
    });
    const raw = (history.messages || []).filter(m => !m.subtype || m.subtype === 'thread_broadcast');
    // Resolve user names
    const messages = [];
    for (const m of raw) {
      const user = await lookupSlackUser(m.user);
      messages.push({
        ts: m.ts,
        text: m.text || '',
        user_name: user ? user.name : 'Unknown',
        user_avatar: user ? user.avatar : null,
        thread_reply_count: m.reply_count || 0,
      });
    }
    const payload = { configured: true, messages };
    _slackCache.timeoff = { data: payload, ts: now };
    res.json(payload);
  } catch (e) {
    console.error('[slack-timeoff] failed:', e.message);
    res.json({ configured: true, error: e.message, messages: [] });
  }
}));

// ---------- Slack time-off auto-import ----------
// Scans the time-off channel every 5 minutes, uses AI to parse messages
// into structured time off requests, and creates them as pending.
const SLACK_SCAN_INTERVAL = 5 * 60 * 1000; // 5 minutes
let lastSlackScanTs = '0';

async function scanSlackTimeOff() {
  if (!SLACK_BOT_TOKEN || !SLACK_TIMEOFF_CHANNEL || !ANTHROPIC_API_KEY) return;

  try {
    // Get the last scan timestamp so we only process new messages
    const { rows: tsRows } = await pool.query(
      "SELECT value FROM app_state WHERE key = 'slack_timeoff_last_ts'"
    );
    const sinceTs = tsRows[0] ? tsRows[0].value : '0';

    const history = await slackGet('conversations.history', {
      channel: SLACK_TIMEOFF_CHANNEL,
      oldest: sinceTs,
      limit: '20',
    });

    const messages = (history.messages || [])
      .filter(m => !m.subtype && m.text && parseFloat(m.ts) > parseFloat(sinceTs))
      .sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts));

    if (!messages.length) return;

    // Get all employee names for matching
    const { rows: allEmps } = await pool.query(
      'SELECT id, name, club_id FROM employees WHERE archived = FALSE'
    );
    const empNames = allEmps.map(e => e.name);

    // Process each message with AI
    const Anthropic = require('@anthropic-ai/sdk');
    const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

    let newestTs = sinceTs;
    let created = 0;

    for (const msg of messages) {
      if (parseFloat(msg.ts) > parseFloat(newestTs)) newestTs = msg.ts;

      // Look up who posted
      const slackUser = await lookupSlackUser(msg.user);
      const posterName = slackUser ? slackUser.name : '';

      try {
        const aiResp = await client.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1024,
          messages: [{
            role: 'user',
            content: `Parse this time-off request from a Slack message. The poster's Slack display name is "${posterName}".

Message: "${msg.text}"

Known employees: ${JSON.stringify(empNames)}

Return ONLY valid JSON (no markdown):
{
  "requests": [
    {
      "employee_name": "exact name from the known list",
      "start_date": "YYYY-MM-DD",
      "end_date": "YYYY-MM-DD",
      "note": "brief summary"
    }
  ]
}

Rules:
- Match the poster or mentioned person to the closest employee name in the known list
- Parse dates from the message (e.g. "May 5-7" = 2026-05-05 to 2026-05-07, assume current year 2026)
- If the message isn't a time-off request, return {"requests": []}
- If you can't determine dates, return {"requests": []}
- For single days, start_date = end_date`,
          }],
        });

        const text = aiResp.content[0].text.trim();
        const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
        const parsed = JSON.parse(cleaned);

        for (const req of (parsed.requests || [])) {
          if (!req.employee_name || !req.start_date || !req.end_date) continue;

          // Match employee
          const emp = allEmps.find(e =>
            e.name.toLowerCase() === req.employee_name.toLowerCase()
          );
          if (!emp) {
            console.log(`[slack-timeoff] no match for "${req.employee_name}", skipping`);
            continue;
          }

          // Check for duplicate
          const { rows: dupes } = await pool.query(
            `SELECT id FROM time_off_requests
              WHERE employee_id = $1 AND start_date = $2 AND end_date = $3`,
            [emp.id, req.start_date, req.end_date]
          );
          if (dupes.length) continue;

          // Create pending request
          await pool.query(
            `INSERT INTO time_off_requests (employee_id, club_id, start_date, end_date, note, status)
             VALUES ($1, $2, $3, $4, $5, 'pending')`,
            [emp.id, emp.club_id, req.start_date, req.end_date, req.note || `From Slack: ${posterName}`]
          );
          created++;
          console.log(`[slack-timeoff] created request: ${emp.name} ${req.start_date} to ${req.end_date}`);
        }
      } catch (parseErr) {
        console.error(`[slack-timeoff] AI parse error for message:`, parseErr.message);
      }
    }

    // Update the last-scanned timestamp
    await pool.query(
      `INSERT INTO app_state (key, value) VALUES ('slack_timeoff_last_ts', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [newestTs]
    );

    if (created) {
      console.log(`[slack-timeoff] created ${created} new request(s) from Slack`);
    }
  } catch (err) {
    console.error('[slack-timeoff] scan error:', err.message);
  }
}

// Start scanning after server is up
setTimeout(() => {
  scanSlackTimeOff();
  setInterval(scanSlackTimeOff, SLACK_SCAN_INTERVAL);
}, 15000);

// Manual trigger for owners
app.post('/api/slack-timeoff/scan', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  if (!SLACK_BOT_TOKEN || !SLACK_TIMEOFF_CHANNEL) {
    return res.json({ ok: false, error: 'SLACK_TOKEN and SLACK_CHANNEL not configured' });
  }
  if (!ANTHROPIC_API_KEY) {
    return res.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' });
  }
  await scanSlackTimeOff();
  res.json({ ok: true });
}));

// ---------- clubs ----------
app.get('/api/clubs', ah(async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM clubs ORDER BY name');
  res.json(rows);
}));

// ---------- employees ----------
app.get('/api/clubs/:id/employees', ah(async (req, res) => {
  const clubId = Number(req.params.id);
  const { rows } = await pool.query(
    'SELECT id, club_id, name, team, archived, sort_order FROM employees WHERE club_id = $1 ORDER BY archived ASC, sort_order ASC, id ASC',
    [clubId]
  );
  res.json(rows);
}));

app.post('/api/clubs/:id/employees', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const clubId = Number(req.params.id);
  const { name, team } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  if (!canEditTeam(user, clubId, team || '')) {
    return res.status(403).json({ error: 'you do not manage that team' });
  }
  const { rows: maxRows } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM employees WHERE club_id = $1',
    [clubId]
  );
  const { rows } = await pool.query(
    'INSERT INTO employees (club_id, name, team, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
    [clubId, name, team || null, maxRows[0].next]
  );
  await audit(user, 'employee_add', clubId, team || null, { employee_id: rows[0].id, employee_name: name, team: team || null });
  res.json(rows[0]);
}));

app.patch('/api/employees/:id', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const empId = Number(req.params.id);
  const { rows: existing } = await pool.query('SELECT * FROM employees WHERE id = $1', [empId]);
  if (!existing[0]) return res.status(404).json({ error: 'not found' });
  if (!canEditEmployee(user, existing[0])) {
    return res.status(403).json({ error: 'you cannot edit this employee' });
  }
  const { name, team, archived, sort_order } = req.body || {};
  // If team is changing, check that the user can also edit the destination team
  if (team !== undefined && team !== null && team !== existing[0].team) {
    if (!canEditTeam(user, existing[0].club_id, team)) {
      return res.status(403).json({ error: 'you cannot move employees into that team' });
    }
  }
  const { rows } = await pool.query(
    `UPDATE employees
       SET name = COALESCE($1, name),
           team = CASE WHEN $2::text IS NULL THEN team ELSE NULLIF($2,'') END,
           archived = COALESCE($3, archived),
           sort_order = COALESCE($4, sort_order)
     WHERE id = $5 RETURNING *`,
    [name ?? null, team ?? null, typeof archived === 'boolean' ? archived : null, sort_order ?? null, empId]
  );
  await audit(user, 'employee_update', existing[0].club_id, existing[0].team, {
    employee_id: empId,
    employee_name: rows[0].name,
    changes: { name, team, archived, sort_order },
  });
  res.json(rows[0]);
}));

app.delete('/api/employees/:id', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const empId = Number(req.params.id);
  const { rows: existing } = await pool.query('SELECT * FROM employees WHERE id = $1', [empId]);
  if (!existing[0]) return res.status(404).json({ error: 'not found' });
  if (!canEditEmployee(user, existing[0])) {
    return res.status(403).json({ error: 'you cannot edit this employee' });
  }
  // Archive instead of hard-delete (preserves history)
  await pool.query('UPDATE employees SET archived = TRUE WHERE id = $1', [empId]);
  await audit(user, 'employee_archive', existing[0].club_id, existing[0].team, {
    employee_id: empId, employee_name: existing[0].name,
  });
  res.json({ ok: true });
}));

// ---------- schedules ----------
async function getOrCreateSchedule(clubId, weekStart) {
  const { rows } = await pool.query(
    'SELECT * FROM schedules WHERE club_id = $1 AND week_start = $2',
    [clubId, weekStart]
  );
  if (rows[0]) return rows[0];
  const { rows: created } = await pool.query(
    'INSERT INTO schedules (club_id, week_start) VALUES ($1,$2) RETURNING *',
    [clubId, weekStart]
  );
  return created[0];
}

app.get('/api/clubs/:id/schedule', ah(async (req, res) => {
  const clubId = Number(req.params.id);
  let weekStart;
  try { weekStart = mondayOf(req.query.week); }
  catch (e) { return res.status(400).json({ error: 'bad week param (YYYY-MM-DD)' }); }

  const schedule = await getOrCreateSchedule(clubId, weekStart);
  const { rows: employees } = await pool.query(
    'SELECT id, name, team, archived, sort_order FROM employees WHERE club_id = $1 AND archived = FALSE ORDER BY sort_order ASC, id ASC',
    [clubId]
  );
  const { rows: shifts } = await pool.query(
    'SELECT employee_id, day_index, shift_text FROM shifts WHERE schedule_id = $1',
    [schedule.id]
  );
  const shiftMap = {};
  for (const s of shifts) {
    shiftMap[s.employee_id] = shiftMap[s.employee_id] || {};
    shiftMap[s.employee_id][s.day_index] = s.shift_text;
  }
  const { rows: totals } = await pool.query(
    'SELECT location, day_index, count_text FROM location_totals WHERE schedule_id = $1',
    [schedule.id]
  );
  const totalsMap = {};
  for (const t of totals) {
    totalsMap[t.location] = totalsMap[t.location] || {};
    totalsMap[t.location][t.day_index] = t.count_text;
  }
  const { rows: clubRow } = await pool.query('SELECT name FROM clubs WHERE id = $1', [clubId]);

  // Recent edits to this club's schedule for this week — powers the
  // Recent changes list visible to every viewer including anonymous staff.
  // Includes cell, notes, total, and publish events matching the week, plus
  // any employee roster edits from the last 7 days (rosters aren't week-
  // scoped but staff still want to know when people are added/removed).
  const { rows: recentRows } = await pool.query(
    `SELECT user_label, action, details, created_at
       FROM audit_log
      WHERE club_id = $1
        AND (
          (action IN ('cell_edit','notes_edit','total_edit','schedule_published','schedule_submitted')
            AND details->>'week_start' = $2)
          OR (action IN ('employee_add','employee_update','employee_archive')
            AND created_at > NOW() - INTERVAL '7 days')
        )
      ORDER BY created_at DESC
      LIMIT 15`,
    [clubId, weekStart]
  );
  const recentUpdates = recentRows.map(r => ({
    user_label: r.user_label,
    action: r.action,
    details: r.details,
    created_at: r.created_at,
  }));
  const lastUpdate = recentUpdates[0] || null;

  // Review status — 4 states:
  //   draft          = no submissions or approvals yet
  //   submitted      = manager sent for review, owner hasn't approved
  //   changes_pending = owner approved but new edits since
  //   approved       = owner approved and no edits since
  const { rows: approveRows } = await pool.query(
    `SELECT created_at FROM audit_log
      WHERE club_id = $1 AND action = 'schedule_published'
        AND details->>'week_start' = $2
      ORDER BY created_at DESC LIMIT 1`,
    [clubId, weekStart]
  );
  const { rows: submitRows } = await pool.query(
    `SELECT created_at FROM audit_log
      WHERE club_id = $1 AND action = 'schedule_submitted'
        AND details->>'week_start' = $2
      ORDER BY created_at DESC LIMIT 1`,
    [clubId, weekStart]
  );
  const lastPublishedAt = approveRows[0] ? approveRows[0].created_at : null;
  const lastSubmittedAt = submitRows[0] ? submitRows[0].created_at : null;
  const updatedAt = new Date(schedule.updated_at);
  let reviewStatus = 'draft';
  if (lastPublishedAt && updatedAt <= new Date(lastPublishedAt)) {
    reviewStatus = 'approved';
  } else if (lastPublishedAt && updatedAt > new Date(lastPublishedAt)) {
    reviewStatus = 'changes_pending';
  } else if (lastSubmittedAt) {
    reviewStatus = 'submitted';
  }

  // Cells edited since the last send-for-review — powers the amber
  // highlighting that persists after Save Draft until the schedule is
  // reviewed. Returns arrays of {employee_id, day_index} and
  // {location, day_index} so the frontend can mark those cells.
  const sinceDate = lastPublishedAt || '1970-01-01';
  // Return pending cells with old_value so the frontend can show
  // strikethrough when a shift was removed (old had text, new is empty).
  const { rows: pendingCells } = await pool.query(
    `SELECT DISTINCT ON (
       (a.details->>'employee_id')::int,
       (a.details->>'day_index')::int
     )
       (a.details->>'employee_id')::int AS employee_id,
       (a.details->>'day_index')::int   AS day_index,
       a.details->>'old_value'          AS old_value,
       a.details->>'new_value'          AS new_value
     FROM audit_log a
     WHERE a.club_id = $1 AND a.action = 'cell_edit'
       AND a.details->>'week_start' = $2
       AND a.created_at > $3
       AND NOT EXISTS (
         SELECT 1 FROM audit_log b
         WHERE b.club_id = $1 AND b.action = 'cell_approved'
           AND b.details->>'week_start' = $2
           AND (b.details->>'employee_id')::int = (a.details->>'employee_id')::int
           AND (b.details->>'day_index')::int = (a.details->>'day_index')::int
           AND b.created_at > a.created_at
       )
     ORDER BY (a.details->>'employee_id')::int, (a.details->>'day_index')::int, a.created_at DESC`,
    [clubId, weekStart, sinceDate]
  );
  const { rows: pendingTotals } = await pool.query(
    `SELECT DISTINCT
       details->>'location'           AS location,
       (details->>'day_index')::int   AS day_index
     FROM audit_log
     WHERE club_id = $1 AND action = 'total_edit'
       AND details->>'week_start' = $2
       AND created_at > $3`,
    [clubId, weekStart, sinceDate]
  );

  // Pending time off requests that overlap this week
  // Returns one row per (employee, day_index) with the request id so the
  // frontend can show a ghosted "Req Off" and an Approve button.
  const weekEnd = new Date(weekStart + 'T00:00:00Z');
  weekEnd.setUTCDate(weekEnd.getUTCDate() + 6);
  const weekEndStr = weekEnd.toISOString().slice(0, 10);
  const { rows: pendingTimeOff } = await pool.query(
    `SELECT id, employee_id, start_date, end_date
       FROM time_off_requests
      WHERE club_id = $1 AND status = 'pending'
        AND start_date <= $3 AND end_date >= $2`,
    [clubId, weekStart, weekEndStr]
  );
  // Expand each request into individual day_index cells within this week
  const pendingTimeOffCells = [];
  for (const req of pendingTimeOff) {
    const start = new Date(req.start_date instanceof Date
      ? req.start_date.toISOString().slice(0, 10) + 'T00:00:00Z'
      : req.start_date + 'T00:00:00Z');
    const end = new Date(req.end_date instanceof Date
      ? req.end_date.toISOString().slice(0, 10) + 'T00:00:00Z'
      : req.end_date + 'T00:00:00Z');
    const weekStartDate = new Date(weekStart + 'T00:00:00Z');
    for (let d = 0; d < 7; d++) {
      const dayDate = new Date(weekStartDate);
      dayDate.setUTCDate(dayDate.getUTCDate() + d);
      if (dayDate >= start && dayDate <= end) {
        pendingTimeOffCells.push({
          request_id: req.id,
          employee_id: req.employee_id,
          day_index: d,
        });
      }
    }
  }

  res.json({
    schedule: {
      id: schedule.id,
      club_id: schedule.club_id,
      week_start: schedule.week_start instanceof Date
        ? schedule.week_start.toISOString().slice(0, 10)
        : schedule.week_start,
      status: schedule.status,
      notes: schedule.notes,
    },
    employees,
    shifts: shiftMap,
    locations: locationsForClubName(clubRow[0] ? clubRow[0].name : ''),
    totals: totalsMap,
    review_status: reviewStatus,
    pending_cells: pendingCells,
    pending_totals: pendingTotals,
    pending_time_off: pendingTimeOffCells,
    last_update: lastUpdate,
    recent_updates: recentUpdates,
  });
}));

app.patch('/api/schedules/:id/total', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const scheduleId = Number(req.params.id);
  const { location, day_index, count_text } = req.body || {};
  if (!location || day_index == null) return res.status(400).json({ error: 'location and day_index required' });
  const { rows: schedRows } = await pool.query(
    `SELECT s.id, s.club_id, s.week_start, c.name AS club_name
       FROM schedules s JOIN clubs c ON c.id = s.club_id
      WHERE s.id = $1`,
    [scheduleId]
  );
  const sched = schedRows[0];
  if (!sched) return res.status(404).json({ error: 'schedule not found' });
  if (!canEditClub(user, sched.club_id)) {
    return res.status(403).json({ error: 'you do not manage this club' });
  }
  const allowed = locationsForClubName(sched.club_name);
  if (!allowed.includes(location)) {
    return res.status(400).json({ error: 'unknown location for this club' });
  }
  await pool.query(
    `INSERT INTO location_totals (schedule_id, location, day_index, count_text)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (schedule_id, location, day_index)
     DO UPDATE SET count_text = EXCLUDED.count_text`,
    [scheduleId, location, day_index, count_text || '']
  );
  await audit(user, 'total_edit', sched.club_id, null, {
    location,
    day_index,
    week_start: sched.week_start instanceof Date
      ? sched.week_start.toISOString().slice(0, 10)
      : sched.week_start,
    count_text: count_text || '',
  });
  res.json({ ok: true });
}));

app.patch('/api/schedules/:id/cell', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const scheduleId = Number(req.params.id);
  const { employee_id, day_index, shift_text } = req.body || {};
  if (employee_id == null || day_index == null) return res.status(400).json({ error: 'employee_id and day_index required' });
  const { rows: schedRows } = await pool.query('SELECT * FROM schedules WHERE id = $1', [scheduleId]);
  const sched = schedRows[0];
  if (!sched) return res.status(404).json({ error: 'schedule not found' });
  const { rows: empRows } = await pool.query('SELECT * FROM employees WHERE id = $1 AND club_id = $2', [employee_id, sched.club_id]);
  const employee = empRows[0];
  if (!employee) return res.status(400).json({ error: 'employee not in this club' });
  if (!canEditEmployee(user, employee)) {
    return res.status(403).json({ error: 'you do not manage that team' });
  }
  // Capture previous value for the audit log
  const { rows: prevRows } = await pool.query(
    'SELECT shift_text FROM shifts WHERE schedule_id = $1 AND employee_id = $2 AND day_index = $3',
    [scheduleId, employee_id, day_index]
  );
  const oldValue = prevRows[0] ? prevRows[0].shift_text : '';
  await pool.query(
    `INSERT INTO shifts (schedule_id, employee_id, day_index, shift_text)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (schedule_id, employee_id, day_index)
     DO UPDATE SET shift_text = EXCLUDED.shift_text`,
    [scheduleId, employee_id, day_index, shift_text || '']
  );
  await pool.query('UPDATE schedules SET updated_at = NOW() WHERE id = $1', [scheduleId]);
  await audit(user, 'cell_edit', sched.club_id, employee.team, {
    employee_id, employee_name: employee.name,
    day_index,
    week_start: sched.week_start instanceof Date
      ? sched.week_start.toISOString().slice(0, 10)
      : sched.week_start,
    old_value: oldValue,
    new_value: shift_text || '',
  });
  res.json({ ok: true });
}));

app.patch('/api/schedules/:id/notes', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const scheduleId = Number(req.params.id);
  const { notes } = req.body || {};
  const { rows } = await pool.query('SELECT club_id, week_start FROM schedules WHERE id = $1', [scheduleId]);
  if (!rows[0]) return res.status(404).json({ error: 'schedule not found' });
  if (!canEditClub(user, rows[0].club_id)) {
    return res.status(403).json({ error: 'you do not manage this club' });
  }
  await pool.query('UPDATE schedules SET notes = $1, updated_at = NOW() WHERE id = $2', [notes || '', scheduleId]);
  await audit(user, 'notes_edit', rows[0].club_id, null, {
    week_start: rows[0].week_start instanceof Date
      ? rows[0].week_start.toISOString().slice(0, 10)
      : rows[0].week_start,
    preview: (notes || '').slice(0, 80),
  });
  res.json({ ok: true });
}));

// Clear all shifts and location totals for a schedule (owner-only)
app.post('/api/schedules/:id/clear', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  const scheduleId = Number(req.params.id);
  const { rows: schedRows } = await pool.query('SELECT * FROM schedules WHERE id = $1', [scheduleId]);
  const sched = schedRows[0];
  if (!sched) return res.status(404).json({ error: 'schedule not found' });
  const weekStart = sched.week_start instanceof Date
    ? sched.week_start.toISOString().slice(0, 10) : sched.week_start;
  await pool.query('DELETE FROM shifts WHERE schedule_id = $1', [scheduleId]);
  await pool.query('DELETE FROM location_totals WHERE schedule_id = $1', [scheduleId]);
  await pool.query('UPDATE schedules SET notes = \'\', updated_at = NOW() WHERE id = $1', [scheduleId]);
  const { rows: clubRows } = await pool.query('SELECT name FROM clubs WHERE id = $1', [sched.club_id]);
  await audit(user, 'schedule_cleared', sched.club_id, null, {
    week_start: weekStart,
    club_name: clubRows[0] ? clubRows[0].name : '',
  });
  res.json({ ok: true });
}));

// Import schedule data from JSON (owner-only). Accepts the same format
// as the backup export: { shifts: [{employee_name, day_index, shift_text}], totals: [{location, day_index, count_text}], notes }
// Targets a specific club + week. Matches employees by name.
app.post('/api/clubs/:id/import', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  const clubId = Number(req.params.id);
  const { week_start, shifts, totals, notes } = req.body || {};
  if (!week_start) return res.status(400).json({ error: 'week_start required' });
  let weekStart;
  try { weekStart = mondayOf(week_start); }
  catch (e) { return res.status(400).json({ error: 'bad week_start (YYYY-MM-DD)' }); }

  const schedule = await getOrCreateSchedule(clubId, weekStart);
  const { rows: clubRows } = await pool.query('SELECT name FROM clubs WHERE id = $1', [clubId]);
  const clubName = clubRows[0] ? clubRows[0].name : '';

  // Build employee name→id lookup (active employees only)
  const { rows: emps } = await pool.query(
    'SELECT id, name FROM employees WHERE club_id = $1 AND archived = FALSE', [clubId]);
  const empByName = {};
  for (const e of emps) empByName[e.name.toLowerCase().trim()] = e.id;

  let imported = 0;
  let skipped = [];

  // Import shifts
  if (Array.isArray(shifts)) {
    for (const s of shifts) {
      if (s.employee_name == null || s.day_index == null) continue;
      const empId = empByName[String(s.employee_name).toLowerCase().trim()];
      if (!empId) { skipped.push(s.employee_name); continue; }
      const dayIdx = Number(s.day_index);
      if (dayIdx < 0 || dayIdx > 6) continue;
      await pool.query(
        `INSERT INTO shifts (schedule_id, employee_id, day_index, shift_text)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (schedule_id, employee_id, day_index)
         DO UPDATE SET shift_text = EXCLUDED.shift_text`,
        [schedule.id, empId, dayIdx, s.shift_text || '']
      );
      imported++;
    }
  }

  // Import totals
  if (Array.isArray(totals)) {
    for (const t of totals) {
      if (!t.location || t.day_index == null) continue;
      const dayIdx = Number(t.day_index);
      if (dayIdx < 0 || dayIdx > 6) continue;
      await pool.query(
        `INSERT INTO location_totals (schedule_id, location, day_index, count_text)
         VALUES ($1,$2,$3,$4)
         ON CONFLICT (schedule_id, location, day_index)
         DO UPDATE SET count_text = EXCLUDED.count_text`,
        [schedule.id, t.location, dayIdx, t.count_text || '']
      );
      imported++;
    }
  }

  // Import notes
  if (notes != null) {
    await pool.query('UPDATE schedules SET notes = $1, updated_at = NOW() WHERE id = $2', [notes, schedule.id]);
  }

  await pool.query('UPDATE schedules SET updated_at = NOW() WHERE id = $1', [schedule.id]);
  await audit(user, 'schedule_imported', clubId, null, {
    week_start: weekStart,
    club_name: clubName,
    imported_count: imported,
    skipped_names: [...new Set(skipped)],
  });
  res.json({ ok: true, imported, skipped: [...new Set(skipped)] });
}));

// ---------- schedule images ----------
const scheduleUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf'];
    cb(null, allowed.includes(file.mimetype));
  },
});

// Upload a schedule image for a given week (replaces existing)
app.post('/api/schedule-images', scheduleUpload.single('image'), ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  if (!req.file) return res.status(400).json({ error: 'image file required (jpg, png, webp, gif, or pdf)' });
  const { week_start } = req.body;
  if (!week_start) return res.status(400).json({ error: 'week_start required' });
  let weekStart;
  try { weekStart = mondayOf(week_start); }
  catch (e) { return res.status(400).json({ error: 'bad week_start (YYYY-MM-DD)' }); }

  await pool.query(
    `INSERT INTO schedule_images (week_start, original_name, mime_type, image_data, uploaded_by)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (week_start) DO UPDATE
     SET original_name = EXCLUDED.original_name, mime_type = EXCLUDED.mime_type,
         image_data = EXCLUDED.image_data, uploaded_by = EXCLUDED.uploaded_by,
         created_at = NOW()`,
    [weekStart, req.file.originalname, req.file.mimetype, req.file.buffer, user.id]
  );
  await audit(user, 'schedule_image_upload', null, null, {
    week_start: weekStart,
    original_name: req.file.originalname,
    size: req.file.size,
  });
  res.json({ ok: true, week_start: weekStart });
}));

// List which weeks have schedule images
app.get('/api/schedule-images', ah(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT week_start, original_name, mime_type, created_at FROM schedule_images ORDER BY week_start DESC'
  );
  res.json(rows.map(r => ({
    week_start: r.week_start instanceof Date ? r.week_start.toISOString().slice(0, 10) : r.week_start,
    original_name: r.original_name,
    mime_type: r.mime_type,
    created_at: r.created_at,
  })));
}));

// Serve a schedule image by week
app.get('/api/schedule-images/:weekStart', ah(async (req, res) => {
  const weekStart = req.params.weekStart;
  const { rows } = await pool.query(
    'SELECT mime_type, image_data FROM schedule_images WHERE week_start = $1',
    [weekStart]
  );
  if (!rows[0]) return res.status(404).json({ error: 'no image for this week' });
  res.setHeader('Content-Type', rows[0].mime_type);
  res.setHeader('Cache-Control', 'public, max-age=60');
  res.send(rows[0].image_data);
}));

// Delete a schedule image (owner-only)
app.delete('/api/schedule-images/:weekStart', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  const weekStart = req.params.weekStart;
  await pool.query('DELETE FROM schedule_images WHERE week_start = $1', [weekStart]);
  await audit(user, 'schedule_image_delete', null, null, { week_start: weekStart });
  res.json({ ok: true });
}));

// ---------- time off requests ----------

// List time off requests (optionally filter by status/club)
app.get('/api/time-off', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const status = req.query.status || null;
  const params = [];
  let where = '1=1';
  if (status) { params.push(status); where += ` AND t.status = $${params.length}`; }
  const { rows } = await pool.query(
    `SELECT t.id, t.employee_id, t.club_id, t.start_date, t.end_date, t.note,
            t.status, t.is_pto, t.deny_reason, t.created_at, t.resolved_at,
            e.name AS employee_name, c.name AS club_name
       FROM time_off_requests t
       JOIN employees e ON e.id = t.employee_id
       JOIN clubs c ON c.id = t.club_id
      WHERE ${where}
      ORDER BY t.status = 'pending' DESC, t.start_date ASC, t.created_at DESC`,
    params
  );
  res.json(rows.map(r => ({
    ...r,
    start_date: r.start_date instanceof Date ? r.start_date.toISOString().slice(0, 10) : r.start_date,
    end_date: r.end_date instanceof Date ? r.end_date.toISOString().slice(0, 10) : r.end_date,
  })));
}));

// Public read-only feed of time-off requests — used by fbcnefl.com hub.
// Returns only approved + pending requests whose end date is today or later,
// and only non-sensitive fields (employee name, club, dates, status).
app.get('/api/time-off/public', ah(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT t.id, t.start_date, t.end_date, t.status, t.note,
            e.name AS employee_name, c.name AS club_name
       FROM time_off_requests t
       JOIN employees e ON e.id = t.employee_id
       JOIN clubs c ON c.id = t.club_id
      WHERE t.status IN ('pending','approved')
        AND t.end_date >= CURRENT_DATE
      ORDER BY t.status = 'pending' DESC, t.start_date ASC
      LIMIT 50`
  );
  res.json(rows.map(r => ({
    id: r.id,
    employee_name: r.employee_name,
    club_name: r.club_name,
    start_date: r.start_date instanceof Date ? r.start_date.toISOString().slice(0, 10) : r.start_date,
    end_date: r.end_date instanceof Date ? r.end_date.toISOString().slice(0, 10) : r.end_date,
    status: r.status,
    note: r.note || '',
  })));
}));

// Create a time off request (owner/manager enters on behalf of staff)
app.post('/api/time-off', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const { employee_id, start_date, end_date, note, is_pto } = req.body || {};
  if (!employee_id || !start_date || !end_date) {
    return res.status(400).json({ error: 'employee_id, start_date, end_date required' });
  }
  const { rows: empRows } = await pool.query('SELECT id, club_id, name FROM employees WHERE id = $1', [employee_id]);
  if (!empRows[0]) return res.status(404).json({ error: 'employee not found' });
  const emp = empRows[0];
  const { rows } = await pool.query(
    `INSERT INTO time_off_requests (employee_id, club_id, start_date, end_date, note, is_pto, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [employee_id, emp.club_id, start_date, end_date, note || '', !!is_pto, user.id]
  );
  await audit(user, 'time_off_created', emp.club_id, null, {
    employee_id, employee_name: emp.name, start_date, end_date, note: note || '',
  });
  res.json({ ok: true, id: rows[0].id });
}));

// Approve a time off request — auto-fills Req Off in the schedule
app.post('/api/time-off/:id/approve', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const reqId = Number(req.params.id);
  const { rows } = await pool.query(
    `SELECT t.*, e.name AS employee_name FROM time_off_requests t
     JOIN employees e ON e.id = t.employee_id WHERE t.id = $1`, [reqId]);
  if (!rows[0]) return res.status(404).json({ error: 'request not found' });
  const tor = rows[0];

  await pool.query(
    `UPDATE time_off_requests SET status = 'approved', resolved_by = $1, resolved_at = NOW() WHERE id = $2`,
    [user.id, reqId]
  );

  // Auto-fill Req Off for each day in the range
  const startStr = toDateStr(tor.start_date);
  const endStr = toDateStr(tor.end_date);
  const start = new Date(startStr + 'T00:00:00Z');
  const end = new Date(endStr + 'T00:00:00Z');
  let filled = 0;
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const weekStart = mondayOf(d.toISOString().slice(0, 10));
    const dayOfWeek = d.getUTCDay();
    const dayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1; // Mon=0..Sun=6
    const schedule = await getOrCreateSchedule(tor.club_id, weekStart);
    await pool.query(
      `INSERT INTO shifts (schedule_id, employee_id, day_index, shift_text)
       VALUES ($1, $2, $3, 'Req Off')
       ON CONFLICT (schedule_id, employee_id, day_index)
       DO UPDATE SET shift_text = 'Req Off'`,
      [schedule.id, tor.employee_id, dayIndex]
    );
    filled++;
  }
  await pool.query('UPDATE schedules SET updated_at = NOW() WHERE club_id = $1', [tor.club_id]);

  await audit(user, 'time_off_approved', tor.club_id, null, {
    employee_id: tor.employee_id, employee_name: tor.employee_name,
    start_date: tor.start_date instanceof Date ? tor.start_date.toISOString().slice(0, 10) : tor.start_date,
    end_date: tor.end_date instanceof Date ? tor.end_date.toISOString().slice(0, 10) : tor.end_date,
    days_filled: filled,
  });
  res.json({ ok: true, days_filled: filled });
}));

// Deny a time off request
app.post('/api/time-off/:id/deny', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const reqId = Number(req.params.id);
  const { deny_reason } = req.body || {};
  const { rows } = await pool.query(
    `SELECT t.*, e.name AS employee_name FROM time_off_requests t
     JOIN employees e ON e.id = t.employee_id WHERE t.id = $1`, [reqId]);
  if (!rows[0]) return res.status(404).json({ error: 'request not found' });
  const tor = rows[0];
  await pool.query(
    `UPDATE time_off_requests SET status = 'denied', resolved_by = $1, resolved_at = NOW(), deny_reason = $2 WHERE id = $3`,
    [user.id, deny_reason || '', reqId]
  );
  await audit(user, 'time_off_denied', tor.club_id, null, {
    employee_id: tor.employee_id, employee_name: tor.employee_name,
    start_date: tor.start_date instanceof Date ? tor.start_date.toISOString().slice(0, 10) : tor.start_date,
    end_date: tor.end_date instanceof Date ? tor.end_date.toISOString().slice(0, 10) : tor.end_date,
    deny_reason: deny_reason || '',
  });
  res.json({ ok: true });
}));

// Reset a time off request back to pending — also clears any "Req Off"
// that was auto-filled when it was approved
app.post('/api/time-off/:id/reset', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const reqId = Number(req.params.id);
  const { rows } = await pool.query(
    `SELECT t.*, e.name AS employee_name FROM time_off_requests t
     JOIN employees e ON e.id = t.employee_id WHERE t.id = $1`, [reqId]);
  if (!rows[0]) return res.status(404).json({ error: 'request not found' });
  const tor = rows[0];
  const wasApproved = tor.status === 'approved';

  await pool.query(
    `UPDATE time_off_requests SET status = 'pending', resolved_by = NULL, resolved_at = NULL WHERE id = $1`,
    [reqId]
  );

  // If it was approved, clear the Req Off cells that were auto-filled
  let cleared = 0;
  if (wasApproved) {
    const start = new Date(toDateStr(tor.start_date) + 'T00:00:00Z');
    const end = new Date(toDateStr(tor.end_date) + 'T00:00:00Z');
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const weekStart = mondayOf(d.toISOString().slice(0, 10));
      const dayOfWeek = d.getUTCDay();
      const dayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const { rows: schedRows } = await pool.query(
        'SELECT id FROM schedules WHERE club_id = $1 AND week_start = $2',
        [tor.club_id, weekStart]
      );
      if (!schedRows[0]) continue;
      const scheduleId = schedRows[0].id;
      // Only clear if it's currently "Req Off" (don't clear if manager changed it)
      const result = await pool.query(
        `UPDATE shifts SET shift_text = ''
          WHERE schedule_id = $1 AND employee_id = $2 AND day_index = $3
            AND shift_text = 'Req Off'`,
        [scheduleId, tor.employee_id, dayIndex]
      );
      cleared += result.rowCount;
    }
  }

  await audit(user, 'time_off_reset', tor.club_id, null, {
    employee_id: tor.employee_id, employee_name: tor.employee_name,
    start_date: tor.start_date instanceof Date ? tor.start_date.toISOString().slice(0, 10) : tor.start_date,
    end_date: tor.end_date instanceof Date ? tor.end_date.toISOString().slice(0, 10) : tor.end_date,
    was_approved: wasApproved, cells_cleared: cleared,
  });
  res.json({ ok: true, cells_cleared: cleared });
}));

// Bulk reset all approved requests back to pending (owner-only helper)
app.post('/api/time-off/reset-all-approved', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  const { rows } = await pool.query(
    `SELECT id FROM time_off_requests WHERE status = 'approved'`
  );
  let totalCleared = 0;
  for (const r of rows) {
    const { rows: torRows } = await pool.query(
      `SELECT t.*, e.name AS employee_name FROM time_off_requests t
       JOIN employees e ON e.id = t.employee_id WHERE t.id = $1`, [r.id]);
    const tor = torRows[0];
    if (!tor) continue;
    await pool.query(
      `UPDATE time_off_requests SET status = 'pending', resolved_by = NULL, resolved_at = NULL WHERE id = $1`,
      [r.id]
    );
    const start = new Date(toDateStr(tor.start_date) + 'T00:00:00Z');
    const end = new Date(toDateStr(tor.end_date) + 'T00:00:00Z');
    for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
      const weekStart = mondayOf(d.toISOString().slice(0, 10));
      const dayOfWeek = d.getUTCDay();
      const dayIndex = dayOfWeek === 0 ? 6 : dayOfWeek - 1;
      const { rows: schedRows } = await pool.query(
        'SELECT id FROM schedules WHERE club_id = $1 AND week_start = $2',
        [tor.club_id, weekStart]
      );
      if (!schedRows[0]) continue;
      const result = await pool.query(
        `UPDATE shifts SET shift_text = ''
          WHERE schedule_id = $1 AND employee_id = $2 AND day_index = $3
            AND shift_text = 'Req Off'`,
        [schedRows[0].id, tor.employee_id, dayIndex]
      );
      totalCleared += result.rowCount;
    }
  }
  await audit(user, 'time_off_reset_all', null, null, {
    count: rows.length, cells_cleared: totalCleared,
  });
  res.json({ ok: true, reset_count: rows.length, cells_cleared: totalCleared });
}));

// Edit a time off request
app.patch('/api/time-off/:id', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const reqId = Number(req.params.id);
  const { start_date, end_date, note, is_pto } = req.body || {};
  const sets = [];
  const vals = [];
  if (start_date !== undefined) { vals.push(start_date); sets.push(`start_date = $${vals.length}`); }
  if (end_date !== undefined) { vals.push(end_date); sets.push(`end_date = $${vals.length}`); }
  if (note !== undefined) { vals.push(note); sets.push(`note = $${vals.length}`); }
  if (is_pto !== undefined) { vals.push(!!is_pto); sets.push(`is_pto = $${vals.length}`); }
  if (!sets.length) return res.json({ ok: true });
  vals.push(reqId);
  await pool.query(`UPDATE time_off_requests SET ${sets.join(', ')} WHERE id = $${vals.length}`, vals);
  res.json({ ok: true });
}));

// Delete a time off request
app.delete('/api/time-off/:id', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  await pool.query('DELETE FROM time_off_requests WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ---------- shift change requests ----------
const SLACK_WEBHOOK_URL = process.env.SLACK_WEBHOOK_URL || '';

// Submit a shift change request (no auth — staff use this)
app.post('/api/shift-requests', ah(async (req, res) => {
  const { employee_id, request_text, kind, swap_data } = req.body || {};
  if (!employee_id || !request_text) {
    return res.status(400).json({ error: 'employee_id and request_text required' });
  }
  const { rows: empRows } = await pool.query(
    'SELECT e.id, e.name, e.club_id, c.name AS club_name FROM employees e JOIN clubs c ON c.id = e.club_id WHERE e.id = $1',
    [employee_id]
  );
  if (!empRows[0]) return res.status(404).json({ error: 'employee not found' });
  const emp = empRows[0];

  const validKind = ['swap', 'coverage', 'other'].includes(kind) ? kind : 'other';
  // Only store structured swap data when the kind is 'swap' and fields are well-formed
  let cleanSwapData = null;
  if (validKind === 'swap' && swap_data && typeof swap_data === 'object') {
    const swapWithId = Number(swap_data.swap_with_employee_id);
    const dates = Array.isArray(swap_data.dates) ? swap_data.dates.filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)) : [];
    if (swapWithId && dates.length) {
      cleanSwapData = { swap_with_employee_id: swapWithId, dates };
    }
  }

  const { rows } = await pool.query(
    `INSERT INTO shift_change_requests (employee_id, club_id, request_text, kind, swap_data) VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [employee_id, emp.club_id, request_text, validKind, cleanSwapData ? JSON.stringify(cleanSwapData) : null]
  );

  // Email notification to owners
  if (EMAIL_ENABLED) {
    const subject = `Shift Change Request — ${emp.name} (${emp.club_name})`;
    const html = `
      <h2 style="margin:0 0 8px;color:#1a2233;">Shift Change Request</h2>
      <p><strong>${emp.name}</strong> (${emp.club_name}) is requesting a shift change:</p>
      <p style="padding:12px;background:#f0f4fa;border-radius:6px;margin:12px 0;">${request_text.replace(/\n/g, '<br>')}</p>
      <p><a href="https://schedule.fbcnefl.com" style="display:inline-block;padding:10px 20px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">View Schedule</a></p>
    `;
    try {
      await smtpTransport.sendMail({
        from: EMAIL_FROM,
        to: NOTIFY_EMAILS.join(', '),
        subject,
        html,
      });
    } catch (err) {
      console.error('[shift-request] email failed:', err.message);
    }
  }

  // Slack webhook notification
  if (SLACK_WEBHOOK_URL) {
    try {
      const fetch = globalThis.fetch || require('node-fetch');
      await fetch(SLACK_WEBHOOK_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text: `📋 *Shift Change Request*\n*${emp.name}* (${emp.club_name}):\n> ${request_text}`,
        }),
      });
    } catch (err) {
      console.error('[shift-request] slack webhook failed:', err.message);
    }
  }

  res.json({ ok: true, id: rows[0].id });
}));

// List shift change requests (auth required)
app.get('/api/shift-requests', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const { rows } = await pool.query(
    `SELECT r.id, r.employee_id, r.club_id, r.request_text, r.status, r.kind, r.swap_data,
            r.created_at, r.resolved_at, r.executed_at,
            e.name AS employee_name, c.name AS club_name,
            sw.name AS swap_with_name
       FROM shift_change_requests r
       JOIN employees e ON e.id = r.employee_id
       JOIN clubs c ON c.id = r.club_id
       LEFT JOIN employees sw ON sw.id = (r.swap_data->>'swap_with_employee_id')::int
      ORDER BY r.status = 'pending' DESC, r.created_at DESC
      LIMIT 100`
  );
  res.json(rows);
}));

// Helper: compute Monday (week_start, YYYY-MM-DD) and 0-6 day_index for a given ISO date
function mondayAndDayIndex(isoDate) {
  const d = new Date(isoDate + 'T00:00:00Z');
  // getUTCDay: 0=Sun, 1=Mon ... 6=Sat — remap so Monday=0
  const jsDay = d.getUTCDay();
  const dayIndex = (jsDay + 6) % 7;
  const monday = new Date(d);
  monday.setUTCDate(monday.getUTCDate() - dayIndex);
  const yyyy = monday.getUTCFullYear();
  const mm = String(monday.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(monday.getUTCDate()).padStart(2, '0');
  return { weekStart: `${yyyy}-${mm}-${dd}`, dayIndex };
}

// Execute a shift swap: for each date, exchange shift_text between the two employees
async function executeShiftSwap(request, approver) {
  const { employee_id, swap_data } = request;
  const swapWithId = swap_data.swap_with_employee_id;
  const dates = swap_data.dates || [];
  const swappedCells = [];

  for (const isoDate of dates) {
    const { weekStart, dayIndex } = mondayAndDayIndex(isoDate);

    // Employee A (requester) and B (swap partner) may live in different clubs,
    // so each has their own `schedules` row for the same week.
    const { rows: empA } = await pool.query('SELECT club_id FROM employees WHERE id = $1', [employee_id]);
    const { rows: empB } = await pool.query('SELECT club_id FROM employees WHERE id = $1', [swapWithId]);
    if (!empA[0] || !empB[0]) continue;

    async function scheduleIdFor(clubId) {
      const { rows: sRows } = await pool.query(
        'SELECT id FROM schedules WHERE club_id = $1 AND week_start = $2',
        [clubId, weekStart]
      );
      if (sRows[0]) return sRows[0].id;
      const { rows: ins } = await pool.query(
        'INSERT INTO schedules (club_id, week_start) VALUES ($1, $2) RETURNING id',
        [clubId, weekStart]
      );
      return ins[0].id;
    }

    const schedA = await scheduleIdFor(empA[0].club_id);
    const schedB = await scheduleIdFor(empB[0].club_id);

    async function getShift(schedId, empId) {
      const { rows } = await pool.query(
        'SELECT shift_text FROM shifts WHERE schedule_id = $1 AND employee_id = $2 AND day_index = $3',
        [schedId, empId, dayIndex]
      );
      return rows[0] ? rows[0].shift_text : '';
    }

    const shiftA = await getShift(schedA, employee_id);
    const shiftB = await getShift(schedB, swapWithId);

    async function setShift(schedId, empId, text) {
      await pool.query(
        `INSERT INTO shifts (schedule_id, employee_id, day_index, shift_text)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (schedule_id, employee_id, day_index)
         DO UPDATE SET shift_text = EXCLUDED.shift_text`,
        [schedId, empId, dayIndex, text]
      );
    }

    await setShift(schedA, employee_id, shiftB);
    await setShift(schedB, swapWithId, shiftA);
    await pool.query('UPDATE schedules SET updated_at = NOW() WHERE id IN ($1, $2)', [schedA, schedB]);

    swappedCells.push({ date: isoDate, dayIndex, weekStart, shiftA, shiftB });
  }

  return swappedCells;
}

// Approve/deny a shift change request
app.post('/api/shift-requests/:id/resolve', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const { status } = req.body || {};
  if (!['approved', 'denied'].includes(status)) return res.status(400).json({ error: 'status must be approved or denied' });
  const requestId = Number(req.params.id);

  // Fetch the request to see if we should auto-execute a swap
  const { rows: reqRows } = await pool.query(
    'SELECT id, employee_id, kind, swap_data, status FROM shift_change_requests WHERE id = $1',
    [requestId]
  );
  if (!reqRows[0]) return res.status(404).json({ error: 'not found' });
  const request = reqRows[0];

  let swapped = null;
  if (status === 'approved' && request.kind === 'swap' && request.swap_data && request.status !== 'approved') {
    try {
      swapped = await executeShiftSwap(request, user);
    } catch (err) {
      console.error('[shift-request] auto-swap failed:', err.message);
      return res.status(500).json({ error: 'Auto-swap failed: ' + err.message });
    }
  }

  await pool.query(
    `UPDATE shift_change_requests
        SET status = $1, resolved_by = $2, resolved_at = NOW(),
            executed_at = CASE WHEN $3::boolean THEN NOW() ELSE executed_at END
      WHERE id = $4`,
    [status, user.id, !!swapped, requestId]
  );

  res.json({ ok: true, swapped: swapped ? swapped.length : 0 });
}));

// Delete a shift change request
app.delete('/api/shift-requests/:id', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  await pool.query('DELETE FROM shift_change_requests WHERE id = $1', [Number(req.params.id)]);
  res.json({ ok: true });
}));

// ---------- AI schedule parsing ----------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

app.post('/api/parse-schedule', parseLimiter, scheduleUpload.single('image'), ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
  if (!req.file) return res.status(400).json({ error: 'image or PDF required' });

  // Get all clubs and their employees
  const { rows: clubs } = await pool.query('SELECT id, name FROM clubs ORDER BY name');
  const clubData = {};
  for (const club of clubs) {
    const { rows: emps } = await pool.query(
      'SELECT name, team FROM employees WHERE club_id = $1 AND archived = FALSE ORDER BY sort_order, id',
      [club.id]
    );
    clubData[club.name] = { id: club.id, employees: emps.map(e => e.name) };
  }

  const mediaType = req.file.mimetype === 'application/pdf' ? 'application/pdf'
    : req.file.mimetype.startsWith('image/') ? req.file.mimetype : 'image/jpeg';
  const sourceType = req.file.mimetype === 'application/pdf' ? 'document' : 'image';
  const base64 = req.file.buffer.toString('base64');

  const clubList = Object.entries(clubData).map(([name, d]) =>
    `"${name}": employees = ${JSON.stringify(d.employees)}`
  ).join('\n');

  const Anthropic = require('@anthropic-ai/sdk');
  const client = new Anthropic({ apiKey: ANTHROPIC_API_KEY });

  try {
    const message = await client.messages.create({
      model: 'claude-sonnet-4-5',
      max_tokens: 8192,
      messages: [{
        role: 'user',
        content: [
          {
            type: sourceType,
            source: { type: 'base64', media_type: mediaType, data: base64 },
          },
          {
            type: 'text',
            text: `Extract the weekly schedule grid(s) from this file. There are seven day columns: Monday, Tuesday, Wednesday, Thursday, Friday, Saturday, Sunday (in that order).

Known clubs and their employees:
${clubList}

Return ONLY valid JSON (no markdown, no backticks, no explanation) in this exact format:
{
  "clubs": {
    "Club Name": {
      "Employee Name": ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"],
      ...
    }
  }
}

CRITICAL — COLUMN ALIGNMENT:
The number one mistake to avoid: do NOT left-pack shifts. Each cell's position on the page determines which day it is. If a row has 5 visible shift values but one of them is in the Friday column and two are in Sunday, you must still return an array of 7 with empty strings in the right places.

Use the horizontal position of each shift under its column header to decide which index it goes into. The DATE header row (e.g. "Monday, April 27, 2026" in column 1, "Tuesday, April 28, 2026" in column 2, etc.) is the ground truth for column position.

Example — if a row looks like this on the page:

    MON         TUE         WED         THU         FRI         SAT         SUN
    East        East                                East        East        East

Then the array MUST be: ["East","East","","","East","East","East"]
NOT: ["East","East","East","East","","",""]
NOT: ["East","","East","","East","East","East"]

The two middle columns (Wed, Thu) have no text drawn there — they must be empty strings at indices 2 and 3.

Other rules:
- Each employee array MUST have EXACTLY 7 values (index 0=Mon ... 6=Sun). Double-check the length before you write it.
- Empty/blank cell = "" (empty string). Dashes like "—" or "-" also mean empty; return "".
- Copy shift text EXACTLY as shown, including partial-day notes: "West - 3:30 PM", "Beach - 330 PM", "Camachee - 3 30 PM", "Beach - 1", "East - 3:30 PM", "Camachee 12 - Close", "Camachee 10 - Close", "Shipyard", "Req Off".
- Include EVERY employee row you see, even rows where all 7 cells are empty (return ["","","","","","",""]).
- Match employee names to the known lists above. If a name in the file isn't in any list, use the name exactly as shown.
- The file may have multiple tables per page (e.g. a Jacksonville section that contains both "Julington Creek" and "Jacksonville Beach" sub-tables, and a separate "St. Augustine" section). Merge all Jacksonville employees under "Jacksonville" and all St. Augustine employees under "St. Augustine".
- Ignore "Total Persons …" and "Notes" rows — those are summary rows, not employees.
- Ignore rows that contain only the date header.

Before finishing, silently verify each array has length 7 and that the shift positions match what's visually under each day column. Then output ONLY the JSON.`,
          },
        ],
      }],
    });

    const text = message.content[0].text.trim();
    let parsed;
    try {
      const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '');
      parsed = JSON.parse(cleaned);
    } catch (parseErr) {
      console.error('[parse-schedule] AI response was not valid JSON:', text.slice(0, 500));
      return res.status(422).json({ error: 'Could not parse AI response', raw: text.slice(0, 2000) });
    }

    // Normalize: ensure every employee array has exactly 7 entries
    const warnings = [];
    for (const [clubName, shifts] of Object.entries(parsed.clubs || {})) {
      for (const [emp, arr] of Object.entries(shifts)) {
        if (!Array.isArray(arr)) {
          shifts[emp] = ['', '', '', '', '', '', ''];
          warnings.push(`${clubName}/${emp}: non-array, defaulted to 7 empties`);
          continue;
        }
        if (arr.length !== 7) {
          warnings.push(`${clubName}/${emp}: length ${arr.length}, padded/trimmed to 7`);
          while (arr.length < 7) arr.push('');
          if (arr.length > 7) arr.length = 7;
        }
        // Normalize dashes/null to ""
        for (let i = 0; i < 7; i++) {
          const v = arr[i];
          if (v == null || v === '—' || v === '-' || v === '–') arr[i] = '';
          else if (typeof v === 'string') arr[i] = v.trim();
        }
      }
    }

    // Attach club IDs for the frontend
    const result = { ok: true, clubs: {}, warnings };
    for (const [clubName, shifts] of Object.entries(parsed.clubs || {})) {
      const cd = clubData[clubName];
      result.clubs[clubName] = { club_id: cd ? cd.id : null, shifts };
    }
    res.json(result);
  } catch (aiErr) {
    console.error('[parse-schedule] AI error:', aiErr.message);
    res.status(500).json({ error: 'AI parsing failed: ' + aiErr.message });
  }
}));

// ---------- password reset ----------
// #6: Rate-limited reset with static token (for admin emergency use)
const resetLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 5, message: { error: 'Too many reset attempts.' } });
app.get('/api/reset-password', resetLimiter, ah(async (req, res) => {
  const { email, new_password, token } = req.query;
  const validToken = process.env.RESET_TOKEN || process.env.SESSION_SECRET || '';
  if (!token || !validToken || token !== validToken) {
    return res.status(403).json({ error: 'invalid token' });
  }
  if (!email || !new_password) {
    return res.status(400).json({ error: 'email and new_password required as query params' });
  }
  if (new_password.length < 4) {
    return res.status(400).json({ error: 'password must be at least 4 characters' });
  }
  const normalized = email.toLowerCase().trim();
  const hash = await bcrypt.hash(new_password, 10);
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [normalized]);
  if (rows[0]) {
    await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, rows[0].id]);
    console.log(`[security] password reset for ${normalized} from IP ${req.ip}`);
    return res.json({ ok: true, message: `Password reset for ${normalized}` });
  }
  return res.status(404).json({ error: 'user not found' });
}));

// #7: Forgot password via email — generates a 1-hour token
const passwordResetTokens = new Map(); // email → { token, expires }
app.post('/api/forgot-password', resetLimiter, ah(async (req, res) => {
  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'email required' });
  const normalized = email.toLowerCase().trim();
  const { rows } = await pool.query('SELECT id FROM users WHERE email = $1', [normalized]);
  // Always return ok to avoid email enumeration
  if (!rows[0]) return res.json({ ok: true });
  const token = crypto.randomBytes(32).toString('hex');
  passwordResetTokens.set(normalized, { token, expires: Date.now() + 60 * 60 * 1000 });
  // Send email with reset link
  if (EMAIL_ENABLED && smtpTransport) {
    const resetUrl = `https://schedule.fbcnefl.com/api/reset-with-token?email=${encodeURIComponent(normalized)}&token=${token}`;
    try {
      await smtpTransport.sendMail({
        from: EMAIL_FROM,
        to: normalized,
        subject: 'FBC Schedule — Password Reset',
        html: `<h2>Password Reset</h2><p>Click the link below to reset your password. This link expires in 1 hour.</p><p><a href="${resetUrl}" style="display:inline-block;padding:12px 24px;background:#2563eb;color:#fff;border-radius:6px;text-decoration:none;font-weight:600;">Reset Password</a></p><p style="color:#888;font-size:12px;">If you didn't request this, ignore this email.</p>`,
      });
    } catch (err) {
      console.error('[forgot-password] email failed:', err.message);
    }
  }
  console.log(`[security] forgot-password requested for ${normalized} from IP ${req.ip}`);
  res.json({ ok: true });
}));

// Token-based reset (from email link)
app.get('/api/reset-with-token', ah(async (req, res) => {
  const { email, token } = req.query;
  if (!email || !token) return res.status(400).send('Invalid link.');
  const normalized = email.toLowerCase().trim();
  const stored = passwordResetTokens.get(normalized);
  if (!stored || stored.token !== token || Date.now() > stored.expires) {
    return res.status(400).send('This reset link has expired or is invalid.');
  }
  // Show a simple HTML form to set new password
  res.send(`<!doctype html><html><head><title>Reset Password</title><style>body{font-family:sans-serif;max-width:400px;margin:60px auto;padding:20px;}input{width:100%;padding:10px;margin:8px 0;font-size:16px;border:1px solid #ccc;border-radius:6px;}button{padding:12px;width:100%;font-size:16px;background:#2563eb;color:#fff;border:none;border-radius:6px;cursor:pointer;}</style></head><body><h2>Set New Password</h2><form method="POST" action="/api/reset-with-token"><input type="hidden" name="email" value="${normalized}"><input type="hidden" name="token" value="${token}"><input type="password" name="new_password" placeholder="New password (min 4 chars)" required minlength="4"><button type="submit">Reset Password</button></form></body></html>`);
}));

app.post('/api/reset-with-token', express.urlencoded({ extended: false }), ah(async (req, res) => {
  const { email, token, new_password } = req.body || {};
  if (!email || !token || !new_password) return res.status(400).send('Missing fields.');
  const normalized = email.toLowerCase().trim();
  const stored = passwordResetTokens.get(normalized);
  if (!stored || stored.token !== token || Date.now() > stored.expires) {
    return res.status(400).send('This reset link has expired.');
  }
  if (new_password.length < 4) return res.status(400).send('Password must be at least 4 characters.');
  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE email = $2', [hash, normalized]);
  passwordResetTokens.delete(normalized);
  console.log(`[security] password reset via token for ${normalized} from IP ${req.ip}`);
  res.send('<!doctype html><html><body style="font-family:sans-serif;text-align:center;padding:60px;"><h2>Password Reset</h2><p>Your password has been updated. <a href="/">Go to schedule</a></p></body></html>');
}));

// ---------- advisory banner ----------
app.get('/api/advisory', ah(async (req, res) => {
  const { rows } = await pool.query("SELECT value FROM app_state WHERE key = 'advisory'");
  res.json({ text: rows[0] ? rows[0].value : '' });
}));

app.put('/api/advisory', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  const { text } = req.body || {};
  const value = (text || '').slice(0, 500);
  await pool.query(
    `INSERT INTO app_state (key, value) VALUES ('advisory', $1)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
    [value]
  );
  res.json({ ok: true, text: value });
}));

// ---------- pending tasks ----------
app.get('/api/tasks', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const { rows: timeOff } = await pool.query(
    `SELECT t.id, e.name AS employee_name, t.start_date, t.end_date
       FROM time_off_requests t JOIN employees e ON e.id = t.employee_id
      WHERE t.status = 'pending' ORDER BY t.start_date ASC`
  );
  const { rows: shiftReqs } = await pool.query(
    `SELECT r.id, e.name AS employee_name, r.request_text, r.created_at
       FROM shift_change_requests r JOIN employees e ON e.id = r.employee_id
      WHERE r.status = 'pending' ORDER BY r.created_at DESC`
  );
  res.json({
    time_off: timeOff.map(r => ({
      ...r,
      start_date: toDateStr(r.start_date),
      end_date: toDateStr(r.end_date),
    })),
    shift_requests: shiftReqs,
    total: timeOff.length + shiftReqs.length,
  });
}));

// ---------- health ----------
// ---------- export / backup ----------
// Full JSON backup of all data (owner-only)
app.get('/api/export/backup', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  const { rows: clubs } = await pool.query('SELECT id, name FROM clubs ORDER BY name');
  const { rows: employees } = await pool.query('SELECT id, club_id, name, team, archived, sort_order FROM employees ORDER BY club_id, sort_order');
  const { rows: schedules } = await pool.query('SELECT id, club_id, week_start, status, notes, updated_at FROM schedules ORDER BY week_start DESC');
  const { rows: shifts } = await pool.query('SELECT schedule_id, employee_id, day_index, shift_text FROM shifts');
  const { rows: totals } = await pool.query('SELECT schedule_id, location, day_index, count_text FROM location_totals');
  const { rows: users } = await pool.query('SELECT id, email, role, club_id, team, name FROM users ORDER BY role, email');
  res.setHeader('Content-Disposition', `attachment; filename="fbc-schedule-backup-${new Date().toISOString().slice(0,10)}.json"`);
  res.json({ exported_at: new Date().toISOString(), clubs, employees, schedules, shifts, totals, users });
}));

// PDF export of both clubs' schedules for a given week — one page
const PDFDocument = require('pdfkit');
app.get('/api/export/pdf', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!user) return res.status(401).json({ error: 'sign in required' });
  const weekStart = req.query.week;
  if (!weekStart) return res.status(400).json({ error: 'week required' });

  const { rows: clubs } = await pool.query('SELECT id, name FROM clubs ORDER BY name');
  const days = ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'];
  const dayHeaders = days.map((d, i) => {
    const dt = new Date(weekStart + 'T00:00:00'); dt.setDate(dt.getDate() + i);
    return `${d} ${dt.getMonth()+1}/${dt.getDate()}`;
  });

  // Pre-count total employees to calculate row height that fits one page
  let totalEmps = 0;
  let totalSections = 0; // clubs (not teams — Jacksonville is one section)
  let totalTeamDividers = 0;
  const clubEmps = [];
  for (const club of clubs) {
    const { rows: emps } = await pool.query(
      'SELECT id, name, team FROM employees WHERE club_id = $1 AND archived = FALSE ORDER BY sort_order, id', [club.id]);
    clubEmps.push({ club, emps });
    totalEmps += emps.length;
    totalSections++;
    const teams = new Set(emps.map(e => e.team || ''));
    if (teams.size > 1) totalTeamDividers += teams.size - 1; // dividers between teams
  }

  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 20 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="FBC-Schedule-${weekStart}.pdf"`);
  doc.pipe(res);

  // Title at top
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#0a1628')
    .text('Freedom Boat Club NEFL — Schedule', { align: 'center' });
  doc.fontSize(8).font('Helvetica').fillColor('#3a4a60')
    .text(`Week of ${weekStart}`, { align: 'center' });
  doc.moveDown(0.3);

  const startX = 20;
  const tableW = doc.page.width - 40;
  const nameColW = 110;
  const dayAreaW = tableW - nameColW;
  const dayColW = dayAreaW / 7;
  // Helper to get the x position of day column d (avoids rounding gaps)
  const dayX = (d) => startX + nameColW + Math.round(d * dayColW);
  const dayW = (d) => dayX(d + 1) - dayX(d);
  let y = doc.y;

  // Calculate row height to fit everything on one page
  const usableH = doc.page.height - 20 - y;
  // Each club: 14 (black header) + 12 (date row) + gap. Team dividers: 10 each.
  const sectionOverhead = 14 + 12 + 6;
  const totalOverhead = (totalSections * sectionOverhead) + (totalTeamDividers * 12);
  const rowH = Math.min(14, Math.max(9, Math.floor((usableH - totalOverhead) / totalEmps)));
  const fontSize = rowH <= 10 ? 5.5 : rowH <= 12 ? 6 : 6.5;

  for (let ci = 0; ci < clubEmps.length; ci++) {
    const { club, emps } = clubEmps[ci];

    const { rows: schedRows } = await pool.query(
      'SELECT id FROM schedules WHERE club_id = $1 AND week_start = $2', [club.id, weekStart]);
    const scheduleId = schedRows[0] ? schedRows[0].id : null;
    let shiftMap = {};
    if (scheduleId) {
      const { rows: shifts } = await pool.query(
        'SELECT employee_id, day_index, shift_text FROM shifts WHERE schedule_id = $1', [scheduleId]);
      for (const s of shifts) {
        shiftMap[s.employee_id] = shiftMap[s.employee_id] || {};
        shiftMap[s.employee_id][s.day_index] = s.shift_text;
      }
    }

    // Group by team
    const groups = new Map();
    for (const e of emps) {
      const key = e.team || '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(e);
    }
    const order = ['Julington Creek', 'Jacksonville Beach'];
    const sortedKeys = Array.from(groups.keys()).sort((a, b) => {
      const ai = order.indexOf(a); const bi = order.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
    const multiTeam = sortedKeys.length > 1;

    // Club header — black bar
    doc.rect(startX, y, tableW, 14).fill('#000000');
    doc.fontSize(8).font('Helvetica-Bold').fillColor('#ffffff')
      .text(club.name.toUpperCase(), startX + 6, y + 3, { width: tableW - 12 });
    y += 14;

    // Date header row
    const headerH = 12;
    doc.rect(startX, y, nameColW, headerH).fill('#1a3a6e');
    doc.fontSize(fontSize).font('Helvetica-Bold').fillColor('#ffffff')
      .text('EMPLOYEE', startX + 4, y + 2, { width: nameColW - 8 });
    for (let d = 0; d < 7; d++) {
      const x = dayX(d);
      const w = dayW(d);
      doc.rect(x, y, w, headerH).fill('#1a3a6e');
      doc.fillColor('#ffffff').fontSize(fontSize).text(dayHeaders[d], x + 2, y + 2, { width: w - 4, align: 'center' });
    }
    doc.lineWidth(0.5).strokeColor('#333');
    doc.moveTo(startX, y + headerH).lineTo(startX + tableW, y + headerH).stroke();
    y += headerH;

    let rowIdx = 0;
    for (let ti = 0; ti < sortedKeys.length; ti++) {
      const teamName = sortedKeys[ti];

      // Team divider for multi-team clubs (thick black border + label)
      if (multiTeam && ti > 0) {
        doc.lineWidth(2.5).strokeColor('#000000');
        doc.moveTo(startX, y).lineTo(startX + tableW, y).stroke();
      }
      if (multiTeam && teamName) {
        doc.rect(startX, y, tableW, 10).fill('#2a2a2a');
        doc.fontSize(5.5).font('Helvetica-Bold').fillColor('#ffffff')
          .text(teamName.toUpperCase(), startX + 4, y + 2);
        y += 10;
      }

      for (const emp of groups.get(teamName)) {
        const rowBg = rowIdx % 2 === 0 ? '#ffffff' : '#d0d3d9';

        doc.rect(startX, y, tableW, rowH).fill(rowBg);

        doc.rect(startX, y, nameColW, rowH).fill(rowIdx % 2 === 0 ? '#dce4f0' : '#c4d2e8');
        doc.fontSize(fontSize).font('Helvetica-Bold').fillColor('#000000')
          .text(emp.name, startX + 4, y + (rowH > 12 ? 3 : 2), { width: nameColW - 8 });

        for (let d = 0; d < 7; d++) {
          const x = dayX(d);
          const w = dayW(d);
          const val = (shiftMap[emp.id] && shiftMap[emp.id][d]) || '';
          if (val) {
            const lower = val.toLowerCase();
            if (lower.includes('req off')) doc.fillColor('#aa0000');
            else if (lower.includes('west') || lower.includes('shipyard')) doc.fillColor('#0033aa');
            else doc.fillColor('#000000');
            doc.fontSize(fontSize).font('Helvetica-Bold').text(val, x + 2, y + (rowH > 12 ? 3 : 2), { width: w - 4, align: 'center' });
          }
        }

        // Grid lines
        doc.lineWidth(0.5).strokeColor('#8898b0');
        doc.moveTo(startX, y + rowH).lineTo(startX + tableW, y + rowH).stroke();
        doc.lineWidth(0.3).strokeColor('#a0aec0');
        doc.moveTo(startX, y).lineTo(startX, y + rowH).stroke();
        doc.moveTo(startX + nameColW, y).lineTo(startX + nameColW, y + rowH).stroke();
        for (let d = 1; d <= 7; d++) {
          doc.moveTo(dayX(d), y).lineTo(dayX(d), y + rowH).stroke();
        }

        y += rowH;
        rowIdx++;
      }

      y += 4; // gap between location sections
    }
  }

  doc.end();
}));

app.get('/api/health', ah(async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT NOW() AS now');
    res.json({ ok: true, db: true, time: rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
  }
}));

// Diagnostic: send a test email immediately (no 60s wait). Visit this URL
// in your browser while signed in as owner to verify SMTP is working.
app.get('/api/test-email', ah(async (req, res) => {
  const user = await loadUser(req);
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
  if (!EMAIL_ENABLED) {
    return res.json({
      ok: false,
      error: 'Email not enabled',
      detail: {
        SMTP_USER: SMTP_USER ? '(set)' : '(missing)',
        SMTP_PASS: SMTP_PASS ? '(set)' : '(missing)',
        NOTIFY_EMAILS: NOTIFY_EMAILS.length ? NOTIFY_EMAILS : '(empty)',
        EMAIL_FROM: EMAIL_FROM || '(missing)',
      },
    });
  }
  try {
    const info = await smtpTransport.sendMail({
      from: EMAIL_FROM,
      to: NOTIFY_EMAILS.join(', '),
      subject: 'FBC Schedule — Test Email',
      html: '<h2>Test email from FBC Schedule Dashboard</h2><p>If you see this, email notifications are working.</p><p><a href="https://schedule.fbcnefl.com">Open Dashboard</a></p>',
    });
    res.json({ ok: true, messageId: info.messageId, accepted: info.accepted, rejected: info.rejected });
  } catch (e) {
    res.json({ ok: false, error: e.message, code: e.code || null });
  }
}));

// ---------- SPA fallback ----------
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ---------- JSON error handler ----------
app.use((err, req, res, next) => {
  console.error('[server] unhandled error', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: (err && err.message) || 'internal server error' });
});

// #3: Automated daily backup — store JSON snapshot in app_state
async function runBackup() {
  try {
    const { rows: clubs } = await pool.query('SELECT id, name FROM clubs ORDER BY name');
    const { rows: employees } = await pool.query('SELECT id, club_id, name, team, archived, sort_order FROM employees ORDER BY club_id, sort_order');
    const { rows: schedules } = await pool.query('SELECT id, club_id, week_start, status, notes, updated_at FROM schedules ORDER BY week_start DESC LIMIT 20');
    const schedIds = schedules.map(s => s.id);
    const { rows: shifts } = schedIds.length
      ? await pool.query('SELECT schedule_id, employee_id, day_index, shift_text FROM shifts WHERE schedule_id = ANY($1)', [schedIds])
      : { rows: [] };
    const { rows: users } = await pool.query('SELECT id, email, role, club_id, team, name FROM users ORDER BY role, email');
    const backup = JSON.stringify({
      exported_at: new Date().toISOString(),
      clubs, employees, schedules, shifts, users,
    });
    await pool.query(
      `INSERT INTO app_state (key, value, updated_at) VALUES ('daily_backup', $1, NOW())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
      [backup]
    );
    console.log(`[backup] daily backup saved (${(backup.length / 1024).toFixed(1)} KB)`);
  } catch (err) {
    console.error('[backup] failed:', err.message);
  }
}
// Run backup on startup then every 24h
setTimeout(() => { runBackup(); setInterval(runBackup, 24 * 60 * 60 * 1000); }, 10000);

app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
