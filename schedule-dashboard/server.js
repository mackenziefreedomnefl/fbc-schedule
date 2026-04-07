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
app.use(express.static(path.join(__dirname, 'public')));

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
function requireAuth(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'not authenticated' });
  next();
}
function requireAdmin(req, res, next) {
  if (!req.session.userId) return res.status(401).json({ error: 'not authenticated' });
  if (req.session.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  next();
}

async function loadUser(id) {
  const { rows } = await pool.query(
    'SELECT id, email, role, club_id FROM users WHERE id = $1',
    [id]
  );
  return rows[0] || null;
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

function canTouchClub(user, clubId) {
  if (!user) return false;
  if (user.role === 'admin') return true;
  return Number(user.club_id) === Number(clubId);
}

// ---------- auth ----------
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'email and password required' });
  const { rows } = await pool.query(
    'SELECT id, email, password_hash, role, club_id FROM users WHERE email = $1',
    [String(email).toLowerCase().trim()]
  );
  const u = rows[0];
  if (!u) return res.status(401).json({ error: 'invalid credentials' });
  const ok = await bcrypt.compare(password, u.password_hash);
  if (!ok) return res.status(401).json({ error: 'invalid credentials' });
  req.session.userId = u.id;
  req.session.role = u.role;
  res.json({ id: u.id, email: u.email, role: u.role, club_id: u.club_id });
});

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', requireAuth, async (req, res) => {
  const user = await loadUser(req.session.userId);
  if (!user) return res.status(401).json({ error: 'not authenticated' });
  res.json(user);
});

app.post('/api/me/password', requireAuth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 6) {
    return res.status(400).json({ error: 'new password must be at least 6 chars' });
  }
  const { rows } = await pool.query('SELECT password_hash FROM users WHERE id = $1', [req.session.userId]);
  if (!rows[0]) return res.status(404).json({ error: 'user not found' });
  const ok = await bcrypt.compare(current_password || '', rows[0].password_hash);
  if (!ok) return res.status(400).json({ error: 'current password incorrect' });
  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.session.userId]);
  res.json({ ok: true });
});

// ---------- clubs ----------
app.get('/api/clubs', requireAuth, async (req, res) => {
  const user = await loadUser(req.session.userId);
  let rows;
  if (user.role === 'admin') {
    ({ rows } = await pool.query('SELECT id, name FROM clubs ORDER BY name'));
  } else {
    ({ rows } = await pool.query('SELECT id, name FROM clubs WHERE id = $1', [user.club_id]));
  }
  res.json(rows);
});

app.post('/api/clubs', requireAdmin, async (req, res) => {
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  try {
    const { rows } = await pool.query('INSERT INTO clubs (name) VALUES ($1) RETURNING id, name', [name]);
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// ---------- employees ----------
app.get('/api/clubs/:id/employees', requireAuth, async (req, res) => {
  const user = await loadUser(req.session.userId);
  const clubId = Number(req.params.id);
  if (!canTouchClub(user, clubId)) return res.status(403).json({ error: 'forbidden' });
  const { rows } = await pool.query(
    'SELECT id, club_id, name, team, archived, sort_order FROM employees WHERE club_id = $1 ORDER BY archived ASC, sort_order ASC, id ASC',
    [clubId]
  );
  res.json(rows);
});

app.post('/api/clubs/:id/employees', requireAuth, async (req, res) => {
  const user = await loadUser(req.session.userId);
  const clubId = Number(req.params.id);
  if (!canTouchClub(user, clubId)) return res.status(403).json({ error: 'forbidden' });
  const { name, team } = req.body || {};
  if (!name) return res.status(400).json({ error: 'name required' });
  const { rows: maxRows } = await pool.query(
    'SELECT COALESCE(MAX(sort_order), 0) + 1 AS next FROM employees WHERE club_id = $1',
    [clubId]
  );
  const { rows } = await pool.query(
    'INSERT INTO employees (club_id, name, team, sort_order) VALUES ($1,$2,$3,$4) RETURNING *',
    [clubId, name, team || null, maxRows[0].next]
  );
  res.json(rows[0]);
});

app.patch('/api/employees/:id', requireAuth, async (req, res) => {
  const user = await loadUser(req.session.userId);
  const empId = Number(req.params.id);
  const { rows: existing } = await pool.query('SELECT * FROM employees WHERE id = $1', [empId]);
  if (!existing[0]) return res.status(404).json({ error: 'not found' });
  if (!canTouchClub(user, existing[0].club_id)) return res.status(403).json({ error: 'forbidden' });
  const { name, team, archived, sort_order } = req.body || {};
  const { rows } = await pool.query(
    `UPDATE employees
       SET name = COALESCE($1, name),
           team = CASE WHEN $2::text IS NULL THEN team ELSE NULLIF($2,'') END,
           archived = COALESCE($3, archived),
           sort_order = COALESCE($4, sort_order)
     WHERE id = $5 RETURNING *`,
    [name ?? null, team ?? null, typeof archived === 'boolean' ? archived : null, sort_order ?? null, empId]
  );
  res.json(rows[0]);
});

app.delete('/api/employees/:id', requireAuth, async (req, res) => {
  const user = await loadUser(req.session.userId);
  const empId = Number(req.params.id);
  const { rows: existing } = await pool.query('SELECT * FROM employees WHERE id = $1', [empId]);
  if (!existing[0]) return res.status(404).json({ error: 'not found' });
  if (!canTouchClub(user, existing[0].club_id)) return res.status(403).json({ error: 'forbidden' });
  // Archive instead of hard-delete (preserves history)
  await pool.query('UPDATE employees SET archived = TRUE WHERE id = $1', [empId]);
  res.json({ ok: true });
});

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

app.get('/api/clubs/:id/schedule', requireAuth, async (req, res) => {
  const user = await loadUser(req.session.userId);
  const clubId = Number(req.params.id);
  if (!canTouchClub(user, clubId)) return res.status(403).json({ error: 'forbidden' });
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
  // shiftMap[employee_id][day_index] = text
  const shiftMap = {};
  for (const s of shifts) {
    shiftMap[s.employee_id] = shiftMap[s.employee_id] || {};
    shiftMap[s.employee_id][s.day_index] = s.shift_text;
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
  });
});

async function assertScheduleEditable(scheduleId, user, { allowStatuses = ['draft'], adminOverride = false } = {}) {
  const { rows } = await pool.query('SELECT * FROM schedules WHERE id = $1', [scheduleId]);
  const sched = rows[0];
  if (!sched) return { err: { status: 404, msg: 'schedule not found' } };
  if (!canTouchClub(user, sched.club_id)) return { err: { status: 403, msg: 'forbidden' } };
  if (!allowStatuses.includes(sched.status) && !(adminOverride && user.role === 'admin')) {
    return { err: { status: 400, msg: `schedule is ${sched.status}, cannot edit` } };
  }
  return { sched };
}

app.patch('/api/schedules/:id/cell', requireAuth, async (req, res) => {
  const user = await loadUser(req.session.userId);
  const scheduleId = Number(req.params.id);
  const { employee_id, day_index, shift_text } = req.body || {};
  if (employee_id == null || day_index == null) return res.status(400).json({ error: 'employee_id and day_index required' });
  const { sched, err } = await assertScheduleEditable(scheduleId, user, { allowStatuses: ['draft'], adminOverride: true });
  if (err) return res.status(err.status).json({ error: err.msg });
  // ensure employee belongs to this club
  const { rows: empRows } = await pool.query('SELECT id FROM employees WHERE id = $1 AND club_id = $2', [employee_id, sched.club_id]);
  if (!empRows[0]) return res.status(400).json({ error: 'employee not in this club' });
  await pool.query(
    `INSERT INTO shifts (schedule_id, employee_id, day_index, shift_text)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (schedule_id, employee_id, day_index)
     DO UPDATE SET shift_text = EXCLUDED.shift_text`,
    [scheduleId, employee_id, day_index, shift_text || '']
  );
  await pool.query('UPDATE schedules SET updated_at = NOW() WHERE id = $1', [scheduleId]);
  res.json({ ok: true });
});

app.patch('/api/schedules/:id/notes', requireAuth, async (req, res) => {
  const user = await loadUser(req.session.userId);
  const scheduleId = Number(req.params.id);
  const { notes } = req.body || {};
  const { err } = await assertScheduleEditable(scheduleId, user, { allowStatuses: ['draft'], adminOverride: true });
  if (err) return res.status(err.status).json({ error: err.msg });
  await pool.query('UPDATE schedules SET notes = $1, updated_at = NOW() WHERE id = $2', [notes || '', scheduleId]);
  res.json({ ok: true });
});

async function transitionSchedule(req, res, { from, to, who }) {
  const user = await loadUser(req.session.userId);
  if (who === 'admin' && user.role !== 'admin') return res.status(403).json({ error: 'admin only' });
  const scheduleId = Number(req.params.id);
  const { rows } = await pool.query('SELECT * FROM schedules WHERE id = $1', [scheduleId]);
  const sched = rows[0];
  if (!sched) return res.status(404).json({ error: 'not found' });
  if (who === 'manager' && !canTouchClub(user, sched.club_id)) return res.status(403).json({ error: 'forbidden' });
  if (!from.includes(sched.status)) return res.status(400).json({ error: `cannot transition from ${sched.status}` });
  await pool.query('UPDATE schedules SET status = $1, updated_at = NOW() WHERE id = $2', [to, scheduleId]);
  res.json({ ok: true, status: to });
}

app.post('/api/schedules/:id/submit', requireAuth, (req, res) =>
  transitionSchedule(req, res, { from: ['draft'], to: 'submitted', who: 'manager' }));
app.post('/api/schedules/:id/recall', requireAuth, (req, res) =>
  transitionSchedule(req, res, { from: ['submitted'], to: 'draft', who: 'manager' }));
app.post('/api/schedules/:id/post', requireAuth, (req, res) =>
  transitionSchedule(req, res, { from: ['submitted', 'draft'], to: 'posted', who: 'admin' }));
app.post('/api/schedules/:id/return', requireAuth, (req, res) =>
  transitionSchedule(req, res, { from: ['submitted', 'posted'], to: 'draft', who: 'admin' }));

// ---------- users (admin) ----------
app.get('/api/users', requireAdmin, async (req, res) => {
  const { rows } = await pool.query(
    `SELECT u.id, u.email, u.role, u.club_id, c.name AS club_name
       FROM users u LEFT JOIN clubs c ON c.id = u.club_id
      ORDER BY u.role DESC, u.email`
  );
  res.json(rows);
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { email, password, role, club_id } = req.body || {};
  if (!email || !password || !role) return res.status(400).json({ error: 'email, password, role required' });
  if (!['admin', 'manager'].includes(role)) return res.status(400).json({ error: 'bad role' });
  if (role === 'manager' && !club_id) return res.status(400).json({ error: 'manager requires club_id' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash, role, club_id) VALUES ($1,$2,$3,$4) RETURNING id, email, role, club_id',
      [String(email).toLowerCase().trim(), hash, role, role === 'manager' ? club_id : null]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

app.patch('/api/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  const { password, role, club_id } = req.body || {};
  const sets = [];
  const vals = [];
  if (password) {
    const hash = await bcrypt.hash(password, 10);
    vals.push(hash); sets.push(`password_hash = $${vals.length}`);
  }
  if (role) {
    if (!['admin', 'manager'].includes(role)) return res.status(400).json({ error: 'bad role' });
    vals.push(role); sets.push(`role = $${vals.length}`);
  }
  if (club_id !== undefined) {
    vals.push(club_id || null); sets.push(`club_id = $${vals.length}`);
  }
  if (!sets.length) return res.json({ ok: true });
  vals.push(id);
  const { rows } = await pool.query(
    `UPDATE users SET ${sets.join(', ')} WHERE id = $${vals.length} RETURNING id, email, role, club_id`,
    vals
  );
  res.json(rows[0]);
});

app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.session.userId) return res.status(400).json({ error: 'cannot delete yourself' });
  await pool.query('DELETE FROM users WHERE id = $1', [id]);
  res.json({ ok: true });
});

// ---------- health ----------
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- SPA fallback ----------
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
