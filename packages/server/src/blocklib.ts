import { BLOCK_DEFINITIONS, canonicalJson, type BlockDefinition } from '@cl/shared';
import type { Queryable } from './db.js';

/**
 * Makes sure every (type, version) of the built-in block library exists in the database.
 * The rows are immutable, so if the code now differs from a stored version, that version was
 * edited in place; refuse to start rather than silently serving a changed "original".
 */
export async function syncBlockDefinitions(db: Queryable, definitions: BlockDefinition[] = BLOCK_DEFINITIONS): Promise<void> {
  const rows = await db.query<{ type: string; version: number; definition: BlockDefinition }>(
    'SELECT type, version, definition FROM block_definition',
  );
  const stored = new Map(rows.rows.map((r) => [`${r.type}@${r.version}`, r.definition]));
  for (const def of definitions) {
    const existing = stored.get(`${def.type}@${def.version}`);
    if (!existing) {
      await db.query('INSERT INTO block_definition (type, version, definition) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING', [
        def.type,
        def.version,
        JSON.stringify(def),
      ]);
    } else if (canonicalJson(existing) !== canonicalJson(def)) {
      throw new Error(`Block "${def.type}" version ${def.version} changed without a new version number.`);
    }
  }
}

/** Latest version of each block, in library order. */
export async function listLibrary(db: Queryable): Promise<BlockDefinition[]> {
  const r = await db.query<{ definition: BlockDefinition }>(
    `SELECT DISTINCT ON (type) definition FROM block_definition ORDER BY type, version DESC`,
  );
  const order = new Map(BLOCK_DEFINITIONS.map((d, i) => [d.type, i]));
  // Only blocks the code still offers (the header and footer are brand elements now, not blocks).
  return r.rows.map((x) => x.definition).filter((d) => order.has(d.type)).sort((a, b) => (order.get(a.type) ?? 99) - (order.get(b.type) ?? 99));
}
