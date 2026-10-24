import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { blockDefinition, createInstance, segmentCode, type ContactDto, type PreviewRecipientsResponse, type TestContactDto } from '@cl/shared';
import { createTestApp, type Client, type TestApp } from './testkit.js';

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

const csv = [
  'Email,First Name,Country,Language',
  'a1@example.com,Ann,UAE,en',
  'a2@example.com,Amal,UAE,en',
  'b1@example.com,Bassem,EG,ar',
  'c1@example.com,Carla,UAE,ar',
].join('\n');

let campaignId = '';
beforeEach(async () => {
  await t.db.query('DELETE FROM contact');
  await t.db.query('DELETE FROM audience_setting');
  await builder.post('/api/contacts/import', { csv });
  campaignId = (await builder.post('/api/campaigns', { name: 'Audience test', palette: 'travel' })).body.id;
});

const setFields = (fields: string[], who: Client = builder) => who.put(`/api/campaigns/${campaignId}/audience`, { fields });
const generate = (body: object, who: Client = builder) => who.post(`/api/campaigns/${campaignId}/test-audience`, body);
const codes = (list: TestContactDto[]) => list.map((c) => c.code).sort();

describe('segment names', () => {
  it('are made from the chosen values in order: UAE-en, EG-ar', () => {
    expect(segmentCode(['UAE', 'en'])).toBe('UAE-en');
    expect(segmentCode(['EG', 'ar'])).toBe('EG-ar');
    expect(segmentCode(['EG', null])).toBe('EG-blank');
    expect(segmentCode(['Saudi  Arabia', true])).toBe('Saudi Arabia-yes');
  });
});

describe('choosing the fields that segment a campaign', () => {
  it('saves the choice in order, rejects unknown or unsuitable fields, and only a Builder can change it', async () => {
    const r = await setFields(['country', 'language']);
    expect(r.body.fields).toEqual(['country', 'language']);
    const got = (await builder.get(`/api/campaigns/${campaignId}/audience`)).body;
    expect(got.audience.fields).toEqual(['country', 'language']);
    expect(got.available.map((f: { key: string }) => f.key)).toContain('city');
    expect(got.available.map((f: { key: string }) => f.key)).not.toContain('email');
    expect((await setFields(['nope'])).status).toBe(400);
    expect((await setFields(['email'])).status).toBe(400);
    expect((await setFields(['country', 'city', 'language', 'company', 'first_name', 'last_name'])).status).toBe(400);
    expect((await setFields(['country'], admin)).status).toBe(403);
    expect((await setFields(['country'], qa)).status).toBe(403);
    expect((await admin.get(`/api/campaigns/${campaignId}/audience`)).status).toBe(200); // everyone who can see the campaign can see its set-up
  });

  it('cannot change once the campaign is no longer a draft', async () => {
    await t.db.query("UPDATE campaign SET status = 'submitted' WHERE id = $1", [campaignId]);
    expect((await setFields(['country'])).status).toBe(409);
    expect((await generate({ mode: 'sheet' })).status).toBe(409);
  });
});

describe('the generated test audience', () => {
  it('makes one made-up contact for each segment in your list, named like UAE-en, and never touches the real contacts', async () => {
    await setFields(['country', 'language']);
    const r = await generate({ mode: 'sheet' });
    expect(r.status).toBe(201);
    expect(codes(r.body)).toEqual(['EG-ar', 'UAE-ar', 'UAE-en']);
    const uae = (r.body as TestContactDto[]).find((c) => c.code === 'UAE-en')!;
    expect(uae.data).toMatchObject({ country: 'UAE', language: 'en', last_name: 'Test' });
    expect(uae.email.endsWith('.invalid')).toBe(true); // can never be a real mailbox
    const real = (await builder.get('/api/contacts')).body.contacts as ContactDto[];
    expect(real).toHaveLength(4); // the real list is untouched
    expect(real.some((c) => c.email.endsWith('.invalid'))).toBe(false);
    // making it again replaces the old set rather than piling up
    await generate({ mode: 'sheet' });
    expect((await builder.get(`/api/campaigns/${campaignId}/audience`)).body.test).toHaveLength(3);
  });

  it('"every combination" also makes the ones your list does not have yet, using values you add', async () => {
    await setFields(['country', 'language']);
    const r = await generate({ mode: 'all', extraValues: { country: ['SA'], language: ['fr'] } });
    // countries UAE, EG, SA x languages en, ar, fr
    expect(r.body).toHaveLength(9);
    expect(codes(r.body)).toEqual(expect.arrayContaining(['SA-fr', 'EG-en', 'UAE-fr']));
  });

  it('refuses a huge set, empty choices and bad values, with a clear message', async () => {
    expect((await generate({ mode: 'sheet' })).status).toBe(400); // no fields chosen yet
    await setFields(['country', 'language', 'city']);
    const many = Array.from({ length: 8 }, (_, i) => `V${i}`);
    const r = await generate({ mode: 'all', extraValues: { country: many, language: many, city: many } });
    expect(r.status).toBe(400);
    expect(r.body.message).toContain('60');
    await setFields(['orders']);
    const bad = await generate({ mode: 'all', extraValues: { orders: ['lots'] } });
    expect(bad.status).toBe(400);
    expect(bad.body.message).toContain('whole number');
  });

  it('choosing different fields removes the old test audience, and it can be removed on purpose', async () => {
    await setFields(['country', 'language']);
    await generate({ mode: 'sheet' });
    await setFields(['language']);
    expect((await builder.get(`/api/campaigns/${campaignId}/audience`)).body.test).toHaveLength(0);
    await generate({ mode: 'sheet' });
    expect((await builder.get(`/api/campaigns/${campaignId}/audience`)).body.test).toHaveLength(2);
    expect((await builder.delete(`/api/campaigns/${campaignId}/test-audience`)).status).toBe(204);
    expect((await builder.get(`/api/campaigns/${campaignId}/audience`)).body.test).toHaveLength(0);
  });

  it('the database refuses a test contact whose address could be real, and deleting the campaign removes its test audience', async () => {
    await setFields(['country']);
    await generate({ mode: 'sheet' });
    await expect(t.db.query("INSERT INTO campaign_test_contact (workspace_id, campaign_id, code, email, data) SELECT workspace_id, id, 'X', 'real@example.com', '{}' FROM campaign WHERE id = $1", [campaignId])).rejects.toThrow();
    expect((await builder.delete(`/api/campaigns/${campaignId}`)).status).toBe(204);
    expect((await t.db.query('SELECT 1 FROM campaign_test_contact WHERE campaign_id = $1', [campaignId])).rowCount).toBe(0);
  });
});

describe('Preview as a segment', () => {
  async function withGreeting() {
    const text = createInstance(blockDefinition('text')!);
    text.props.body = 'Hello {{first_name | fallback: "friend"}}, offers for {{country | fallback: "your country"}} in {{language | fallback: "your language"}}.';
    const c = (await builder.get(`/api/campaigns/${campaignId}`)).body;
    await builder.put(`/api/campaigns/${campaignId}/draft`, { content: { ...c.draft.content, blocks: [text] }, baseVersion: c.draft.version });
  }

  it('lists the test audience and the contacts of each segment by name, and shows the email as that recipient', async () => {
    await withGreeting();
    await setFields(['country', 'language']);
    const tests = (await generate({ mode: 'sheet' })).body as TestContactDto[];
    const rec = (await builder.get(`/api/campaigns/${campaignId}/preview-recipients`)).body as PreviewRecipientsResponse;
    expect(rec.segmentFields.map((f) => f.key)).toEqual(['country', 'language']);
    const titles = rec.groups.map((g) => g.title);
    expect(titles).toEqual(expect.arrayContaining(['Built-in examples', 'Test audience (made up for this campaign)', 'Contacts in segment UAE-en', 'Contacts in segment EG-ar']));
    const eg = tests.find((c) => c.code === 'EG-ar')!;
    const p = (await builder.get(`/api/campaigns/${campaignId}/preview?as=test:${eg.id}`)).body;
    expect(p.recipientLabel).toBe('EG-ar (test contact)');
    expect(p.html).toContain('offers for EG in ar');
    expect(p.text).toContain('offers for EG in ar');
    const real = (await builder.get('/api/contacts')).body.contacts.find((c: ContactDto) => c.email === 'a1@example.com');
    const pr = (await builder.get(`/api/campaigns/${campaignId}/preview?as=contact:${real.id}`)).body;
    expect(pr.recipientLabel).toBe('UAE-en  ·  a1@example.com');
    expect(pr.html).toContain('Hello Ann, offers for UAE in en');
    expect((await builder.get(`/api/campaigns/${campaignId}/preview?as=test:00000000-0000-4000-8000-00000000dead`)).status).toBe(400);
  });

  it('a QA reviewer can preview as a test contact but never sees or previews as a real contact', async () => {
    await withGreeting();
    await setFields(['country', 'language']);
    const tests = (await generate({ mode: 'sheet' })).body as TestContactDto[];
    const rec = (await qa.get(`/api/campaigns/${campaignId}/preview-recipients`)).body as PreviewRecipientsResponse;
    expect(rec.groups.map((g) => g.title)).toEqual(['Built-in examples', 'Test audience (made up for this campaign)']);
    expect(JSON.stringify(rec)).not.toContain('@example.com');
    expect((await qa.get(`/api/campaigns/${campaignId}/preview?as=test:${tests[0]!.id}`)).status).toBe(200);
    const real = (await builder.get('/api/contacts')).body.contacts[0] as ContactDto;
    expect((await qa.get(`/api/campaigns/${campaignId}/preview?as=contact:${real.id}`)).status).toBe(403);
  });

  it('your own fields work in placeholders and are not flagged as unknown', async () => {
    await builder.post('/api/contact-fields', { label: 'Country of residence', type: 'text' });
    const text = createInstance(blockDefinition('text')!);
    text.props.body = 'From {{country_of_residence | fallback: "somewhere"}} and {{nonsense | fallback: "x"}}';
    const c = (await builder.get(`/api/campaigns/${campaignId}`)).body;
    await builder.put(`/api/campaigns/${campaignId}/draft`, { content: { ...c.draft.content, blocks: [text] }, baseVersion: c.draft.version });
    const p = (await builder.get(`/api/campaigns/${campaignId}/preview`)).body;
    expect(p.placeholderIssues.map((i: { text: string }) => i.text)).toEqual(['{{nonsense | fallback: "x"}}']);
    await t.db.query('DELETE FROM contact_field');
  });
});
