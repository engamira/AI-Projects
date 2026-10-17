import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createPool } from './db.js';
import { runMigrations } from './migrate.js';

const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL ?? '';
const url = base.replace('-pooler', '');
const schema = `test_${randomBytes(6).toString('hex')}`;
const admin = createPool(url);

beforeAll(async () => {
  await admin.query(`CREATE SCHEMA ${schema}`);
});
afterAll(async () => {
  await admin.query(`DROP SCHEMA ${schema} CASCADE`);
  await admin.end();
});

describe('migrations', () => {
  it('apply once even when several instances start at the same time, and are a no-op afterwards', async () => {
    const pools = [createPool(url, { schema }), createPool(url, { schema }), createPool(url, { schema })];
    try {
      const results = await Promise.all(pools.map((p) => runMigrations(p)));
      const total = results.flat();
      expect(total.length).toBeGreaterThanOrEqual(3);
      expect(new Set(total).size).toBe(total.length); // each migration applied exactly once across all instances
      expect(await runMigrations(pools[0]!)).toEqual([]);
      const rows = await pools[0]!.query('SELECT name FROM schema_migrations ORDER BY name');
      expect(rows.rows.map((r) => r.name)).toEqual([...total].sort());
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });
});
