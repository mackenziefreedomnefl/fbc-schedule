/* eslint-disable no-console */
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const multer = require('multer');
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
app.use(express.json({ limit: '1mb' }));
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
function mondayOf(dateLike) {
  const d = new Date(dateLike + 'T00:00:00Z');
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
app.post('/api/login', ah(async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const { rows } = await pool.query(
    'SELECT id, email, password_hash, role, club_id, team, name FROM users WHERE email = $1',
    [String(email).toLowerCase().trim()]
  );
  const u = rows[0];
  if (!u) return res.status(401).json({ error: 'invalid email or password' });
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid email or password' });
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
  if (!isOwner(user)) return res.status(403).json({ error: 'owners only' });
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

// ---------- Slack connection (kept for future use) ----------
const _env = (k) => process.env[k] || '';
const SLACK_BOT_TOKEN = _env('SLACK_TOKEN');
const SLACK_CHANNEL_ID = _env('SLACK_CHANNEL');

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
            t.status, t.is_pto, t.created_at, t.resolved_at,
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
  const start = new Date(tor.start_date + 'T00:00:00Z');
  const end = new Date(tor.end_date + 'T00:00:00Z');
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
  const { rows } = await pool.query(
    `SELECT t.*, e.name AS employee_name FROM time_off_requests t
     JOIN employees e ON e.id = t.employee_id WHERE t.id = $1`, [reqId]);
  if (!rows[0]) return res.status(404).json({ error: 'request not found' });
  const tor = rows[0];
  await pool.query(
    `UPDATE time_off_requests SET status = 'denied', resolved_by = $1, resolved_at = NOW() WHERE id = $2`,
    [user.id, reqId]
  );
  await audit(user, 'time_off_denied', tor.club_id, null, {
    employee_id: tor.employee_id, employee_name: tor.employee_name,
    start_date: tor.start_date instanceof Date ? tor.start_date.toISOString().slice(0, 10) : tor.start_date,
    end_date: tor.end_date instanceof Date ? tor.end_date.toISOString().slice(0, 10) : tor.end_date,
  });
  res.json({ ok: true });
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

// ---------- AI schedule parsing ----------
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || '';

app.post('/api/parse-schedule', scheduleUpload.single('image'), ah(async (req, res) => {
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
      model: 'claude-sonnet-4-20250514',
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
            text: `Extract the weekly schedule data from this image/PDF. It may contain one or more club schedules.

Known clubs and their employees:
${clubList}

Return ONLY valid JSON (no markdown, no backticks) in this exact format:
{
  "clubs": {
    "Club Name": {
      "Employee Name": ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
      ...
    },
    ...
  }
}

Rules:
- Each employee array has exactly 7 values (Mon=index 0 through Sun=index 6)
- Use empty string "" for days with no assignment
- Use the exact shift text as shown (e.g. "East", "West", "Beach", "Camachee", "Shipyard", "Req Off", "12 - Close Camachee", "Open - 4 East", "Beach - 1", "Capt Training", "Noon - Close Camachee", "Shipyard - 1", etc.)
- Match employee names exactly to the known employee lists above
- If an employee in the image isn't in a known list, use their name as shown
- Only include clubs and employees that appear in the image`,
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

    // Attach club IDs for the frontend
    const result = { ok: true, clubs: {} };
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

// ---------- password reset / owner create (no auth required) ----------
// Visit /api/reset-password?email=you@email.com&new_password=newpass&token=SECRET
// Creates an owner account if one doesn't exist, otherwise resets the password.
// Token must match RESET_TOKEN env var (or SESSION_SECRET as fallback)
app.get('/api/reset-password', ah(async (req, res) => {
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
    await pool.query('UPDATE users SET password_hash = $1, role = \'owner\' WHERE id = $2', [hash, rows[0].id]);
    return res.json({ ok: true, message: `Password reset for ${normalized}`, action: 'updated' });
  }
  await pool.query(
    "INSERT INTO users (email, password_hash, role, name) VALUES ($1, $2, 'owner', $3)",
    [normalized, hash, normalized.split('@')[0]]
  );
  res.json({ ok: true, message: `Owner account created for ${normalized}`, action: 'created' });
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

  const doc = new PDFDocument({ size: 'LETTER', layout: 'landscape', margin: 20 });
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `attachment; filename="FBC-Schedule-${weekStart}.pdf"`);
  doc.pipe(res);

  // Title at top
  doc.fontSize(14).font('Helvetica-Bold').fillColor('#0a1628')
    .text('Freedom Boat Club NEFL — Schedule', { align: 'center' });
  doc.fontSize(9).font('Helvetica').fillColor('#3a4a60')
    .text(`Week of ${weekStart}`, { align: 'center' });
  doc.moveDown(0.4);

  const startX = 20;
  const tableW = doc.page.width - 40;
  const nameColW = 115;
  const dayColW = Math.floor((tableW - nameColW) / 7);
  let y = doc.y;

  for (let ci = 0; ci < clubs.length; ci++) {
    const club = clubs[ci];

    const { rows: emps } = await pool.query(
      'SELECT id, name, team FROM employees WHERE club_id = $1 AND archived = FALSE ORDER BY sort_order, id', [club.id]);
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

    // Club name bar — solid black background
    if (y > doc.page.height - 60) { doc.addPage(); y = 20; }
    doc.rect(startX, y, tableW, 18).fill('#000000');
    doc.fontSize(11).font('Helvetica-Bold').fillColor('#ffffff')
      .text(club.name.toUpperCase(), startX + 6, y + 4, { width: tableW - 12 });
    y += 18;

    // Column headers — dark blue, larger text
    const headerH = 16;
    doc.rect(startX, y, nameColW, headerH).fill('#1a3a6e');
    doc.fontSize(7).font('Helvetica-Bold').fillColor('#ffffff')
      .text('EMPLOYEE', startX + 4, y + 4, { width: nameColW - 8 });
    for (let d = 0; d < 7; d++) {
      const x = startX + nameColW + d * dayColW;
      doc.rect(x, y, dayColW, headerH).fill('#1a3a6e');
      doc.fillColor('#ffffff').fontSize(7).text(dayHeaders[d], x + 2, y + 4, { width: dayColW - 4, align: 'center' });
    }
    // Grid lines on header
    doc.lineWidth(0.75).strokeColor('#333333');
    doc.moveTo(startX, y + headerH).lineTo(startX + tableW, y + headerH).stroke();
    doc.moveTo(startX, y).lineTo(startX, y + headerH).stroke();
    doc.moveTo(startX + nameColW, y).lineTo(startX + nameColW, y + headerH).stroke();
    for (let d = 1; d <= 7; d++) {
      doc.moveTo(startX + nameColW + d * dayColW, y).lineTo(startX + nameColW + d * dayColW, y + headerH).stroke();
    }
    y += headerH;

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

    let rowIdx = 0;
    for (const teamName of sortedKeys) {
      // Team divider
      if (sortedKeys.length > 1 && teamName) {
        if (y > doc.page.height - 30) { doc.addPage(); y = 20; }
        doc.rect(startX, y, tableW, 12).fill('#d0d8e8').stroke('#9aa8c0');
        doc.fontSize(6).font('Helvetica-Bold').fillColor('#2a3a55')
          .text(teamName.toUpperCase(), startX + 4, y + 2);
        y += 12;
      }

      for (const emp of groups.get(teamName)) {
        if (y > doc.page.height - 30) { doc.addPage(); y = 20; }
        const rowH = 16;
        const rowBg = rowIdx % 2 === 0 ? '#ffffff' : '#e8edf6';

        // Fill entire row background first
        doc.rect(startX, y, tableW, rowH).fill(rowBg);

        // Name cell — darker background to stand out
        doc.rect(startX, y, nameColW, rowH).fill(rowIdx % 2 === 0 ? '#dce4f0' : '#c4d2e8');
        doc.fontSize(7).font('Helvetica-Bold').fillColor('#000000')
          .text(emp.name, startX + 6, y + 4, { width: nameColW - 12 });

        // Day cells text
        for (let d = 0; d < 7; d++) {
          const x = startX + nameColW + d * dayColW;
          const val = (shiftMap[emp.id] && shiftMap[emp.id][d]) || '';
          if (val) {
            const lower = val.toLowerCase();
            if (lower.includes('req off')) doc.fillColor('#aa0000');
            else if (lower.includes('west') || lower.includes('shipyard')) doc.fillColor('#0033aa');
            else doc.fillColor('#000000');
            doc.fontSize(7).font('Helvetica-Bold').text(val, x + 3, y + 4, { width: dayColW - 6, align: 'center' });
          }
        }

        // Draw grid lines — softer color for less congestion
        doc.lineWidth(0.5).strokeColor('#8898b0');
        // Horizontal line at bottom of row
        doc.moveTo(startX, y + rowH).lineTo(startX + tableW, y + rowH).stroke();
        // Vertical lines for each column
        doc.lineWidth(0.3).strokeColor('#a0aec0');
        doc.moveTo(startX, y).lineTo(startX, y + rowH).stroke();
        doc.moveTo(startX + nameColW, y).lineTo(startX + nameColW, y + rowH).stroke();
        for (let d = 1; d <= 7; d++) {
          const x = startX + nameColW + d * dayColW;
          doc.moveTo(x, y).lineTo(x, y + rowH).stroke();
        }

        y += rowH;
        rowIdx++;
      }
    }

    y += 8; // gap between clubs
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

app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
