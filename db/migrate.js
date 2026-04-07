/* eslint-disable no-console */
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const bcrypt = require('bcrypt');
try { require('dotenv').config(); } catch (_) { /* dotenv optional */ }

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

    // Bootstrap admin
    const { rows: adminRows } = await pool.query("SELECT COUNT(*)::int AS c FROM users WHERE role = 'admin'");
    if (adminRows[0].c === 0) {
      const email = process.env.ADMIN_EMAIL;
      const password = process.env.ADMIN_PASSWORD;
      if (email && password) {
        console.log(`[migrate] creating bootstrap admin ${email}`);
        const hash = await bcrypt.hash(password, 10);
        await pool.query(
          "INSERT INTO users (email, password_hash, role) VALUES ($1,$2,'admin') ON CONFLICT (email) DO NOTHING",
          [email.toLowerCase(), hash]
        );
      } else {
        console.warn('[migrate] no admin user exists and ADMIN_EMAIL/ADMIN_PASSWORD not set.');
      }
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
