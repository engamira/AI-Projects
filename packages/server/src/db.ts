import pg from 'pg';

export type Db = Pick<pg.Pool, 'query' | 'end' | 'connect'>;
export type Queryable = Pick<pg.Pool, 'query'>;

/** The single workspace of version 1. Every tenant-owned row carries this id. */
export const DEFAULT_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';

export function createPool(connectionString: string, opts: { schema?: string } = {}): pg.Pool {
  if (opts.schema && !/^[a-z_][a-z0-9_]*$/.test(opts.schema)) throw new Error('invalid schema name');
  return new pg.Pool({
    // Always verify the server certificate (same behaviour pg applies to sslmode=require, stated explicitly).
    connectionString: connectionString.replace(/sslmode=(require|prefer|verify-ca)/, 'sslmode=verify-full'),
    max: 5,
    // Fail fast instead of hanging forever when the database is slow or unreachable.
    connectionTimeoutMillis: 10_000,
    query_timeout: 30_000,
    idleTimeoutMillis: 30_000,
    ssl: connectionString.includes('localhost') ? false : { rejectUnauthorized: true },
    // Tests isolate each run in its own schema (needs a direct, non-pooled connection).
    ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
  });
}

/** Runs fn inside a transaction on a dedicated connection. */
export async function withTransaction<T>(db: Db, fn: (q: Queryable) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
