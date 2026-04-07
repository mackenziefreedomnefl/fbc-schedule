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

// Auth model: a session is either anonymous (read-only) or tied to a specific
// club via req.session.clubId. Writes that touch a club require the session
// to be tied to that exact club.
function requireClub(req, res, clubId) {
  if (!req.session.clubId) {
    res.status(401).json({ error: 'sign in required' });
    return false;
  }
  if (Number(req.session.clubId) !== Number(clubId)) {
    res.status(403).json({ error: 'you are signed in to a different club' });
    return false;
  }
  return true;
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

// ---------- auth ----------
app.post('/api/login', ah(async (req, res) => {
  const { club_id, password } = req.body || {};
  if (!club_id || !password) return res.status(400).json({ error: 'club_id and password required' });
  const { rows } = await pool.query('SELECT id, name, password_hash FROM clubs WHERE id = $1', [club_id]);
  const club = rows[0];
  if (!club) return res.status(404).json({ error: 'club not found' });
  if (!club.password_hash) return res.status(400).json({ error: 'this club has no password set yet' });
  const ok = await bcrypt.compare(password, club.password_hash);
  if (!ok) return res.status(401).json({ error: 'wrong password' });
  req.session.clubId = club.id;
  res.json({ club_id: club.id, name: club.name });
}));

app.post('/api/logout', (req, res) => {
  req.session.destroy(() => res.json({ ok: true }));
});

app.get('/api/me', ah(async (req, res) => {
  if (!req.session.clubId) return res.json({ club_id: null });
  const { rows } = await pool.query('SELECT id AS club_id, name FROM clubs WHERE id = $1', [req.session.clubId]);
  if (!rows[0]) {
    req.session.destroy(() => {});
    return res.json({ club_id: null });
  }
  res.json({ club_id: rows[0].club_id, name: rows[0].name });
}));

app.post('/api/clubs/:id/password', ah(async (req, res) => {
  const clubId = Number(req.params.id);
  if (!requireClub(req, res, clubId)) return;
  const { current_password, new_password } = req.body || {};
  if (!new_password || new_password.length < 4) {
    return res.status(400).json({ error: 'new password must be at least 4 characters' });
  }
  const { rows } = await pool.query('SELECT password_hash FROM clubs WHERE id = $1', [clubId]);
  if (!rows[0]) return res.status(404).json({ error: 'club not found' });
  if (rows[0].password_hash) {
    const ok = await bcrypt.compare(current_password || '', rows[0].password_hash);
    if (!ok) return res.status(400).json({ error: 'current password is wrong' });
  }
  const hash = await bcrypt.hash(new_password, 10);
  await pool.query('UPDATE clubs SET password_hash = $1 WHERE id = $2', [hash, clubId]);
  res.json({ ok: true });
}));

// ---------- clubs ----------
// Public: list clubs. Returns has_password so the frontend can warn if a club
// has no password set yet.
app.get('/api/clubs', ah(async (req, res) => {
  const { rows } = await pool.query(
    'SELECT id, name, (password_hash IS NOT NULL) AS has_password FROM clubs ORDER BY name'
  );
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
  const clubId = Number(req.params.id);
  if (!requireClub(req, res, clubId)) return;
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
}));

app.patch('/api/employees/:id', ah(async (req, res) => {
  const empId = Number(req.params.id);
  const { rows: existing } = await pool.query('SELECT * FROM employees WHERE id = $1', [empId]);
  if (!existing[0]) return res.status(404).json({ error: 'not found' });
  if (!requireClub(req, res, existing[0].club_id)) return;
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
}));

app.delete('/api/employees/:id', ah(async (req, res) => {
  const empId = Number(req.params.id);
  const { rows: existing } = await pool.query('SELECT * FROM employees WHERE id = $1', [empId]);
  if (!existing[0]) return res.status(404).json({ error: 'not found' });
  if (!requireClub(req, res, existing[0].club_id)) return;
  // Archive instead of hard-delete (preserves history)
  await pool.query('UPDATE employees SET archived = TRUE WHERE id = $1', [empId]);
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
}));

app.patch('/api/schedules/:id/cell', ah(async (req, res) => {
  const scheduleId = Number(req.params.id);
  const { employee_id, day_index, shift_text } = req.body || {};
  if (employee_id == null || day_index == null) return res.status(400).json({ error: 'employee_id and day_index required' });
  const { rows: schedRows } = await pool.query('SELECT * FROM schedules WHERE id = $1', [scheduleId]);
  const sched = schedRows[0];
  if (!sched) return res.status(404).json({ error: 'schedule not found' });
  if (!requireClub(req, res, sched.club_id)) return;
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
}));

app.patch('/api/schedules/:id/notes', ah(async (req, res) => {
  const scheduleId = Number(req.params.id);
  const { notes } = req.body || {};
  const { rows } = await pool.query('SELECT club_id FROM schedules WHERE id = $1', [scheduleId]);
  if (!rows[0]) return res.status(404).json({ error: 'schedule not found' });
  if (!requireClub(req, res, rows[0].club_id)) return;
  await pool.query('UPDATE schedules SET notes = $1, updated_at = NOW() WHERE id = $2', [notes || '', scheduleId]);
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
// Any uncaught error in a route handler ends up here. Always return JSON so the
// frontend can surface a useful message instead of "Request failed".
app.use((err, req, res, next) => {
  console.error('[server] unhandled error', err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: (err && err.message) || 'internal server error' });
});

app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
