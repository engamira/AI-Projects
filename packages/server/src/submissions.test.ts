import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockDefinition, createInstance, type EmailContent, type EmailRevisionSummary } from '@cl/shared';
import { createTestApp, type Client, type TestApp } from './testkit.js';

// Revisions of a language email, sending one to QA, and previewing with the reason each block is shown or hidden.

let t: TestApp;
let builder: Client;
let admin: Client;
let qa: Client;
beforeAll(async () => {
  t = await createTestApp();
  builder = await t.sessionFor(await t.seedUser('builder', { totp: true }));
  admin = await t.sessionFor(await t.seedUser('admin', { totp: true }));
  qa = await t.sessionFor(await t.seedUser('qa_reviewer', { totp: true }));
});
afterAll(() => t.close());

/** An English-Email with three saved revisions (each changes the subject). */
async function germanWithRevisions() {
  const c = (await builder.post('/api/campaigns', { name: 'Autumn', palette: 'travel', starter: true, model: 'v2' })).body;
  await builder.put(`/api/campaigns/${c.id}/languages`, { input: 'English, German' });
  const en = (await builder.post(`/api/campaigns/${c.id}/emails`, { languageId: 'en', createFromId: null })).body;
  const de = (await builder.post(`/api/campaigns/${c.id}/emails`, { languageId: 'de', createFromId: en.id })).body;
  let draft = de.draft as { content: EmailContent; version: number };
  for (const subject of ['Zweite Fassung', 'Dritte Fassung']) {
    const content = structuredClone(draft.content);
    content.settings.subject = subject;
    const saved = await builder.put(`/api/emails/${de.id}/draft`, { content, baseVersion: draft.version });
    draft = { content, version: saved.body.version };
    await builder.post(`/api/emails/${de.id}/revisions`, { label: subject });
  }
  const revs = (await builder.get(`/api/emails/${de.id}/revisions`)).body as EmailRevisionSummary[];
  return { campaignId: c.id as string, en, de, revs, draft };
}

describe('sending a revision to QA', { timeout: 240_000 }, () => {
  it('sends the latest saved revision by default, or the one chosen, and each language has its own numbers', async () => {
    const { de, revs } = await germanWithRevisions();
    expect(revs.map((r) => r.number)).toEqual([3, 2, 1]);
    expect(revs.every((r) => r.qaStatus === null)).toBe(true);

    const second = await builder.post(`/api/emails/${de.id}/qa-submissions`, { revisionId: revs[1]!.id });
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ revisionNumber: 2, revisionId: revs[1]!.id, state: 'started' });

    const latest = await builder.post(`/api/emails/${de.id}/qa-submissions`, {}); // nothing chosen
    expect(latest.status).toBe(201);
    expect(latest.body).toMatchObject({ revisionNumber: 3, revisionId: revs[0]!.id });

    const after = (await builder.get(`/api/emails/${de.id}/revisions`)).body as EmailRevisionSummary[];
    expect(after.map((r) => [r.number, r.qaStatus])).toEqual([[3, 'started'], [2, 'started'], [1, null]]);
  });

  it('refuses a revision of another email, a second submission of the same revision, and anyone but a Builder', async () => {
    const { de, en, revs } = await germanWithRevisions();
    const enRevs = (await builder.get(`/api/emails/${en.id}/revisions`)).body as EmailRevisionSummary[];
    expect((await builder.post(`/api/emails/${de.id}/qa-submissions`, { revisionId: enRevs[0]!.id })).status).toBe(400); // that is English's revision
    expect((await builder.post(`/api/emails/${de.id}/qa-submissions`, { revisionId: revs[2]!.id })).status).toBe(201);
    const dup = await builder.post(`/api/emails/${de.id}/qa-submissions`, { revisionId: revs[2]!.id });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toContain('Revision 1 is already with QA');
    expect((await qa.post(`/api/emails/${de.id}/qa-submissions`, {})).status).toBe(403);
    expect((await admin.post(`/api/emails/${de.id}/qa-submissions`, {})).status).toBe(403);
  });

  it('a retried send returns the first result and creates nothing new', async () => {
    const { de } = await germanWithRevisions();
    const a = await builder.post(`/api/emails/${de.id}/qa-submissions`, { requestId: 'send-0001' });
    const b = await builder.post(`/api/emails/${de.id}/qa-submissions`, { requestId: 'send-0001' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(200);
    expect(b.body.id).toBe(a.body.id);
    expect((await t.db.query('SELECT count(*)::int AS n FROM qa_submission WHERE variant_id = $1', [de.id])).rows[0].n).toBe(1);
  });

  it('never includes unsaved changes, and saving a newer revision does not change what is under review', async () => {
    const { de, draft } = await germanWithRevisions();
    const unsaved = structuredClone(draft.content);
    unsaved.settings.subject = 'Noch nicht gespeichert';
    await builder.put(`/api/emails/${de.id}/draft`, { content: unsaved, baseVersion: draft.version });
    const sent = await builder.post(`/api/emails/${de.id}/qa-submissions`, {});
    expect(sent.body).toMatchObject({ revisionNumber: 3, draftDiffers: true }); // the draft differs, and it was not sent
    const rev = (await builder.get(`/api/emails/${de.id}/revisions/${sent.body.revisionId}`)).body as { number: number; content: EmailContent };
    expect(rev.content.settings.subject).toBe('Dritte Fassung');

    // a newer revision is saved while QA is underway: the submission still points at revision 3
    await builder.post(`/api/emails/${de.id}/revisions`, { label: 'newer' });
    const row = (await t.db.query('SELECT r.number FROM qa_submission s JOIN email_revision r ON r.id = s.revision_id WHERE s.id = $1', [sent.body.id])).rows[0];
    expect(row.number).toBe(3);
    const list = (await builder.get(`/api/emails/${de.id}/revisions`)).body as EmailRevisionSummary[];
    expect(list.map((r) => [r.number, r.qaStatus])).toEqual([[4, null], [3, 'started'], [2, null], [1, null]]);
  });

  it('a revision is immutable and can be opened with its content', async () => {
    const { de, revs } = await germanWithRevisions();
    const one = (await builder.get(`/api/emails/${de.id}/revisions/${revs[2]!.id}`)).body as { number: number; content: EmailContent };
    expect(one.number).toBe(1);
    expect(one.content.blocks.length).toBeGreaterThan(0);
    await expect(t.db.query('UPDATE email_revision SET label = $2 WHERE id = $1', [revs[0]!.id, 'edited'])).rejects.toThrow(/immutable/);
    expect((await builder.get(`/api/emails/${de.id}/revisions/00000000-0000-4000-8000-000000000999`)).status).toBe(404);
  });
});

describe('previewing a language email as a test audience', { timeout: 240_000 }, () => {
  it('shows only what the audience sees, and says why for every block', async () => {
    const c = (await builder.post('/api/campaigns', { name: 'Why', palette: 'travel', model: 'v2' })).body;
    const en = (await builder.post(`/api/campaigns/${c.id}/emails`, { languageId: 'en', createFromId: null })).body;
    const content = en.draft.content as EmailContent;
    const uae = createInstance(blockDefinition('text')!);
    uae.props.heading = 'Only for the UAE';
    uae.rules = [{ id: crypto.randomUUID(), effect: 'show', when: { match: 'all', rules: [{ field: 'country', op: 'is', values: ['UAE'] }] } }];
    const everyone = createInstance(blockDefinition('text')!);
    everyone.props.heading = 'For everyone';
    content.blocks.push(uae, everyone);
    await builder.put(`/api/emails/${en.id}/draft`, { content, baseVersion: en.draft.version });
    const audiences = ((await builder.get(`/api/campaigns/${c.id}/derived`)).body as { audiences: { id: string; name: string }[] }).audiences;
    const inUae = audiences.find((a) => a.name === 'UAE English-Audience')!;
    const outside = audiences.find((a) => a.name === 'Not UAE English-Audience')!;

    const a = (await builder.get(`/api/emails/${en.id}/preview?as=audience:${inUae.id}`)).body;
    expect(a.html).toContain('Only for the UAE');
    expect(a.blocks.find((b: { id: string }) => b.id === uae.id)).toMatchObject({ visible: true, label: 'Text' });
    expect(a.blocks.find((b: { id: string }) => b.id === uae.id).summary).toContain('Shown: Show when Country is UAE is met');

    const b = (await builder.get(`/api/emails/${en.id}/preview?as=audience:${outside.id}`)).body;
    expect(b.html).not.toContain('Only for the UAE');
    expect(b.html).toContain('For everyone');
    expect(b.blocks.find((x: { id: string }) => x.id === uae.id)).toMatchObject({ visible: false });
    expect(b.blocks.find((x: { id: string }) => x.id === everyone.id).summary).toBe('No rules: always shown.');

    // a saved revision can be previewed too
    const revs = (await builder.get(`/api/emails/${en.id}/revisions`)).body as EmailRevisionSummary[];
    const old = (await builder.get(`/api/emails/${en.id}/preview?as=audience:${inUae.id}&revision=${revs[revs.length - 1]!.id}`)).body;
    expect(old.html).not.toContain('Only for the UAE'); // revision 1 was saved before that block existed
    expect(old.versionLabel).toContain('saved revision');
  });
});
