import fs from 'node:fs';
import pg from 'pg';
import { performance } from 'node:perf_hooks';
import { config } from './config.js';

pg.types.setTypeParser(20, v => parseInt(v, 10));

const ca = fs.readFileSync('/app/supabase-ca.crt', 'utf8');

function securePgConfig(connectionString, max) {
  const url = new URL(connectionString);

  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) {
    url.searchParams.delete(key);
  }

  return {
    connectionString: url.toString(),
    ssl: {
      ca,
      rejectUnauthorized: true,
    },
    max,
  };
}

export const appPool = new pg.Pool(
  securePgConfig(config.databaseUrl, 5)
);

export const sysPool = new pg.Pool(
  securePgConfig(config.systemDatabaseUrl, 3)
);

for (const p of [appPool, sysPool]) {
  p.on('error', () => {});
}

const RETRYABLE = new Set(['40001', '40P01']); 


export async function tx(pool, fn, ctx = {}) {
  for (let attempt = 0; ; attempt++) {
    const c = await pool.connect();
    let clientError;

    const onClientError = err => {
      clientError = err;
    };

    c.on('error', onClientError);

    const originalQuery = c.query.bind(c);

    if (pool === sysPool) {
      c.query = (...args) => {
        const sql = typeof args[0] === 'string'
          ? args[0]
          : args[0]?.text || '<unknown query>';

        if (typeof args.at(-1) === 'function') {
          return originalQuery(...args);
        }

        const started = performance.now();

        const logSlowQuery = error => {
          const ms = performance.now() - started;

          if (ms >= 500) {
            console.warn(JSON.stringify({
              type: 'slow_sql',
              ms: Math.round(ms),
              error: error?.code || null,
              sql: sql.replace(/\s+/g, ' ').slice(0, 240),
            }));
          }
        };

        return originalQuery(...args).then(
          result => {
            logSlowQuery();
            return result;
          },
          error => {
            logSlowQuery(error);
            throw error;
          }
        );
      };
    }

    try {
      await c.query('BEGIN');
      if (clientError) throw clientError;

      if (pool === appPool) {
        await c.query(
          "SELECT set_config('app.workspace_id', $1, true), set_config('app.user_id', $2, true)",
          [ctx.workspaceId || '', ctx.userId || '']
        );
        if (clientError) throw clientError;
      }

      const out = await fn(c);
      if (clientError) throw clientError;

      await c.query('COMMIT');
      if (clientError) throw clientError;

      return out;
    } catch (e) {
      try {
        await c.query('ROLLBACK');
      } catch {}

      if (RETRYABLE.has(e.code) && attempt < 3) {
        continue;
      }

      throw clientError || e;
    } finally {
      c.query = originalQuery;
      c.removeListener('error', onClientError);
      c.release(clientError || undefined);
    }
  }
}

export const withTenant = (ctx, fn) => tx(appPool, fn, ctx);
export const withSystem = fn => tx(sysPool, fn);

export class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}