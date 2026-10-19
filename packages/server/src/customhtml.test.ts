import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { blockDefinition, createInstance, emptyContent, type EmailContent } from '@cl/shared';
import { sanitizeCustomHtml } from './customhtml.js';
import { renderEmail } from './render.js';
import { createTestApp, type Client, type TestApp } from './testkit.js';

let t: TestApp;
let builder: Client;
let admin: Client;
beforeAll(async () => {
  t = await createTestApp();
  builder = await t.sessionFor(await t.seedUser('builder', { totp: true }));
  admin = await t.sessionFor(await t.seedUser('admin', { totp: true }));
});
afterAll(() => t.close());

const customBlock = (html: string) => {
  const b = createInstance(blockDefinition('custom_html')!);
  b.props.html = html;
  return b;
};

describe('custom HTML is cleaned (XSS)', () => {
  const attacks: [string, string][] = [
    ['script tag', '<p>hi</p><script>alert(1)</script>'],
    ['onerror handler', '<img src="https://x.test/a.png" onerror="alert(1)">'],
    ['onclick handler', '<p onclick="alert(1)">x</p>'],
    ['javascript link', '<a href="javascript:alert(1)">x</a>'],
    ['obfuscated javascript link', '<a href=" jAvA&#115;cript:alert(1)">x</a>'],
    ['data picture', '<img src="data:image/svg+xml;base64,PHN2ZyBvbmxvYWQ9YWxlcnQoMSk+">'],
    ['iframe', '<iframe src="https://evil.test"></iframe>'],
    ['svg onload', '<svg onload="alert(1)"><circle/></svg>'],
    ['form', '<form action="https://evil.test"><input name="p"><button>Go</button></form>'],
    ['style tag', '<style>body{background:url(https://evil.test/x)}</style><p>x</p>'],
    ['css url in style', '<p style="background:url(javascript:alert(1))">x</p>'],
    ['css expression', '<p style="width:expression(alert(1))">x</p>'],
    ['mjml breakout', '</mj-text></mj-column></mj-section><mj-raw><script>alert(1)</script></mj-raw>'],
    ['meta refresh', '<meta http-equiv="refresh" content="0;url=https://evil.test">'],
    ['base tag', '<base href="https://evil.test/">'],
  ];
  for (const [name, html] of attacks) {
    it(`removes: ${name}`, async () => {
      const out = sanitizeCustomHtml(html);
      expect(out).not.toMatch(/<script|<iframe|<svg|<form|<input|<style|<meta|<base|<mj-/i);
      expect(out).not.toMatch(/\son\w+\s*=/i);
      expect(out).not.toMatch(/javascript:|data:|expression\(|url\(/i);
      const { html: full } = await renderEmail({ ...emptyContent('travel'), blocks: [customBlock(html)] });
      expect(full).not.toMatch(/alert\(1\)/); // nothing executable reaches the finished email
    });
  }

  it('keeps ordinary formatting, tables, safe links and https pictures', () => {
    const out = sanitizeCustomHtml('<table width="100%"><tr><td style="color:#ff0000;padding:8px"><b>Hi</b> <a href="https://ok.test/a?x=1">link</a><img src="https://ok.test/p.png" alt="p" width="50"></td></tr></table>');
    expect(out).toContain('<table');
    expect(out).toContain('color:#ff0000');
    expect(out).toContain('href="https://ok.test/a?x=1"');
    expect(out).toContain('src="https://ok.test/p.png"');
    expect(out).toContain('rel="noopener noreferrer"');
  });

  it('the preview tells the Admin what was removed', async () => {
    const r = await renderEmail({ ...emptyContent('travel'), blocks: [customBlock('<script>x()</script><p onclick="y()">a</p>')] });
    expect(r.warnings.join(' ')).toContain('script tags are removed');
    expect(r.warnings.join(' ')).toContain('event handlers');
  });
});

describe('who may edit custom HTML (enforced on the server)', () => {
  async function newCampaign() {
    const c = (await builder.post('/api/campaigns', { name: 'Custom', palette: 'travel' })).body;
    return c as { id: string; draft: { content: EmailContent; version: number } };
  }
  const put = (who: Client, id: string, content: EmailContent, baseVersion: number) => who.put(`/api/campaigns/${id}/draft`, { content, baseVersion });

  it('a Builder cannot add custom HTML, and an Admin can', async () => {
    const c = await newCampaign();
    const withBlock = { ...c.draft.content, blocks: [customBlock('<p>Hello</p>')] };
    const b = await put(builder, c.id, withBlock, c.draft.version);
    expect(b.status).toBe(403);
    expect(b.body.message).toContain('Only an Admin');
    expect((await put(admin, c.id, withBlock, c.draft.version)).status).toBe(200);
  });

  it('a Builder can keep working around an Admin block but cannot change or remove it', async () => {
    const c = await newCampaign();
    const base = c.draft.content;
    const block = customBlock('<p>Admin text</p>');
    const v1 = (await put(admin, c.id, { ...base, blocks: [block] }, c.draft.version)).body.version;
    const text = createInstance(blockDefinition('text')!);
    const ok = await put(builder, c.id, { ...base, blocks: [text, block] }, v1);
    expect(ok.status).toBe(200);
    const changed = { ...block, props: { ...block.props, html: '<p>Builder change</p>' } };
    expect((await put(builder, c.id, { ...base, blocks: [text, changed] }, ok.body.version)).status).toBe(403);
    expect((await put(builder, c.id, { ...base, blocks: [text] }, ok.body.version)).status).toBe(403);
  });

  it('an Admin cannot change anything except custom HTML blocks', async () => {
    const c = await newCampaign();
    const base = c.draft.content;
    const text = createInstance(blockDefinition('text')!);
    const v1 = (await put(builder, c.id, { ...base, blocks: [text] }, c.draft.version)).body.version;
    const edited = { ...text, props: { ...text.props, heading: 'Admin edit' } };
    expect((await put(admin, c.id, { ...base, blocks: [edited] }, v1)).status).toBe(403);
    expect((await put(admin, c.id, { ...base, settings: { ...base.settings, subject: 'Changed' }, blocks: [text] }, v1)).status).toBe(403);
    // adding custom HTML next to existing blocks is fine
    expect((await put(admin, c.id, { ...base, blocks: [customBlock('<p>x</p>'), text] }, v1)).status).toBe(200);
  });

  it('a Builder cannot restore an old version that has different custom HTML', async () => {
    const c = await newCampaign();
    const base = c.draft.content;
    const v1 = (await put(admin, c.id, { ...base, blocks: [customBlock('<p>one</p>')] }, c.draft.version)).body.version;
    await builder.post(`/api/campaigns/${c.id}/revisions`, { label: 'with html' });
    await put(admin, c.id, { ...base, blocks: [] }, v1);
    const revs = (await builder.get(`/api/campaigns/${c.id}/revisions`)).body as { id: string; label: string | null }[];
    const withHtml = revs.find((r) => r.label === 'with html')!;
    expect((await builder.post(`/api/campaigns/${c.id}/revisions/${withHtml.id}/restore`, {})).status).toBe(403);
  });
});
