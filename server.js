/* eslint-disable no-console */
const path = require('path');
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { Pool } = require('pg');
const PgSession = require('connect-pg-simple')(session);
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

const PORT = process.env.PORT || 3000;

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

// Whether a user can edit a single employee's row (cells, name, team, archive).
function canEditEmployee(user, employee) {
  if (!user || !employee) return false;
  if (isOwner(user)) return true;
  if (user.role !== 'manager') return false;
  if (Number(user.club_id) !== Number(employee.club_id)) return false;
  if (user.team) return (employee.team || '') === user.team;
  return true;
}

// Whether a user can add an employee to (clubId, team).
function canEditTeam(user, clubId, team) {
  if (!user) return false;
  if (isOwner(user)) return true;
  if (user.role !== 'manager') return false;
  if (Number(user.club_id) !== Number(clubId)) return false;
  if (user.team) return team === user.team;
  return true;
}

// Whether a user can edit anything inside a club (e.g. notes shared per
// schedule). Owners always; managers if their club matches.
function canEditClub(user, clubId) {
  if (!user) return false;
  if (isOwner(user)) return true;
  if (user.role !== 'manager') return false;
  return Number(user.club_id) === Number(clubId);
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
  const { password, role, club_id, team, name } = req.body || {};
  const sets = [];
  const vals = [];
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
  const { rows } = await pool.query(
    `SELECT a.id, a.user_id, a.user_label, a.action, a.club_id, a.team, a.details, a.created_at,
            c.name AS club_name
       FROM audit_log a
       LEFT JOIN clubs c ON c.id = a.club_id
      WHERE a.created_at >= NOW() - INTERVAL '30 days'
      ORDER BY a.created_at DESC
      LIMIT 500`
  );
  res.json(rows);
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

  // Most recent edit to this club (any action) — powers the Last updated marker.
  // Scoped to schedule-related actions so user/admin events don't show up.
  const { rows: lastRows } = await pool.query(
    `SELECT user_label, action, details, created_at
       FROM audit_log
      WHERE club_id = $1
        AND action IN ('cell_edit','notes_edit','total_edit','employee_add','employee_update','employee_archive')
      ORDER BY created_at DESC
      LIMIT 1`,
    [clubId]
  );
  const lastUpdate = lastRows[0] ? {
    user_label: lastRows[0].user_label,
    action: lastRows[0].action,
    details: lastRows[0].details,
    created_at: lastRows[0].created_at,
  } : null;

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
    last_update: lastUpdate,
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

// ---------- health ----------
app.get('/api/health', ah(async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT NOW() AS now');
    res.json({ ok: true, db: true, time: rows[0].now });
  } catch (e) {
    res.status(500).json({ ok: false, db: false, error: e.message });
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
