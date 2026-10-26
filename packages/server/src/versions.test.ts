import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  activeLanguageVersions, blocksShownFor, defaultEmailName, derivedSegments, routeKeyFor, versionName, describeCondition, evaluateCondition, pickVersion, validateCondition, type Comparison, type ConditionGroup,
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


describe('conditions on blocks', () => {
  const get = (c: Record<string, string | number | boolean | null>) => (f: string) => c[f];
  const types = (f: string) => ({ country: 'text', language: 'text', orders: 'number', since: 'date', vip: 'boolean' } as const)[f as 'country'];
  const rule = (field: string, op: Comparison, ...values: string[]) => ({ field, op, values });
  const all = (...rules: ConditionGroup['rules']): ConditionGroup => ({ match: 'all', rules });
  const any = (...rules: ConditionGroup['rules']): ConditionGroup => ({ match: 'any', rules });

  it('compares text without caring about capitals, and numbers, dates and yes/no by their kind', () => {
    const uae = { country: ' uae ', language: 'AR', orders: 12, since: '2024-05-01', vip: true };
    const ev = (c: ConditionGroup, who = uae) => evaluateCondition(c, get(who), types);
    expect(ev(all(rule('country', 'is', 'UAE')))).toBe(true);
    expect(ev(all(rule('country', 'is_not', 'UAE')))).toBe(false);
    expect(ev(all(rule('country', 'is_one_of', 'KSA', 'uae')))).toBe(true);
    expect(ev(all(rule('country', 'contains', 'ua')))).toBe(true);
    expect(ev(all(rule('country', 'not_contains', 'ua')))).toBe(false);
    expect(ev(all(rule('orders', 'greater', '10')))).toBe(true);
    expect(ev(all(rule('orders', 'less', '10')))).toBe(false);
    expect(ev(all(rule('orders', 'greater', '9'), rule('orders', 'less', '20')))).toBe(true);
    expect(ev(all(rule('since', 'less', '2025-01-01')))).toBe(true); // before
    expect(ev(all(rule('since', 'greater', '2025-01-01')))).toBe(false); // after
    expect(ev(all(rule('vip', 'is', 'yes')))).toBe(true);
    expect(ev(all(rule('vip', 'is', 'no')))).toBe(false);
    expect(ev(all(rule('vip', 'is_not', 'no')))).toBe(true);
  });

  it('blank values: blank, not blank, and "is not" a value', () => {
    const none = { country: null, language: '', orders: null, since: null, vip: null };
    const ev = (c: ConditionGroup) => evaluateCondition(c, get(none), types);
    expect(ev(all(rule('country', 'is_blank')))).toBe(true);
    expect(ev(all(rule('language', 'is_blank')))).toBe(true);
    expect(ev(all(rule('country', 'is_not_blank')))).toBe(false);
    expect(ev(all(rule('country', 'is', 'UAE')))).toBe(false);
    expect(ev(all(rule('country', 'is_not', 'UAE')))).toBe(true);
    expect(ev(all(rule('orders', 'greater', '1')))).toBe(false);
  });

  it('AND, OR and groups', () => {
    const c = { country: 'KSA', language: 'ar', orders: 0, since: null, vip: true };
    const g = all(any(rule('country', 'is', 'UAE'), rule('country', 'is', 'KSA')), rule('vip', 'is', 'yes'));
    expect(evaluateCondition(g, get(c), types)).toBe(true);
    expect(evaluateCondition(g, get({ ...c, vip: false }), types)).toBe(false);
    expect(evaluateCondition(g, get({ ...c, country: 'EG' }), types)).toBe(false);
    expect(describeCondition(g, (k) => k.toUpperCase(), types)).toBe('(COUNTRY is UAE or COUNTRY is KSA) and VIP is yes');
  });

  it('rejects malformed conditions', () => {
    expect(validateCondition(all(rule('country', 'is', 'UAE')))).toBeNull();
    expect(validateCondition({ match: 'all', rules: [] })).toContain('at least one');
    expect(validateCondition({ match: 'maybe', rules: [rule('country', 'is', 'x')] })).toContain('all');
    expect(validateCondition(all({ field: 'Country!', op: 'is', values: ['x'] }))).toContain('invalid field');
    expect(validateCondition(all({ field: 'country', op: 'matches', values: ['x'] } as never))).toContain('unknown comparison');
    expect(validateCondition(all({ field: 'country', op: 'is', values: [] }))).toContain('needs a value');
    let deep: ConditionGroup = all(rule('country', 'is', 'x'));
    for (let i = 0; i < 4; i++) deep = all(deep);
    expect(validateCondition(deep)).toContain('nested');
    const many = all(...Array.from({ length: 21 }, () => rule('country', 'is', 'x')));
    expect(validateCondition(many)).toContain('at most');
  });

  it('a block with a condition is saved and shown only to matching contacts', () => {
    const c = base();
    const b = textBlock('Only UAE');
    b.showWhen = all(rule('country', 'is', 'UAE'));
    c.blocks.push(b);
    expect(validateContent(c).ok).toBe(true);
    expect(blocksShownFor(c.blocks, { country: 'UAE' }).length).toBe(2);
    expect(blocksShownFor(c.blocks, { country: 'EG' }).length).toBe(1);
    const bad = base();
    const w = textBlock('Bad');
    w.showWhen = { match: 'all', rules: [] };
    bad.blocks.push(w);
    expect(validateContent(bad)).toMatchObject({ ok: false, error: expect.stringContaining('condition') });
  });
});

describe('language defaults', () => {
  const fields = ['country', 'language'];
  function campaign() {
    const c = base();
    c.versioning = { mode: 'conditions', languageField: 'language' };
    const arDefault = newVariant(c, ['language'], ['ar'], 'language');
    arDefault.blocks[0]!.props.heading = 'Arabic default';
    const uaeEn = newVariant(c, fields, ['UAE', 'en']);
    uaeEn.blocks[0]!.props.heading = 'UAE English copy';
    c.variants = [arDefault, uaeEn];
    return { c, arDefault, uaeEn };
  }

  it('contacts get their own copy first, then their language default, then the overall Default', () => {
    const { c, arDefault, uaeEn } = campaign();
    expect(pickVersion(c, fields, { country: 'UAE', language: 'en' })).toMatchObject({ layer: 'copy', variant: { id: uaeEn.id } });
    expect(pickVersion(c, fields, { country: 'EG', language: 'ar' })).toMatchObject({ layer: 'language', variant: { id: arDefault.id } });
    expect(pickVersion(c, fields, { country: 'EG', language: ' AR ' }).layer).toBe('language');
    expect(pickVersion(c, fields, { country: 'FR', language: 'fr' })).toMatchObject({ layer: 'default', variant: null });
    expect(pickVersion(c, fields, { country: 'FR' })).toMatchObject({ layer: 'default' }); // no language at all
  });

  it('language defaults only apply when conditions are chosen and Language is a segment field', () => {
    const { c, arDefault } = campaign();
    expect(activeLanguageVersions(c, fields).map((v) => v.id)).toEqual([arDefault.id]);
    expect(activeLanguageVersions(c, ['country'])).toEqual([]); // Language is not a segment field
    expect(pickVersion(c, ['country'], { country: 'EG', language: 'ar' }).layer).toBe('default');
    c.versioning = { mode: 'copies', languageField: 'language' };
    expect(activeLanguageVersions(c, fields)).toEqual([]);
    expect(pickVersion(c, fields, { country: 'EG', language: 'ar' }).layer).toBe('default');
  });

  it('a language default and a segment copy may share one key when Language is the only segment field', () => {
    const c = base();
    c.versioning = { mode: 'conditions', languageField: 'language' };
    c.variants = [newVariant(c, ['language'], ['ar'], 'language'), newVariant(c, ['language'], ['ar'])];
    expect(validateContent(c).ok).toBe(true);
    expect(pickVersion(c, ['language'], { language: 'ar' }).layer).toBe('copy');
  });
});

describe('previews with languages and conditions', () => {
  it('shows the language default with only the blocks the segment is allowed to see', async () => {
    await t.db.query('DELETE FROM contact');
    await t.db.query('DELETE FROM audience_setting');
    const id = (await builder.post('/api/campaigns', { name: 'Languages', palette: 'travel' })).body.id;
    await builder.put(`/api/campaigns/${id}/audience`, { fields: ['country', 'language'] });
    await builder.post(`/api/campaigns/${id}/test-audience`, { mode: 'values', values: { country: ['UAE', 'EG'], language: ['ar'] } });
    const tests = (await builder.get(`/api/campaigns/${id}/audience`)).body.test as TestContactDto[];

    const c = base();
    c.versioning = { mode: 'conditions', languageField: 'language' };
    const ar = newVariant(c, ['language'], ['ar'], 'language');
    ar.blocks = [textBlock('For everyone in Arabic'), textBlock('UAE offer'), textBlock('Egypt offer')];
    ar.blocks[1]!.showWhen = { match: 'all', rules: [{ field: 'country', op: 'is', values: ['UAE'] }] };
    ar.blocks[2]!.showWhen = { match: 'all', rules: [{ field: 'country', op: 'is_one_of', values: ['EG', 'KSA'] }] };
    c.variants = [ar];
    expect((await builder.put(`/api/campaigns/${id}/draft`, { content: c, baseVersion: 1 })).status).toBe(200);

    const uae = (await builder.get(`/api/campaigns/${id}/preview?as=test:${tests.find((x) => x.code === 'UAE-ar')!.id}`)).body;
    expect(uae.html).toContain('For everyone in Arabic');
    expect(uae.html).toContain('UAE offer');
    expect(uae.html).not.toContain('Egypt offer');
    expect(uae.versionLabel).toBe('ar email · 2 of 3 blocks');
    const eg = (await builder.get(`/api/campaigns/${id}/preview?as=test:${tests.find((x) => x.code === 'EG-ar')!.id}`)).body;
    expect(eg.html).toContain('Egypt offer');
    expect(eg.html).not.toContain('UAE offer');
    // while editing the language default every block is shown
    const whole = (await builder.get(`/api/campaigns/${id}/preview?variant=${ar.id}`)).body;
    expect(whole.html).toContain('UAE offer');
    expect(whole.html).toContain('Egypt offer');
    // only a Builder can change conditions or how versions are built
    const v = (await builder.get(`/api/campaigns/${id}`)).body.draft.version;
    const tamper = JSON.parse(JSON.stringify(c)) as EmailContent;
    delete tamper.variants![0]!.blocks[1]!.showWhen;
    expect((await admin.put(`/api/campaigns/${id}/draft`, { content: tamper, baseVersion: v })).status).toBe(403);
    const mode = JSON.parse(JSON.stringify(c)) as EmailContent;
    mode.versioning = { mode: 'copies' };
    expect((await admin.put(`/api/campaigns/${id}/draft`, { content: mode, baseVersion: v })).status).toBe(403);
  });
});

describe('segments made by block conditions, and sending one segment the email of another', () => {
  const when = (field: string, ...values: string[]): ConditionGroup => ({ match: 'all', rules: [{ field, op: values.length > 1 ? 'is_one_of' : 'is', values }] });
  function campaign() {
    const c = base();
    c.versioning = { mode: 'conditions', languageField: 'language' };
    const en = newVariant(c, ['language'], ['fr'], 'language');
    en.blocks = [textBlock('For all'), textBlock('UAE only'), textBlock('SA only')];
    en.blocks[1]!.showWhen = when('country', 'UAE');
    en.blocks[2]!.showWhen = when('country', 'SA');
    const ar = newVariant(c, ['language'], ['ar'], 'language');
    c.variants = [en, ar];
    return { c, en, ar };
  }

  it('lists a segment for each value the conditions mention plus one control segment with a value none of them mention', () => {
    const { c } = campaign();
    const d = derivedSegments(c, ['language'], ['fr', 'ar']);
    expect(d.rows.map((r) => r.code)).toEqual(['UAE-fr', 'SA-fr', 'FR-fr', 'ar']);
    expect(d.tooMany).toBe(false);
    expect(derivedSegments({ ...c, versioning: { mode: 'copies' } }, ['language'], ['fr']).rows).toEqual([]);
  });

  it('a segment can be sent the email of another segment, or the Default; the rest stay automatic', () => {
    const { c, en, ar } = campaign();
    const sa = { country: 'SA', language: 'fr' };
    expect(pickVersion(c, ['language'], sa)).toMatchObject({ layer: 'language', variant: { id: en.id } });
    const key = routeKeyFor(c, ['language'], sa);
    c.versioning = { ...c.versioning!, routes: { [key]: ar.id } };
    expect(pickVersion(c, ['language'], sa)).toMatchObject({ layer: 'mapped', variant: { id: ar.id } });
    expect(pickVersion(c, ['language'], { country: 'UAE', language: 'fr' }).layer).toBe('language'); // other segments unchanged
    c.versioning = { ...c.versioning!, routes: { [key]: 'default' } };
    expect(pickVersion(c, ['language'], sa)).toMatchObject({ layer: 'mapped', variant: null });
    c.versioning = { ...c.versioning!, routes: { [key]: 'not-a-version' } };
    expect(pickVersion(c, ['language'], sa).layer).toBe('language'); // a stale route is ignored
    expect(validateContent(c).ok).toBe(true);
  });

  it('routes are saved, shown in the preview, and only a Builder can change them', async () => {
    await t.db.query('DELETE FROM contact');
    const id = (await builder.post('/api/campaigns', { name: 'Routes', palette: 'travel' })).body.id;
    await builder.put(`/api/campaigns/${id}/audience`, { fields: ['language'] });
    const made = await builder.post(`/api/campaigns/${id}/test-audience`, { mode: 'combos', combos: { fields: ['country', 'language'], rows: [['UAE', 'fr'], ['SA', 'fr'], ['', 'fr']] } });
    expect(made.status).toBe(201);
    expect((made.body.contacts as TestContactDto[]).map((x) => x.code)).toEqual(['Default-fr', 'SA-fr', 'UAE-fr']);
    const tests = made.body.contacts as TestContactDto[];
    expect(tests.find((x) => x.code === 'Default-fr')!.data.country).toBeNull();

    const { c, en } = campaign();
    const sa = tests.find((x) => x.code === 'SA-fr')!;
    c.versioning = { ...c.versioning!, routes: { [routeKeyFor(c, ['language'], sa.data)]: 'default' } };
    expect((await builder.put(`/api/campaigns/${id}/draft`, { content: c, baseVersion: 1 })).status).toBe(200);
    const asSa = (await builder.get(`/api/campaigns/${id}/preview?as=test:${sa.id}`)).body;
    expect(asSa.versionLabel).toBe('Default email');
    const asUae = (await builder.get(`/api/campaigns/${id}/preview?as=test:${tests.find((x) => x.code === 'UAE-fr')!.id}`)).body;
    expect(asUae.versionLabel).toBe('fr email · 2 of 3 blocks');
    expect(asUae.html).toContain('UAE only');
    expect(asUae.html).not.toContain('SA only');
    expect(en.blocks.length).toBe(3);

    const v = (await builder.get(`/api/campaigns/${id}`)).body.draft.version;
    const tamper = JSON.parse(JSON.stringify(c)) as EmailContent;
    delete tamper.versioning!.routes;
    expect((await admin.put(`/api/campaigns/${id}/draft`, { content: tamper, baseVersion: v })).status).toBe(403);
    expect((await qa.post(`/api/campaigns/${id}/test-audience`, { mode: 'combos', combos: { fields: ['country', 'language'], rows: [['EG', 'fr']] } })).status).toBe(403);
    expect((await builder.post(`/api/campaigns/${id}/test-audience`, { mode: 'combos', combos: { fields: ['email', 'language'], rows: [['a', 'fr']] } })).status).toBe(400);
    expect((await builder.post(`/api/campaigns/${id}/test-audience`, { mode: 'combos', combos: { fields: ['country', 'language'], rows: [['EG']] } })).status).toBe(400);
  });
});

describe('every comparison makes a segment, and several values can be typed in one box', () => {
  const types = (f: string) => ({ country: 'text', orders: 'number', since: 'date', vip: 'boolean' } as const)[f as 'country'];
  const rule = (field: string, op: Comparison, ...values: string[]) => ({ match: 'all' as const, rules: [{ field, op, values }] });
  function campaign() {
    const c = base();
    c.versioning = { mode: 'conditions', languageField: 'language' };
    const en = newVariant(c, ['language'], ['fr'], 'language');
    en.blocks = [textBlock('a'), textBlock('b'), textBlock('c'), textBlock('d'), textBlock('e'), textBlock('f')];
    en.blocks[0]!.showWhen = rule('country', 'is', 'UAE, SA'); // typed in one box
    en.blocks[1]!.showWhen = rule('country', 'contains', 'ua');
    en.blocks[2]!.showWhen = rule('orders', 'greater', '10');
    en.blocks[3]!.showWhen = rule('orders', 'less', '3');
    en.blocks[4]!.showWhen = rule('since', 'greater', '2025-01-01');
    en.blocks[5]!.showWhen = rule('country', 'is_blank');
    c.variants = [en];
    return { c, en };
  }

  it('"is" with several values typed in one box means any of them', () => {
    const get = (c: Record<string, string>) => (f: string) => c[f];
    const g = rule('country', 'is', 'UAE, SA');
    expect(evaluateCondition(g, get({ country: 'sa' }))).toBe(true);
    expect(evaluateCondition(g, get({ country: 'UAE' }))).toBe(true);
    expect(evaluateCondition(g, get({ country: 'EG' }))).toBe(false);
    expect(evaluateCondition(rule('country', 'is_not', 'UAE, SA'), get({ country: 'SA' }))).toBe(false);
    expect(describeCondition(g, (k) => k)).toBe('country is UAE or SA');
  });

  it('lists a short-named segment for each comparison, and each has a test value that really falls into it', () => {
    const { c } = campaign();
    const d = derivedSegments(c, ['language'], ['fr'], types);
    expect(d.rows.length).toBeGreaterThan(5);
    // the parts, per field: country (UAE, SA, has ua, blank), orders (over 10, under 3), since (after 2025-01-01)
    const parts = new Set(d.rows.flatMap((r) => r.values));
    for (const p of ['UAE', 'SA', 'has ua', 'blank', 'over 10', 'under 3', 'after 2025-01-01']) expect(parts.has(p)).toBe(true);
    expect(d.rows.some((r) => r.template && r.code === 'FR-7-1990-01-01-fr')).toBe(true); // the control: a country, an order count and a date that no rule mentions
    for (const r of d.rows) {
      if (!r.samples) continue;
      const contact = Object.fromEntries(r.fields.map((f, i) => [f, r.samples![i] === '' ? null : r.samples![i]]));
      expect(routeKeyFor(c, ['language'], contact, types)).toBe(r.key); // the made-up contact lands in its own segment
    }
  });

  it('a contact belongs to the first part it meets; plain values come before contains', () => {
    const { c } = campaign();
    const k = (country: string) => JSON.parse(routeKeyFor(c, ['language'], { country, orders: 1, since: null, language: 'fr' }, types)) as [string[], string[]];
    expect(k('UAE')[1][0]).toBe('uae'); // meets "is UAE" and "contains ua": the plain value wins
    expect(k('Guam')[1][0]).toBe('has ua'); // only "contains ua"
    expect(k('Egypt')[1][0]).toBe(''); // none: Default
  });
});

describe('language email names, and English as the Default email', () => {
  it('a language email is just the language, with or without rules; the Default email is the English one', () => {
    const c = base();
    c.versioning = { mode: 'conditions', languageField: 'language' };
    const ar = newVariant(c, ['language'], ['ar'], 'language');
    expect(versionName(ar)).toBe('ar');
    ar.blocks[0]!.showWhen = { match: 'all', rules: [{ field: 'country', op: 'is', values: ['UAE'] }] };
    expect(versionName(ar)).toBe('ar');
    expect(defaultEmailName(c)).toBe('Default');
  });

  it('the "any other case" of a language is marked as the language email itself, and English uses the Default email\'s rules', () => {
    const c = base();
    c.versioning = { mode: 'conditions', languageField: 'language' };
    c.blocks[0]!.showWhen = { match: 'all', rules: [{ field: 'country', op: 'is', values: ['UAE'] }] };
    const d = derivedSegments(c, ['language'], ['en']);
    expect(d.rows.map((r) => [r.code, r.template])).toEqual([['UAE-en', false], ['SA-en', true]]);
    expect(derivedSegments(c, ['language'], ['fr']).rows.map((r) => r.code)).toEqual(['fr']); // French has no email, so no rules of its own
  });
});

describe('English always uses the Default email', () => {
  it('ignores any English language email, in picking, in the list of language emails and in new versions', () => {
    const c = base();
    c.versioning = { mode: 'conditions', languageField: 'language' };
    c.variants = [newVariant(c, ['language'], ['en'], 'language'), newVariant(c, ['language'], ['ar'], 'language')];
    expect(pickVersion(c, ['language'], { language: 'EN' })).toMatchObject({ layer: 'default', variant: null });
    expect(pickVersion(c, ['language'], { language: 'ar' }).layer).toBe('language');
    expect(activeLanguageVersions(c, ['language']).map((v) => v.values[0])).toEqual(['ar']);
  });
});

describe('removed rule segments', () => {
  it('are not listed once removed, and the others stay', () => {
    const c = base();
    c.versioning = { mode: 'conditions', languageField: 'language' };
    c.blocks[0]!.showWhen = { match: 'all', rules: [{ field: 'country', op: 'is', values: ['UAE, EG'] }] };
    const all = derivedSegments(c, ['language'], ['en']);
    expect(all.rows.map((r) => r.code)).toEqual(['UAE-en', 'EG-en', 'SA-en']);
    c.versioning = { ...c.versioning!, removed: [all.rows[1]!.key] };
    expect(derivedSegments(c, ['language'], ['en']).rows.map((r) => r.code)).toEqual(['UAE-en', 'SA-en']);
    expect(validateContent(c).ok).toBe(true);
  });
});
