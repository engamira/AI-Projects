import { PALETTE_IDS, defaultBrand, type BrandProfileDto, type PaletteId, type Props } from '@cl/shared';
import { DEFAULT_WORKSPACE_ID, type Queryable } from './db.js';

type Row = { palette: PaletteId; version: number; header: Props; footer: Props; created_at: Date; updated_by_name: string | null };
const toDto = (r: Row): BrandProfileDto => ({
  palette: r.palette, version: r.version, header: r.header, footer: r.footer,
  updatedAt: r.created_at.toISOString(), updatedByName: r.updated_by_name,
});

/** Makes sure every template has a starting header and footer (version 1). Safe to run on every start. */
export async function ensureBrandProfiles(q: Queryable): Promise<void> {
  for (const palette of PALETTE_IDS) {
    const d = defaultBrand(palette);
    await q.query(
      `INSERT INTO brand_profile_version (workspace_id, palette, version, header, footer)
       VALUES ($1, $2, 1, $3, $4) ON CONFLICT (workspace_id, palette, version) DO NOTHING`,
      [DEFAULT_WORKSPACE_ID, palette, JSON.stringify(d.header), JSON.stringify(d.footer)],
    );
  }
}

export async function latestProfile(q: Queryable, palette: PaletteId): Promise<BrandProfileDto> {
  const r = await q.query<Row>(
    `SELECT b.palette, b.version, b.header, b.footer, b.created_at, u.name AS updated_by_name
       FROM brand_profile_version b LEFT JOIN app_user u ON u.id = b.created_by
      WHERE b.workspace_id = $1 AND b.palette = $2 ORDER BY b.version DESC LIMIT 1`,
    [DEFAULT_WORKSPACE_ID, palette],
  );
  const row = r.rows[0];
  if (!row) throw new Error(`No brand profile for ${palette}`);
  return toDto(row);
}

export async function allLatestProfiles(q: Queryable): Promise<Record<PaletteId, BrandProfileDto>> {
  const out = {} as Record<PaletteId, BrandProfileDto>;
  for (const p of PALETTE_IDS) out[p] = await latestProfile(q, p);
  return out;
}

export async function profileVersion(q: Queryable, palette: PaletteId, version: number): Promise<BrandProfileDto | undefined> {
  const r = await q.query<Row>(
    `SELECT b.palette, b.version, b.header, b.footer, b.created_at, u.name AS updated_by_name
       FROM brand_profile_version b LEFT JOIN app_user u ON u.id = b.created_by
      WHERE b.workspace_id = $1 AND b.palette = $2 AND b.version = $3`,
    [DEFAULT_WORKSPACE_ID, palette, version],
  );
  return r.rows[0] && toDto(r.rows[0]);
}
