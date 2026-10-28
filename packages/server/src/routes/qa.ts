import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { hasCapability, type CorrectionDto, type QaIssueDto, type QaSubmissionDto, type QaVariantOverview, type SuppressionRuleDto } from '@cl/shared';
import type { AppConfig } from '../config.js';
import { DEFAULT_WORKSPACE_ID, withTransaction, type Db } from '../db.js';
import { approve, campaignQa, commentOn, correctionsFor, ignoreIssue, issueById, issuesOf, listSuppressions, refreshState, requestRetest, runQa, sendForCorrection, submissionDto } from '../qa.js';
import { logActivity } from '../services.js';

const idParam = z.object({ id: z.string().uuid() });
const commentBody = z.object({ comment: z.string().trim().max(2000) });
const ignoreBody = z.object({
  reason: z.string().trim().min(3, 'Give a reason.').max(500),
  scope: z.enum(['once', 'project', 'global']).default('once'),
  wholeCheck: z.boolean().default(false),
}).refine((b) => !(b.scope === 'once' && b.wholeCheck), { message: 'Ignoring a whole kind of finding needs the project or global scope.' });
const retestBody = z.object({ revisionId: z.string().uuid().optional() });
const revokeBody = z.object({ reason: z.string().trim().min(3, 'Give a reason.').max(500) });

export function qaRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  const notFound = (reply: FastifyReply, what = 'Not found') => reply.status(404).send({ error: 'not_found', message: `${what}.` });
  const approvedMsg = (reply: FastifyReply) => reply.status(409).send({ error: 'approved', message: 'This revision is already approved, so its findings can no longer change.' });

  // ---- the QA tab of one email: every language email with its status
  app.get<{ Params: { id: string } }>('/api/campaigns/:id/qa', { config: { access: 'campaign.view' } }, async (req, reply): Promise<QaVariantOverview[] | FastifyReply> => {
    const { id } = idParam.parse(req.params);
    const c = await db.query('SELECT 1 FROM campaign WHERE id = $1 AND workspace_id = $2', [id, DEFAULT_WORKSPACE_ID]);
    return c.rowCount ? campaignQa(db, id) : notFound(reply, 'Email not found');
  });

  app.get<{ Params: { id: string } }>('/api/qa-submissions/:id', { config: { access: 'campaign.view' } }, async (req, reply): Promise<{ submission: QaSubmissionDto; issues: QaIssueDto[] } | FastifyReply> => {
    const { id } = idParam.parse(req.params);
    const submission = await submissionDto(db, id);
    return submission ? { submission, issues: await issuesOf(db, id) } : notFound(reply, 'Submission not found');
  });

  // ---- run the checks on exactly the submitted revision
  app.post<{ Params: { id: string } }>('/api/qa-submissions/:id/runs', { config: { access: 'qa.review' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const out = await withTransaction(db, (q) => runQa(q, id, req.auth!.user.id, { baseUrl: config.baseUrl }));
    if (out === 'missing') return notFound(reply, 'Submission not found');
    if (out === 'approved') return approvedMsg(reply);
    return reply.status(201).send({ ...out, submission: await submissionDto(db, id), issues: await issuesOf(db, id) });
  });

  app.post<{ Params: { id: string } }>('/api/qa-submissions/:id/approve', { config: { access: 'qa.approve' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const out = await withTransaction(db, (q) => approve(q, id, req.auth!.user.id));
    if (out.kind === 'error') return reply.status(out.status).send({ error: out.error, message: out.message });
    return { submission: await submissionDto(db, id), issues: await issuesOf(db, id) };
  });

  // ---- findings
  app.patch<{ Params: { id: string } }>('/api/qa-issues/:id', { config: { access: 'qa.review' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { comment } = commentBody.parse(req.body);
    const done = await withTransaction(db, (q) => commentOn(q, id, req.auth!.user.id, comment));
    return done ? (await issueById(db, id)) : notFound(reply, 'Finding not found');
  });

  app.post<{ Params: { id: string } }>('/api/qa-issues/:id/ignore', { config: { access: 'qa.review' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const body = ignoreBody.parse(req.body);
    if (body.scope === 'global' && !hasCapability(req.auth!.user.role, 'qa.suppress_global')) {
      return reply.status(403).send({ error: 'forbidden', message: 'You may ignore a finding for this email only. Hiding a kind of finding for every email needs a different permission.' });
    }
    const out = await withTransaction(db, (q) => ignoreIssue(q, id, req.auth!.user.id, body));
    if (out === 'missing') return notFound(reply, 'Finding not found');
    if (out === 'approved') return approvedMsg(reply);
    return out;
  });

  app.post<{ Params: { id: string } }>('/api/qa-issues/:id/send-for-correction', { config: { access: 'qa.review' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { comment } = commentBody.parse(req.body ?? { comment: '' });
    const out = await withTransaction(db, (q) => sendForCorrection(q, id, req.auth!.user.id, comment));
    if (out === 'missing') return notFound(reply, 'Finding not found');
    if (out === 'approved') return approvedMsg(reply);
    if (out === 'not_open') return reply.status(409).send({ error: 'not_open', message: 'This finding is already resolved or ignored.' });
    return out;
  });

  // ---- the builder's side
  app.get<{ Params: { id: string } }>('/api/campaigns/:id/corrections', { config: { access: 'campaign.view' } }, async (req): Promise<CorrectionDto[]> => {
    const { id } = idParam.parse(req.params);
    // a Builder sees what is assigned to them; QA reviewers and Admins see all of the email's open corrections
    const mine = hasCapability(req.auth!.user.role, 'campaign.edit') ? req.auth!.user.id : null;
    return correctionsFor(db, id, mine);
  });

  app.post<{ Params: { id: string } }>('/api/emails/:id/retest', { config: { access: 'campaign.submit' } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { revisionId } = retestBody.parse(req.body ?? {});
    const out = await withTransaction(db, (q) => requestRetest(q, id, req.auth!.user.id, revisionId ?? null));
    if (out.kind === 'error') return reply.status(out.status).send({ error: out.error, message: out.message });
    return reply.status(201).send(out);
  });

  // ---- suppression rules (App Settings): reviewable, reversible, recorded
  app.get('/api/suppression-rules', { config: { access: ['qa.review', 'rules.manage'] } }, async (): Promise<SuppressionRuleDto[]> => listSuppressions(db));

  app.post<{ Params: { id: string } }>('/api/suppression-rules/:id/revoke', { config: { access: ['qa.review', 'rules.manage'] } }, async (req, reply) => {
    const { id } = idParam.parse(req.params);
    const { reason } = revokeBody.parse(req.body);
    const role = req.auth!.user.role;
    const userId = req.auth!.user.id;
    const out = await withTransaction(db, async (q) => {
      const r = await q.query<{ scope: 'project' | 'global'; revoked_at: Date | null; check_id: string }>('SELECT scope, revoked_at, check_id FROM suppression_rule WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [id, DEFAULT_WORKSPACE_ID]);
      const rule = r.rows[0];
      if (!rule) return 'missing' as const;
      if (rule.revoked_at) return 'revoked' as const;
      const allowed = rule.scope === 'global' ? hasCapability(role, 'qa.suppress_global') || hasCapability(role, 'rules.manage') : hasCapability(role, 'qa.review') || hasCapability(role, 'rules.manage');
      if (!allowed) return 'forbidden' as const;
      await q.query('UPDATE suppression_rule SET revoked_by = $2, revoked_at = now(), revoke_reason = $3 WHERE id = $1', [id, userId, reason]);
      // findings it was hiding come back, so nothing stays hidden by a rule that no longer exists
      const back = await q.query<{ id: string; submission_id: string }>(
        `UPDATE qa_issue SET status = 'open', suppressed_by = NULL, ignore_reason = NULL, updated_at = now()
          WHERE suppressed_by = $1 AND status = 'ignored' AND submission_id NOT IN (SELECT submission_id FROM qa_approval) RETURNING id, submission_id`, [id]);
      for (const s of new Set(back.rows.map((b) => b.submission_id))) await refreshState(q, s);
      await logActivity(q, { actorId: userId, action: 'qa.suppression_revoked', entityType: 'suppression_rule', entityId: id, details: { reason, reopened: back.rowCount } });
      return 'ok' as const;
    });
    if (out === 'missing') return notFound(reply, 'Rule not found');
    if (out === 'revoked') return reply.status(409).send({ error: 'already_revoked', message: 'This rule was already revoked.' });
    if (out === 'forbidden') return reply.status(403).send({ error: 'forbidden', message: 'You may not change this rule.' });
    return listSuppressions(db);
  });
}
