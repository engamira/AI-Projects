import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLOCK_DEFINITIONS, BLOCK_TYPES, canonicalJson, createInstance, blockDefinition, emptyContent, validateContent, type EmailContent } from '@cl/shared';
import { sha256 } from './crypto.js';
import { renderEmail } from './render.js';
import { createTestApp, type Client, type TestApp } from './testkit.js';

let t: TestApp;
let builder: Client;
beforeAll(async () => {
  t = await createTestApp();
  builder = await t.sessionFor(await t.seedUser('builder', { totp: true }));
});
afterAll(() => t.close());

const libraryHash = async () =>
  sha256(JSON.stringify((await t.db.query('SELECT type, version, definition FROM block_definition ORDER BY type, version')).rows));

const newCampaign = async (name = 'Spring sale', client: Client = builder) => (await client.post('/api/campaigns', { name })).body;
const block = (type: (typeof BLOCK_TYPES)[number]) => createInstance(blockDefinition(type)!);

describe('block library', () => {
  it('serves all ten shared blocks as originals', async () => {
    const res = await builder.get('/api/library/blocks');
    expect(res.status).toBe(200);
    expect(res.body.blocks.map((b: { type: string }) => b.type)).toEqual([...BLOCK_TYPES]);
    expect(res.body.blocks.every((b: { version: number }) => b.version === 1)).toBe(true);
  });

  it('cannot be changed through the API or the database', async () => {
    for (const method of ['post', 'put', 'patch'] as const) {
      expect((await builder[method]('/api/library/blocks', {})).status).toBe(404);
    }
    await expect(t.db.query(`UPDATE block_definition SET definition = '{}'`)).rejects.toThrow(/immutable/);
    await expect(t.db.query(`DELETE FROM block_definition`)).rejects.toThrow(/immutable/);
  });

  it('every definition has defaults that pass validation (a fresh block is always valid)', () => {
    for (const def of BLOCK_DEFINITIONS) {
      const content: EmailContent = { ...emptyContent(), blocks: [createInstance(def)] };
      const v = validateContent(content);
      expect(v.ok, `${def.type}: ${!v.ok ? v.error : ''}`).toBe(true);
    }
  });
});

describe('saving and reopening', () => {
  it('restores every edit exactly and leaves the library and other emails untouched', async () => {
    const before = await libraryHash();
    const a = await newCampaign('Email A');
    const b = await newCampaign('Email B');

    const hero = block('hero');
    const text = block('text');
    const content: EmailContent = { ...emptyContent(), blocks: [hero, text] };
    content.settings.subject = 'Big news';
    content.blocks[0]!.props.headline = 'Edited in email A only';
    content.blocks[0]!.props.bgColor = '#ff0000';
    content.blocks[1]!.props.paddingY = 48;

    const saved = await builder.put(`/api/campaigns/${a.id}/draft`, { content, baseVersion: a.draft.version });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(2);

    // Reopen: identical content, byte for byte.
    const reopened = await builder.get(`/api/campaigns/${a.id}`);
    expect(canonicalJson(reopened.body.draft.content)).toBe(canonicalJson(content));
    expect(reopened.body.draft.content.blocks[0].props.headline).toBe('Edited in email A only');

    // Other email unaffected, library unchanged.
    expect((await builder.get(`/api/campaigns/${b.id}`)).body.draft.content.blocks).toEqual([]);
    expect(await libraryHash()).toBe(before);
    const lib = (await builder.get('/api/library/blocks')).body.blocks.find((x: { type: string }) => x.type === 'hero');
    expect(lib.defaults.headline).toBe(blockDefinition('hero')!.defaults.headline);
  });

  it('two blocks of the same type in one email are independent, and so are instances across emails', async () => {
    const c1 = await newCampaign('One');
    const c2 = await newCampaign('Two');
    const first = block('text');
    const second = block('text');
    expect(first.props).not.toBe(second.props);
    first.props.heading = 'Changed';
    expect(second.props.heading).toBe(blockDefinition('text')!.defaults.heading);
    expect(blockDefinition('text')!.defaults.heading).toBe('Section heading'); // original untouched in code too

    await builder.put(`/api/campaigns/${c1.id}/draft`, { content: { ...emptyContent(), blocks: [first] }, baseVersion: 1 });
    await builder.put(`/api/campaigns/${c2.id}/draft`, { content: { ...emptyContent(), blocks: [second] }, baseVersion: 1 });
    expect((await builder.get(`/api/campaigns/${c1.id}`)).body.draft.content.blocks[0].props.heading).toBe('Changed');
    expect((await builder.get(`/api/campaigns/${c2.id}`)).body.draft.content.blocks[0].props.heading).toBe('Section heading');
  });

  it('does nothing when the content has not changed', async () => {
    const c = await newCampaign();
    const content = emptyContent();
    const r1 = await builder.put(`/api/campaigns/${c.id}/draft`, { content, baseVersion: 1 });
    expect(r1.body.version).toBe(1);
  });

  it('refuses to overwrite newer work from a stale window', async () => {
    const c = await newCampaign();
    const v1 = { ...emptyContent(), blocks: [block('text')] };
    expect((await builder.put(`/api/campaigns/${c.id}/draft`, { content: v1, baseVersion: 1 })).status).toBe(200);
    const stale = { ...emptyContent(), blocks: [block('button')] };
    const res = await builder.put(`/api/campaigns/${c.id}/draft`, { content: stale, baseVersion: 1 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('version_conflict');
    expect((await builder.get(`/api/campaigns/${c.id}`)).body.draft.content.blocks[0].type).toBe('text');
  });

  it('rejects invalid or dangerous content with a clear message and stores nothing', async () => {
    const c = await newCampaign();
    const put = (content: unknown) => builder.put(`/api/campaigns/${c.id}/draft`, { content, baseVersion: 1 });
    const withProp = (type: (typeof BLOCK_TYPES)[number], key: string, value: unknown) => {
      const b = block(type);
      (b.props as Record<string, unknown>)[key] = value;
      return { ...emptyContent(), blocks: [b] };
    };

    const js = await put(withProp('button', 'url', 'javascript:alert(1)'));
    expect(js.status).toBe(400);
    expect(js.body.message).toContain('Link');
    expect((await put(withProp('image', 'src', 'http://insecure.example/x.png'))).status).toBe(400);
    expect((await put(withProp('image', 'src', 'data:image/png;base64,AAAA'))).status).toBe(400);
    expect((await put(withProp('text', 'bgColor', 'red; background:url(x)'))).status).toBe(400);
    expect((await put(withProp('spacer', 'height', 99999))).status).toBe(400);
    expect((await put(withProp('text', 'body', 'x'.repeat(5000)))).status).toBe(400);
    expect((await put({ ...emptyContent(), blocks: [{ id: crypto.randomUUID(), type: 'script', sourceVersion: 1, props: {} }] })).status).toBe(400);
    expect((await put({ ...emptyContent(), blocks: Array.from({ length: 101 }, () => block('spacer')) })).status).toBe(400);
    const extra = block('spacer');
    (extra.props as Record<string, unknown>).onclick = 'alert(1)';
    expect((await put({ ...emptyContent(), blocks: [extra] })).status).toBe(400);
    const dup = block('spacer');
    expect((await put({ ...emptyContent(), blocks: [dup, dup] })).status).toBe(400);
    const badSender = emptyContent();
    badSender.settings.senderEmail = 'not-an-email';
    expect((await put(badSender)).status).toBe(400);

    expect((await builder.get(`/api/campaigns/${c.id}`)).body.draft.version).toBe(1);
  });

  it('allows safe link kinds and personalization placeholders in links', async () => {
    const c = await newCampaign();
    const b = block('button');
    for (const url of ['https://example.com/a?b=1', 'mailto:hi@example.com', 'tel:+971 4 123 4567', '{{unsubscribe_url}}', 'https://example.com/?u={{user_id}}']) {
      b.props.url = url;
      const res = await builder.put(`/api/campaigns/${c.id}/draft`, { content: { ...emptyContent(), blocks: [b] }, baseVersion: (await builder.get(`/api/campaigns/${c.id}`)).body.draft.version });
      expect(res.status, url).toBe(200);
    }
  });
});

describe('revisions and duplication', () => {
  it('saves named versions and restores without rewriting history', async () => {
    const c = await newCampaign('History');
    const v2 = { ...emptyContent(), blocks: [block('hero')] };
    await builder.put(`/api/campaigns/${c.id}/draft`, { content: v2, baseVersion: 1 });
    expect((await builder.post(`/api/campaigns/${c.id}/revisions`, { label: 'With hero' })).status).toBe(201);
    const v3 = { ...v2, blocks: [...v2.blocks, block('footer')] };
    await builder.put(`/api/campaigns/${c.id}/draft`, { content: v3, baseVersion: 2 });
    await builder.post(`/api/campaigns/${c.id}/revisions`, { label: 'With footer' });

    let list = (await builder.get(`/api/campaigns/${c.id}/revisions`)).body;
    expect(list.map((r: { number: number }) => r.number)).toEqual([3, 2, 1]);
    const heroOnly = list.find((r: { label: string }) => r.label === 'With hero');

    const restored = await builder.post(`/api/campaigns/${c.id}/revisions/${heroOnly.id}/restore`);
    expect(restored.status).toBe(200);
    expect(restored.body.draft.content.blocks).toHaveLength(1);
    expect(restored.body.draft.version).toBe(4);

    list = (await builder.get(`/api/campaigns/${c.id}/revisions`)).body;
    expect(list.map((r: { number: number }) => r.number)).toEqual([4, 3, 2, 1]);
    expect(list[0]).toMatchObject({ kind: 'restore', restoredFromNumber: 2 });
    // The "With footer" revision is still there, unchanged.
    const footer = await builder.get(`/api/campaigns/${c.id}/preview?revision=${list.find((r: { label: string }) => r.label === 'With footer').id}`);
    expect(footer.body.html).toContain('Unsubscribe');
    await expect(t.db.query(`UPDATE campaign_revision SET label = 'x'`)).rejects.toThrow(/immutable/);
    await expect(t.db.query(`DELETE FROM campaign_revision WHERE campaign_id = $1`, [c.id])).rejects.toThrow(/immutable/);
  });

  it('duplicates a campaign with new block ids, and edits to the copy never reach the original', async () => {
    const c = await newCampaign('Original');
    const content = { ...emptyContent(), blocks: [block('text'), block('button')] };
    await builder.put(`/api/campaigns/${c.id}/draft`, { content, baseVersion: 1 });

    const copy = (await builder.post(`/api/campaigns/${c.id}/duplicate`)).body;
    expect(copy.name).toBe('Copy of Original');
    expect(copy.id).not.toBe(c.id);
    const copyIds = copy.draft.content.blocks.map((b: { id: string }) => b.id);
    expect(copyIds.some((id: string) => content.blocks.some((b) => b.id === id))).toBe(false);
    expect(copy.draft.content.blocks.map((b: { props: unknown }) => b.props)).toEqual(content.blocks.map((b) => b.props));

    copy.draft.content.blocks[0].props.heading = 'Only in the copy';
    await builder.put(`/api/campaigns/${copy.id}/draft`, { content: copy.draft.content, baseVersion: copy.draft.version });
    expect((await builder.get(`/api/campaigns/${c.id}`)).body.draft.content.blocks[0].props.heading).toBe('Section heading');
    expect((await builder.get(`/api/campaigns/${copy.id}/revisions`)).body[0].kind).toBe('duplicate');
  });

  it('lists campaigns and renames them', async () => {
    const c = await newCampaign('Before');
    expect((await builder.patch(`/api/campaigns/${c.id}`, { name: 'After' })).body.name).toBe('After');
    expect((await builder.patch(`/api/campaigns/${c.id}`, { name: '   ' })).status).toBe(400);
    const list = (await builder.get('/api/campaigns')).body;
    expect(list.find((x: { id: string }) => x.id === c.id)).toMatchObject({ name: 'After', status: 'draft', revisionCount: 1 });
  });
});

describe('who can do what', () => {
  it('Admin and QA reviewer can open campaigns and previews but cannot change anything', async () => {
    const c = await newCampaign('Shared');
    for (const role of ['admin', 'qa_reviewer'] as const) {
      const other = await t.sessionFor(await t.seedUser(role, { totp: true }));
      expect((await other.get('/api/campaigns')).status).toBe(200);
      expect((await other.get(`/api/campaigns/${c.id}`)).status).toBe(200);
      expect((await other.get(`/api/campaigns/${c.id}/preview`)).status).toBe(200);
      expect((await other.get('/api/library/blocks')).status).toBe(200);
      expect((await other.post('/api/campaigns', { name: 'Nope' })).status).toBe(403);
      expect((await other.put(`/api/campaigns/${c.id}/draft`, { content: emptyContent(), baseVersion: 1 })).status).toBe(403);
      expect((await other.post(`/api/campaigns/${c.id}/duplicate`)).status).toBe(403);
      expect((await other.post(`/api/campaigns/${c.id}/revisions`, {})).status).toBe(403);
    }
  });

  it('records creation, renaming, versions and restores in the activity history', async () => {
    const admin = await t.sessionFor(await t.seedUser('admin', { totp: true }));
    const actions = (await admin.get('/api/activity')).body.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['campaign.created', 'campaign.renamed', 'campaign.revision_saved', 'campaign.revision_restored', 'campaign.duplicated']));
  });
});

describe('email HTML', () => {
  it('renders every block type into a complete HTML email with subject and preheader', async () => {
    const content: EmailContent = { ...emptyContent(), blocks: BLOCK_TYPES.map(block) };
    content.settings.subject = 'Summer fares';
    content.settings.preheader = 'Save up to 30% this week';
    const { html, warnings } = await renderEmail(content);
    expect(warnings).toEqual([]);
    expect(html).toContain('<title>Summer fares</title>');
    expect(html).toContain('Save up to 30% this week');
    expect(html).toContain('A big, clear headline');
    expect(html).toContain('{{unsubscribe_url}}');
    expect(html).toContain('Dubai Silicon Oasis');
    expect(html).toContain('@media'); // responsive rules from MJML
  });

  it('escapes text so markup typed by a user cannot become live HTML', async () => {
    const t1 = block('text');
    t1.props.heading = '<script>alert(1)</script>';
    t1.props.body = '<img src=x onerror=alert(2)> & "quotes"\nsecond line';
    const content: EmailContent = { ...emptyContent(), blocks: [t1] };
    content.settings.subject = '</title><script>alert(3)</script>';
    const { html } = await renderEmail(content);
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/<img[^>]*onerror/i);
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('second line');
  });

  it('keeps personalization placeholders intact for later resolution', async () => {
    const t1 = block('text');
    t1.props.body = 'Hello {{first_name}}';
    const { html } = await renderEmail({ ...emptyContent(), blocks: [t1] });
    expect(html).toContain('Hello {{first_name}}');
  });

  it('shows a visible placeholder (not a broken image) when an image has no address yet', async () => {
    const { html } = await renderEmail({ ...emptyContent(), blocks: [block('image')] });
    expect(html).toContain('Image placeholder');
    expect(html).not.toContain('<img src=""');
  });

  it('produces identical HTML and hash for identical content', async () => {
    const content: EmailContent = { ...emptyContent(), blocks: [block('hero')] };
    const copy = JSON.parse(JSON.stringify(content)) as EmailContent;
    expect((await renderEmail(content)).html).toBe((await renderEmail(copy)).html);
    expect(canonicalJson(content)).toBe(canonicalJson({ blocks: content.blocks, settings: content.settings, schemaVersion: 1 }));
  });
});
