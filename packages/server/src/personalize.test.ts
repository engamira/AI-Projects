import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockDefinition, createInstance, emptyContent, findPlaceholderIssues, personalize } from '@cl/shared';
import { htmlToPlainText, renderEmail } from './render.js';
import { createTestApp, type Client, type TestApp } from './testkit.js';

let t: TestApp;
let builder: Client;
beforeAll(async () => {
  t = await createTestApp();
  builder = await t.sessionFor(await t.seedUser('builder', { totp: true }));
});
afterAll(() => t.close());

const withText = (body: string, subject = 'Hello') => {
  const b = createInstance(blockDefinition('text')!);
  b.props.body = body;
  const c = emptyContent('travel');
  c.settings.subject = subject;
  return { ...c, blocks: [b] };
};

describe('placeholders', () => {
  it('uses the contact value, or the fallback when it is missing or blank', () => {
    const src = 'Hi {{first_name | fallback: "there"}}!';
    expect(personalize(src, { first_name: 'Alex' }, { html: false })).toBe('Hi Alex!');
    expect(personalize(src, {}, { html: false })).toBe('Hi there!');
    expect(personalize(src, { first_name: '   ' }, { html: false })).toBe('Hi there!');
    expect(personalize(src, null, { html: false })).toBe('Hi there!');
  });

  it('escapes contact values in HTML so a name cannot inject markup', () => {
    const out = personalize('{{first_name | fallback: "x"}}', { first_name: '<img src=x onerror=alert(1)>' }, { html: true });
    expect(out).not.toContain('<img');
    expect(out).toContain('&lt;img');
  });

  it('flags a missing fallback, an unknown field and half-typed braces', () => {
    const kinds = (v: unknown) => findPlaceholderIssues(v).map((i) => i.kind);
    expect(kinds('Hi {{first_name}}')).toEqual(['missing_fallback']);
    expect(kinds('Hi {{first_name | fallback: ""}}')).toEqual(['missing_fallback']);
    expect(kinds('Hi {{nickname | fallback: "x"}}')).toEqual(['unknown_field']);
    expect(kinds('Hi {{first_name | fallback: "x"')).toEqual(['malformed']);
    expect(kinds({ a: ['{{email}}', 'Hi {{first_name | fallback: "there"}}'] })).toEqual([]); // email always exists
  });

  it('renders HTML and plain text with the fallback or the contact, and reports problems', async () => {
    const c = withText('Dear {{first_name | fallback: "traveller"}}, see {{oops}}', 'Offer for {{first_name | fallback: "you"}}');
    const empty = await renderEmail(c, { recipient: {} });
    expect(empty.html).toContain('Dear traveller');
    expect(empty.html).toContain('<title>Offer for you</title>');
    expect(empty.text).toContain('Dear traveller');
    expect(empty.placeholderIssues.map((i) => i.kind)).toEqual(['unknown_field']);
    const alex = await renderEmail(c, { recipient: { first_name: 'Alex' } });
    expect(alex.html).toContain('Dear Alex');
    expect(alex.text).toContain('Dear Alex');
    const raw = await renderEmail(c);
    expect(raw.html).toContain('first_name');
  });
});

describe('plain-text alternative', () => {
  it('turns links into "label (url)", keeps line breaks, decodes entities, drops styles', async () => {
    const out = htmlToPlainText('<head><style>.a{}</style></head><body><p>Tom &amp; Jerry</p><p>Line<br/>two <a href="https://x.test/a?b=1&amp;c=2">Book now</a></p></body>');
    expect(out).toBe('Tom & Jerry\nLine\ntwo Book now (https://x.test/a?b=1&c=2)\n');
  });

  it('a real email gives readable text with the footer and unsubscribe wording and no markup', async () => {
    const { text } = await renderEmail(withText('Hello there'));
    expect(text).toContain('Hello there');
    expect(text).toMatch(/Unsubscribe/);
    expect(text).not.toMatch(/<[a-z]/i);
    expect(text).not.toMatch(/&[a-z]+;/);
  });
});

describe('preview endpoint', () => {
  it('previews "as" a sample contact, an empty contact, or raw, and returns text and issues', async () => {
    const c = (await builder.post('/api/campaigns', { name: 'P', palette: 'travel' })).body;
    const content = { ...c.draft.content, blocks: [{ ...createInstance(blockDefinition('text')!), props: { ...createInstance(blockDefinition('text')!).props, body: 'Hi {{first_name | fallback: "friend"}} {{last_name}}' } }] };
    expect((await builder.put(`/api/campaigns/${c.id}/draft`, { content, baseVersion: 1 })).status).toBe(200);
    const sample = (await builder.get(`/api/campaigns/${c.id}/preview`)).body;
    expect(sample.html).toContain('Hi Alex');
    expect(sample.text).toContain('Hi Alex Morgan');
    expect(sample.placeholderIssues.map((i: { kind: string }) => i.kind)).toEqual(['missing_fallback']);
    expect((await builder.get(`/api/campaigns/${c.id}/preview?as=empty`)).body.html).toContain('Hi friend');
    expect((await builder.get(`/api/campaigns/${c.id}/preview?as=raw`)).body.html).toContain('fallback');
    expect((await builder.get(`/api/campaigns/${c.id}/preview?as=bogus`)).status).toBe(400);
  });
});
