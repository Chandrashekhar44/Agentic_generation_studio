import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { log } from './log.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
const adminUrl = process.env.ADMIN_DATABASE_URL;
const appPw = process.env.APP_DB_PASSWORD || 'studio_app_pw';
const sysPw = process.env.SYSTEM_DB_PASSWORD || 'studio_system_pw';

const ca = fs.readFileSync('/app/supabase-ca.crt', 'utf8');
const adminConnectionUrl = new URL(adminUrl);

for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) {
  adminConnectionUrl.searchParams.delete(key);
}

async function connectWithRetry() {
  for (let i = 0; i < 60; i++) {
    const c = new pg.Client({
      connectionString: adminConnectionUrl.toString(),
      ssl: { ca, rejectUnauthorized: true },
    });
    try {
      await c.connect();
      return c;
    } catch (e) {
      await c.end().catch(() => {});
      if (i === 59) {
        throw new Error(`Database connection failed: ${e.message}`, { cause: e });
      }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  throw new Error('database unreachable');
}

const c = await connectWithRetry();

try {
  await c.query('SELECT pg_advisory_lock(727274)');
  await c.query(
    'CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())'
  );

  for (const [role, pw, extra] of [
    ['studio_app', appPw, 'NOBYPASSRLS'],
    ['studio_system', sysPw, 'BYPASSRLS'],
  ]) {
    const exists = await c.query(
      'SELECT 1 FROM pg_roles WHERE rolname = $1',
      [role]
    );

    if (!exists.rowCount) {
      await c.query(
        `CREATE ROLE ${role} LOGIN NOSUPERUSER ${extra} PASSWORD ${c.escapeLiteral(pw)}`
      );
      log.info('database role created', { role });
    } else {
      log.info('database role already exists; leaving its attributes unchanged', { role });
    }
  }

  const files = fs.readdirSync(dir).filter(f => f.endsWith('.sql')).sort();

  for (const f of files) {
    const done = await c.query(
      'SELECT 1 FROM schema_migrations WHERE name = $1',
      [f]
    );
    if (done.rowCount) continue;

    await c.query('BEGIN');
    try {
      await c.query(fs.readFileSync(path.join(dir, f), 'utf8'));
      await c.query(
        'INSERT INTO schema_migrations(name) VALUES ($1)',
        [f]
      );
      await c.query('COMMIT');
      log.info('migration applied', { file: f });
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  }

  await c.query('SELECT pg_advisory_unlock(727274)');
  log.info('migrations complete');
} finally {
  await c.end();
}