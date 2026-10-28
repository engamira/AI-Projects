// Safety copy before a data-model change: writes the content tables (emails, revisions, audience set-up, contact fields,
// block definitions, brand versions) to one JSON file under backups/ (ignored by git). It does not include users,
// sessions, passwords or secrets. Usage: npm run backup-content   (DATABASE_URL must be set)
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createPool } from '../db.js';

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL must be set.');
  process.exit(1);
}

const TABLES = ['campaign', 'campaign_revision', 'campaign_audience', 'campaign_test_contact', 'contact_field', 'audience_setting', 'block_definition', 'brand_profile_version', 'asset_folder'];
const db = createPool(process.env.DATABASE_URL);
try {
  const out: Record<string, unknown[]> = {};
  const counts: string[] = [];
  for (const t of TABLES) {
    const exists = await db.query('SELECT to_regclass($1) AS t', [t]);
    if (!exists.rows[0]?.t) { counts.push(`${t}: (table not in this database yet)`); continue; }
    const r = await db.query(`SELECT * FROM ${t}`);
    out[t] = r.rows;
    counts.push(`${t}: ${r.rows.length}`);
  }
  const dir = join(process.cwd(), '..', '..', 'backups');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `content-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  writeFileSync(file, JSON.stringify({ takenAt: new Date().toISOString(), tables: out }, null, 1));
  console.log(`Backup written: ${file}\n${counts.join('\n')}`);
} finally {
  await db.end();
}
