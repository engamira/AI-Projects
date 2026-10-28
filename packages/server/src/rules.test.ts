import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  blockDefinition, createInstance, explainBlock, generateScenarios, isBlockVisible, lintRules, validateContent, emptyContent,
  type BlockInstance, type BlockRule, type CampaignEmails, type Comparison, type ConditionGroup, type EmailContent,
} from '@cl/shared';
import { createTestApp, type Client, type TestApp } from './testkit.js';

// The rules engine (show / hide, AND / OR / NOT), the segments and test audiences it creates, and how everything stays in step.

const types = (f: string) => ({ country: 'text', city: 'text', vip: 'boolean', language: 'text', orders: 'number' } as const)[f as 'country'];
const labels = (f: string) => ({ country: 'Country', city: 'City', vip: 'VIP', language: 'Language', orders: 'Orders' } as Record<string, string>)[f] ?? f;
const leaf = (field: string, op: Comparison, ...values: string[]) => ({ field, op, values });
const all = (...rules: ConditionGroup['rules']): ConditionGroup => ({ match: 'all', rules });
const any = (...rules: ConditionGroup['rules']): ConditionGroup => ({ match: 'any', rules });
const not = (g: ConditionGroup): ConditionGroup => ({ ...g, not: true });
const rule = (effect: 'show' | 'hide', when: ConditionGroup, id = crypto.randomUUID()): BlockRule => ({ id, effect, when });
const block = (heading: string, ...rules: BlockRule[]): BlockInstance => {
  const b = createInstance(blockDefinition('text')!);
  b.props.heading = heading;
  if (rules.length) b.rules = rules;
  return b;
};
const seen = (b: BlockInstance, who: Record<string, string | number | boolean | null>) => isBlockVisible(b, (f) => who[f], types);

describe('the rules engine', () => {
  it('shows a block with no rules to everyone', () => {
    expect(seen(block('x'), {})).toBe(true);
  });

  it('show rules: shown only when one is met; hide rules: hidden when one is met; hide wins', () => {
    const uae = block('UAE only', rule('show', all(leaf('country', 'is', 'UAE'))));
    expect(seen(uae, { country: 'uae' })).toBe(true);
    expect(seen(uae, { country: 'SA' })).toBe(false);
    expect(seen(uae, {})).toBe(false); // a missing value is blank, which is not UAE
    const notUae = block('Not for UAE', rule('hide', all(leaf('country', 'is', 'UAE'))));
    expect(seen(notUae, { country: 'UAE' })).toBe(false);
    expect(seen(notUae, { country: 'SA' })).toBe(true);
    expect(seen(notUae, {})).toBe(true);
    const both = block('both', rule('show', all(leaf('country', 'is', 'UAE'))), rule('hide', all(leaf('vip', 'is', 'yes'))));
    expect(seen(both, { country: 'UAE', vip: false })).toBe(true);
    expect(seen(both, { country: 'UAE', vip: true })).toBe(false); // hide wins
    expect(seen(both, { country: 'SA', vip: false })).toBe(false);
  });

  it('AND, OR and NOT, nested', () => {
    const b = block('mix', rule('show', all(any(leaf('country', 'is', 'UAE'), leaf('country', 'is', 'KSA')), not(all(leaf('city', 'is', 'Sharjah'))))));
    expect(seen(b, { country: 'UAE', city: 'Dubai' })).toBe(true);
    expect(seen(b, { country: 'KSA' })).toBe(true);
    expect(seen(b, { country: 'UAE', city: 'sharjah' })).toBe(false);
    expect(seen(b, { country: 'EG' })).toBe(false);
  });

  it('reads the older single "show when" condition as one show rule', () => {
    const old = block('old');
    old.showWhen = all(leaf('country', 'is', 'UAE'));
    expect(seen(old, { country: 'UAE' })).toBe(true);
    expect(seen(old, { country: 'EG' })).toBe(false);
  });

  it('explains why a block is shown or hidden', () => {
    const b = block('x', rule('hide', all(leaf('country', 'is', 'UAE'))));
    expect(explainBlock(b, (f) => ({ country: 'UAE' } as Record<string, string>)[f], types, labels)).toMatchObject({ visible: false, summary: 'Hidden: Hide when Country is UAE is met.' });
    expect(explainBlock(b, () => 'SA', types, labels)).toMatchObject({ visible: true, summary: 'Shown: no hide rule is met.' });
    expect(explainBlock(block('plain'), () => null, types, labels).summary).toBe('No rules: always shown.');
  });

  it('is saved with the email and checked: bad rules are refused, copies get new rule ids', () => {
    const c: EmailContent = emptyContent('travel');
    c.blocks = [block('a', rule('show', all(leaf('country', 'is', 'UAE'))))];
    expect(validateContent(c).ok).toBe(true);
    const bad = structuredClone(c);
    bad.blocks[0]!.rules = [{ id: 'nope', effect: 'maybe', when: all() } as never];
    expect(validateContent(bad).ok).toBe(false);
    const wrongGroup = structuredClone(c);
    (wrongGroup.blocks[0]!.rules![0]!.when as { not: unknown }).not = 'yes';
    expect(validateContent(wrongGroup).ok).toBe(false);
  });

  it('finds mistakes in the rules', () => {
    const impossible = block('never', rule('show', all(leaf('country', 'is', 'UAE'), leaf('country', 'is', 'KSA'))));
    const cancel = block('cancel', rule('show', all(leaf('vip', 'is', 'yes'))), rule('hide', all(leaf('vip', 'is', 'yes'))));
    const unknown = block('unknown', rule('show', all(leaf('shoe_size', 'is', '42'))));
    const problems = lintRules([impossible, cancel, unknown], ['country', 'vip'], types).map((p) => p.message);
    expect(problems.some((m) => m.includes('never be met'))).toBe(true);
    expect(problems.some((m) => m.includes('never shown'))).toBe(true);
    expect(problems.some((m) => m.includes('shoe_size'))).toBe(true);
  });
});

describe('scenarios made from the rules', () => {
  const gen = (blocks: BlockInstance[]) => generateScenarios({ language: { id: 'en', name: 'English' }, blocks, typeOf: types, labelOf: labels });

  it('gives a baseline, and for a UAE + VIP rule a positive and a negative audience', () => {
    const blocks = [block('VIP in UAE', rule('show', all(leaf('country', 'is', 'UAE'), leaf('vip', 'is', 'yes')))), block('everyone')];
    const { scenarios } = gen(blocks);
    expect(scenarios.map((s) => s.audienceName)).toEqual(['en-Audience', 'UAE VIP English-Audience', 'Not UAE English-Audience']);
    expect(scenarios.map((s) => s.polarity)).toEqual(['baseline', 'positive', 'negative']);
    const [base, pos, neg] = scenarios;
    expect(pos!.attributes).toMatchObject({ language: 'en', country: 'UAE', vip: true });
    expect(neg!.attributes.country).not.toBe('UAE');
    // both outcomes are covered: the VIP/UAE block is shown to the first, hidden from the others
    expect(pos!.expected.visible).toContain(blocks[0]!.id);
    expect(neg!.expected.hidden).toContain(blocks[0]!.id);
    expect(base!.expected.hidden).toContain(blocks[0]!.id);
    expect(neg!.expected.visible).toContain(blocks[1]!.id);
  });

  it('covers hide rules and NOT, without duplicates', () => {
    const blocks = [
      block('not for UAE', rule('hide', all(leaf('country', 'is', 'UAE')))),
      block('also not for UAE', rule('hide', all(leaf('country', 'is', 'UAE')))),
      block('everyone but Sharjah', rule('show', not(all(leaf('city', 'is', 'Sharjah'))))),
    ];
    const { scenarios } = gen(blocks);
    const names = scenarios.map((s) => s.audienceName);
    expect(names).toEqual(['en-Audience', 'UAE English-Audience', 'Not UAE English-Audience', 'Not Sharjah English-Audience', 'Sharjah English-Audience']);
    expect(new Set(scenarios.map((s) => s.fingerprint)).size).toBe(scenarios.length);
    const uae = scenarios.find((s) => s.audienceName === 'UAE English-Audience')!;
    expect(uae.ruleIds).toHaveLength(2); // both blocks' rules are tested by the same audience
    expect(uae.expected.hidden).toEqual([blocks[0]!.id, blocks[1]!.id]);
  });

  it('is the same every time, and capped', () => {
    const many = Array.from({ length: 70 }, (_, i) => block(`b${i}`, rule('show', all(leaf('city', 'is', `City${i}`)))));
    const a = gen(many);
    expect(a.tooMany).toBe(true);
    expect(a.scenarios).toHaveLength(60);
    expect(gen(many).scenarios.map((s) => s.fingerprint)).toEqual(a.scenarios.map((s) => s.fingerprint));
  });
});

let t: TestApp;
let builder: Client;
let admin: Client;
beforeAll(async () => {
  t = await createTestApp();
  builder = await t.sessionFor(await t.seedUser('builder', { totp: true }));
  admin = await t.sessionFor(await t.seedUser('admin', { totp: true }));
});
afterAll(() => t.close());

const names = (d: { audiences: { name: string }[] }) => d.audiences.map((a) => a.name);

describe('segments and test audiences stay in step with the emails', () => {
  it('are made from the rules, copied with the email, updated when a rule changes, and removed with the email', async () => {
    const c = (await builder.post('/api/campaigns', { name: 'UAE offers', palette: 'travel', model: 'v2' })).body;
    await builder.put(`/api/campaigns/${c.id}/languages`, { input: 'English, German' });
    const derived = async () => (await builder.get(`/api/campaigns/${c.id}/derived`)).body as { segments: { name: string }[]; audiences: { id: string; name: string; polarity: string; expected: { visible: string[]; hidden: string[] } }[]; warnings: unknown[] };
    // before any email exists: one baseline audience per language
    expect(names(await derived())).toEqual(['en-Audience', 'de-Audience']);

    const en = (await builder.post(`/api/campaigns/${c.id}/emails`, { languageId: 'en', createFromId: null })).body;
    const content = en.draft.content as EmailContent;
    const uaeVip = block('UAE VIP offer', rule('show', all(leaf('country', 'is', 'UAE'), leaf('vip', 'is', 'yes'))));
    content.blocks.push(uaeVip);
    expect((await builder.put(`/api/emails/${en.id}/draft`, { content, baseVersion: en.draft.version })).status).toBe(200);
    let d = await derived();
    expect(names(d)).toEqual(['en-Audience', 'UAE VIP English-Audience', 'Not UAE English-Audience', 'de-Audience']);
    expect(d.segments.map((s) => s.name)).toEqual(['UAE VIP English Segment', 'Not UAE English Segment']);

    // German is cloned from the saved English email: it brings the rules, and the audiences follow
    await builder.post(`/api/emails/${en.id}/revisions`, {});
    const de = (await builder.post(`/api/campaigns/${c.id}/emails`, { languageId: 'de', createFromId: en.id })).body;
    d = await derived();
    expect(names(d)).toEqual(['en-Audience', 'UAE VIP English-Audience', 'Not UAE English-Audience', 'de-Audience', 'UAE VIP German-Audience', 'Not UAE German-Audience']);

    // the audience the rule describes sees the block; the negative one does not
    const positive = d.audiences.find((a) => a.name === 'UAE VIP English-Audience')!;
    const negative = d.audiences.find((a) => a.name === 'Not UAE English-Audience')!;
    const html = async (id: string, as: string) => (await builder.get(`/api/emails/${id}/preview?as=audience:${as}`)).body;
    const shown = await html(en.id, positive.id);
    expect(shown.html).toContain('UAE VIP offer');
    expect(shown.recipientLabel).toBe('UAE VIP English-Audience (test audience)');
    expect((await html(en.id, negative.id)).html).not.toContain('UAE VIP offer');
    expect((await html(en.id, negative.id)).versionLabel).toMatch(/blocks$/);

    // editing the rule updates the audiences and leaves nothing obsolete behind
    const edited = (await builder.get(`/api/emails/${en.id}`)).body;
    const ec = edited.draft.content as EmailContent;
    ec.blocks[ec.blocks.length - 1]!.rules = [rule('hide', all(leaf('city', 'is', 'Sharjah')))];
    expect((await builder.put(`/api/emails/${en.id}/draft`, { content: ec, baseVersion: edited.draft.version })).status).toBe(200);
    d = await derived();
    expect(names(d).filter((n) => n.includes('English'))).toEqual(['Sharjah English-Audience', 'Not Sharjah English-Audience']);
    expect(names(d)).not.toContain('UAE VIP English-Audience');
    expect(names(d)).toContain('UAE VIP German-Audience'); // German has its own copy of the rule: independent of English

    // typing words (no change to blocks or rules) does not rebuild anything
    const before = (await t.db.query('SELECT id FROM test_audience WHERE campaign_id = $1 ORDER BY name', [c.id])).rows.map((r) => r.id as string);
    const again = (await builder.get(`/api/emails/${en.id}`)).body;
    const ac = again.draft.content as EmailContent;
    ac.settings.subject = 'Hello';
    await builder.put(`/api/emails/${en.id}/draft`, { content: ac, baseVersion: again.draft.version });
    expect((await t.db.query('SELECT id FROM test_audience WHERE campaign_id = $1 ORDER BY name', [c.id])).rows.map((r) => r.id as string)).toEqual(before);

    // deleting an email removes its scenarios, keeps the language's baseline
    expect((await builder.delete(`/api/emails/${de.id}`)).status).toBe(204);
    d = await derived();
    expect(names(d).filter((n) => n.includes('German'))).toEqual([]);
    expect(names(d)).toContain('de-Audience');

    // dropping a language removes its baseline
    await builder.put(`/api/campaigns/${c.id}/languages`, { input: 'English' });
    expect(names(await derived())).not.toContain('de-Audience');
    expect((await admin.get(`/api/campaigns/${c.id}/derived`)).status).toBe(200);
    expect(((await builder.get(`/api/campaigns/${c.id}/emails`)).body as CampaignEmails).languages).toHaveLength(1);
  });

  it('test audiences are made-up contacts that can never be mailed', async () => {
    const c = (await builder.post('/api/campaigns', { name: 'Fixtures', palette: 'travel', model: 'v2' })).body;
    const d = (await builder.get(`/api/campaigns/${c.id}/derived`)).body as { audiences: { email: string }[] };
    expect(d.audiences.length).toBeGreaterThan(0);
    for (const a of d.audiences) expect(a.email.endsWith('.invalid')).toBe(true);
    const real = (await t.db.query('SELECT count(*)::int AS n FROM contact')).rows[0].n as number;
    expect(real).toBe(0); // they never become contacts
  });
});
