import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  blockDefinition, cloneContent, createInstance, emptyContent, flatContent, newVariant, pickVariant, segmentKey, validateContent, versionOf,
  type EmailContent, type TestContactDto,
} from '@cl/shared';
import { createTestApp, type Client, type TestApp } from './testkit.js';

// One email per segment: the Default version plus full, independent copies written for particular segments.

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

const textBlock = (heading: string) => {
  const b = createInstance(blockDefinition('text')!);
  b.props.heading = heading;
  return b;
};

const base = (): EmailContent => {
  const c = emptyContent('travel');
  c.settings.subject = 'Hello';
  c.blocks = [textBlock('Default heading')];
  return c;
};

describe('matching a contact to a version', () => {
  it('ignores capitals and spacing, needs the same fields, and falls back to the Default', () => {
    const c = base();
    const uaeAr = newVariant(c, ['country', 'language'], ['UAE', 'ar']);
    c.variants = [uaeAr];
    expect(pickVariant(c, ['country', 'language'], { country: ' uae ', language: 'AR' })?.id).toBe(uaeAr.id);
    expect(pickVariant(c, ['country', 'language'], { country: 'UAE', language: 'en' })).toBeNull();
    expect(pickVariant(c, ['country', 'language'], { country: 'UAE' })).toBeNull(); // blank language is a different segment
    expect(pickVariant(c, ['language', 'country'], { country: 'UAE', language: 'ar' })).toBeNull(); // other field order = other segments
    expect(pickVariant(c, [], { country: 'UAE', language: 'ar' })).toBeNull();
    expect(segmentKey(['vip'], [true])).toBe(segmentKey(['vip'], ['Yes']));
  });

  it('a new version is an independent copy that keeps the block ids', () => {
    const c = base();
    const v = newVariant(c, ['country'], ['EG']);
    expect(v.blocks[0]!.id).toBe(c.blocks[0]!.id);
    v.blocks[0]!.props.heading = 'Changed';
    v.settings.subject = 'Other';
    expect(c.blocks[0]!.props.heading).toBe('Default heading');
    expect(c.settings.subject).toBe('Hello');
  });

  it('flatContent and versionOf give the version to render or edit', () => {
    const c = base();
    const v = newVariant(c, ['country'], ['EG']);
    v.settings.subject = 'EG subject';
    c.variants = [v];
    expect(flatContent(c, v).settings.subject).toBe('EG subject');
    expect(flatContent(c, v).variants).toBeUndefined();
    expect(flatContent(c, null).settings.subject).toBe('Hello');
    expect(versionOf(c, v.id).settings.subject).toBe('EG subject');
    expect(versionOf(c, 'nope').settings.subject).toBe('Hello');
  });

  it('copying a campaign gives every version and block new ids, consistently', () => {
    const c = base();
    c.variants = [newVariant(c, ['country'], ['EG'])];
    const copy = cloneContent(c, true);
    expect(copy.variants![0]!.id).not.toBe(c.variants[0]!.id);
    expect(copy.blocks[0]!.id).not.toBe(c.blocks[0]!.id);
    expect(copy.variants![0]!.blocks[0]!.id).toBe(copy.blocks[0]!.id); // same block, same new id in every version
  });
});

describe('validation', () => {
  it('accepts versions, and an email without versions stays exactly as before', () => {
    const plain = base();
    expect(validateContent(plain).ok).toBe(true);
    const c = base();
    c.variants = [newVariant(c, ['country', 'language'], ['UAE', 'ar'])];
    const r = validateContent(c);
    expect(r.ok).toBe(true);
    const none = validateContent({ ...base(), variants: [] });
    expect(none.ok && 'variants' in none.content).toBe(false);
  });

  it('refuses two versions for one segment, other template colors, and bad content inside a version', () => {
    const dup = base();
    dup.variants = [newVariant(dup, ['country'], ['EG']), newVariant(dup, ['country'], ['eg'])];
    expect(validateContent(dup)).toMatchObject({ ok: false, error: expect.stringContaining('same segment') });

    const pal = base();
    const v = newVariant(pal, ['country'], ['EG']);
    v.settings = { ...v.settings, palette: 'events' } as EmailContent['settings'];
    pal.variants = [v];
    expect(validateContent(pal)).toMatchObject({ ok: false, error: expect.stringContaining('template colors') });

    const bad = base();
    const w = newVariant(bad, ['country'], ['EG']);
    w.blocks[0]!.props.fontSize = 999;
    bad.variants = [w];
    const r = validateContent(bad);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('EG');
  });
});

describe('saving, previewing and who may change what', () => {
  let id = '';
  let ar: EmailContent['variants'] extends (infer V)[] | undefined ? V : never;
  beforeEach(async () => {
    await t.db.query('DELETE FROM contact');
    await t.db.query('DELETE FROM audience_setting');
    id = (await builder.post('/api/campaigns', { name: 'Versions', palette: 'travel' })).body.id;
    await builder.put(`/api/campaigns/${id}/audience`, { fields: ['country', 'language'] });
  });

  async function saveWithArabic() {
    const c = base();
    ar = newVariant(c, ['country', 'language'], ['UAE', 'ar']);
    ar.settings.subject = 'مرحبا';
    ar.blocks[0]!.props.heading = 'Arabic heading';
    c.variants = [ar];
    const r = await builder.put(`/api/campaigns/${id}/draft`, { content: c, baseVersion: 1 });
    expect(r.status).toBe(200);
    return c;
  }

  it('a Builder saves versions with the campaign, and changing a version changes the content fingerprint', async () => {
    const c = await saveWithArabic();
    const got = (await builder.get(`/api/campaigns/${id}`)).body;
    expect(got.draft.content.variants).toHaveLength(1);
    const h1 = got.draft.hash;
    c.variants![0]!.blocks[0]!.props.heading = 'Edited Arabic';
    const r = await builder.put(`/api/campaigns/${id}/draft`, { content: c, baseVersion: got.draft.version });
    expect(r.body.hash).not.toBe(h1); // approval will be tied to this hash, so editing any version invalidates it
  });

  it('Preview as a segment shows that segment\'s version; other contacts get the Default', async () => {
    await saveWithArabic();
    await builder.post(`/api/campaigns/${id}/test-audience`, { mode: 'values', values: { country: ['UAE'], language: ['ar', 'en'] } });
    const tests = (await builder.get(`/api/campaigns/${id}/audience`)).body.test as TestContactDto[];
    const uaeAr = tests.find((x) => x.code === 'UAE-ar')!;
    const uaeEn = tests.find((x) => x.code === 'UAE-en')!;
    const a = (await builder.get(`/api/campaigns/${id}/preview?as=test:${uaeAr.id}`)).body;
    expect(a.versionLabel).toBe('UAE-ar version');
    expect(a.html).toContain('Arabic heading');
    const e = (await builder.get(`/api/campaigns/${id}/preview?as=test:${uaeEn.id}`)).body;
    expect(e.versionLabel).toBe('Default version');
    expect(e.html).toContain('Default heading');
    expect(e.html).not.toContain('Arabic heading');
    // a real contact is matched by its own values
    await builder.post('/api/contacts', { email: 'x@example.com', country: 'uae', language: 'AR' });
    const real = (await builder.get('/api/contacts')).body.contacts[0];
    expect((await builder.get(`/api/campaigns/${id}/preview?as=contact:${real.id}`)).body.versionLabel).toBe('UAE-ar version');
    // while editing, the version being edited is shown whoever the sample is
    const explicit = (await builder.get(`/api/campaigns/${id}/preview?as=sample&variant=${ar.id}`)).body;
    expect(explicit.html).toContain('Arabic heading');
    expect((await builder.get(`/api/campaigns/${id}/preview?variant=00000000-0000-4000-8000-00000000dead`)).status).toBe(400);
    // an email without versions says nothing about versions
    const other = (await builder.post('/api/campaigns', { name: 'Plain', palette: 'travel' })).body.id;
    expect((await builder.get(`/api/campaigns/${other}/preview`)).body.versionLabel).toBeUndefined();
  });

  it('only an Admin may add or change Custom HTML inside a version, and an Admin cannot change anything else in it', async () => {
    const c = await saveWithArabic();
    const v = (await builder.get(`/api/campaigns/${id}`)).body.draft.version;

    const sneaky = JSON.parse(JSON.stringify(c)) as EmailContent;
    const html = createInstance(blockDefinition('custom_html')!);
    sneaky.variants![0]!.blocks.push(html);
    expect((await builder.put(`/api/campaigns/${id}/draft`, { content: sneaky, baseVersion: v })).status).toBe(403);

    expect((await admin.put(`/api/campaigns/${id}/draft`, { content: sneaky, baseVersion: v })).status).toBe(200);
    const v2 = (await builder.get(`/api/campaigns/${id}`)).body.draft.version;

    const tamper = JSON.parse(JSON.stringify(sneaky)) as EmailContent;
    tamper.variants![0]!.blocks[0]!.props.heading = 'Admin edit';
    expect((await admin.put(`/api/campaigns/${id}/draft`, { content: tamper, baseVersion: v2 })).status).toBe(403);
    const dropVersion = JSON.parse(JSON.stringify(sneaky)) as EmailContent;
    delete dropVersion.variants;
    expect((await admin.put(`/api/campaigns/${id}/draft`, { content: dropVersion, baseVersion: v2 })).status).toBe(403);
  });

  it('a QA reviewer can view the versions but not change them', async () => {
    const c = await saveWithArabic();
    expect((await qa.get(`/api/campaigns/${id}`)).body.draft.content.variants).toHaveLength(1);
    const v = (await builder.get(`/api/campaigns/${id}`)).body.draft.version;
    c.variants![0]!.blocks[0]!.props.heading = 'QA edit';
    expect((await qa.put(`/api/campaigns/${id}/draft`, { content: c, baseVersion: v })).status).toBe(403);
  });

  it('saved versions, restore and duplicate carry the segment versions', async () => {
    await saveWithArabic();
    expect((await builder.post(`/api/campaigns/${id}/revisions`, { label: 'with Arabic' })).status).toBe(201);
    const rev = (await builder.get(`/api/campaigns/${id}/revisions`)).body.find((r: { label: string | null }) => r.label === 'with Arabic');
    // remove the Arabic version, then restore the saved one
    const cur = (await builder.get(`/api/campaigns/${id}`)).body.draft;
    const stripped = { ...cur.content };
    delete stripped.variants;
    await builder.put(`/api/campaigns/${id}/draft`, { content: stripped, baseVersion: cur.version });
    const back = (await builder.post(`/api/campaigns/${id}/revisions/${rev.id}/restore`)).body;
    expect(back.draft.content.variants).toHaveLength(1);
    const dup = (await builder.post(`/api/campaigns/${id}/duplicate`)).body;
    expect(dup.draft.content.variants).toHaveLength(1);
    expect(dup.draft.content.variants[0].id).not.toBe(back.draft.content.variants[0].id);
  });
});
