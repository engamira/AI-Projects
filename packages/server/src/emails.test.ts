import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newVariant, parseLanguageList, type CampaignEmails, type EmailContent, type LanguageDto } from '@cl/shared';
import { createTestApp, type Client, type TestApp } from './testkit.js';

// Language emails: the registry, one email per language with its own revisions, cloning, upgrade of older emails, right-to-left.

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

const newEmail = async (name = 'Spring sale') => (await builder.post('/api/campaigns', { name, palette: 'travel', starter: true, model: 'v2' })).body as { id: string; model: string };
const setLanguages = (id: string, input: string, who: Client = builder) => who.put(`/api/campaigns/${id}/languages`, { input });
const emails = async (id: string) => (await builder.get(`/api/campaigns/${id}/emails`)).body as CampaignEmails;
const createEmail = (id: string, languageId: string, createFromId: string | null = null, requestId?: string, who: Client = builder) => who.post(`/api/campaigns/${id}/emails`, { languageId, createFromId, requestId });

describe('language registry', () => {
  it('has 26 languages with English first, and reads typed lists', async () => {
    const list = (await builder.get('/api/languages')).body as LanguageDto[];
    expect(list).toHaveLength(26);
    expect(list[0]!.id).toBe('en');
    expect(list.find((l) => l.id === 'ar')!.direction).toBe('rtl');
    expect(list.map((l) => l.name)).toContain('Italian');
    expect(parseLanguageList('german, English ,arabic', list).ids).toEqual(['en', 'de', 'ar']); // English first
    expect(parseLanguageList('ALL LANGUAGES', list).ids).toHaveLength(26);
    const bad = parseLanguageList('English, Klingon, english, Portuguese (Portugal)', list);
    expect(bad.unknown).toEqual(['Klingon']);
    expect(bad.duplicates).toEqual(['English']);
    expect(bad.ids).toEqual(['en', 'pt-pt']);
  });
});

describe('languages and emails of an email', () => {
  it('starts with English; a typed list, "all languages", and bad input are handled', async () => {
    const c = await newEmail();
    expect((await emails(c.id)).languages.map((l) => l.id)).toEqual(['en']);
    expect((await setLanguages(c.id, 'English, Arabic, German')).status).toBe(200);
    expect((await emails(c.id)).languages.map((l) => [l.id, l.emailName, l.variant])).toEqual([['en', 'English-Email', null], ['ar', 'Arabic-Email', null], ['de', 'German-Email', null]]);
    const unknown = await setLanguages(c.id, 'English, Klingon');
    expect(unknown.status).toBe(400);
    expect(unknown.body.unknown).toEqual(['Klingon']);
    expect((await setLanguages(c.id, '  ')).status).toBe(400);
    expect((await setLanguages(c.id, 'all languages')).status).toBe(200);
    expect((await emails(c.id)).languages).toHaveLength(26);
  });

  it('QA reviewers cannot change languages or create emails; reading is allowed', async () => {
    const c = await newEmail();
    expect((await setLanguages(c.id, 'English, German', qa)).status).toBe(403);
    expect((await createEmail(c.id, 'en', null, undefined, qa)).status).toBe(403);
    expect((await qa.get(`/api/campaigns/${c.id}/emails`)).status).toBe(200);
  });

  it('creates English from the starting layout, refuses duplicates, and a retry returns the first result', async () => {
    const c = await newEmail();
    const first = await createEmail(c.id, 'en', null, 'request-0001');
    expect(first.status).toBe(201);
    expect(first.body.name).toBe('English-Email');
    expect(first.body.draft.content.blocks.length).toBeGreaterThan(0);
    const again = await createEmail(c.id, 'en', null, 'request-0001');
    expect(again.status).toBe(200);
    expect(again.body.id).toBe(first.body.id);
    const dup = await createEmail(c.id, 'en', null, 'request-0002');
    expect(dup.status).toBe(409);
    expect((await emails(c.id)).languages[0]!.variant).toMatchObject({ revisionCount: 1, latestRevision: 1, unsavedChanges: false });
    expect((await createEmail(c.id, 'fr')).status).toBe(400); // French is not in the list
    await setLanguages(c.id, 'English, French');
    expect((await createEmail(c.id, 'fr')).status).toBe(400); // another language needs a saved email to copy from
  });

  it('clones an email: same blocks, styling and rules, new ids, and the copy is independent', async () => {
    const c = await newEmail();
    await setLanguages(c.id, 'English, German');
    const en = (await createEmail(c.id, 'en')).body;
    // give the English email a rule on its first block, then save that as a revision
    const content = en.draft.content as EmailContent;
    content.settings.subject = 'English subject';
    content.blocks[0]!.showWhen = { match: 'all', rules: [{ field: 'country', op: 'is', values: ['UAE'] }] };
    expect((await builder.put(`/api/emails/${en.id}/draft`, { content, baseVersion: en.draft.version })).status).toBe(200);
    expect((await builder.post(`/api/emails/${en.id}/revisions`, { label: 'with rule' })).body.number).toBe(2);

    const de = await createEmail(c.id, 'de', en.id);
    expect(de.status).toBe(201);
    expect(de.body.name).toBe('German-Email');
    const copy = de.body.draft.content as EmailContent;
    expect(copy.blocks.map((b) => b.type)).toEqual(content.blocks.map((b) => b.type));
    expect(copy.blocks[0]!.showWhen).toEqual(content.blocks[0]!.showWhen); // the rule came along
    expect(copy.settings.subject).toBe('English subject');
    for (const [i, b] of copy.blocks.entries()) expect(b.id).not.toBe(content.blocks[i]!.id); // fresh ids

    // changing the German email leaves English untouched
    copy.blocks[0]!.showWhen = undefined;
    copy.settings.subject = 'Deutscher Betreff';
    expect((await builder.put(`/api/emails/${de.body.id}/draft`, { content: copy, baseVersion: de.body.draft.version })).status).toBe(200);
    const enNow = (await builder.get(`/api/emails/${en.id}`)).body;
    expect(enNow.draft.content.settings.subject).toBe('English subject');
    expect(enNow.draft.content.blocks[0].showWhen).toBeTruthy();
    // revision numbers are per language
    expect((await emails(c.id)).languages.map((l) => [l.id, l.variant?.latestRevision])).toEqual([['en', 2], ['de', 1]]);
    expect((await builder.post(`/api/emails/${de.body.id}/revisions`, {})).body.number).toBe(2);
    expect((await builder.get(`/api/emails/${de.body.id}/revisions`)).body.map((r: { number: number }) => r.number)).toEqual([2, 1]);
  });

  it('copies the latest SAVED revision, not unsaved work', async () => {
    const c = await newEmail();
    await setLanguages(c.id, 'English, French');
    const en = (await createEmail(c.id, 'en')).body;
    const content = en.draft.content as EmailContent;
    content.settings.subject = 'Unsaved subject';
    await builder.put(`/api/emails/${en.id}/draft`, { content, baseVersion: en.draft.version });
    expect((await emails(c.id)).languages[0]!.variant!.unsavedChanges).toBe(true);
    const fr = (await createEmail(c.id, 'fr', en.id)).body;
    expect(fr.draft.content.settings.subject).not.toBe('Unsaved subject');
  });

  it('refuses to drop a language that has an email, and deleting the email frees it', async () => {
    const c = await newEmail();
    await setLanguages(c.id, 'English, German');
    const en = (await createEmail(c.id, 'en')).body;
    const de = (await createEmail(c.id, 'de', en.id)).body;
    const blocked = await setLanguages(c.id, 'English');
    expect(blocked.status).toBe(409);
    expect(blocked.body.blocked).toEqual(['de']);
    expect((await builder.delete(`/api/emails/${de.id}`)).status).toBe(204);
    expect((await setLanguages(c.id, 'English')).status).toBe(200);
    expect((await t.db.query('SELECT 1 FROM email_revision WHERE variant_id = $1', [de.id])).rowCount).toBe(0); // its history went with it
  });

  it('only a stale-free save is accepted, the palette is locked, and an Admin can only touch Custom HTML', async () => {
    const c = await newEmail();
    const en = (await createEmail(c.id, 'en')).body;
    const content = en.draft.content as EmailContent;
    const stale = await builder.put(`/api/emails/${en.id}/draft`, { content, baseVersion: 99 });
    expect(stale.status === 200 || stale.status === 409).toBe(true); // unchanged content is a no-op; changed content with a wrong version conflicts
    const changed = structuredClone(content);
    changed.settings.subject = 'New subject';
    expect((await builder.put(`/api/emails/${en.id}/draft`, { content: changed, baseVersion: 99 })).status).toBe(409);
    const recolor = structuredClone(content);
    recolor.settings.palette = 'events';
    expect((await builder.put(`/api/emails/${en.id}/draft`, { content: recolor, baseVersion: en.draft.version })).status).toBe(400);
    expect((await admin.put(`/api/emails/${en.id}/draft`, { content: changed, baseVersion: en.draft.version })).status).toBe(403);
  });

  it('right-to-left languages are rendered right to left', async () => {
    const c = await newEmail();
    await setLanguages(c.id, 'English, Arabic');
    const en = (await createEmail(c.id, 'en')).body;
    const ar = (await createEmail(c.id, 'ar', en.id)).body;
    const arHtml = (await builder.get(`/api/emails/${ar.id}/preview`)).body.html as string;
    expect(arHtml).toMatch(/<html[^>]*dir="rtl"/);
    expect(arHtml).toMatch(/lang="ar"/);
    const enHtml = (await builder.get(`/api/emails/${en.id}/preview`)).body.html as string;
    expect(enHtml).not.toMatch(/dir="rtl"/);
    expect((await builder.get(`/api/emails/${ar.id}/preview`)).body.versionLabel).toBe('Arabic-Email');
  });
});

describe('upgrading an email from the previous editor', () => {
  it('moves the default to English, language emails to their languages, keeps segment copies, loses nothing, and is safe to repeat', async () => {
    const legacy = (await builder.post('/api/campaigns', { name: 'Old email', palette: 'travel', starter: true })).body;
    expect(legacy.model).toBe('legacy');
    const content = legacy.draft.content as EmailContent;
    content.versioning = { mode: 'conditions', languageField: 'language' };
    const arEmail = newVariant(content, ['language'], ['ar'], 'language');
    const copy = newVariant(content, ['country', 'language'], ['UAE', 'en']);
    content.variants = [arEmail, copy];
    expect((await builder.put(`/api/campaigns/${legacy.id}/draft`, { content, baseVersion: legacy.draft.version })).status).toBe(200);
    await builder.post(`/api/campaigns/${legacy.id}/revisions`, { label: 'before upgrade' });

    const up = await builder.post(`/api/campaigns/${legacy.id}/upgrade`, {});
    expect(up.status).toBe(200);
    expect(up.body.report).toMatchObject({ languages: ['en', 'ar'], keptAsLegacy: 1 });
    const now = await emails(legacy.id);
    expect(now.model).toBe('v2');
    expect(now.languages.map((l) => [l.id, !!l.variant])).toEqual([['en', true], ['ar', true]]);
    // the English email has the old saved versions as revisions; nothing was deleted from the old tables
    expect(now.languages[0]!.variant!.revisionCount).toBeGreaterThanOrEqual(2);
    expect(now.languages[0]!.variant!.unsavedChanges).toBe(false);
    expect((await t.db.query('SELECT count(*)::int AS n FROM campaign_revision WHERE campaign_id = $1', [legacy.id])).rows[0].n).toBeGreaterThanOrEqual(2);
    const row = (await t.db.query('SELECT draft_content, legacy_variants FROM campaign WHERE id = $1', [legacy.id])).rows[0];
    expect(row.draft_content.variants).toHaveLength(2); // the old document is untouched
    expect(row.legacy_variants).toHaveLength(1); // the per-segment copy is kept, read only
    const enDraft = (await builder.get(`/api/emails/${now.languages[0]!.variant!.id}`)).body.draft.content as EmailContent;
    expect(enDraft.variants).toBeUndefined();
    expect(enDraft.versioning).toBeUndefined();

    expect((await builder.post(`/api/campaigns/${legacy.id}/upgrade`, {})).body.alreadyUpgraded).toBe(true);
    expect((await emails(legacy.id)).languages).toHaveLength(2);
    expect((await qa.post(`/api/campaigns/${legacy.id}/upgrade`, {})).status).toBe(403);
  });

  it('an email created with the new model is listed with its model and revision count', async () => {
    const c = await newEmail('Listed');
    await createEmail(c.id, 'en');
    const list = (await builder.get('/api/campaigns')).body as Array<{ id: string; model: string; revisionCount: number }>;
    expect(list.find((x) => x.id === c.id)).toMatchObject({ model: 'v2', revisionCount: 1 });
  });
});


describe('duplicating an email made with languages', () => {
  it('copies the languages and every language email, independent of the original', async () => {
    const c = await newEmail('To copy');
    await setLanguages(c.id, 'English, German');
    const en = (await createEmail(c.id, 'en')).body;
    await createEmail(c.id, 'de', en.id);
    const copy = (await builder.post(`/api/campaigns/${c.id}/duplicate`, {})).body;
    expect(copy.model).toBe('v2');
    const e = await emails(copy.id);
    expect(e.languages.map((l) => [l.id, !!l.variant])).toEqual([['en', true], ['de', true]]);
    expect(e.languages[0]!.variant!.id).not.toBe(en.id);
    expect(e.languages[1]!.variant!.latestRevision).toBe(1);
  });
});
