import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  canonicalJson,
  cloneContent,
  collectAssetIds,
  PALETTE_IDS,
  campaignStatus,
  hasCapability,
  emptyContent,
  flatContent,
  pickVersion,
  versionName,
  normalizeContent,
  starterContent,
  validateContent,
  type CampaignDto,
  type CampaignSummary,
  type EmailContent,
  type LibraryResponse,
  type PreviewResponse,
  type RevisionDto,
  type SaveDraftResponse,
} from '@cl/shared';
import { missingAssets } from '../assets.js';
import { getAudienceFields, resolveRecipient } from '../campaignAudience.js';
import { allFields } from '../contacts.js';
import { roleEditRefusal } from '../editrules.js';
import { listLibrary } from '../blocklib.js';
import { latestProfile } from '../brand.js';
import type { AppConfig } from '../config.js';
import { sha256 } from '../crypto.js';
import { DEFAULT_WORKSPACE_ID, withTransaction, type Db, type Queryable } from '../db.js';
import { renderEmail } from '../render.js';
import { logActivity } from '../services.js';

const hashOf = (c: EmailContent): string => sha256(canonicalJson(c));

type CampaignRow = {
  id: string;
  name: string;
  status: string;
  draft_content: EmailContent;
  draft_version: number;
  draft_hash: string;
  updated_at: Date;
};

const toDto = (r: CampaignRow): CampaignDto => ({
  id: r.id,
  name: r.name,
  status: r.status,
  draft: { content: r.draft_content, version: r.draft_version, hash: r.draft_hash, updatedAt: r.updated_at.toISOString() },
});

const idParam = z.object({ id: z.string().uuid() });
const revParams = z.object({ id: z.string().uuid(), rid: z.string().uuid() });
const nameBody = z.object({ name: z.string().trim().min(1, 'Enter a name.').max(120, 'Name is too long.') });
const createBody = nameBody.extend({ palette: z.enum(PALETTE_IDS).default('travel'), starter: z.boolean().default(false) });
const labelBody = z.object({ label: z.string().trim().max(120).optional() });
const draftBody = z.object({ content: z.unknown(), baseVersion: z.number().int().min(1) });

export function campaignRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  const notFound = (reply: FastifyReply) => reply.status(404).send({ error: 'not_found', message: 'Campaign not found.' });

  async function getCampaign(q: Queryable, id: string, lock = false): Promise<CampaignRow | undefined> {
    const r = await q.query<CampaignRow>(
      `SELECT id, name, status, draft_content, draft_version, draft_hash, updated_at FROM campaign
        WHERE id = $1 AND workspace_id = $2 ${lock ? 'FOR UPDATE' : ''}`,
      [id, DEFAULT_WORKSPACE_ID],
    );
    const row = r.rows[0];
    return row && { ...row, draft_content: normalizeContent(row.draft_content) };
  }

  async function addRevision(
    q: Queryable,
    campaignId: string,
    userId: string,
    kind: RevisionDto['kind'],
    content: EmailContent,
    opts: { label?: string | null; restoredFromId?: string } = {},
  ): Promise<number> {
    // The campaign row must already be locked by the caller so numbers never collide.
    const r = await q.query<{ n: number }>('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM campaign_revision WHERE campaign_id = $1', [campaignId]);
    const number = r.rows[0]!.n;
    await q.query(
      `INSERT INTO campaign_revision (workspace_id, campaign_id, number, kind, label, content, content_hash, restored_from_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [DEFAULT_WORKSPACE_ID, campaignId, number, kind, opts.label ?? null, JSON.stringify(content), hashOf(content), opts.restoredFromId ?? null, userId],
    );
    return number;
  }

  async function createCampaign(q: Queryable, userId: string, name: string, content: EmailContent, kind: 'created' | 'duplicate', label?: string): Promise<CampaignRow> {
    const r = await q.query<CampaignRow>(
      `INSERT INTO campaign (workspace_id, name, draft_content, draft_hash, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $5, $5)
       RETURNING id, name, status, draft_content, draft_version, draft_hash, updated_at`,
      [DEFAULT_WORKSPACE_ID, name, JSON.stringify(content), hashOf(content), userId],
    );
    const row = r.rows[0]!;
    await addRevision(q, row.id, userId, kind, content, { label });
    return row;
  }

  // ---- block library (read-only: there is no route that changes it) ----
  app.get('/api/library/blocks', { config: { access: 'campaign.view' } }, async (): Promise<LibraryResponse> => ({
    blocks: await listLibrary(db),
  }));

  // ---- campaigns ----
  app.get('/api/campaigns', { config: { access: 'campaign.view' } }, async (): Promise<CampaignSummary[]> => {
    const r = await db.query<{ id: string; name: string; status: string; updated_at: Date; created_by_name: string | null; revision_count: string }>(
      `SELECT c.id, c.name, c.status, c.updated_at, u.name AS created_by_name,
              (SELECT count(*) FROM campaign_revision r WHERE r.campaign_id = c.id) AS revision_count
         FROM campaign c LEFT JOIN app_user u ON u.id = c.created_by
        WHERE c.workspace_id = $1 ORDER BY c.updated_at DESC`,
      [DEFAULT_WORKSPACE_ID],
    );
    return r.rows.map((x) => ({
      id: x.id, name: x.name, status: x.status, createdByName: x.created_by_name,
      updatedAt: x.updated_at.toISOString(), revisionCount: Number(x.revision_count),
    }));
  });

  // Deleting removes the campaign and its saved versions for good. Only campaigns that have not been through review
  // (draft) or were sent back for changes can be deleted; the activity history keeps a record that it happened.
  app.delete<{ Params: { id: string } }>('/api/campaigns/:id', { config: { access: 'campaign.delete' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const userId = req.auth!.user.id;
    const result = await withTransaction(db, async (q) => {
      const c = await getCampaign(q, id, true);
      if (!c) return { kind: 'missing' as const };
      if (!campaignStatus(c.status).deletable) return { kind: 'locked' as const, status: c.status };
      await q.query('DELETE FROM campaign WHERE id = $1 AND workspace_id = $2', [id, DEFAULT_WORKSPACE_ID]);
      await logActivity(q, { actorId: userId, action: 'campaign.deleted', entityType: 'campaign', entityId: id, details: { name: c.name, status: c.status } });
      return { kind: 'ok' as const };
    });
    if (result.kind === 'missing') return notFound(reply);
    if (result.kind === 'locked') return reply.status(409).send({ error: 'not_deletable', message: `A campaign that is "${campaignStatus(result.status).label}" cannot be deleted.` });
    return reply.status(204).send();
  });

  app.post('/api/campaigns', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { name, palette, starter } = createBody.parse(req.body);
    const userId = req.auth!.user.id;
    const row = await withTransaction(db, async (q) => {
      const c = await createCampaign(q, userId, name, starter ? starterContent(palette) : emptyContent(palette), 'created');
      await logActivity(q, { actorId: userId, action: 'campaign.created', entityType: 'campaign', entityId: c.id, details: { name, palette, starter } });
      return c;
    });
    return reply.status(201).send(toDto(row));
  });

  app.get<{ Params: { id: string } }>('/api/campaigns/:id', { config: { access: 'campaign.view' } }, async (req, reply) => {
    const c = await getCampaign(db, idParam.parse(req.params).id);
    return c ? toDto(c) : notFound(reply);
  });

  app.patch<{ Params: { id: string } }>('/api/campaigns/:id', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { name } = nameBody.parse(req.body);
    const result = await withTransaction(db, async (q) => {
      const c = await getCampaign(q, id, true);
      if (!c) return null;
      await q.query('UPDATE campaign SET name = $2, updated_by = $3, updated_at = now() WHERE id = $1', [id, name, req.auth!.user.id]);
      await logActivity(q, { actorId: req.auth!.user.id, action: 'campaign.renamed', entityType: 'campaign', entityId: id, details: { from: c.name, to: name } });
      return true;
    });
    if (!result) return notFound(reply);
    return toDto((await getCampaign(db, id))!);
  });

  // Autosave target. Uses optimistic concurrency: a stale tab cannot overwrite newer work.
  app.put<{ Params: { id: string } }>('/api/campaigns/:id/draft', { config: { access: ['campaign.edit', 'html.custom'] } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = draftBody.parse(req.body);
    const v = validateContent(body.content);
    if (!v.ok) return reply.status(400).send({ error: 'invalid_content', message: v.error });
    const hash = hashOf(v.content);
    const missing = await missingAssets(db, collectAssetIds(v.content));
    if (missing.length) return reply.status(400).send({ error: 'missing_asset', message: 'A picture used in this email no longer exists in the asset library.' });

    const current = await getCampaign(db, id);
    if (!current) return notFound(reply);
    if (current.status !== 'draft') return reply.status(409).send({ error: 'locked', message: 'This campaign can no longer be edited.' });
    if (v.content.settings.palette !== current.draft_content.settings.palette) {
      return reply.status(400).send({ error: 'palette_locked', message: 'The template colors are fixed when a campaign is created and cannot be changed.' });
    }
    const refusal = roleEditRefusal(req.auth!.user.role, current.draft_content, v.content);
    if (refusal) return reply.status(403).send({ error: 'forbidden_edit', message: refusal });
    if (current.draft_hash === hash) {
      const same: SaveDraftResponse = { version: current.draft_version, hash, updatedAt: current.updated_at.toISOString() };
      return same; // nothing changed
    }

    const r = await db.query<{ draft_version: number; updated_at: Date }>(
      `UPDATE campaign SET draft_content = $3, draft_hash = $4, draft_version = draft_version + 1, updated_by = $5, updated_at = now()
        WHERE id = $1 AND workspace_id = $6 AND draft_version = $2 AND status = 'draft'
        RETURNING draft_version, updated_at`,
      [id, body.baseVersion, JSON.stringify(v.content), hash, req.auth!.user.id, DEFAULT_WORKSPACE_ID],
    );
    if (r.rowCount !== 1) {
      const now = await getCampaign(db, id);
      return reply.status(409).send({
        error: 'version_conflict',
        message: 'This email was changed in another window or by someone else. Reload to see the latest version.',
        currentVersion: now?.draft_version,
      });
    }
    const out: SaveDraftResponse = { version: r.rows[0]!.draft_version, hash, updatedAt: r.rows[0]!.updated_at.toISOString() };
    return out;
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/duplicate', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const userId = req.auth!.user.id;
    const copy = await withTransaction(db, async (q) => {
      const src = await getCampaign(q, id);
      if (!src) return null;
      // Fresh block ids: the copy shares nothing with the original.
      const c = await createCampaign(q, userId, `Copy of ${src.name}`.slice(0, 120), cloneContent(src.draft_content, true), 'duplicate', `Copied from "${src.name}"`);
      await logActivity(q, { actorId: userId, action: 'campaign.duplicated', entityType: 'campaign', entityId: c.id, details: { from: id } });
      return c;
    });
    return copy ? reply.status(201).send(toDto(copy)) : notFound(reply);
  });

  // ---- revisions ----
  app.get<{ Params: { id: string } }>('/api/campaigns/:id/revisions', { config: { access: 'campaign.view' } }, async (req, reply): Promise<RevisionDto[] | FastifyReply> => {
    const { id } = idParam.parse(req.params);
    if (!(await getCampaign(db, id))) return notFound(reply);
    const r = await db.query<{
      id: string; number: number; kind: RevisionDto['kind']; label: string | null; created_by_name: string | null; created_at: Date; content_hash: string; restored_from_number: number | null;
    }>(
      `SELECT r.id, r.number, r.kind, r.label, u.name AS created_by_name, r.created_at, r.content_hash, src.number AS restored_from_number
         FROM campaign_revision r
         LEFT JOIN app_user u ON u.id = r.created_by
         LEFT JOIN campaign_revision src ON src.id = r.restored_from_id
        WHERE r.campaign_id = $1 ORDER BY r.number DESC`,
      [id],
    );
    return r.rows.map((x) => ({
      id: x.id, number: x.number, kind: x.kind, label: x.label, createdByName: x.created_by_name,
      createdAt: x.created_at.toISOString(), hash: x.content_hash, restoredFromNumber: x.restored_from_number,
    }));
  });

  app.post<{ Params: { id: string } }>('/api/campaigns/:id/revisions', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { label } = labelBody.parse(req.body ?? {});
    const userId = req.auth!.user.id;
    const number = await withTransaction(db, async (q) => {
      const c = await getCampaign(q, id, true);
      if (!c) return null;
      const n = await addRevision(q, id, userId, 'manual', c.draft_content, { label: label || null });
      await logActivity(q, { actorId: userId, action: 'campaign.revision_saved', entityType: 'campaign', entityId: id, details: { number: n, label: label || null } });
      return n;
    });
    return number === null ? notFound(reply) : reply.status(201).send({ number });
  });

  // Restoring never rewrites history: the old content becomes the draft and a new "restore" revision is recorded.
  app.post<{ Params: { id: string; rid: string } }>('/api/campaigns/:id/revisions/:rid/restore', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { id, rid } = revParams.parse(req.params);
    const userId = req.auth!.user.id;
    const result = await withTransaction(db, async (q) => {
      const c = await getCampaign(q, id, true);
      if (!c) return 'missing' as const;
      if (c.status !== 'draft') return 'locked' as const;
      const rev = await q.query<{ number: number; content: EmailContent }>(
        'SELECT number, content FROM campaign_revision WHERE id = $1 AND campaign_id = $2',
        [rid, id],
      );
      if (!rev.rows[0]) return 'missing' as const;
      const content = normalizeContent(rev.rows[0].content);
      if (roleEditRefusal(req.auth!.user.role, c.draft_content, content)) return 'html' as const;
      await q.query(
        `UPDATE campaign SET draft_content = $2, draft_hash = $3, draft_version = draft_version + 1, updated_by = $4, updated_at = now() WHERE id = $1`,
        [id, JSON.stringify(content), hashOf(content), userId],
      );
      const n = await addRevision(q, id, userId, 'restore', content, { restoredFromId: rid });
      await logActivity(q, { actorId: userId, action: 'campaign.revision_restored', entityType: 'campaign', entityId: id, details: { restoredNumber: rev.rows[0].number, newNumber: n } });
      return 'ok' as const;
    });
    if (result === 'missing') return notFound(reply);
    if (result === 'html') return reply.status(403).send({ error: 'forbidden_edit', message: 'That version has different Custom HTML blocks. Only an Admin can change those, so ask an Admin to restore it.' });
    if (result === 'locked') return reply.status(409).send({ error: 'locked', message: 'This campaign can no longer be edited.' });
    return toDto((await getCampaign(db, id))!);
  });

  // ---- preview: the same renderer that QA and sending will use ----
  app.get<{ Params: { id: string }; Querystring: { revision?: string; as?: string; variant?: string } }>('/api/campaigns/:id/preview', { config: { access: 'campaign.view' } }, async (req, reply): Promise<PreviewResponse | FastifyReply> => {
    const { id } = idParam.parse(req.params);
    const rid = z.string().uuid().optional().parse(req.query.revision);
    const as = z.string().max(80).default('sample').parse(req.query.as);
    const variantId = z.string().uuid().optional().parse(req.query.variant);
    const who = await resolveRecipient(db, id, as, hasCapability(req.auth!.user.role, 'audience.manage'));
    if (who.kind === 'not_found') return reply.status(400).send({ error: 'invalid_recipient', message: 'That recipient does not exist (any more).' });
    if (who.kind === 'forbidden') return reply.status(403).send({ error: 'forbidden' });
    const c = await getCampaign(db, id);
    if (!c) return notFound(reply);
    let content = c.draft_content;
    if (rid) {
      const r = await db.query<{ content: EmailContent }>('SELECT content FROM campaign_revision WHERE id = $1 AND campaign_id = $2', [rid, id]);
      if (!r.rows[0]) return notFound(reply);
      content = normalizeContent(r.rows[0].content);
    }
    // Which email: the one asked for (while editing it, shown whole), else the one this recipient receives:
    // a copy for their segment, else the default for their language, else the overall Default. Blocks whose
    // "show when" condition the recipient does not meet are left out.
    const allF = await allFields(db);
    const typeOf = (k: string) => allF.find((f) => f.key === k)?.type;
    const picked = variantId ? content.variants?.find((v) => v.id === variantId) ?? null : null;
    if (variantId && !picked) return reply.status(400).send({ error: 'invalid_version', message: 'That version does not exist (any more).' });
    const contact = !variantId && who.kind === 'recipient' ? who.recipient : null;
    const choice = contact ? pickVersion(content, await getAudienceFields(db, id), contact) : { variant: picked, layer: picked ? (picked.kind ? 'language' : 'copy') : 'default' };
    const variant = choice.variant;
    const flat = flatContent(content, variant, { contact, typeOf });
    // Every email shows the shared header and footer of its template (latest version).
    const brand = await latestProfile(db, content.settings.palette);
    const knownFields = allF.map((f) => f.key);
    const out = await renderEmail(flat, { baseUrl: config.baseUrl, brand, knownFields, ...(who.kind === 'recipient' ? { recipient: who.recipient } : {}) });
    const total = (variant ?? content).blocks.length;
    const conditional = (variant ?? content).blocks.some((b) => b.showWhen);
    if (content.variants?.length || conditional) {
      const base = variant ? versionName(variant) + (variant.kind ? '' : ' version') : 'Default version';
      out.versionLabel = conditional && contact && flat.blocks.length < total ? `${base} · ${flat.blocks.length} of ${total} blocks` : base;
    }
    return who.kind === 'recipient' ? { ...out, recipientLabel: who.label } : out;
  });
}
