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
    team: 'Main',
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

    console.log('[migrate] done.');
  } catch (err) {
    console.error('[migrate] failed:', err);
    // Don't hard-fail `npm install` if DB is not reachable at build time.
    if (process.env.MIGRATE_STRICT === 'true') process.exit(1);
  } finally {
    await pool.end().catch(() => {});
  }
}

main();
