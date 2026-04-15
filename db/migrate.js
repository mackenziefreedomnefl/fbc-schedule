/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

// Map of club name -> env var holding that club's password.
// A password is only ever written to the DB if the column is still null,
// so setting the env var re-seeds the password only when it was never set.
// To change a password after that, use the /api/clubs/:id/password endpoint
// or set FORCE_RESET_PASSWORDS=true and redeploy.
const CLUB_PASSWORD_ENV = {
  'Jacksonville': 'JACKSONVILLE_PASSWORD',
  'St. Augustine': 'ST_AUGUSTINE_PASSWORD',
};

// Authoritative rosters. Each array is the ordered list of active employees
// for that team. Running sync updates every listed employee's team, sort
// position, and archived=false state, inserts any that are missing, and
// archives anyone in REMOVED_FROM_ROSTER. Safe to re-run.
const ROSTERS = [
  {
    club: 'Jacksonville',
    team: 'Julington Creek',
    sortBase: 0,
    names: [
      'Nick Tragemann', 'Alison Conner', 'Sergio Palacios', 'Sam Wentworth',
      'Branson Messer', 'William Krupsky', 'Davin Barbour', 'Delaney Holcomb',
      'Aiden Rock', 'William Eisner',
    ],
  },
  {
    club: 'Jacksonville',
    team: 'Jacksonville Beach',
    sortBase: 100,
    names: [
      'Dustyn Burd', 'Michael Mobley', 'Brandon Lanier', 'Tyler Boggess',
      'Morgan Tragemann', 'Justice Bramer', 'Jaron Firesheets', 'Alec Murino',
      'Mackenzie Shealy', 'Brandon McSwigan',
    ],
  },
  {
    club: 'St. Augustine',
    team: null,
    sortBase: 0,
    names: [
      'Sean Dressander', 'Gavin Carillo', 'Jaxin Gamber', 'Zoe Henley',
      'Michael Guillet', 'Julia Catlett', 'Ryan Constantino',
      'John Gleaton-Hernandez', 'Bill Harris', 'Aidan Popp', 'Austin Corzo',
      'Jack Fant', 'Alexander Vida',
    ],
  },
];

// Names explicitly removed from their club's active roster. These get
// archived (not deleted) so their past shifts stay intact.
const REMOVED_FROM_ROSTER = [
  { club: 'Jacksonville', name: 'Caroline Sirico' },
  { club: 'Jacksonville', name: 'Rain Bartenfelder' },
  { club: 'St. Augustine', name: 'Andrew Gibner' },
  { club: 'St. Augustine', name: 'Dalton Hawley' },
];

async function main() {
  if (!process.env.DATABASE_URL) {
    console.warn('[migrate] DATABASE_URL not set — skipping migration. (This is expected during local `npm install` without a DB.)');
    return;
  }

  const useSsl = String(process.env.PGSSL || '').toLowerCase() === 'true'
    || /railway|render|heroku|amazonaws/i.test(process.env.DATABASE_URL || '');

  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: useSsl ? { rejectUnauthorized: false } : false,
  });

  try {
    const schemaSql = fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8');
    console.log('[migrate] applying schema...');
    await pool.query(schemaSql);

    // One-shot: clear all schedule data if requested
    if (String(process.env.CLEAR_ALL_SCHEDULES || '').toLowerCase() === 'true') {
      await pool.query('DELETE FROM shifts');
      await pool.query('DELETE FROM location_totals');
      await pool.query('DELETE FROM schedules');
      await pool.query("DELETE FROM audit_log");
      await pool.query("DELETE FROM app_state WHERE key IN ('example_seeded','import_schedule_v2')");
      console.log('[migrate] CLEARED all schedule data, totals, and audit log. Remove CLEAR_ALL_SCHEDULES env var now.');
    }

    // Seed clubs/employees if DB empty
    const { rows: clubCountRows } = await pool.query('SELECT COUNT(*)::int AS c FROM clubs');
    if (clubCountRows[0].c === 0) {
      console.log('[migrate] seeding clubs and employees...');
      const seed = JSON.parse(fs.readFileSync(path.join(__dirname, 'seed-data.json'), 'utf8'));
      for (const club of seed.clubs) {
        const { rows } = await pool.query(
          'INSERT INTO clubs (name) VALUES ($1) RETURNING id',
          [club.name]
        );
        const clubId = rows[0].id;
        let order = 0;
        for (const emp of club.employees) {
          await pool.query(
            'INSERT INTO employees (club_id, name, team, sort_order) VALUES ($1,$2,$3,$4)',
            [clubId, emp.name, emp.team || null, order++]
          );
        }
      }
    } else {
      console.log('[migrate] clubs already present — skipping seed.');
    }

    // Rename Jacksonville team labels (idempotent — no-op after first run).
    const { rowCount: r1 } = await pool.query(
      `UPDATE employees SET team = 'Julington Creek'
        WHERE team = 'Main'
          AND club_id = (SELECT id FROM clubs WHERE name = 'Jacksonville')`
    );
    const { rowCount: r2 } = await pool.query(
      `UPDATE employees SET team = 'Jacksonville Beach'
        WHERE team = 'Team 2'
          AND club_id = (SELECT id FROM clubs WHERE name = 'Jacksonville')`
    );
    if (r1 || r2) {
      console.log(`[migrate] renamed Jacksonville teams: Main→Julington Creek (${r1}), Team 2→Jacksonville Beach (${r2})`);
    }

    // Sync authoritative rosters. For every listed employee: upsert, unarchive,
    // set team + sort_order to match the list. For names in REMOVED_FROM_ROSTER:
    // archive. Idempotent.
    for (const roster of ROSTERS) {
      const { rows: clubRows } = await pool.query('SELECT id FROM clubs WHERE name = $1', [roster.club]);
      if (!clubRows[0]) continue;
      const clubId = clubRows[0].id;
      for (let i = 0; i < roster.names.length; i++) {
        const name = roster.names[i];
        const sortOrder = roster.sortBase + i;
        const { rowCount } = await pool.query(
          `UPDATE employees
             SET team = $1, sort_order = $2, archived = FALSE
           WHERE club_id = $3 AND name = $4`,
          [roster.team, sortOrder, clubId, name]
        );
        if (rowCount === 0) {
          await pool.query(
            'INSERT INTO employees (club_id, name, team, sort_order, archived) VALUES ($1,$2,$3,$4,FALSE)',
            [clubId, name, roster.team, sortOrder]
          );
          console.log(`[migrate] added ${name} to ${roster.club} / ${roster.team}`);
        }
      }
    }
    for (const removed of REMOVED_FROM_ROSTER) {
      const { rowCount } = await pool.query(
        `UPDATE employees
           SET archived = TRUE
         WHERE name = $1
           AND club_id = (SELECT id FROM clubs WHERE name = $2)
           AND archived = FALSE`,
        [removed.name, removed.club]
      );
      if (rowCount) console.log(`[migrate] archived ${removed.name} from ${removed.club}`);
    }

    // Seed club passwords from env vars. Only writes when the password_hash
    // column is null, unless FORCE_RESET_PASSWORDS=true is set.
    // (Legacy: superseded by user-based auth, but left in place so existing
    // env vars don't error out and so the column can be used as a fallback.)
    const forceReset = String(process.env.FORCE_RESET_PASSWORDS || '').toLowerCase() === 'true';
    for (const [clubName, envKey] of Object.entries(CLUB_PASSWORD_ENV)) {
      const pw = process.env[envKey];
      if (!pw) continue;
      const { rows: clubRows } = await pool.query('SELECT id, password_hash FROM clubs WHERE name = $1', [clubName]);
      if (!clubRows[0]) continue;
      if (clubRows[0].password_hash && !forceReset) continue;
      const hash = await bcrypt.hash(pw, 10);
      await pool.query('UPDATE clubs SET password_hash = $1 WHERE id = $2', [hash, clubRows[0].id]);
      console.log(`[migrate] set password for ${clubName} from ${envKey}`);
    }

    // Bootstrap owner users from OWNER_EMAILS / OWNER_PASSWORD env vars.
    // Each comma-separated email becomes an owner account. The password is
    // only applied when the user is first created, OR when
    // FORCE_RESET_PASSWORDS=true. Owners can change their own passwords later.
    const ownerEmailsRaw = String(process.env.OWNER_EMAILS || '').trim();
    const ownerPassword = process.env.OWNER_PASSWORD;
    if (ownerEmailsRaw && ownerPassword) {
      const ownerEmails = ownerEmailsRaw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
      for (const email of ownerEmails) {
        const { rows: existing } = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
        if (!existing[0]) {
          const hash = await bcrypt.hash(ownerPassword, 10);
          await pool.query(
            "INSERT INTO users (email, password_hash, role, name) VALUES ($1, $2, 'owner', $3)",
            [email, hash, email.split('@')[0]]
          );
          console.log(`[migrate] created owner ${email}`);
        } else if (forceReset) {
          const hash = await bcrypt.hash(ownerPassword, 10);
          await pool.query(
            "UPDATE users SET password_hash = $1, role = 'owner' WHERE id = $2",
            [hash, existing[0].id]
          );
          console.log(`[migrate] reset owner password for ${email}`);
        } else {
          // Make sure existing user has owner role even if their password is unchanged
          await pool.query("UPDATE users SET role = 'owner' WHERE id = $1 AND role <> 'owner'", [existing[0].id]);
        }
      }
    } else if (ownerEmailsRaw && !ownerPassword) {
      console.warn('[migrate] OWNER_EMAILS set but OWNER_PASSWORD missing — owners not seeded');
    }

    // Prune audit log entries older than 30 days.
    const { rowCount: pruned } = await pool.query(
      "DELETE FROM audit_log WHERE created_at < NOW() - INTERVAL '30 days'"
    );
    if (pruned) console.log(`[migrate] pruned ${pruned} audit log entries older than 30 days`);

    // One-shot example data seed (shifts + totals for this week and next week).
    // Controlled by the app_state flag 'example_seeded' so it only runs once.
    // Set RESET_EXAMPLE_DATA=true to force it to run again.
    await seedExampleData(pool);

    // Import specific schedule data from screenshots (one-shot)
    await importScheduleData(pool);

    console.log('[migrate] done.');
  } catch (err) {
    console.error('[migrate] failed:', err);
    // Don't hard-fail `npm install` if DB is not reachable at build time.
    if (process.env.MIGRATE_STRICT === 'true') process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

// ---------- example data seeder ----------

function mondayOfLocal(date) {
  const d = new Date(date);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  return d.toISOString().slice(0, 10);
}
function addDaysLocal(dateStr, n) {
  const d = new Date(dateStr + 'T00:00:00');
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

// Two weeks of sample shift data, one per tab. Empty string = no shift.
// Index 0 = Monday ... Index 6 = Sunday.
const EXAMPLE_SHIFTS = {
  'Jacksonville': [
    // THIS WEEK
    {
      'Nick Tragemann':    ['East','East','','','East','','East'],
      'Alison Conner':     ['West','West','','','West','West',''],
      'Sergio Palacios':   ['','','','East','East','East','East'],
      'Sam Wentworth':     ['','','West','West','','West','West'],
      'Branson Messer':    ['','','','','','',''],
      'William Krupsky':   ['','','','','','',''],
      'Davin Barbour':     ['','','','','West','East','East'],
      'Delaney Holcomb':   ['','','','East','','East','East'],
      'Aiden Rock':        ['','','','','','','West'],
      'William Eisner':    ['','','Open - 4 East','','','',''],
      'Dustyn Burd':       ['','Beach','','Beach','','Beach','Beach'],
      'Michael Mobley':    ['Beach','Req Off','Req Off','','Beach','Beach',''],
      'Brandon Lanier':    ['','Beach','Beach','','Beach','Beach',''],
      'Tyler Boggess':     ['','','','','','Beach',''],
      'Morgan Tragemann':  ['Beach','','East','Beach','','','Beach'],
      'Justice Bramer':    ['Beach','','Beach','','Beach','','Beach'],
      'Jaron Firesheets':  ['','','','','Beach','Beach','Beach'],
      'Alec Murino':       ['Beach','','','','Beach','','Beach'],
      'Mackenzie Shealy':  ['','','','','','',''],
      'Brandon McSwigan':  ['','Beach','','','','','Beach'],
    },
    // NEXT WEEK
    {
      'Nick Tragemann':    ['East','East','','','','East','East'],
      'Alison Conner':     ['West','West','','','West','Req Off',''],
      'Sergio Palacios':   ['','','','East','East','East','East'],
      'Sam Wentworth':     ['','','West','West','','West','West'],
      'Branson Messer':    ['','','','','','',''],
      'William Krupsky':   ['','','','','','',''],
      'Davin Barbour':     ['East','','','','East','East','East'],
      'Delaney Holcomb':   ['','','','East','','East','East'],
      'Aiden Rock':        ['','','','','','',''],
      'William Eisner':    ['','','East','','West','East','West'],
      'Dustyn Burd':       ['','Beach','','Beach','','Beach','Beach'],
      'Michael Mobley':    ['','Beach','Beach','','Beach','Beach',''],
      'Brandon Lanier':    ['','Beach','Beach','','Beach','Beach',''],
      'Tyler Boggess':     ['','','','','','',''],
      'Morgan Tragemann':  ['Beach','','East','Beach','','West','Beach'],
      'Justice Bramer':    ['Beach','','Beach','Beach','Req Off','Req Off',''],
      'Jaron Firesheets':  ['','Beach','','Beach','Beach','','Beach'],
      'Alec Murino':       ['Beach','','','','Beach','','Beach'],
      'Mackenzie Shealy':  ['','','','','','',''],
      'Brandon McSwigan':  ['Beach','','','','','','Beach'],
    },
  ],
  'St. Augustine': [
    // THIS WEEK
    {
      'Sean Dressander':       ['Camachee','Camachee','','','','','Camachee'],
      'Gavin Carillo':         ['','','Camachee','Camachee','Camachee','Camachee','Camachee'],
      'Jaxin Gamber':          ['','','','Camachee','','Shipyard','Shipyard'],
      'Zoe Henley':            ['Req Off','Req Off','Req Off','Req Off','Camachee','Camachee','Camachee'],
      'Michael Guillet':       ['','','','','Req Off','Req Off','Req Off'],
      'Julia Catlett':         ['Camachee','','Camachee','','Camachee','Camachee','Camachee'],
      'Ryan Constantino':      ['Camachee','Camachee','','','Req Off','Req Off','Req Off'],
      'John Gleaton-Hernandez':['','Camachee','','Camachee','Camachee','',''],
      'Bill Harris':           ['Camachee','','Camachee','Camachee','Camachee','','Camachee'],
      'Aidan Popp':            ['','','','','','Req Off','Camachee'],
      'Austin Corzo':          ['','','','12 - Close Camachee','','Camachee',''],
      'Jack Fant':             ['Shipyard','Shipyard','','','Shipyard','','Shipyard'],
      'Alexander Vida':        ['','','Shipyard','Shipyard','Camachee','Shipyard',''],
    },
    // NEXT WEEK
    {
      'Sean Dressander':       ['Camachee','Camachee','Req Off','Req Off','Req Off','Req Off','Req Off'],
      'Gavin Carillo':         ['','','Camachee','Camachee','Camachee','Camachee','Camachee'],
      'Jaxin Gamber':          ['','','','','','','Shipyard'],
      'Zoe Henley':            ['Camachee','','','','Camachee','','Req Off'],
      'Michael Guillet':       ['','','','','Shipyard','',''],
      'Julia Catlett':         ['Camachee','','Camachee','','','Camachee','Camachee'],
      'Ryan Constantino':      ['','Camachee','','Camachee','','',''],
      'John Gleaton-Hernandez':['','Camachee','','Camachee','','','Camachee'],
      'Bill Harris':           ['Camachee','','Camachee','Camachee','Camachee','','Camachee'],
      'Aidan Popp':            ['','','','','','Camachee','12 - Close Camachee'],
      'Austin Corzo':          ['','','','','','Camachee',''],
      'Jack Fant':             ['Shipyard','Shipyard','','','Shipyard','Shipyard','Shipyard'],
      'Alexander Vida':        ['','','Shipyard','Shipyard','Shipyard','Shipyard',''],
    },
  ],
};

const EXAMPLE_TOTALS = {
  'Jacksonville': [
    { JB:  [4,3,3,3,4,5,5], JCE: [1,1,1,2,3,4,4], JCW: [1,1,1,1,2,2,2] },
    { JB:  [4,3,3,3,4,5,5], JCE: [2,1,2,2,3,4,4], JCW: [1,1,1,1,2,2,2] },
  ],
  'St. Augustine': [
    { CC:  [4,3,3,3,5,5,5], SY:  [1,1,1,1,1,2,2] },
    { CC:  [4,3,3,3,4,5,5], SY:  [1,1,1,1,1,2,2] },
  ],
};

async function seedExampleData(pool) {
  const reset = String(process.env.RESET_EXAMPLE_DATA || '').toLowerCase() === 'true';
  const { rows: flagRows } = await pool.query(
    "SELECT value FROM app_state WHERE key = 'example_seeded'"
  );
  if (flagRows[0] && !reset) {
    return; // already seeded
  }

  const thisWeek = mondayOfLocal(new Date());
  const weeks = [thisWeek, addDaysLocal(thisWeek, 7)];
  console.log(`[migrate] seeding example data for weeks ${weeks[0]} and ${weeks[1]}`);

  for (const [clubName, weekData] of Object.entries(EXAMPLE_SHIFTS)) {
    const { rows: clubRows } = await pool.query('SELECT id FROM clubs WHERE name = $1', [clubName]);
    if (!clubRows[0]) continue;
    const clubId = clubRows[0].id;

    for (let wIdx = 0; wIdx < 2; wIdx++) {
      const weekStart = weeks[wIdx];

      // get or create the schedule row
      const { rows: schedRows } = await pool.query(
        'SELECT id FROM schedules WHERE club_id = $1 AND week_start = $2',
        [clubId, weekStart]
      );
      let scheduleId;
      if (schedRows[0]) {
        scheduleId = schedRows[0].id;
      } else {
        const { rows: created } = await pool.query(
          'INSERT INTO schedules (club_id, week_start) VALUES ($1,$2) RETURNING id',
          [clubId, weekStart]
        );
        scheduleId = created[0].id;
      }

      // insert shifts. DO NOTHING preserves any real edits the user may have
      // already made; we only fill empty cells.
      for (const [empName, shifts] of Object.entries(weekData[wIdx])) {
        const { rows: empRows } = await pool.query(
          'SELECT id FROM employees WHERE club_id = $1 AND name = $2',
          [clubId, empName]
        );
        if (!empRows[0]) continue;
        const empId = empRows[0].id;
        for (let d = 0; d < 7; d++) {
          const text = shifts[d] || '';
          if (!text) continue;
          await pool.query(
            `INSERT INTO shifts (schedule_id, employee_id, day_index, shift_text)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (schedule_id, employee_id, day_index) DO NOTHING`,
            [scheduleId, empId, d, text]
          );
        }
      }

      // insert totals (same DO NOTHING idempotency)
      const totalsForWeek = EXAMPLE_TOTALS[clubName][wIdx];
      for (const [loc, counts] of Object.entries(totalsForWeek)) {
        for (let d = 0; d < 7; d++) {
          if (counts[d] == null) continue;
          await pool.query(
            `INSERT INTO location_totals (schedule_id, location, day_index, count_text)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (schedule_id, location, day_index) DO NOTHING`,
            [scheduleId, loc, d, String(counts[d])]
          );
        }
      }
    }
  }

  // Mark as seeded so subsequent deploys skip this
  await pool.query(
    `INSERT INTO app_state (key, value) VALUES ('example_seeded', NOW()::text)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`
  );
  console.log('[migrate] example data seeded');
}

// ---------- schedule data import ----------
const IMPORT_DATA = {
  'Jacksonville': {
    '2026-03-30': { // Mar 30 - Apr 5
      shifts: {
        'Nick Tragemann':    ['East','East','','','','East','East'],
        'Alison Conner':     ['West','West','','','West','Req Off',''],
        'Sergio Palacios':   ['','','','East','East','East','East'],
        'Sam Wentworth':     ['','','West','West','','West','West'],
        'Branson Messer':    ['','','','','','',''],
        'William Krupsky':   ['','','','','','',''],
        'Davin Barbour':     ['East','','','','East','East','East'],
        'Delaney Holcomb':   ['','','','East','','East','East'],
        'Aiden Rock':        ['','','','','','',''],
        'William Eisner':    ['','','East','','West','East','West'],
        'Dustyn Burd':       ['','Beach','','Beach','','Beach','Beach'],
        'Michael Mobley':    ['','Beach','Beach','','Beach','Beach',''],
        'Brandon Lanier':    ['','','Beach','','Beach','Beach',''],
        'Tyler Boggess':     ['','','','','','',''],
        'Morgan Tragemann':  ['Beach','','East','Beach','','West','Beach'],
        'Justice Bramer':    ['Beach','','Beach','Beach','Req Off','Req Off',''],
        'Jaron Firesheets':  ['','Beach','','Beach','Beach','','Beach'],
        'Alec Murino':       ['Beach','','','','Beach','','Beach'],
        'Mackenzie Shealy':  ['','','','','','',''],
        'Brandon McSwigan':  ['Beach','','','','Beach','','Beach'],
      },
      totals: { JB: [4,3,3,3,4,5,5], JCE: [2,1,2,2,3,4,4], JCW: [1,1,1,1,2,2,2] },
    },
    '2026-04-06': { // Apr 6 - Apr 12
      shifts: {
        'Nick Tragemann':    ['East','East','','','East','','East'],
        'Alison Conner':     ['West','West','','','West','West',''],
        'Sergio Palacios':   ['','','','East','East','East','East'],
        'Sam Wentworth':     ['','','West','West','','West','West'],
        'Branson Messer':    ['','','','','','',''],
        'William Krupsky':   ['','','','','','',''],
        'Davin Barbour':     ['','','','','West','East','East'],
        'Delaney Holcomb':   ['','','','East','','East','East'],
        'Aiden Rock':        ['','','','','','','West'],
        'William Eisner':    ['','Open - 4 East','','','East','East',''],
        'Dustyn Burd':       ['','Beach','','Beach','','Beach','Beach'],
        'Michael Mobley':    ['Beach','Req Off','Req Off','','Beach','Beach',''],
        'Brandon Lanier':    ['','Beach','Beach','','Beach','Beach',''],
        'Tyler Boggess':     ['','','','','','Beach',''],
        'Morgan Tragemann':  ['Beach','','East','Beach','','',''],
        'Justice Bramer':    ['Beach','','Beach','','Beach','','Beach'],
        'Jaron Firesheets':  ['','','','Beach','','Beach','Beach'],
        'Alec Murino':       ['Beach','','','','Beach','','Beach'],
        'Mackenzie Shealy':  ['','','','','','',''],
        'Brandon McSwigan':  ['','Beach','','Beach','','','Beach'],
      },
      totals: { JB: [4,3,3,3,4,5,5], JCE: [1,1,1,2,3,4,4], JCW: [1,1,1,1,2,2,2] },
    },
  },
  'St. Augustine': {
    '2026-03-30': {
      shifts: {
        'Sean Dressander':        ['Camachee','Camachee','Req Off','Req Off','Req Off','Req Off','Req Off'],
        'Gavin Carillo':          ['','','Camachee','Camachee','Camachee','Camachee','Camachee'],
        'Jaxin Gamber':           ['','','','','','','Shipyard'],
        'Zoe Henley':             ['Camachee','','','','Camachee','','Req Off'],
        'Michael Guillet':        ['','','','','','Shipyard','Camachee'],
        'Julia Catlett':          ['Camachee','Camachee','Camachee','','','Camachee','Camachee'],
        'Ryan Constantino':       ['','Camachee','','Camachee','','Camachee',''],
        'John Gleaton-Hernandez': ['','Camachee','','Camachee','','','Camachee'],
        'Bill Harris':            ['Camachee','','Camachee','Camachee','Camachee','','Camachee'],
        'Aidan Popp':             ['','','','','','Camachee','12 - Close Camachee'],
        'Austin Corzo':           ['','','','','','Camachee',''],
        'Jack Fant':              ['Shipyard','Shipyard','','','Shipyard','Shipyard','Shipyard'],
        'Alexander Vida':         ['','','Shipyard','Shipyard','Shipyard','Shipyard',''],
      },
      totals: { CC: [4,3,3,3,4,5,5], SY: [1,1,1,1,1,2,2] },
    },
    '2026-04-06': {
      shifts: {
        'Sean Dressander':        ['Camachee','Camachee','','','Camachee','','Camachee'],
        'Gavin Carillo':          ['','','Camachee','Camachee','Camachee','Camachee',''],
        'Jaxin Gamber':           ['','','','Camachee','','Shipyard','Shipyard'],
        'Zoe Henley':             ['Req Off','Req Off','Req Off','Req Off','Camachee','Camachee','Camachee'],
        'Michael Guillet':        ['','','','','Req Off','Req Off','Req Off'],
        'Julia Catlett':          ['Camachee','','Camachee','','Camachee','Camachee',''],
        'Ryan Constantino':       ['Camachee','Camachee','','','Req Off','Req Off','Req Off'],
        'John Gleaton-Hernandez': ['','Camachee','','Camachee','','Camachee',''],
        'Bill Harris':            ['Camachee','','Camachee','','','','Camachee'],
        'Aidan Popp':             ['','','','','','Req Off','Camachee'],
        'Austin Corzo':           ['','','','12 - Close Camachee','','Camachee','Camachee'],
        'Jack Fant':              ['Shipyard','Shipyard','','','Shipyard','','Shipyard'],
        'Alexander Vida':         ['','','Shipyard','Shipyard','Camachee','Shipyard',''],
      },
      totals: { CC: [4,3,3,3,5,5,5], SY: [1,1,1,1,1,2,2] },
    },
  },
};

async function importScheduleData(pool) {
  const { rows: flagRows } = await pool.query(
    "SELECT value FROM app_state WHERE key = 'import_schedule_v2'"
  );
  if (flagRows[0] && process.env.FORCE_IMPORT !== 'true') return;

  console.log('[migrate] importing schedule data from screenshots...');
  for (const [clubName, weeks] of Object.entries(IMPORT_DATA)) {
    const { rows: clubRows } = await pool.query('SELECT id FROM clubs WHERE name = $1', [clubName]);
    if (!clubRows[0]) { console.log(`[migrate] club ${clubName} not found, skipping`); continue; }
    const clubId = clubRows[0].id;

    for (const [weekStart, weekData] of Object.entries(weeks)) {
      // Get or create schedule
      let scheduleId;
      const { rows: sr } = await pool.query(
        'SELECT id FROM schedules WHERE club_id = $1 AND week_start = $2', [clubId, weekStart]);
      if (sr[0]) {
        scheduleId = sr[0].id;
      } else {
        const { rows: cr } = await pool.query(
          'INSERT INTO schedules (club_id, week_start) VALUES ($1,$2) RETURNING id', [clubId, weekStart]);
        scheduleId = cr[0].id;
      }

      // Import shifts (overwrite existing)
      for (const [empName, days] of Object.entries(weekData.shifts)) {
        const { rows: empRows } = await pool.query(
          'SELECT id FROM employees WHERE club_id = $1 AND name = $2', [clubId, empName]);
        if (!empRows[0]) continue;
        const empId = empRows[0].id;
        for (let d = 0; d < 7; d++) {
          const text = days[d] || '';
          await pool.query(
            `INSERT INTO shifts (schedule_id, employee_id, day_index, shift_text)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (schedule_id, employee_id, day_index)
             DO UPDATE SET shift_text = EXCLUDED.shift_text`,
            [scheduleId, empId, d, text]);
        }
      }

      // Import totals (overwrite existing)
      for (const [loc, counts] of Object.entries(weekData.totals || {})) {
        for (let d = 0; d < 7; d++) {
          await pool.query(
            `INSERT INTO location_totals (schedule_id, location, day_index, count_text)
             VALUES ($1,$2,$3,$4)
             ON CONFLICT (schedule_id, location, day_index)
             DO UPDATE SET count_text = EXCLUDED.count_text`,
            [scheduleId, loc, d, String(counts[d])]);
        }
      }

      console.log(`[migrate] imported ${clubName} week of ${weekStart}`);
    }
  }

  await pool.query(
    `INSERT INTO app_state (key, value) VALUES ('import_schedule_v2', NOW()::text)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`);
  console.log('[migrate] schedule import complete');
}

main();
