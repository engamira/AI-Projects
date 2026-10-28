import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CorrectionDto, type EmailContent, type QaIssueDto, type QaSubmissionDto, type QaVariantOverview, type SuppressionRuleDto } from '@cl/shared';
import { createTestApp, type Client, type TestApp } from './testkit.js';

// QA: checks on an exact revision, findings, ignore and suppression, corrections and retest, approval.

let t: TestApp;
let builder: Client;
let admin: Client;
let qa: Client;
let qa2: Client;
beforeAll(async () => {
  t = await createTestApp();
  builder = await t.sessionFor(await t.seedUser('builder', { totp: true }));
  admin = await t.sessionFor(await t.seedUser('admin', { totp: true }));
  qa = await t.sessionFor(await t.seedUser('qa_reviewer', { totp: true }));
  qa2 = await t.sessionFor(await t.seedUser('qa_reviewer', { totp: true }));
});
afterAll(() => t.close());

type Sub = { submission: QaSubmissionDto; issues: QaIssueDto[] };

/** An English email with a starter layout, saved as revision 1 and sent to QA. */
async function sentToQa(extra?: (c: EmailContent) => void) {
  const c = (await builder.post('/api/campaigns', { name: 'Autumn', palette: 'travel', starter: true, model: 'v2' })).body;
  await builder.put(`/api/campaigns/${c.id}/languages`, { input: 'English, German' });
  const en = (await builder.post(`/api/campaigns/${c.id}/emails`, { languageId: 'en', createFromId: null })).body;
  let draft = en.draft as { content: EmailContent; version: number };
  {
    const content = structuredClone(draft.content);
    content.settings.subject = ''; // the findings the tests look for: no subject, no preview text
    content.settings.preheader = '';
    extra?.(content);
    const saved = await builder.put(`/api/emails/${en.id}/draft`, { content, baseVersion: draft.version });
    draft = { content, version: saved.body.version };
    await builder.post(`/api/emails/${en.id}/revisions`, {});
  }
  const sent = (await builder.post(`/api/emails/${en.id}/qa-submissions`, {})).body as { id: string; revisionNumber: number };
  return { campaignId: c.id as string, en, draft, submissionId: sent.id, revisionNumber: sent.revisionNumber };
}
const run = (id: string, who: Client = qa) => who.post(`/api/qa-submissions/${id}/runs`, {});
const get = async (id: string) => (await builder.get(`/api/qa-submissions/${id}`)).body as Sub;
const ids = (issues: QaIssueDto[]) => issues.map((i) => i.checkId);

describe('running the QA checks', { timeout: 300_000 }, () => {
  it('checks the exact submitted revision, says what it could not check, and repeating it changes nothing', async () => {
    const s = await sentToQa();
    expect((await run(s.submissionId, builder)).status).toBe(403); // only QA reviewers run checks
    expect((await run(s.submissionId, admin)).status).toBe(403);
    const first = await run(s.submissionId);
    expect(first.status).toBe(201);
    const issues = first.body.issues as QaIssueDto[];
    expect(ids(issues)).toContain('settings.subject_missing'); // the starter layout has no subject yet
    expect(issues.every((i) => /^QA-\d{4}$/.test(i.label) && i.status === 'open' && i.revisionNumber === s.revisionNumber && i.source === 'deterministic')).toBe(true);
    const sub = first.body.submission as QaSubmissionDto;
    expect(sub.runs[0]!.coverage.notRun.some((n) => n.includes('Outlook'))).toBe(true); // it says what it cannot check
    expect(sub.runs[0]!.coverage.notRun.some((n) => n.includes('AI'))).toBe(true);
    const again = await run(s.submissionId);
    expect((again.body.issues as QaIssueDto[]).map((i) => i.id).sort()).toEqual(issues.map((i) => i.id).sort()); // same findings, same ids
  });

  it('finds a copy that was never translated', async () => {
    const s = await sentToQa((c) => { c.settings.subject = 'Autumn fares from Dubai'; });
    const de = (await builder.post(`/api/campaigns/${s.campaignId}/emails`, { languageId: 'de', createFromId: s.en.id })).body;
    await builder.post(`/api/emails/${de.id}/revisions`, {});
    const sent = (await builder.post(`/api/emails/${de.id}/qa-submissions`, {})).body;
    const r = await run(sent.id);
    expect(ids(r.body.issues)).toContain('localization.untranslated_copy');
  });
});

describe('findings, corrections, retest and approval', { timeout: 300_000 }, () => {
  it('goes from a sent-back finding to a fixed revision to an approval of that revision only', async () => {
    const s = await sentToQa();
    const issues = (await run(s.submissionId)).body.issues as QaIssueDto[];
    const subject = issues.find((i) => i.checkId === 'settings.subject_missing')!;

    // approval is refused while a high finding is open
    const blocked = await qa.post(`/api/qa-submissions/${s.submissionId}/approve`, {});
    expect(blocked.status).toBe(409);
    expect(blocked.body.message).toContain(subject.label);

    // QA sends it back with a note: it appears for the builder, and the status follows the findings
    const sent = await qa.post(`/api/qa-issues/${subject.id}/send-for-correction`, { comment: 'Please add the subject.' });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ status: 'sent_for_correction', reviewerComment: 'Please add the subject.', correctionStatus: 'pending' });
    const overview = (await qa.get(`/api/campaigns/${s.campaignId}/qa`)).body as QaVariantOverview[];
    expect(overview.find((o) => o.languageId === 'en')).toMatchObject({ status: 'sent_for_corrections', newerRevisionExists: false });
    expect(overview.map((o) => o.languageId)).toEqual(['en']); // only emails that have been created are listed
    const todo = (await builder.get(`/api/campaigns/${s.campaignId}/corrections`)).body as CorrectionDto[];
    expect(todo).toHaveLength(1);
    expect(todo[0]).toMatchObject({ qaNote: 'Please add the subject.', originalRevisionNumber: 2, emailName: 'English-Email', status: 'pending' });
    expect(todo[0]!.originalDescription).toContain('subject');

    // a retest needs a new saved revision
    expect((await builder.post(`/api/emails/${s.en.id}/retest`, {})).body.error).toBe('no_new_revision');
    const fixed = structuredClone(s.draft.content);
    fixed.settings.subject = 'Autumn fares from Dubai';
    const saved = await builder.put(`/api/emails/${s.en.id}/draft`, { content: fixed, baseVersion: s.draft.version });
    expect(saved.status).toBe(200);
    expect((await builder.post(`/api/emails/${s.en.id}/revisions`, { label: 'subject added' })).body.number).toBe(3);
    expect((await qa.post(`/api/emails/${s.en.id}/retest`, {})).status).toBe(403);
    const retest = await builder.post(`/api/emails/${s.en.id}/retest`, {});
    expect(retest.status).toBe(201);
    expect(retest.body).toMatchObject({ revisionNumber: 3, items: 1 });

    // a retest goes back to QA without being approved; the old finding is now waiting for its retest
    let ov = (await qa.get(`/api/campaigns/${s.campaignId}/qa`)).body as QaVariantOverview[];
    expect(ov.find((o) => o.languageId === 'en')).toMatchObject({ status: 'retest' });
    expect(ov.find((o) => o.languageId === 'en')!.submission!.approval).toBeNull();
    expect((await qa.post(`/api/qa-submissions/${retest.body.submissionId}/approve`, {})).body.error).toBe('not_checked');

    // QA runs the checks on revision 3: the subject finding is gone, so the old one is resolved and its correction closed
    const second = await run(retest.body.submissionId);
    expect(ids(second.body.issues)).not.toContain('settings.subject_missing');
    const old = await get(s.submissionId);
    expect(old.issues.find((i) => i.id === subject.id)).toMatchObject({ status: 'resolved', correctionStatus: 'resolved' });
    expect(((await builder.get(`/api/campaigns/${s.campaignId}/corrections`)).body as CorrectionDto[])).toHaveLength(0);

    // anything high that is still there must be dealt with; then QA approves revision 3
    for (const i of (second.body.issues as QaIssueDto[]).filter((x) => x.severity === 'high' || x.severity === 'critical')) {
      expect((await qa.post(`/api/qa-issues/${i.id}/ignore`, { reason: 'Checked by hand', scope: 'once' })).status).toBe(200);
    }
    expect((await builder.post(`/api/qa-submissions/${retest.body.submissionId}/approve`, {})).status).toBe(403); // a Builder cannot approve
    expect((await admin.post(`/api/qa-submissions/${retest.body.submissionId}/approve`, {})).status).toBe(403); // neither can an Admin
    const approved = await qa.post(`/api/qa-submissions/${retest.body.submissionId}/approve`, {});
    expect(approved.status).toBe(200);
    expect((approved.body as Sub).submission.approval).not.toBeNull();

    // the approval applies to revision 3 only, and findings of an approved revision no longer change
    ov = (await qa.get(`/api/campaigns/${s.campaignId}/qa`)).body as QaVariantOverview[];
    expect(ov.find((o) => o.languageId === 'en')).toMatchObject({ status: 'approved' });
    expect((await get(s.submissionId)).submission.approval).toBeNull();
    const any = (approved.body as Sub).issues[0];
    if (any) expect((await qa.post(`/api/qa-issues/${any.id}/ignore`, { reason: 'late', scope: 'once' })).status).toBe(409);
    expect((await run(retest.body.submissionId)).status).toBe(409);
    const row = (await t.db.query('SELECT r.number FROM qa_approval a JOIN email_revision r ON r.id = a.revision_id')).rows;
    expect(row.map((r) => r.number)).toEqual([3]);
  });

  it('the database refuses an approval by the author or the sender, and approvals cannot be changed', async () => {
    const s = await sentToQa();
    await run(s.submissionId);
    const sub = (await t.db.query('SELECT submitted_by, revision_id FROM qa_submission WHERE id = $1', [s.submissionId])).rows[0];
    await expect(t.db.query('INSERT INTO qa_approval (workspace_id, submission_id, revision_id, content_hash, reviewer_id) SELECT workspace_id, id, revision_id, \'x\', submitted_by FROM qa_submission WHERE id = $1', [s.submissionId]))
      .rejects.toThrow(/different person/);
    void sub;
    for (const i of ((await get(s.submissionId)).issues).filter((x) => x.severity === 'high' || x.severity === 'critical')) await qa.post(`/api/qa-issues/${i.id}/ignore`, { reason: 'Checked by hand', scope: 'once' });
    expect((await qa2.post(`/api/qa-submissions/${s.submissionId}/approve`, {})).status).toBe(200);
    await expect(t.db.query('UPDATE qa_approval SET content_hash = $1', ['y'])).rejects.toThrow(/cannot change/);
    await expect(t.db.query('DELETE FROM qa_approval')).rejects.toThrow(/cannot change/);
  });
});

describe('ignoring and suppression rules', { timeout: 300_000 }, () => {
  it('one exact finding can be hidden for the email or for everyone; each rule is listed, reversible and recorded', async () => {
    const a = await sentToQa();
    const first = (await run(a.submissionId)).body.issues as QaIssueDto[];
    const target = first.find((i) => i.checkId === 'settings.subject_missing')!;
    expect((await qa.post(`/api/qa-issues/${target.id}/ignore`, { reason: 'x' })).status).toBe(400); // a reason is needed
    expect((await qa.post(`/api/qa-issues/${target.id}/ignore`, { reason: 'Subject comes from the system', scope: 'once', wholeCheck: true })).status).toBe(400);
    const ign = await qa.post(`/api/qa-issues/${target.id}/ignore`, { reason: 'Subject comes from the system', scope: 'project' });
    expect(ign.status).toBe(200);
    expect(ign.body.status).toBe('ignored');
    let rules = (await qa.get('/api/suppression-rules')).body as SuppressionRuleDto[];
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ scope: 'project', checkId: 'settings.subject_missing', fingerprint: target.id ? expect.any(String) : null, reason: 'Subject comes from the system', revokedAt: null });
    expect(rules[0]!.description).toContain('settings.subject_missing');

    // another revision of the same email: the same finding is hidden by the rule, other findings are not
    const second = structuredClone(a.draft.content);
    second.settings.preheader = 'Preview';
    await builder.put(`/api/emails/${a.en.id}/draft`, { content: second, baseVersion: a.draft.version });
    await builder.post(`/api/emails/${a.en.id}/revisions`, {});
    const sent2 = (await builder.post(`/api/emails/${a.en.id}/qa-submissions`, {})).body;
    const r2 = (await run(sent2.id)).body.issues as QaIssueDto[];
    const hidden = r2.find((i) => i.checkId === 'settings.subject_missing')!;
    expect(hidden).toMatchObject({ status: 'ignored', suppressedBy: rules[0]!.id });
    expect(r2.filter((i) => i.status === 'open').length).toBeGreaterThan(0); // nothing else was hidden

    // a different email is not affected by a project rule
    const b = await sentToQa();
    expect(((await run(b.submissionId)).body.issues as QaIssueDto[]).find((i) => i.checkId === 'settings.subject_missing')!.status).toBe('open');

    // revoking brings the finding back; the rule stays in the list as revoked
    const revoked = await qa.post(`/api/suppression-rules/${rules[0]!.id}/revoke`, { reason: 'Not needed any more' });
    expect(revoked.status).toBe(200);
    rules = revoked.body as SuppressionRuleDto[];
    expect(rules[0]).toMatchObject({ revokedAt: expect.any(String), revokeReason: 'Not needed any more' });
    expect(((await get(sent2.id)).issues).find((i) => i.checkId === 'settings.subject_missing')!.status).toBe('open');
    expect((await qa.post(`/api/suppression-rules/${rules[0]!.id}/revoke`, { reason: 'again please' })).status).toBe(409);
    await expect(t.db.query('DELETE FROM suppression_rule')).rejects.toThrow(/revoked, never deleted/);
    expect((await builder.get('/api/suppression-rules')).status).toBe(403);
  });

  it('hiding a kind of finding for every email needs its own permission, and an Admin can revoke it', async () => {
    const a = await sentToQa();
    const target = ((await run(a.submissionId)).body.issues as QaIssueDto[]).find((i) => i.checkId === 'settings.preheader_missing')!;
    const g = await qa.post(`/api/qa-issues/${target.id}/ignore`, { reason: 'We never use preview text', scope: 'global', wholeCheck: true });
    expect(g.status).toBe(200);
    const b = await sentToQa();
    expect(((await run(b.submissionId)).body.issues as QaIssueDto[]).find((i) => i.checkId === 'settings.preheader_missing')!.status).toBe('ignored'); // other emails too
    const rules = (await admin.get('/api/suppression-rules')).body as SuppressionRuleDto[];
    const global = rules.find((r) => r.scope === 'global' && !r.revokedAt)!;
    expect(global.fingerprint).toBeNull();
    expect((await admin.post(`/api/suppression-rules/${global.id}/revoke`, { reason: 'Admin review' })).status).toBe(200);
    const audit = (await t.db.query("SELECT action FROM activity_log WHERE action LIKE 'qa.suppression%' ORDER BY created_at")).rows.map((r) => r.action as string);
    expect(audit).toContain('qa.suppression_created');
    expect(audit).toContain('qa.suppression_revoked');
  });
});
