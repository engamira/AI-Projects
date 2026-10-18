import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PALETTE_IDS, canonicalJson, collectAssetIds, validateBrand, type BrandResponse, type BrandVersionDto } from '@cl/shared';
import { missingAssets } from '../assets.js';
import { allLatestProfiles, latestProfile } from '../brand.js';
import { DEFAULT_WORKSPACE_ID, type Db } from '../db.js';
import { logActivity } from '../services.js';

const params = z.object({ palette: z.enum(PALETTE_IDS) });
const saveBody = z.object({ header: z.record(z.string(), z.unknown()), footer: z.record(z.string(), z.unknown()), baseVersion: z.number().int().min(1) });

export function brandRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/brand', { config: { access: 'campaign.view' } }, async (): Promise<BrandResponse> => ({ profiles: await allLatestProfiles(db) }));

  app.get<{ Params: { palette: string } }>('/api/brand/:palette/versions', { config: { access: 'brand.manage' } }, async (req): Promise<BrandVersionDto[]> => {
    const { palette } = params.parse(req.params);
    const r = await db.query<{ version: number; created_at: Date; name: string | null }>(
      `SELECT b.version, b.created_at, u.name FROM brand_profile_version b LEFT JOIN app_user u ON u.id = b.created_by
        WHERE b.workspace_id = $1 AND b.palette = $2 ORDER BY b.version DESC`,
      [DEFAULT_WORKSPACE_ID, palette],
    );
    return r.rows.map((x) => ({ version: x.version, updatedAt: x.created_at.toISOString(), updatedByName: x.name }));
  });

  // Saving adds a new version. Emails that follow this template pick it up; nothing is overwritten.
  app.put<{ Params: { palette: string } }>('/api/brand/:palette', { config: { access: 'brand.manage' } }, async (req, reply) => {
    const { palette } = params.parse(req.params);
    const body = saveBody.parse(req.body);
    const v = validateBrand(body.header, body.footer);
    if (!v.ok) return reply.status(400).send({ error: 'invalid_brand', message: v.error });
    const missing = await missingAssets(db, collectAssetIds([v.header, v.footer]));
    if (missing.length) return reply.status(400).send({ error: 'missing_asset', message: 'A picture used here no longer exists in the asset library.' });

    const current = await latestProfile(db, palette);
    if (canonicalJson({ h: current.header, f: current.footer }) === canonicalJson({ h: v.header, f: v.footer })) return current; // nothing changed
    if (current.version !== body.baseVersion) {
      return reply.status(409).send({ error: 'version_conflict', message: 'The header and footer were changed by someone else. Reload to see the latest version.', currentVersion: current.version });
    }
    try {
      await db.query(
        `INSERT INTO brand_profile_version (workspace_id, palette, version, header, footer, created_by) VALUES ($1, $2, $3, $4, $5, $6)`,
        [DEFAULT_WORKSPACE_ID, palette, current.version + 1, JSON.stringify(v.header), JSON.stringify(v.footer), req.auth!.user.id],
      );
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.status(409).send({ error: 'version_conflict', message: 'The header and footer were changed by someone else. Reload to see the latest version.' });
      }
      throw err;
    }
    await logActivity(db, { actorId: req.auth!.user.id, action: 'brand.updated', entityType: 'brand', entityId: palette, details: { palette, version: current.version + 1 } });
    return latestProfile(db, palette);
  });
}
