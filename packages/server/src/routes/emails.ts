import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  blockDefinition, collectAssetIds, emailName, explainBlock, normalizeContent, parseLanguageList, validateContent, visibleBlocks,
  type BlockExplanationDto, type CampaignEmails, type DerivedResponse, type EmailContent, type EmailDraftDto, type EmailRevisionDetail, type EmailRevisionSummary, type QaSubmissionResult, type LanguageDto, type PreviewResponse, type SaveDraftResponse,
} from '@cl/shared';
import { missingAssets } from '../assets.js';
import { resolveRecipient } from '../campaignAudience.js';
import { hasCapability } from '@cl/shared';
import { allFields } from '../contacts.js';
import { latestProfile } from '../brand.js';
import type { AppConfig } from '../config.js';
import { DEFAULT_WORKSPACE_ID, withTransaction, type Db, type Queryable } from '../db.js';
import { addEmailRevision, campaignEmails, createEmailVariant, hashOf, listLanguages, setSelectedLanguages, upgradeCampaign } from '../emails.js';
import { readDerived, rulesSignature, syncDerived } from '../derived.js';
import { roleEditRefusal } from '../editrules.js';
import { renderEmail } from '../render.js';
import { logActivity } from '../services.js';

const idParam = z.object({ id: z.string().uuid() });
const revParams = z.object({ id: z.string().uuid(), rid: z.string().uuid() });
const languagesBody = z.object({ input: z.string().max(2000) });
const createBody = z.object({ languageId: z.string().min(1).max(20), createFromId: z.string().uuid().nullable().optional(), requestId: z.string().min(8).max(80).optional() });
const draftBody = z.object({ content: z.unknown(), baseVersion: z.number().int().min(1) });
const labelBody = z.object({ label: z.string().trim().max(120).optional() });
const submitBody = z.object({ revisionId: z.string().uuid().optional(), note: z.string().trim().max(1000).optional(), requestId: z.string().min(8).max(80).optional() });

type VariantRow = { id: string; campaign_id: string; language_id: string; draft_content: EmailContent; draft_version: number; draft_hash: string; updated_at: Date };

export function emailRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  const notFound = (reply: FastifyReply, what = 'Email') => reply.status(404).send({ error: 'not_found', message: `${what} not found.` });

  async function campaignRow(q: Queryable, id: string) {
    const r = await q.query<{ id: string; status: string; model: 'legacy' | 'v2'; draft_content: EmailContent }>(
      'SELECT id, status, model, draft_content FROM campaign WHERE id = $1 AND workspace_id = $2', [id, DEFAULT_WORKSPACE_ID],
    );
    return r.rows[0];
  }
  async function variantRow(q: Queryable, id: string, lock = false): Promise<(VariantRow & { status: string; direction: 'ltr' | 'rtl'; locale: string; language_name: string }) | undefined> {
    const r = await q.query<VariantRow & { status: string; direction: 'ltr' | 'rtl'; locale: string; language_name: string }>(
      `SELECT v.id, v.campaign_id, v.language_id, v.draft_content, v.draft_version, v.draft_hash, v.updated_at, c.status, l.direction, l.locale, l.name AS language_name
         FROM email_variant v JOIN campaign c ON c.id = v.campaign_id JOIN language l ON l.id = v.language_id
        WHERE v.id = $1 AND v.workspace_id = $2 ${lock ? 'FOR UPDATE OF v' : ''}`,
      [id, DEFAULT_WORKSPACE_ID],
    );
    const row = r.rows[0];
    return row && { ...row, draft_content: normalizeContent(row.draft_content) };
  }
  const toDraft = (v: NonNullable<Awaited<ReturnType<typeof variantRow>>>): EmailDraftDto => ({
    id: v.id, campaignId: v.campaign_id, languageId: v.language_id, name: emailName({ name: v.language_name }), status: v.status, direction: v.direction,
    draft: { content: v.draft_content, version: v.draft_version, hash: v.draft_hash, updatedAt: v.updated_at.toISOString() },
  });

  // ---- the language registry ----
  app.get('/api/languages', { config: { access: 'campaign.view' } }, async (): Promise<LanguageDto[]> => listLanguages(db));

  // ---- the languages of one email, and the emails written in them ----
  app.get<{ Params: { id: string } }>('/api/campaigns/:id/emails', { config: { access: 'campaign.view' } }, async (req, reply): Promise<CampaignEmails | FastifyReply> => {
    const { id } = idParam.parse(req.params);
    const c = await campaignRow(db, id);
    if (!c) return notFound(reply);
    return campaignEmails(db, id, c.model);
  });

  // "English, Arabic, German" or "all languages". Unknown names are refused, never guessed.
  app.put<{ Params: { id: string } }>('/api/campaigns/:id/languages', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { input } = languagesBody.parse(req.body);
    const userId = req.auth!.user.id;
    const registry = await listLanguages(db);
    const parsed = parseLanguageList(input, registry);
    if (parsed.unknown.length) return reply.status(400).send({ error: 'unknown_language', message: `Not a language we support: ${parsed.unknown.join(', ')}.`, unknown: parsed.unknown });
    if (parsed.ids.length === 0) return reply.status(400).send({ error: 'no_language', message: 'Enter at least one language, or "all languages".' });
    const result = await withTransaction(db, async (q) => {
      const c = await q.query<{ status: string; model: string }>('SELECT status, model FROM campaign WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [id, DEFAULT_WORKSPACE_ID]);
      if (!c.rows[0]) return { kind: 'missing' as const };
      if (c.rows[0].model !== 'v2') return { kind: 'legacy' as const };
      if (c.rows[0].status !== 'draft') return { kind: 'locked' as const };
      const out = await setSelectedLanguages(q, id, parsed.ids);
      if ('blocked' in out) return { kind: 'blocked' as const, blocked: out.blocked };
      await syncDerived(q, id);
      await logActivity(q, { actorId: userId, action: 'campaign.languages_set', entityType: 'campaign', entityId: id, details: { languages: parsed.ids } });
      return { kind: 'ok' as const };
    });
    if (result.kind === 'missing') return notFound(reply);
    if (result.kind === 'legacy') return reply.status(409).send({ error: 'legacy_email', message: 'This email uses the previous editor. Upgrade it first.' });
    if (result.kind === 'locked') return reply.status(409).send({ error: 'locked', message: 'This email can no longer be edited.' });
    if (result.kind === 'blocked') {
      const names = result.blocked.map((b) => registry.find((l) => l.id === b)?.name ?? b);
      return reply.status(409).send({ error: 'language_has_email', message: `${names.join(', ')} already ${names.length === 1 ? 'has an email' : 'have emails'}. Delete ${names.length === 1 ? 'it' : 'them'} first to remove the language.`, blocked: result.blocked });
    }
    return { duplicates: parsed.duplicates, emails: await campaignEmails(db, id, 'v2') };
  });

  // Segments and test audiences made from the rules of this email's language emails (read only: they follow the rules).
  app.get<{ Params: { id: string } }>('/api/campaigns/:id/derived', { config: { access: 'campaign.view' } }, async (req, reply): Promise<DerivedResponse | FastifyReply> => {
    const { id } = idParam.parse(req.params);
    if (!(await campaignRow(db, id))) return notFound(reply);
    return readDerived(db, id);
  });

  // Create the email of one language (English from the starting layout, any other from a saved email). Safe to retry with the same requestId.
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/emails', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = createBody.parse(req.body);
    const userId = req.auth!.user.id;
    const out = await withTransaction(db, async (q) => {
      const r = await createEmailVariant(q, { campaignId: id, languageId: body.languageId, createFromId: body.createFromId ?? null, userId, requestId: body.requestId ?? null });
      if (r.kind === 'ok' && !r.existing) {
        await syncDerived(q, id);
        await logActivity(q, { actorId: userId, action: body.createFromId ? 'email.cloned' : 'email.created', entityType: 'campaign', entityId: id, details: { language: body.languageId, from: body.createFromId ?? null, emailId: r.id } });
      }
      return r;
    });
    if (out.kind === 'error') return reply.status(out.status).send({ error: out.error, message: out.message });
    const v = await variantRow(db, out.id);
    return reply.status(out.existing ? 200 : 201).send(toDraft(v!));
  });

  // Upgrade an email made with the previous editor (keeps everything; copies per segment are kept read-only).
  app.post<{ Params: { id: string } }>('/api/campaigns/:id/upgrade', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const userId = req.auth!.user.id;
    const r = await withTransaction(db, async (q) => {
      const out = await upgradeCampaign(q, id, userId);
      if (typeof out === 'object') await syncDerived(q, id);
      if (typeof out === 'object') await logActivity(q, { actorId: userId, action: 'campaign.upgraded', entityType: 'campaign', entityId: id, details: out });
      return out;
    });
    if (r === 'missing') return notFound(reply);
    if (r === 'locked') return reply.status(409).send({ error: 'locked', message: 'This email can no longer be edited.' });
    if (r === 'done') return reply.status(200).send({ alreadyUpgraded: true });
    return reply.status(200).send({ alreadyUpgraded: false, report: r });
  });

  // ---- one language email ----
  app.get<{ Params: { id: string } }>('/api/emails/:id', { config: { access: 'campaign.view' } }, async (req, reply) => {
    const v = await variantRow(db, idParam.parse(req.params).id);
    return v ? toDraft(v) : notFound(reply);
  });

  app.delete<{ Params: { id: string } }>('/api/emails/:id', { config: { access: 'campaign.delete' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const userId = req.auth!.user.id;
    const r = await withTransaction(db, async (q) => {
      const v = await variantRow(q, id, true);
      if (!v) return 'missing' as const;
      if (v.status !== 'draft') return 'locked' as const;
      await q.query('DELETE FROM email_variant WHERE id = $1', [id]);
      await syncDerived(q, v.campaign_id);
      await logActivity(q, { actorId: userId, action: 'email.deleted', entityType: 'campaign', entityId: v.campaign_id, details: { language: v.language_id, emailId: id } });
      return 'ok' as const;
    });
    if (r === 'missing') return notFound(reply);
    if (r === 'locked') return reply.status(409).send({ error: 'locked', message: 'This email can no longer be edited.' });
    return reply.status(204).send();
  });

  // Autosave target: the same rules as for the previous editor (stale tab refused, locked palette, Admin only touches Custom HTML).
  app.put<{ Params: { id: string } }>('/api/emails/:id/draft', { config: { access: ['campaign.edit', 'html.custom'] } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = draftBody.parse(req.body);
    const v = validateContent(body.content);
    if (!v.ok) return reply.status(400).send({ error: 'invalid_content', message: v.error });
    const hash = hashOf(v.content);
    const missing = await missingAssets(db, collectAssetIds(v.content));
    if (missing.length) return reply.status(400).send({ error: 'missing_asset', message: 'A picture used in this email no longer exists in the asset library.' });
    const current = await variantRow(db, id);
    if (!current) return notFound(reply);
    if (current.status !== 'draft') return reply.status(409).send({ error: 'locked', message: 'This email can no longer be edited.' });
    const camp = await campaignRow(db, current.campaign_id);
    if (camp && v.content.settings.palette !== normalizeContent(camp.draft_content).settings.palette) {
      return reply.status(400).send({ error: 'palette_locked', message: 'The template colors are fixed when an email is created and cannot be changed.' });
    }
    const refusal = roleEditRefusal(req.auth!.user.role, current.draft_content, v.content);
    if (refusal) return reply.status(403).send({ error: 'forbidden_edit', message: refusal });
    if (current.draft_hash === hash) return { version: current.draft_version, hash, updatedAt: current.updated_at.toISOString() } satisfies SaveDraftResponse;
    // the segments and test audiences follow the rules: rebuilt in the same transaction when the blocks or their rules changed
    const r = await withTransaction(db, async (q) => {
      const res = await q.query<{ draft_version: number; updated_at: Date }>(
        `UPDATE email_variant SET draft_content = $3, draft_hash = $4, draft_version = draft_version + 1, updated_by = $5, updated_at = now()
          WHERE id = $1 AND workspace_id = $6 AND draft_version = $2 RETURNING draft_version, updated_at`,
        [id, body.baseVersion, JSON.stringify(v.content), hash, req.auth!.user.id, DEFAULT_WORKSPACE_ID],
      );
      if (res.rowCount === 1 && rulesSignature(current.draft_content) !== rulesSignature(v.content)) await syncDerived(q, current.campaign_id);
      return res;
    });
    if (r.rowCount !== 1) {
      const now = await variantRow(db, id);
      return reply.status(409).send({ error: 'version_conflict', message: 'This email was changed in another window or by someone else. Reload to see the latest version.', currentVersion: now?.draft_version });
    }
    return { version: r.rows[0]!.draft_version, hash, updatedAt: r.rows[0]!.updated_at.toISOString() } satisfies SaveDraftResponse;
  });

  // ---- revisions of one language email (each language has its own numbering) ----
  app.get<{ Params: { id: string } }>('/api/emails/:id/revisions', { config: { access: 'campaign.view' } }, async (req, reply): Promise<EmailRevisionSummary[] | FastifyReply> => {
    const { id } = idParam.parse(req.params);
    if (!(await variantRow(db, id))) return notFound(reply);
    const r = await db.query<{ id: string; number: number; kind: string; label: string | null; created_by_name: string | null; created_at: Date; content_hash: string; qa_state: EmailRevisionSummary['qaStatus'] }>(
      `SELECT r.id, r.number, r.kind, r.label, u.name AS created_by_name, r.created_at, r.content_hash,
              (SELECT s.state FROM qa_submission s WHERE s.revision_id = r.id ORDER BY s.created_at DESC LIMIT 1) AS qa_state
         FROM email_revision r LEFT JOIN app_user u ON u.id = r.created_by WHERE r.variant_id = $1 ORDER BY r.number DESC`,
      [id],
    );
    return r.rows.map((x) => ({ id: x.id, number: x.number, kind: x.kind, label: x.label, createdByName: x.created_by_name, createdAt: x.created_at.toISOString(), hash: x.content_hash, qaStatus: x.qa_state }));
  });

  // One saved revision with its content (to open or compare it).
  app.get<{ Params: { id: string; rid: string } }>('/api/emails/:id/revisions/:rid', { config: { access: 'campaign.view' } }, async (req, reply): Promise<EmailRevisionDetail | FastifyReply> => {
    const { id, rid } = revParams.parse(req.params);
    const r = await db.query<{ id: string; number: number; kind: string; label: string | null; created_by_name: string | null; created_at: Date; content_hash: string; content: unknown; qa_state: EmailRevisionSummary['qaStatus'] }>(
      `SELECT r.id, r.number, r.kind, r.label, u.name AS created_by_name, r.created_at, r.content_hash, r.content,
              (SELECT s.state FROM qa_submission s WHERE s.revision_id = r.id ORDER BY s.created_at DESC LIMIT 1) AS qa_state
         FROM email_revision r LEFT JOIN app_user u ON u.id = r.created_by WHERE r.id = $1 AND r.variant_id = $2`,
      [rid, id],
    );
    const x = r.rows[0];
    if (!x) return notFound(reply, 'Revision');
    return { id: x.id, number: x.number, kind: x.kind, label: x.label, createdByName: x.created_by_name, createdAt: x.created_at.toISOString(), hash: x.content_hash, qaStatus: x.qa_state, content: normalizeContent(x.content) };
  });

  // Send a saved revision to QA: the latest one unless another is named. The submission points at that exact revision and
  // never at the draft, so unsaved changes are never included and newer revisions never change what is under review.
  app.post<{ Params: { id: string } }>('/api/emails/:id/qa-submissions', { config: { access: 'campaign.submit' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = submitBody.parse(req.body ?? {});
    const userId = req.auth!.user.id;
    const out = await withTransaction(db, async (q) => {
      const v = await variantRow(q, id, true);
      if (!v) return { kind: 'missing' as const };
      if (v.status !== 'draft') return { kind: 'locked' as const };
      if (body.requestId) {
        const prior = await q.query<{ id: string; revision_id: string; state: string; number: number }>(
          'SELECT s.id, s.revision_id, s.state, r.number FROM qa_submission s JOIN email_revision r ON r.id = s.revision_id WHERE s.variant_id = $1 AND s.request_id = $2', [id, body.requestId]);
        if (prior.rows[0]) return { kind: 'ok' as const, existing: true, result: { id: prior.rows[0].id, revisionId: prior.rows[0].revision_id, revisionNumber: prior.rows[0].number, state: prior.rows[0].state, draftDiffers: false, existing: true } satisfies QaSubmissionResult };
      }
      const rev = body.revisionId
        ? await q.query<{ id: string; number: number; content_hash: string }>('SELECT id, number, content_hash FROM email_revision WHERE id = $1 AND variant_id = $2', [body.revisionId, id])
        : await q.query<{ id: string; number: number; content_hash: string }>('SELECT id, number, content_hash FROM email_revision WHERE variant_id = $1 ORDER BY number DESC LIMIT 1', [id]);
      const r = rev.rows[0];
      if (!r) return { kind: 'bad_revision' as const };
      const active = await q.query<{ state: string }>(`SELECT state FROM qa_submission WHERE revision_id = $1 AND state IN ('started', 'sent_for_corrections', 'retest', 'approved')`, [r.id]);
      if (active.rows[0]) return { kind: 'duplicate' as const, state: active.rows[0].state, number: r.number };
      const ins = await q.query<{ id: string; state: string }>(
        `INSERT INTO qa_submission (workspace_id, campaign_id, variant_id, revision_id, note, request_id, submitted_by) VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id, state`,
        [DEFAULT_WORKSPACE_ID, v.campaign_id, id, r.id, body.note ?? null, body.requestId ?? null, userId],
      );
      await logActivity(q, { actorId: userId, action: 'email.submitted_to_qa', entityType: 'campaign', entityId: v.campaign_id, details: { language: v.language_id, revision: r.number, submissionId: ins.rows[0]!.id, explicit: !!body.revisionId } });
      return { kind: 'ok' as const, existing: false, result: { id: ins.rows[0]!.id, revisionId: r.id, revisionNumber: r.number, state: ins.rows[0]!.state, draftDiffers: v.draft_hash !== r.content_hash, existing: false } satisfies QaSubmissionResult };
    });
    if (out.kind === 'missing') return notFound(reply);
    if (out.kind === 'locked') return reply.status(409).send({ error: 'locked', message: 'This email can no longer be edited.' });
    if (out.kind === 'bad_revision') return reply.status(400).send({ error: 'invalid_revision', message: 'Save a revision first, or choose one of this email\'s saved revisions.' });
    if (out.kind === 'duplicate') return reply.status(409).send({ error: 'already_submitted', message: `Revision ${out.number} is already with QA (${out.state === 'approved' ? 'approved' : 'under review'}).` });
    return reply.status(out.existing ? 200 : 201).send(out.result);
  });

  app.post<{ Params: { id: string } }>('/api/emails/:id/revisions', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { label } = labelBody.parse(req.body ?? {});
    const userId = req.auth!.user.id;
    const number = await withTransaction(db, async (q) => {
      const v = await variantRow(q, id, true);
      if (!v) return null;
      const n = await addEmailRevision(q, id, userId, 'manual', v.draft_content, { label: label || null });
      await logActivity(q, { actorId: userId, action: 'email.revision_saved', entityType: 'campaign', entityId: v.campaign_id, details: { language: v.language_id, number: n, label: label || null } });
      return n;
    });
    return number === null ? notFound(reply) : reply.status(201).send({ number });
  });

  // Restoring never rewrites history: the old content becomes the draft and a new "restore" revision is recorded.
  app.post<{ Params: { id: string; rid: string } }>('/api/emails/:id/revisions/:rid/restore', { config: { access: 'campaign.edit' } }, async (req, reply) => {
    const { id, rid } = revParams.parse(req.params);
    const userId = req.auth!.user.id;
    const result = await withTransaction(db, async (q) => {
      const v = await variantRow(q, id, true);
      if (!v) return 'missing' as const;
      if (v.status !== 'draft') return 'locked' as const;
      const rev = await q.query<{ number: number; content: EmailContent }>('SELECT number, content FROM email_revision WHERE id = $1 AND variant_id = $2', [rid, id]);
      if (!rev.rows[0]) return 'missing' as const;
      const content = normalizeContent(rev.rows[0].content);
      if (roleEditRefusal(req.auth!.user.role, v.draft_content, content)) return 'html' as const;
      await q.query('UPDATE email_variant SET draft_content = $2, draft_hash = $3, draft_version = draft_version + 1, updated_by = $4, updated_at = now() WHERE id = $1', [id, JSON.stringify(content), hashOf(content), userId]);
      const n = await addEmailRevision(q, id, userId, 'restore', content, { restoredFromId: rid });
      await syncDerived(q, v.campaign_id);
      await logActivity(q, { actorId: userId, action: 'email.revision_restored', entityType: 'campaign', entityId: v.campaign_id, details: { language: v.language_id, restoredNumber: rev.rows[0].number, newNumber: n } });
      return 'ok' as const;
    });
    if (result === 'missing') return notFound(reply);
    if (result === 'html') return reply.status(403).send({ error: 'forbidden_edit', message: 'That version has different Custom HTML blocks. Only an Admin can change those, so ask an Admin to restore it.' });
    if (result === 'locked') return reply.status(409).send({ error: 'locked', message: 'This email can no longer be edited.' });
    return toDraft((await variantRow(db, id))!);
  });

  // ---- preview of one language email (same renderer as everything else) ----
  app.get<{ Params: { id: string }; Querystring: { revision?: string; as?: string } }>('/api/emails/:id/preview', { config: { access: 'campaign.view' } }, async (req, reply): Promise<PreviewResponse | FastifyReply> => {
    const { id } = idParam.parse(req.params);
    const rid = z.string().uuid().optional().parse(req.query.revision);
    const as = z.string().max(80).default('sample').parse(req.query.as);
    const v = await variantRow(db, id);
    if (!v) return notFound(reply);
    const who = await resolveRecipient(db, v.campaign_id, as, hasCapability(req.auth!.user.role, 'audience.manage'));
    if (who.kind === 'not_found') return reply.status(400).send({ error: 'invalid_recipient', message: 'That recipient does not exist (any more).' });
    if (who.kind === 'forbidden') return reply.status(403).send({ error: 'forbidden' });
    let content = v.draft_content;
    if (rid) {
      const r = await db.query<{ content: EmailContent }>('SELECT content FROM email_revision WHERE id = $1 AND variant_id = $2', [rid, id]);
      if (!r.rows[0]) return notFound(reply, 'Revision');
      content = normalizeContent(r.rows[0].content);
    }
    const brand = await latestProfile(db, content.settings.palette);
    const knownFields = (await allFields(db)).map((f) => f.key);
    const fieldList = await allFields(db);
    const typeOf = (k: string) => fieldList.find((f) => f.key === k)?.type;
    // the same rules engine as everywhere else decides which blocks this recipient sees
    const shown = who.kind === 'recipient' && who.recipient ? visibleBlocks(content.blocks, (f) => (who.recipient as Record<string, string | number | boolean | null | undefined>)[f], typeOf) : content.blocks;
    const out = await renderEmail({ ...content, blocks: shown }, { baseUrl: config.baseUrl, brand, knownFields, language: { locale: v.locale, direction: v.direction }, ...(who.kind === 'recipient' ? { recipient: who.recipient } : {}) });
    out.versionLabel = `${emailName({ name: v.language_name })}${rid ? ' (saved revision)' : ''}${shown.length !== content.blocks.length ? ` · ${shown.length} of ${content.blocks.length} blocks` : ''}`;
    if (who.kind === 'recipient' && who.recipient) {
      const r = who.recipient as Record<string, string | number | boolean | null | undefined>;
      const labelOf = (k: string) => (fieldList.find((f) => f.key === k)?.label ?? k).replace(/ \(.*\)$/, '');
      out.blocks = content.blocks.map((b): BlockExplanationDto => ({ id: b.id, type: b.type, label: blockDefinition(b.type)?.label ?? b.type, ...explainBlock(b, (f) => r[f], typeOf, labelOf) }));
    }
    return who.kind === 'recipient' ? { ...out, recipientLabel: who.label } : out;
  });
}

