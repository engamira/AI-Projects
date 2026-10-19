import { createHash } from 'node:crypto';
import { imageSize } from 'image-size';
import { ASSET_MAX_BYTES, type AssetDto } from '@cl/shared';
import { DEFAULT_WORKSPACE_ID, type Queryable } from './db.js';

// Images live behind this small interface (database today, object storage later).
// Emails refer to them as "asset:<id>", so moving the storage never changes an email.

const MAX_DIMENSION = 6000; // pixels, either side

export type DetectedImage = { mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'; width: number; height: number };

/** Detects the real type from the file's own bytes (the browser-supplied type is never trusted). SVG and everything else is refused. */
export function detectImage(buf: Buffer): DetectedImage | { error: string } {
  let mime: DetectedImage['mime'] | null = null;
  if (buf.length > 12 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) mime = 'image/png';
  else if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) mime = 'image/jpeg';
  else if (buf.length > 6 && ['GIF87a', 'GIF89a'].includes(buf.subarray(0, 6).toString('latin1'))) mime = 'image/gif';
  else if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') mime = 'image/webp';
  if (!mime) return { error: 'Only PNG, JPG, GIF and WebP pictures can be uploaded.' };
  try {
    const { width, height } = imageSize(buf);
    if (!width || !height) return { error: 'This picture could not be read.' };
    if (width > MAX_DIMENSION || height > MAX_DIMENSION) return { error: `The picture is too large (max ${MAX_DIMENSION} pixels on either side).` };
    return { mime, width, height };
  } catch {
    return { error: 'This picture could not be read. Try saving it again as a PNG or JPG.' };
  }
}

export function safeFilename(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'image';
  const cleaned = base.replace(/[^A-Za-z0-9._() -]/g, '_').replace(/^\.+/, '').slice(0, 100);
  return cleaned || 'image';
}

type Row = { id: string; filename: string; mime: string; size_bytes: number; width: number | null; height: number | null; created_at: Date; created_by_name: string | null };
const toDto = (r: Row): AssetDto => ({
  id: r.id, filename: r.filename, mime: r.mime, sizeBytes: r.size_bytes, width: r.width, height: r.height,
  createdAt: r.created_at.toISOString(), createdByName: r.created_by_name,
});

const COLS = `a.id, a.filename, a.mime, a.size_bytes, a.width, a.height, a.created_at, u.name AS created_by_name`;

/** Saves an image. The same picture uploaded twice is stored once. */
export async function saveAsset(q: Queryable, buf: Buffer, filename: string, userId: string): Promise<{ asset: AssetDto; created: boolean } | { error: string }> {
  if (buf.length === 0) return { error: 'The file is empty.' };
  if (buf.length > ASSET_MAX_BYTES) return { error: `The picture is larger than ${ASSET_MAX_BYTES / 1048576} MB. Please reduce its size.` };
  const img = detectImage(buf);
  if ('error' in img) return img;
  const sha = createHash('sha256').update(buf).digest('hex');
  const ins = await q.query<{ id: string }>(
    `INSERT INTO asset (workspace_id, filename, mime, size_bytes, width, height, sha256, data, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) ON CONFLICT (workspace_id, sha256) DO NOTHING RETURNING id`,
    [DEFAULT_WORKSPACE_ID, safeFilename(filename), img.mime, buf.length, img.width, img.height, sha, buf, userId],
  );
  const id = ins.rows[0]?.id ?? (await q.query<{ id: string }>('SELECT id FROM asset WHERE workspace_id = $1 AND sha256 = $2', [DEFAULT_WORKSPACE_ID, sha])).rows[0]!.id;
  const row = (await q.query<Row>(`SELECT ${COLS} FROM asset a LEFT JOIN app_user u ON u.id = a.created_by WHERE a.id = $1`, [id])).rows[0]!;
  return { asset: toDto(row), created: !!ins.rows[0] };
}

export async function listAssets(q: Queryable): Promise<AssetDto[]> {
  const r = await q.query<Row>(
    `SELECT ${COLS} FROM asset a LEFT JOIN app_user u ON u.id = a.created_by WHERE a.workspace_id = $1 ORDER BY a.created_at DESC LIMIT 300`,
    [DEFAULT_WORKSPACE_ID],
  );
  return r.rows.map(toDto);
}

export async function getAssetFile(q: Queryable, id: string): Promise<{ mime: string; data: Buffer } | undefined> {
  const r = await q.query<{ mime: string; data: Buffer }>('SELECT mime, data FROM asset WHERE id = $1 AND workspace_id = $2', [id, DEFAULT_WORKSPACE_ID]);
  return r.rows[0];
}

/** Returns the ids from the list that do not exist as assets. */
export async function missingAssets(q: Queryable, ids: string[]): Promise<string[]> {
  if (ids.length === 0) return [];
  const r = await q.query<{ id: string }>('SELECT id FROM asset WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [DEFAULT_WORKSPACE_ID, ids]);
  const found = new Set(r.rows.map((x) => x.id));
  return ids.filter((i) => !found.has(i));
}

// ---------- Cropped copies ----------
// "square-240.jpg" is a 240x240 crop; "card-480.jpg" is a 480x360 (4:3) crop. Only these sizes are allowed.
const VARIANT = /^(square-(120|240|360)|card-(320|480|640))\.jpg$/;

export function parseVariant(name: string): { width: number; height: number } | null {
  if (!VARIANT.test(name)) return null;
  const [kind, size] = name.replace('.jpg', '').split('-') as ['square' | 'card', string];
  const width = Number(size);
  return { width, height: kind === 'square' ? width : Math.round((width * 3) / 4) };
}

export async function getVariantFile(q: Queryable, id: string, name: string): Promise<{ mime: string; data: Buffer } | undefined> {
  const dims = parseVariant(name);
  if (!dims) return undefined;
  const cached = await q.query<{ mime: string; data: Buffer }>('SELECT mime, data FROM asset_variant WHERE asset_id = $1 AND variant = $2', [id, name]);
  if (cached.rows[0]) return cached.rows[0];
  const original = await q.query<{ data: Buffer }>('SELECT data FROM asset WHERE id = $1 AND workspace_id = $2', [id, DEFAULT_WORKSPACE_ID]);
  if (!original.rows[0]) return undefined;
  const sharp = (await import('sharp')).default;
  const data = await sharp(original.rows[0].data, { limitInputPixels: 40_000_000 })
    .rotate() // respect the camera's orientation
    .flatten({ background: '#ffffff' }) // transparent areas become white
    .resize(dims.width, dims.height, { fit: 'cover', position: sharp.strategy.attention }) // crop around the most interesting part
    .jpeg({ quality: 85, mozjpeg: true })
    .toBuffer();
  await q.query('INSERT INTO asset_variant (asset_id, variant, mime, data) VALUES ($1, $2, $3, $4) ON CONFLICT DO NOTHING', [id, name, 'image/jpeg', data]);
  return { mime: 'image/jpeg', data };
}
