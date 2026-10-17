import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db } from './db.js';
import { createPool } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/** Applies pending SQL migrations in filename order, each in its own transaction. */
export async function runMigrations(db: Db): Promise<string[]> {
  const applied: string[] = [];
  // Creating the bookkeeping table can itself race when several instances start together, so lock first.
  const boot = await db.connect();
  try {
    await boot.query('BEGIN');
    await boot.query('SELECT pg_advisory_xact_lock(727274)');
    await boot.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    await boot.query('COMMIT');
  } catch (err) {
    await boot.query('ROLLBACK');
    throw err;
  } finally {
    boot.release();
  }
  const done = new Set(
    (await db.query<{ name: string }>('SELECT name FROM schema_migrations')).rows.map((r) => r.name),
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const file of files) {
    if (done.has(file)) continue;
    const sql = await readFile(path.join(dir, file), 'utf8');
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // Only one process may apply migrations at a time (transaction-level lock: safe behind a connection pooler).
      await client.query('SELECT pg_advisory_xact_lock(727274)');
      const already = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [file]);
      if (already.rowCount) {
        await client.query('COMMIT');
        continue;
      }
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [file]);
      await client.query('COMMIT');
      applied.push(file);
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }
  return applied;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('DATABASE_URL is not set');
    process.exit(1);
  }
  const pool = createPool(url);
  runMigrations(pool)
    .then(
      (applied) => console.log(applied.length ? `Applied: ${applied.join(', ')}` : 'No pending migrations'),
      (err) => {
        console.error(err);
        process.exitCode = 1;
      },
    )
    .finally(() => pool.end());
}
