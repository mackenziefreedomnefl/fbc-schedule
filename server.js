/* eslint-disable no-console */
const path = require('path');
const express = require('express');
const { Pool } = require('pg');
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

// ---------- helpers ----------
// Normalize a date (string or Date) to the Monday of its week as YYYY-MM-DD
function mondayOf(dateLike) {
  const d = new Date(dateLike + 'T00:00:00Z');
  if (isNaN(d.getTime())) throw new Error('bad date');
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.toISOString().slice(0, 10);
}

// ---------- clubs ----------
app.get('/api/clubs', async (req, res) => {
  const { rows } = await pool.query('SELECT id, name FROM clubs ORDER BY name');
  res.json(rows);
});

app.post('/api/clubs', async (req, res) => {
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
app.get('/api/clubs/:id/employees', async (req, res) => {
  const clubId = Number(req.params.id);
  const { rows } = await pool.query(
    'SELECT id, club_id, name, team, archived, sort_order FROM employees WHERE club_id = $1 ORDER BY archived ASC, sort_order ASC, id ASC',
    [clubId]
  );
  res.json(rows);
});

app.post('/api/clubs/:id/employees', async (req, res) => {
  const clubId = Number(req.params.id);
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

app.patch('/api/employees/:id', async (req, res) => {
  const empId = Number(req.params.id);
  const { rows: existing } = await pool.query('SELECT * FROM employees WHERE id = $1', [empId]);
  if (!existing[0]) return res.status(404).json({ error: 'not found' });
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

app.delete('/api/employees/:id', async (req, res) => {
  const empId = Number(req.params.id);
  const { rows: existing } = await pool.query('SELECT * FROM employees WHERE id = $1', [empId]);
  if (!existing[0]) return res.status(404).json({ error: 'not found' });
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

app.get('/api/clubs/:id/schedule', async (req, res) => {
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
});

app.patch('/api/schedules/:id/cell', async (req, res) => {
  const scheduleId = Number(req.params.id);
  const { employee_id, day_index, shift_text } = req.body || {};
  if (employee_id == null || day_index == null) return res.status(400).json({ error: 'employee_id and day_index required' });
  const { rows: schedRows } = await pool.query('SELECT * FROM schedules WHERE id = $1', [scheduleId]);
  const sched = schedRows[0];
  if (!sched) return res.status(404).json({ error: 'schedule not found' });
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

app.patch('/api/schedules/:id/notes', async (req, res) => {
  const scheduleId = Number(req.params.id);
  const { notes } = req.body || {};
  const { rows } = await pool.query('SELECT id FROM schedules WHERE id = $1', [scheduleId]);
  if (!rows[0]) return res.status(404).json({ error: 'schedule not found' });
  await pool.query('UPDATE schedules SET notes = $1, updated_at = NOW() WHERE id = $2', [notes || '', scheduleId]);
  res.json({ ok: true });
});

async function transitionSchedule(req, res, { from, to }) {
  const scheduleId = Number(req.params.id);
  const { rows } = await pool.query('SELECT * FROM schedules WHERE id = $1', [scheduleId]);
  const sched = rows[0];
  if (!sched) return res.status(404).json({ error: 'not found' });
  if (!from.includes(sched.status)) return res.status(400).json({ error: `cannot transition from ${sched.status}` });
  await pool.query('UPDATE schedules SET status = $1, updated_at = NOW() WHERE id = $2', [to, scheduleId]);
  res.json({ ok: true, status: to });
}

app.post('/api/schedules/:id/submit', (req, res) =>
  transitionSchedule(req, res, { from: ['draft'], to: 'submitted' }));
app.post('/api/schedules/:id/recall', (req, res) =>
  transitionSchedule(req, res, { from: ['submitted'], to: 'draft' }));
app.post('/api/schedules/:id/post', (req, res) =>
  transitionSchedule(req, res, { from: ['submitted', 'draft'], to: 'posted' }));
app.post('/api/schedules/:id/return', (req, res) =>
  transitionSchedule(req, res, { from: ['submitted', 'posted'], to: 'draft' }));

// ---------- health ----------
app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));

// ---------- SPA fallback ----------
app.get('*', (req, res) => {
  res.setHeader('Cache-Control', 'no-store, must-revalidate');
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`[server] listening on :${PORT}`));
