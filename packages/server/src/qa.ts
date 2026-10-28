import {
  QA_STATUS_LABELS, deriveQaStatus, emailName, isBlocking, issueLabel, normalizeContent,
  type CorrectionDto, type EmailContent, type IssueStatus, type QaIssueDto, type QaSeverity, type QaStatus, type QaSubmissionDto, type QaVariantOverview, type SubmissionState, type SuppressionRuleDto, type TestAudienceDto,
} from '@cl/shared';
import { allFields } from './contacts.js';
import { latestProfile } from './brand.js';
import { sha256 } from './crypto.js';
import { DEFAULT_WORKSPACE_ID, type Queryable } from './db.js';
import { CHECK_SET_VERSION, runChecks, type Finding } from './qaChecks.js';
import { logActivity, notifyUser } from './services.js';

// QA workflow rules, enforced here (and by the database where it matters):
//  - everything points at one immutable revision; a newer revision never changes what is under review;
//  - the status of an email is worked out from its findings and approval, never from the last click;
//  - the approver is never the person who wrote the revision or sent it to QA (Admin included);
//  - "ignore" for a whole kind of finding is a named, reversible suppression rule, kept in the history.

export type SubRow = {
  id: string; campaign_id: string; variant_id: string; revision_id: string; state: SubmissionState; submitted_by: string; previous_submission_id: string | null; created_at: Date;
  revision_number: number; content_hash: string; revision_content: EmailContent; revision_author: string;
  language_id: string; language_name: string; locale: string; direction: 'ltr' | 'rtl'; campaign_name: string; campaign_status: string;
};

export async function loadSubmission(q: Queryable, id: string, lock = false): Promise<SubRow | undefined> {
  const r = await q.query<SubRow>(
    `SELECT s.id, s.campaign_id, s.variant_id, s.revision_id, s.state, s.submitted_by, s.previous_submission_id, s.created_at,
            r.number AS revision_number, r.content_hash, r.content AS revision_content, r.created_by AS revision_author,
            v.language_id, l.name AS language_name, l.locale, l.direction, c.name AS campaign_name, c.status AS campaign_status
       FROM qa_submission s
       JOIN email_revision r ON r.id = s.revision_id
       JOIN email_variant v ON v.id = s.variant_id
       JOIN language l ON l.id = v.language_id
       JOIN campaign c ON c.id = s.campaign_id
      WHERE s.id = $1 AND s.workspace_id = $2 ${lock ? 'FOR UPDATE OF s' : ''}`,
    [id, DEFAULT_WORKSPACE_ID],
  );
  const row = r.rows[0];
  return row && { ...row, revision_content: normalizeContent(row.revision_content) };
}

export const fingerprintOf = (f: Pick<Finding, 'checkId' | 'blockId' | 'key'>): string => sha256([f.checkId, f.blockId ?? '', f.key].join('|'));

type IssueRow = {
  id: string; number: number; submission_id: string; variant_id: string; revision_id: string; fingerprint: string; check_id: string; category: QaIssueDto['category']; severity: QaSeverity;
  source: 'deterministic' | 'ai'; block_id: string | null; title: string; description: string; evidence: Record<string, unknown>; status: IssueStatus;
  reviewer_comment: string | null; ignore_reason: string | null; suppressed_by: string | null; carried_from: string | null;
  revision_number: number; language_id: string; language_name: string; correction_status: QaIssueDto['correctionStatus'];
};
const ISSUE_SELECT = `SELECT i.id, i.number, i.submission_id, i.variant_id, i.revision_id, i.fingerprint, i.check_id, i.category, i.severity, i.source, i.block_id, i.title, i.description, i.evidence, i.status,
       i.reviewer_comment, i.ignore_reason, i.suppressed_by, i.carried_from, r.number AS revision_number, v.language_id, l.name AS language_name, ci.status AS correction_status
  FROM qa_issue i JOIN email_revision r ON r.id = i.revision_id JOIN email_variant v ON v.id = i.variant_id JOIN language l ON l.id = v.language_id LEFT JOIN correction_item ci ON ci.issue_id = i.id`;
const SEVERITY_ORDER = `CASE i.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END`;

export const toIssueDto = (i: IssueRow): QaIssueDto => ({
  id: i.id, number: i.number, label: issueLabel(i.number), submissionId: i.submission_id, variantId: i.variant_id, revisionId: i.revision_id, revisionNumber: i.revision_number,
  languageId: i.language_id, languageName: i.language_name, checkId: i.check_id, category: i.category, severity: i.severity, source: i.source, blockId: i.block_id, title: i.title,
  description: i.description, evidence: i.evidence, status: i.status, reviewerComment: i.reviewer_comment, ignoredReason: i.ignore_reason, suppressedBy: i.suppressed_by,
  correctionStatus: i.correction_status, carriedFrom: i.carried_from,
});

export async function issuesOf(q: Queryable, submissionId: string): Promise<QaIssueDto[]> {
  const r = await q.query<IssueRow>(`${ISSUE_SELECT} WHERE i.submission_id = $1 ORDER BY ${SEVERITY_ORDER}, i.number`, [submissionId]);
  return r.rows.map(toIssueDto);
}

export async function issueById(q: Queryable, id: string): Promise<QaIssueDto | undefined> {
  const r = await q.query<IssueRow>(`${ISSUE_SELECT} WHERE i.id = $1 AND i.workspace_id = $2`, [id, DEFAULT_WORKSPACE_ID]);
  return r.rows[0] && toIssueDto(r.rows[0]);
}

/** Works out the state of a submission from its findings and approval and stores it. */
export async function refreshState(q: Queryable, submissionId: string): Promise<SubmissionState> {
  const s = await q.query<{ previous_submission_id: string | null; approved: boolean }>(
    'SELECT s.previous_submission_id, EXISTS (SELECT 1 FROM qa_approval a WHERE a.submission_id = s.id) AS approved FROM qa_submission s WHERE s.id = $1', [submissionId]);
  const row = s.rows[0]!;
  const issues = (await q.query<{ status: IssueStatus }>('SELECT status FROM qa_issue WHERE submission_id = $1', [submissionId])).rows;
  const status = deriveQaStatus({ hasSubmission: true, approved: row.approved, isRetest: !!row.previous_submission_id, issues });
  const state: SubmissionState = status === 'not_submitted' ? 'started' : status;
  await q.query('UPDATE qa_submission SET state = $2 WHERE id = $1 AND state <> $2', [submissionId, state]);
  return state;
}

// ---------- running the checks ----------

export async function runQa(q: Queryable, submissionId: string, userId: string, ctx: { baseUrl: string }): Promise<{ runId: string; found: number; suppressed: number } | 'missing' | 'approved'> {
  const sub = await loadSubmission(q, submissionId, true);
  if (!sub) return 'missing';
  const approved = await q.query('SELECT 1 FROM qa_approval WHERE submission_id = $1', [submissionId]);
  if (approved.rowCount) return 'approved';

  const lang = { id: sub.language_id, name: sub.language_name, locale: sub.locale, direction: sub.direction };
  const english = sub.language_id === 'en' ? null : (await q.query<{ content: EmailContent }>(
    `SELECT r.content FROM email_revision r JOIN email_variant v ON v.id = r.variant_id WHERE v.campaign_id = $1 AND v.language_id = 'en' ORDER BY r.number DESC LIMIT 1`, [sub.campaign_id])).rows[0]?.content;
  const aud = await q.query<Pick<TestAudienceDto, 'name' | 'expected'>>('SELECT name, expected FROM test_audience WHERE campaign_id = $1 AND language_id = $2 ORDER BY position', [sub.campaign_id, sub.language_id]);
  const brand = await latestProfile(q, sub.revision_content.settings.palette);
  const { findings, coverage } = await runChecks({
    content: sub.revision_content, language: lang, english: english ? normalizeContent(english) : null, audiences: aud.rows, fields: await allFields(q), brand, baseUrl: ctx.baseUrl,
  });

  const run = await q.query<{ id: string }>(
    `INSERT INTO qa_run (workspace_id, submission_id, kind, check_set_version, coverage, started_by, finished_at) VALUES ($1, $2, 'deterministic', $3, $4, $5, now()) RETURNING id`,
    [DEFAULT_WORKSPACE_ID, submissionId, CHECK_SET_VERSION, JSON.stringify(coverage), userId]);
  const runId = run.rows[0]!.id;

  const rules = (await q.query<{ id: string; check_id: string; fingerprint: string | null; reason: string }>(
    `SELECT id, check_id, fingerprint, reason FROM suppression_rule WHERE revoked_at IS NULL AND (scope = 'global' OR campaign_id = $1)`, [sub.campaign_id])).rows;
  const previous = sub.previous_submission_id
    ? (await q.query<{ id: string; fingerprint: string; status: IssueStatus }>('SELECT id, fingerprint, status FROM qa_issue WHERE submission_id = $1', [sub.previous_submission_id])).rows
    : [];
  const prevBy = new Map(previous.map((p) => [p.fingerprint, p]));
  const have = new Map((await q.query<{ id: string; fingerprint: string; status: IssueStatus; suppressed_by: string | null }>('SELECT id, fingerprint, status, suppressed_by FROM qa_issue WHERE submission_id = $1', [submissionId])).rows.map((r) => [r.fingerprint, r]));

  let suppressed = 0;
  const seen = new Set<string>();
  for (const fd of findings) {
    const fp = fingerprintOf(fd);
    if (seen.has(fp)) continue;
    seen.add(fp);
    const rule = rules.find((r) => r.check_id === fd.checkId && (r.fingerprint === null || r.fingerprint === fp));
    const existing = have.get(fp);
    if (existing) {
      // same finding as in an earlier run of this submission: keep its status and notes, refresh the details
      const reopen = existing.status === 'resolved';
      await q.query('UPDATE qa_issue SET run_id = $2, title = $3, description = $4, evidence = $5, severity = $6, status = CASE WHEN $7 THEN \'open\' ELSE status END, updated_at = now() WHERE id = $1',
        [existing.id, runId, fd.title, fd.description, JSON.stringify(fd.evidence), fd.severity, reopen]);
      continue;
    }
    if (rule) suppressed++;
    const prior = prevBy.get(fp);
    await q.query(
      `INSERT INTO qa_issue (workspace_id, campaign_id, variant_id, submission_id, run_id, revision_id, fingerprint, check_id, category, severity, source, block_id, title, description, evidence, status, ignore_reason, suppressed_by, carried_from)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'deterministic', $11, $12, $13, $14, $15, $16, $17, $18)`,
      [DEFAULT_WORKSPACE_ID, sub.campaign_id, sub.variant_id, submissionId, runId, sub.revision_id, fp, fd.checkId, fd.category, fd.severity, fd.blockId, fd.title, fd.description, JSON.stringify(fd.evidence),
        rule ? 'ignored' : 'open', rule ? `Hidden by a suppression rule: ${rule.reason}` : null, rule?.id ?? null, prior?.id ?? null],
    );
  }
  // findings of an earlier run that this run did not find any more are resolved
  for (const [fp, row] of have) if (!seen.has(fp) && row.status === 'open') await q.query(`UPDATE qa_issue SET status = 'resolved', updated_at = now() WHERE id = $1`, [row.id]);

  // a retest: findings that were sent back and are gone now are fixed; the ones still there stay with the builder
  for (const p of previous) {
    if (p.status !== 'sent_for_correction' && p.status !== 'retest') continue;
    if (seen.has(p.fingerprint)) continue;
    await q.query(`UPDATE qa_issue SET status = 'resolved', updated_at = now() WHERE id = $1`, [p.id]);
    await q.query(`UPDATE correction_item SET status = 'resolved', updated_at = now() WHERE issue_id = $1`, [p.id]);
  }
  await refreshState(q, submissionId);
  await logActivity(q, { actorId: userId, action: 'qa.run', entityType: 'campaign', entityId: sub.campaign_id, details: { language: sub.language_id, revision: sub.revision_number, submissionId, found: seen.size, suppressed } });
  return { runId, found: seen.size, suppressed };
}

// ---------- findings: comment, ignore, send for correction ----------

export async function commentOn(q: Queryable, issueId: string, userId: string, comment: string): Promise<boolean> {
  const r = await q.query('UPDATE qa_issue SET reviewer_comment = $2, updated_at = now() WHERE id = $1 AND workspace_id = $3', [issueId, comment || null, DEFAULT_WORKSPACE_ID]);
  if (r.rowCount) await q.query(`UPDATE correction_item SET qa_note = $2, updated_at = now() WHERE issue_id = $1`, [issueId, comment || null]);
  void userId;
  return !!r.rowCount;
}

export type IgnoreInput = { reason: string; scope: 'once' | 'project' | 'global'; wholeCheck: boolean };

export async function ignoreIssue(q: Queryable, issueId: string, userId: string, input: IgnoreInput): Promise<QaIssueDto | 'missing' | 'approved'> {
  const issue = await q.query<{ submission_id: string; campaign_id: string; check_id: string; fingerprint: string; title: string; status: IssueStatus }>(
    'SELECT submission_id, campaign_id, check_id, fingerprint, title, status FROM qa_issue WHERE id = $1 AND workspace_id = $2 FOR UPDATE', [issueId, DEFAULT_WORKSPACE_ID]);
  const row = issue.rows[0];
  if (!row) return 'missing';
  if ((await q.query('SELECT 1 FROM qa_approval WHERE submission_id = $1', [row.submission_id])).rowCount) return 'approved';
  let ruleId: string | null = null;
  if (input.scope !== 'once') {
    const description = input.wholeCheck ? `Every “${row.check_id}” finding` : `The finding “${row.title}” (${row.check_id})`;
    const rule = await q.query<{ id: string }>(
      `INSERT INTO suppression_rule (workspace_id, scope, campaign_id, check_id, fingerprint, description, reason, created_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [DEFAULT_WORKSPACE_ID, input.scope, input.scope === 'project' ? row.campaign_id : null, row.check_id, input.wholeCheck ? null : row.fingerprint, description, input.reason, userId]);
    ruleId = rule.rows[0]!.id;
    await logActivity(q, { actorId: userId, action: 'qa.suppression_created', entityType: 'suppression_rule', entityId: ruleId, details: { scope: input.scope, checkId: row.check_id, wholeCheck: input.wholeCheck, reason: input.reason } });
  }
  await q.query(`UPDATE qa_issue SET status = 'ignored', ignored_by = $2, ignore_reason = $3, suppressed_by = $4, updated_at = now() WHERE id = $1`, [issueId, userId, input.reason, ruleId]);
  await q.query(`UPDATE correction_item SET status = 'withdrawn', updated_at = now() WHERE issue_id = $1 AND status IN ('pending', 'retest_requested')`, [issueId]);
  await refreshState(q, row.submission_id);
  await logActivity(q, { actorId: userId, action: 'qa.issue_ignored', entityType: 'campaign', entityId: row.campaign_id, details: { issueId, scope: input.scope, reason: input.reason } });
  return (await issueById(q, issueId))!;
}

export async function sendForCorrection(q: Queryable, issueId: string, userId: string, comment: string): Promise<QaIssueDto | 'missing' | 'approved' | 'not_open'> {
  const r = await q.query<{ submission_id: string; campaign_id: string; variant_id: string; status: IssueStatus; description: string; title: string; revision_number: number; submitted_by: string; label: number }>(
    `SELECT i.submission_id, i.campaign_id, i.variant_id, i.status, i.description, i.title, rv.number AS revision_number, s.submitted_by, i.number AS label
       FROM qa_issue i JOIN qa_submission s ON s.id = i.submission_id JOIN email_revision rv ON rv.id = i.revision_id WHERE i.id = $1 AND i.workspace_id = $2 FOR UPDATE OF i`, [issueId, DEFAULT_WORKSPACE_ID]);
  const row = r.rows[0];
  if (!row) return 'missing';
  if ((await q.query('SELECT 1 FROM qa_approval WHERE submission_id = $1', [row.submission_id])).rowCount) return 'approved';
  if (row.status === 'ignored' || row.status === 'resolved') return 'not_open';
  await q.query(`UPDATE qa_issue SET status = 'sent_for_correction', reviewer_comment = COALESCE(NULLIF($2, ''), reviewer_comment), updated_at = now() WHERE id = $1`, [issueId, comment]);
  await q.query(
    `INSERT INTO correction_item (workspace_id, campaign_id, variant_id, issue_id, assigned_to, status, qa_note, original_description, original_revision_number, created_by)
     VALUES ($1, $2, $3, $4, $5, 'pending', NULLIF($6, ''), $7, $8, $9)
     ON CONFLICT (issue_id) DO UPDATE SET status = 'pending', qa_note = COALESCE(NULLIF($6, ''), correction_item.qa_note), updated_at = now()`,
    [DEFAULT_WORKSPACE_ID, row.campaign_id, row.variant_id, issueId, row.submitted_by, comment, `${row.title}. ${row.description}`, row.revision_number, userId]);
  await refreshState(q, row.submission_id);
  await notifyUser(q, row.submitted_by, { type: 'qa.correction', title: `QA-${String(row.label).padStart(4, '0')} needs a correction`, body: row.title, link: `/campaigns/${row.campaign_id}?tab=check` });
  await logActivity(q, { actorId: userId, action: 'qa.sent_for_correction', entityType: 'campaign', entityId: row.campaign_id, details: { issueId, comment } });
  return (await issueById(q, issueId))!;
}

// ---------- the builder asks for a retest ----------

export async function requestRetest(q: Queryable, variantId: string, userId: string, revisionId: string | null): Promise<
  { kind: 'ok'; submissionId: string; revisionNumber: number; items: number } | { kind: 'error'; status: number; error: string; message: string }> {
  const cur = await q.query<{ id: string; campaign_id: string; revision_number: number; revision_id: string }>(
    `SELECT s.id, s.campaign_id, s.revision_id, r.number AS revision_number FROM qa_submission s JOIN email_revision r ON r.id = s.revision_id
      WHERE s.variant_id = $1 ORDER BY s.created_at DESC LIMIT 1 FOR UPDATE OF s`, [variantId]);
  const c = cur.rows[0];
  if (!c) return { kind: 'error', status: 409, error: 'no_submission', message: 'This email has not been sent to QA.' };
  const pending = await q.query<{ id: string; issue_id: string }>(`SELECT id, issue_id FROM correction_item WHERE variant_id = $1 AND status = 'pending'`, [variantId]);
  if (pending.rows.length === 0) return { kind: 'error', status: 409, error: 'nothing_to_retest', message: 'No corrections are waiting for a retest.' };
  const rev = revisionId
    ? await q.query<{ id: string; number: number }>('SELECT id, number FROM email_revision WHERE id = $1 AND variant_id = $2', [revisionId, variantId])
    : await q.query<{ id: string; number: number }>('SELECT id, number FROM email_revision WHERE variant_id = $1 ORDER BY number DESC LIMIT 1', [variantId]);
  const r = rev.rows[0];
  if (!r) return { kind: 'error', status: 400, error: 'invalid_revision', message: 'Choose one of this email\'s saved revisions.' };
  if (r.number <= c.revision_number) return { kind: 'error', status: 409, error: 'no_new_revision', message: `Save a new revision with your corrections first. Revision ${c.revision_number} is the one QA already reviewed.` };
  const sub = await q.query<{ id: string }>(
    `INSERT INTO qa_submission (workspace_id, campaign_id, variant_id, revision_id, state, submitted_by, previous_submission_id) VALUES ($1, $2, $3, $4, 'retest', $5, $6) RETURNING id`,
    [DEFAULT_WORKSPACE_ID, c.campaign_id, variantId, r.id, userId, c.id]);
  const submissionId = sub.rows[0]!.id;
  await q.query(`UPDATE correction_item SET status = 'retest_requested', retest_submission_id = $2, updated_at = now() WHERE variant_id = $1 AND status = 'pending'`, [variantId, submissionId]);
  await q.query(`UPDATE qa_issue SET status = 'retest', updated_at = now() WHERE id = ANY($1::uuid[])`, [pending.rows.map((p) => p.issue_id)]);
  await refreshState(q, c.id);
  await refreshState(q, submissionId);
  await logActivity(q, { actorId: userId, action: 'qa.retest_requested', entityType: 'campaign', entityId: c.campaign_id, details: { variantId, from: c.revision_number, to: r.number, items: pending.rows.length } });
  return { kind: 'ok', submissionId, revisionNumber: r.number, items: pending.rows.length };
}

// ---------- approval ----------

export async function approve(q: Queryable, submissionId: string, userId: string): Promise<
  { kind: 'ok' } | { kind: 'error'; status: number; error: string; message: string }> {
  const sub = await loadSubmission(q, submissionId, true);
  if (!sub) return { kind: 'error', status: 404, error: 'not_found', message: 'Submission not found.' };
  if ((await q.query('SELECT 1 FROM qa_approval WHERE submission_id = $1', [submissionId])).rowCount) return { kind: 'ok' };
  if (userId === sub.revision_author || userId === sub.submitted_by) return { kind: 'error', status: 403, error: 'author_cannot_approve', message: 'The person who wrote this revision or sent it to QA cannot approve it.' };
  const runs = await q.query('SELECT 1 FROM qa_run WHERE submission_id = $1 LIMIT 1', [submissionId]);
  if (!runs.rowCount) return { kind: 'error', status: 409, error: 'not_checked', message: 'Run the QA checks on this revision before approving it.' };
  const issues = await issuesOf(q, submissionId);
  const blocking = issues.filter(isBlocking);
  if (blocking.length) return { kind: 'error', status: 409, error: 'blocking_issues', message: `${blocking.length} high or critical finding${blocking.length === 1 ? ' is' : 's are'} not resolved or ignored: ${blocking.map((b) => b.label).join(', ')}.` };
  await q.query('INSERT INTO qa_approval (workspace_id, submission_id, revision_id, content_hash, reviewer_id) VALUES ($1, $2, $3, $4, $5)', [DEFAULT_WORKSPACE_ID, submissionId, sub.revision_id, sub.content_hash, userId]);
  await refreshState(q, submissionId);
  await notifyUser(q, sub.submitted_by, { type: 'qa.approved', title: `${emailName({ name: sub.language_name })} revision ${sub.revision_number} was approved`, link: `/campaigns/${sub.campaign_id}?tab=qa` });
  await logActivity(q, { actorId: userId, action: 'qa.approved', entityType: 'campaign', entityId: sub.campaign_id, details: { language: sub.language_id, revision: sub.revision_number, submissionId, contentHash: sub.content_hash } });
  return { kind: 'ok' };
}

// ---------- reading ----------

export async function submissionDto(q: Queryable, id: string): Promise<QaSubmissionDto | undefined> {
  const r = await q.query<{ id: string; variant_id: string; revision_id: string; state: SubmissionState; created_at: Date; previous_submission_id: string | null; revision_number: number; by_name: string | null; reviewer_name: string | null; approved_at: Date | null }>(
    `SELECT s.id, s.variant_id, s.revision_id, s.state, s.created_at, s.previous_submission_id, r.number AS revision_number, u.name AS by_name, rv.name AS reviewer_name, a.approved_at
       FROM qa_submission s JOIN email_revision r ON r.id = s.revision_id LEFT JOIN app_user u ON u.id = s.submitted_by
       LEFT JOIN qa_approval a ON a.submission_id = s.id LEFT JOIN app_user rv ON rv.id = a.reviewer_id WHERE s.id = $1 AND s.workspace_id = $2`, [id, DEFAULT_WORKSPACE_ID]);
  const s = r.rows[0];
  if (!s) return undefined;
  const runs = await q.query<{ id: string; kind: 'deterministic' | 'ai'; started_at: Date; finished_at: Date | null; coverage: { ran: string[]; notRun: string[] } }>(
    'SELECT id, kind, started_at, finished_at, coverage FROM qa_run WHERE submission_id = $1 ORDER BY started_at DESC', [id]);
  return {
    id: s.id, variantId: s.variant_id, revisionId: s.revision_id, revisionNumber: s.revision_number, state: s.state, submittedByName: s.by_name, createdAt: s.created_at.toISOString(),
    previousSubmissionId: s.previous_submission_id, approval: s.approved_at ? { reviewerName: s.reviewer_name, approvedAt: s.approved_at.toISOString() } : null,
    runs: runs.rows.map((x) => ({ id: x.id, kind: x.kind, startedAt: x.started_at.toISOString(), finishedAt: x.finished_at?.toISOString() ?? null, coverage: x.coverage })),
  };
}

export async function campaignQa(q: Queryable, campaignId: string): Promise<QaVariantOverview[]> {
  const v = await q.query<{ id: string; language_id: string; language_name: string; latest_revision: number | null }>(
    `SELECT v.id, v.language_id, l.name AS language_name, (SELECT max(number) FROM email_revision r WHERE r.variant_id = v.id) AS latest_revision
       FROM email_variant v JOIN language l ON l.id = v.language_id WHERE v.campaign_id = $1 ORDER BY l.sort`, [campaignId]);
  const out: QaVariantOverview[] = [];
  for (const x of v.rows) {
    const s = await q.query<{ id: string }>('SELECT id FROM qa_submission WHERE variant_id = $1 ORDER BY created_at DESC LIMIT 1', [x.id]);
    const submission = s.rows[0] ? (await submissionDto(q, s.rows[0].id)) ?? null : null;
    const issues = submission ? await issuesOf(q, submission.id) : [];
    const status: QaStatus = deriveQaStatus({ hasSubmission: !!submission, approved: !!submission?.approval, isRetest: !!submission?.previousSubmissionId, issues });
    out.push({
      variantId: x.id, languageId: x.language_id, languageName: x.language_name, emailName: emailName({ name: x.language_name }), latestRevision: x.latest_revision, status,
      submission, openIssues: issues.filter((i) => i.status === 'open' || i.status === 'sent_for_correction' || i.status === 'retest').length, blockingIssues: issues.filter(isBlocking).length,
      newerRevisionExists: !!submission && x.latest_revision !== null && x.latest_revision > submission.revisionNumber,
    });
  }
  return out;
}

export async function correctionsFor(q: Queryable, campaignId: string, assignedTo: string | null): Promise<CorrectionDto[]> {
  const r = await q.query<{ id: string; issue_id: string; campaign_id: string; campaign_name: string; variant_id: string; language_name: string; status: CorrectionDto['status']; qa_note: string | null; original_description: string; original_revision_number: number; assigned_name: string | null; created_at: Date }>(
    `SELECT ci.id, ci.issue_id, ci.campaign_id, c.name AS campaign_name, ci.variant_id, l.name AS language_name, ci.status, ci.qa_note, ci.original_description, ci.original_revision_number, u.name AS assigned_name, ci.created_at
       FROM correction_item ci JOIN campaign c ON c.id = ci.campaign_id JOIN email_variant v ON v.id = ci.variant_id JOIN language l ON l.id = v.language_id LEFT JOIN app_user u ON u.id = ci.assigned_to
      WHERE ci.campaign_id = $1 AND ci.status IN ('pending', 'retest_requested') AND ($2::uuid IS NULL OR ci.assigned_to = $2)
      ORDER BY ci.created_at DESC`, [campaignId, assignedTo]);
  const out: CorrectionDto[] = [];
  for (const x of r.rows) {
    const issue = await issueById(q, x.issue_id);
    if (!issue) continue;
    out.push({ id: x.id, issue, campaignId: x.campaign_id, campaignName: x.campaign_name, variantId: x.variant_id, emailName: emailName({ name: x.language_name }), status: x.status, qaNote: x.qa_note, originalDescription: x.original_description, originalRevisionNumber: x.original_revision_number, assignedToName: x.assigned_name, createdAt: x.created_at.toISOString() });
  }
  return out;
}

export async function listSuppressions(q: Queryable): Promise<SuppressionRuleDto[]> {
  const r = await q.query<{ id: string; scope: 'project' | 'global'; campaign_id: string | null; campaign_name: string | null; check_id: string; fingerprint: string | null; description: string; reason: string; created_by_name: string | null; created_at: Date; revoked_by_name: string | null; revoked_at: Date | null; revoke_reason: string | null }>(
    `SELECT s.id, s.scope, s.campaign_id, c.name AS campaign_name, s.check_id, s.fingerprint, s.description, s.reason, cu.name AS created_by_name, s.created_at, ru.name AS revoked_by_name, s.revoked_at, s.revoke_reason
       FROM suppression_rule s LEFT JOIN campaign c ON c.id = s.campaign_id LEFT JOIN app_user cu ON cu.id = s.created_by LEFT JOIN app_user ru ON ru.id = s.revoked_by
      WHERE s.workspace_id = $1 ORDER BY (s.revoked_at IS NOT NULL), s.created_at DESC`, [DEFAULT_WORKSPACE_ID]);
  return r.rows.map((x) => ({ id: x.id, scope: x.scope, campaignId: x.campaign_id, campaignName: x.campaign_name, checkId: x.check_id, fingerprint: x.fingerprint, description: x.description, reason: x.reason, createdByName: x.created_by_name, createdAt: x.created_at.toISOString(), revokedByName: x.revoked_by_name, revokedAt: x.revoked_at?.toISOString() ?? null, revokeReason: x.revoke_reason }));
}

export const statusLabel = (s: QaStatus): string => QA_STATUS_LABELS[s];
