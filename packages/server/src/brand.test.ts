import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BLOCK_TYPES, PALETTE_IDS, createInstance, blockDefinition, emptyContent, validateContent, type BrandResponse } from '@cl/shared';
import { createTestApp, type Client, type TestApp } from './testkit.js';

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

let t: TestApp;
let admin: Client;
let builder: Client;
let qa: Client;
beforeAll(async () => {
  t = await createTestApp();
  admin = await t.sessionFor(await t.seedUser('admin', { totp: true }));
  builder = await t.sessionFor(await t.seedUser('builder', { totp: true }));
  qa = await t.sessionFor(await t.seedUser('qa_reviewer', { totp: true }));
});
afterAll(() => t.close());

const brand = async (c: Client = admin): Promise<BrandResponse['profiles']> => (await c.get('/api/brand')).body.profiles;

describe('shared header and footer per template', () => {
  it('each template starts with its own header and footer, visible to every role', async () => {
    for (const c of [admin, builder, qa]) {
      const p = await brand(c);
      expect(Object.keys(p).sort()).toEqual([...PALETTE_IDS].sort());
      expect(p.travel.header.brandName).toBe('Fly');
      expect(p.events.header.brandName).toBe('Agenda');
      expect(p.cosmetics.header.brandName).toBe('PrettyWoman');
      expect(p.travel.footer.address).toContain('Dubai Silicon Oasis');
      expect(p.travel.footer.unsubscribeUrl).toBe('{{unsubscribe_url}}');
      expect(p.travel.version).toBe(1);
    }
  });

  it('header and footer are not blocks any more: they are not in the library and cannot be added to an email', async () => {
    const lib = (await builder.get('/api/library/blocks')).body.blocks.map((b: { type: string }) => b.type);
    expect(lib).toEqual([...BLOCK_TYPES]);
    expect(lib).not.toContain('header');
    expect(lib).not.toContain('footer');
    // an older email that still contains them just loses them
    const old = { ...emptyContent(), blocks: [{ id: crypto.randomUUID(), type: 'header', sourceVersion: 2, props: { brandName: 'Old' } }, createInstance(blockDefinition('text')!)] };
    const v = validateContent(old);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.content.blocks.map((b) => b.type)).toEqual(['text']);
  });

  it('every email shows its own template header at the top and footer at the bottom', async () => {
    for (const [palette, name] of [['travel', 'Fly'], ['events', 'Agenda'], ['cosmetics', 'PrettyWoman']] as const) {
      const c = (await builder.post('/api/campaigns', { name: `${name} email`, palette })).body;
      const html = (await builder.get(`/api/campaigns/${c.id}/preview`)).body.html as string;
      expect(html, palette).toContain(name);
      expect(html.indexOf(name)).toBeLessThan(html.indexOf('Unsubscribe'));
      expect(html).toContain('{{unsubscribe_url}}');
      expect(html).toContain('Dubai Silicon Oasis');
    }
  });

  it('only an Admin can change them; each change is a new version, recorded in the activity history', async () => {
    const before = (await brand()).travel;
    const header = { ...before.header, brandName: 'Fly Airlines', linkUrl: 'https://fly.example', linkUrlAlias: 'Header logo' };
    const footer = { ...before.footer, companyName: 'Fly Airlines LLC', facebook: 'https://facebook.com/fly' };

    expect((await builder.put('/api/brand/travel', { header, footer, baseVersion: 1 })).status).toBe(403);
    expect((await qa.put('/api/brand/travel', { header, footer, baseVersion: 1 })).status).toBe(403);

    const saved = await admin.put('/api/brand/travel', { header, footer, baseVersion: 1 });
    expect(saved.status).toBe(200);
    expect(saved.body.version).toBe(2);
    expect((await brand()).travel.header.brandName).toBe('Fly Airlines');
    expect((await brand()).events.header.brandName).toBe('Agenda'); // other templates untouched

    const versions = (await admin.get('/api/brand/travel/versions')).body;
    expect(versions.map((v: { version: number }) => v.version)).toEqual([2, 1]);
    expect((await builder.get('/api/brand/travel/versions')).status).toBe(403);

    const log = (await admin.get('/api/activity')).body;
    expect(log.find((a: { action: string }) => a.action === 'brand.updated')?.details).toMatchObject({ palette: 'travel', version: 2 });
    await expect(t.db.query(`UPDATE brand_profile_version SET header = '{}'`)).rejects.toThrow(/immutable/);
    await expect(t.db.query(`DELETE FROM brand_profile_version`)).rejects.toThrow(/immutable/);
  });

  it('draft emails of that template pick up the change, other templates do not', async () => {
    const travel = (await builder.post('/api/campaigns', { name: 'Travel draft', palette: 'travel' })).body;
    const events = (await builder.post('/api/campaigns', { name: 'Events draft', palette: 'events' })).body;
    const travelHtml = (await builder.get(`/api/campaigns/${travel.id}/preview`)).body.html as string;
    const eventsHtml = (await builder.get(`/api/campaigns/${events.id}/preview`)).body.html as string;
    expect(travelHtml).toContain('Fly Airlines');
    expect(travelHtml).toContain('https://facebook.com/fly');
    expect(eventsHtml).not.toContain('Fly Airlines');
  });

  it('saving unchanged values does not create a new version', async () => {
    const cur = (await brand()).travel;
    const res = await admin.put('/api/brand/travel', { header: cur.header, footer: cur.footer, baseVersion: cur.version });
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(cur.version);
  });

  it('an out-of-date window cannot overwrite a newer header or footer', async () => {
    const cur = (await brand()).events;
    const a = await admin.put('/api/brand/events', { header: { ...cur.header, brandName: 'Agenda Live' }, footer: cur.footer, baseVersion: cur.version });
    expect(a.status).toBe(200);
    const stale = await admin.put('/api/brand/events', { header: { ...cur.header, brandName: 'Stale' }, footer: cur.footer, baseVersion: cur.version });
    expect(stale.status).toBe(409);
    expect(stale.body.error).toBe('version_conflict');
    expect((await brand()).events.header.brandName).toBe('Agenda Live');
  });

  it('rejects unsafe or invalid header and footer values', async () => {
    const cur = (await brand()).cosmetics;
    const put = (header: object, footer: object) => admin.put('/api/brand/cosmetics', { header, footer, baseVersion: cur.version });
    expect((await put({ ...cur.header, linkUrl: 'javascript:alert(1)' }, cur.footer)).status).toBe(400);
    expect((await put(cur.header, { ...cur.footer, instagram: 'not a link' })).status).toBe(400);
    expect((await put(cur.header, { ...cur.footer, address: 'x'.repeat(400) })).status).toBe(400);
    expect((await put({ ...cur.header, logoUrl: 'asset:00000000-0000-4000-8000-000000000000' }, cur.footer)).body.error).toBe('missing_asset');
    expect((await put({ ...cur.header, evil: 'x' }, cur.footer)).status).toBe(400);
    expect((await admin.put('/api/brand/neon', { header: cur.header, footer: cur.footer, baseVersion: 1 })).status).toBe(400);
    expect((await brand()).cosmetics.version).toBe(cur.version);
  });

  it('a logo from the asset library shows in the header of that template only', async () => {
    const asset = (await admin.upload('/api/assets', 'pretty.png', PNG)).body;
    const cur = (await brand()).cosmetics;
    const ok = await admin.put('/api/brand/cosmetics', { header: { ...cur.header, logoUrl: `asset:${asset.id}` }, footer: cur.footer, baseVersion: cur.version });
    expect(ok.status).toBe(200);
    const c = (await builder.post('/api/campaigns', { name: 'Logo check', palette: 'cosmetics' })).body;
    const html = (await builder.get(`/api/campaigns/${c.id}/preview`)).body.html as string;
    expect(html).toContain(`/media/${asset.id}`);
    const other = (await builder.post('/api/campaigns', { name: 'Other', palette: 'events' })).body;
    expect(((await builder.get(`/api/campaigns/${other.id}/preview`)).body.html as string)).not.toContain(asset.id);
  });
});
