import { imageSize } from 'image-size';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { emptyContent, createInstance, blockDefinition, type EmailContent } from '@cl/shared';
import { createTestApp, type Client, type TestApp } from './testkit.js';

// A real 1x1 PNG and 1x1 GIF
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
const GIF = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

let t: TestApp;
let builder: Client;
let admin: Client;
beforeAll(async () => {
  t = await createTestApp();
  builder = await t.sessionFor(await t.seedUser('builder', { totp: true }));
  admin = await t.sessionFor(await t.seedUser('admin', { totp: true }));
});
afterAll(() => t.close());

/** A PNG header that claims a very large picture (only the header is read). */
const hugePng = () => {
  const b = Buffer.from(PNG);
  b.writeUInt32BE(7000, 16);
  return b;
};

describe('asset library', () => {
  it('stores a picture from its real bytes and serves it publicly with the right headers', async () => {
    const up = await builder.upload('/api/assets', 'Summer logo.png', PNG);
    expect(up.status).toBe(201);
    expect(up.body).toMatchObject({ filename: 'Summer logo.png', mime: 'image/png', width: 1, height: 1, sizeBytes: PNG.length });

    // No sign-in needed: email apps load pictures from this address
    const anon = t.client();
    const file = await t.app.inject({ url: `/media/${up.body.id}` });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('image/png');
    expect(file.headers['cache-control']).toContain('immutable');
    expect(file.headers['cross-origin-resource-policy']).toBe('cross-origin');
    expect(file.headers['x-content-type-options']).toBe('nosniff');
    expect(file.rawPayload.equals(PNG)).toBe(true);
    void anon;
  });

  it('stores the same picture once, even if uploaded twice or by different people', async () => {
    const first = await builder.upload('/api/assets', 'a.png', GIF, 'image/gif');
    const second = await admin.upload('/api/assets', 'renamed.gif', GIF, 'image/gif');
    expect([first.status, second.status]).toEqual([201, 200]);
    expect(second.body.id).toBe(first.body.id);
    expect(first.body.mime).toBe('image/gif');
  });

  it('judges the file by its content, not its name or declared type', async () => {
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    for (const [name, data, mime] of [
      ['logo.svg', svg, 'image/svg+xml'],
      ['looks-like.png', svg, 'image/png'], // wrong content, right name
      ['notes.txt', Buffer.from('hello'), 'text/plain'],
      ['fake.png', Buffer.concat([PNG.subarray(0, 8), Buffer.from('garbage-not-a-real-image')]), 'image/png'],
      ['empty.png', Buffer.alloc(0), 'image/png'],
    ] as const) {
      const res = await builder.upload('/api/assets', name, Buffer.from(data), mime);
      expect(res.status, name).toBe(400);
      expect(res.body.message, name).toBeTruthy();
    }
    expect((await builder.upload('/api/assets', 'huge.png', hugePng())).status).toBe(400);
  });

  it('refuses files over 2 MB', async () => {
    const big = Buffer.concat([PNG, Buffer.alloc(2.5 * 1024 * 1024)]);
    const res = await builder.upload('/api/assets', 'big.png', big);
    expect(res.status).toBe(413);
  });

  it('cleans the file name', async () => {
    const res = await builder.upload('/api/assets', '../../evil<script>.png', Buffer.concat([PNG, Buffer.from('x')]));
    // (extra trailing byte makes this a different file from the plain PNG above)
    expect([200, 201, 400]).toContain(res.status);
    if (res.status < 300) expect(res.body.filename).not.toMatch(/[\\/<>]/);
  });

  it('is available to Admin and Builder only; QA reviewers and signed-out visitors are refused', async () => {
    expect((await builder.get('/api/assets')).status).toBe(200);
    expect((await admin.get('/api/assets')).status).toBe(200);
    const qa = await t.sessionFor(await t.seedUser('qa_reviewer', { totp: true }));
    expect((await qa.get('/api/assets')).status).toBe(403);
    expect((await qa.upload('/api/assets', 'x.png', PNG)).status).toBe(403);
    expect((await t.client().get('/api/assets')).status).toBe(401);
    expect((await t.client().upload('/api/assets', 'x.png', PNG)).status).toBe(401);
  });

  it('unknown or malformed picture addresses are plain 404s', async () => {
    expect((await t.app.inject('/media/00000000-0000-4000-8000-000000000000')).statusCode).toBe(404);
    expect((await t.app.inject('/media/not-a-uuid')).statusCode).toBe(404);
  });

  it('records uploads in the activity history', async () => {
    const log = (await admin.get('/api/activity')).body.map((a: { action: string }) => a.action);
    expect(log).toContain('asset.uploaded');
  });
});

describe('pictures inside emails', () => {
  const emailWith = (src: string): EmailContent => {
    const img = createInstance(blockDefinition('image')!);
    img.props.src = src;
    img.props.alt = 'A picture';
    return { ...emptyContent(), blocks: [img] };
  };

  it('can use a library picture, which becomes a full web address in the email', async () => {
    const asset = (await builder.upload('/api/assets', 'hero.png', PNG)).body;
    const c = (await builder.post('/api/campaigns', { name: 'With picture' })).body;
    const content = emailWith(`asset:${asset.id}`);
    expect((await builder.put(`/api/campaigns/${c.id}/draft`, { content, baseVersion: 1 })).status).toBe(200);
    const html = (await builder.get(`/api/campaigns/${c.id}/preview`)).body.html as string;
    expect(html).toContain(`http://localhost:3000/media/${asset.id}`);
    expect(html).not.toContain('asset:');
    // what is stored stays environment-independent
    expect((await builder.get(`/api/campaigns/${c.id}`)).body.draft.content.blocks[0].props.src).toBe(`asset:${asset.id}`);
  });

  it('refuses a picture that is not in the library, and unsafe addresses', async () => {
    const c = (await builder.post('/api/campaigns', { name: 'Bad picture' })).body;
    const put = (src: string) => builder.put(`/api/campaigns/${c.id}/draft`, { content: emailWith(src), baseVersion: 1 });
    const missing = await put('asset:00000000-0000-4000-8000-000000000000');
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('missing_asset');
    expect((await put('asset:not-an-id')).status).toBe(400);
    expect((await put('http://insecure.example/x.png')).status).toBe(400);
    expect((await put('javascript:alert(1)')).status).toBe(400);
  });
});

describe('cropped copies for round and equal-size pictures', () => {
  const dims = (buf: Buffer) => imageSize(buf);
  const photo = async (w: number, h: number, color = '#c0392b') => sharp({ create: { width: w, height: h, channels: 3, background: color } }).png().toBuffer();

  it('wide, tall and square pictures all come out the same shape, and the original is never changed', async () => {
    for (const [w, h] of [[600, 200], [200, 700], [300, 300]] as const) {
      const buf = await photo(w, h);
      const asset = (await builder.upload('/api/assets', `p${w}x${h}.png`, buf)).body;
      const sq = await t.app.inject({ url: `/media/${asset.id}/square-240.jpg` });
      expect(sq.statusCode, `${w}x${h}`).toBe(200);
      expect(sq.headers['content-type']).toBe('image/jpeg');
      expect(sq.headers['cross-origin-resource-policy']).toBe('cross-origin');
      expect(sq.headers['cache-control']).toContain('immutable');
      expect(dims(sq.rawPayload)).toMatchObject({ width: 240, height: 240 });
      const card = await t.app.inject({ url: `/media/${asset.id}/card-480.jpg` });
      expect(dims(card.rawPayload)).toMatchObject({ width: 480, height: 360 });
      const original = await t.app.inject({ url: `/media/${asset.id}` });
      expect(original.rawPayload.equals(buf)).toBe(true);
    }
  });

  it('is made once and then reused', async () => {
    const asset = (await builder.upload('/api/assets', 'once.png', await photo(500, 250, '#2980b9'))).body;
    const a = await t.app.inject({ url: `/media/${asset.id}/square-120.jpg` });
    const b = await t.app.inject({ url: `/media/${asset.id}/square-120.jpg` });
    expect(a.rawPayload.equals(b.rawPayload)).toBe(true);
    expect((await t.db.query('SELECT count(*)::int AS n FROM asset_variant WHERE asset_id = $1', [asset.id])).rows[0].n).toBe(1);
  });

  it('only the agreed sizes exist; anything else is a plain 404', async () => {
    const asset = (await builder.upload('/api/assets', 'sizes.png', await photo(400, 400, '#27ae60'))).body;
    for (const v of ['square-241.jpg', 'square-9999.jpg', 'card-100.jpg', 'square-240.png', 'square-240', 'portrait-240.jpg', '..%2F..%2Fetc', 'square-240.jpg.exe']) {
      expect((await t.app.inject({ url: `/media/${asset.id}/${v}` })).statusCode, v).toBe(404);
    }
    expect((await t.app.inject({ url: '/media/00000000-0000-4000-8000-000000000000/square-240.jpg' })).statusCode).toBe(404);
    expect((await t.app.inject({ url: '/media/not-a-uuid/square-240.jpg' })).statusCode).toBe(404);
  });

  it('the generated email asks for the crops for round photos and cards, and leaves other websites\' pictures alone', async () => {
    const asset = (await builder.upload('/api/assets', 'person.png', await photo(640, 320, '#8e44ad'))).body;
    const speakers = createInstance(blockDefinition('speakers')!);
    speakers.props.p1Image = `asset:${asset.id}`;
    speakers.props.p2Image = 'https://example.com/photo.jpg';
    const events = (await builder.post('/api/campaigns', { name: 'Crops', palette: 'events' })).body;
    expect((await builder.put(`/api/campaigns/${events.id}/draft`, { content: { ...events.draft.content, blocks: [speakers] }, baseVersion: 1 })).status).toBe(200);
    const html = (await builder.get(`/api/campaigns/${events.id}/preview`)).body.html as string;
    expect(html).toContain(`/media/${asset.id}/square-240.jpg`);
    expect(html).toContain('https://example.com/photo.jpg');
    expect(html).not.toContain('example.com/photo.jpg/square');

    const products = createInstance(blockDefinition('products')!);
    products.props.c1Image = `asset:${asset.id}`;
    const cosmetics = (await builder.post('/api/campaigns', { name: 'Cards', palette: 'cosmetics' })).body;
    await builder.put(`/api/campaigns/${cosmetics.id}/draft`, { content: { ...cosmetics.draft.content, blocks: [products] }, baseVersion: 1 });
    expect(((await builder.get(`/api/campaigns/${cosmetics.id}/preview`)).body.html as string)).toContain(`/media/${asset.id}/card-480.jpg`);
  });
});

describe('picture folders', () => {
  const mkPng = async (n: number) => sharp({ create: { width: 2 + n, height: 2, channels: 3, background: { r: n * 40, g: 90, b: 160 } } }).png().toBuffer();
  const folders = async () => (await builder.get('/api/asset-folders')).body as { id: string; name: string; count: number }[];

  it('a folder can be created, with whitespace tidied; empty, too long and repeated names are refused', async () => {
    const f = await builder.post('/api/asset-folders', { name: '  Summer   2026 ' });
    expect(f.status).toBe(201);
    expect(f.body.name).toBe('Summer 2026');
    expect((await builder.post('/api/asset-folders', { name: '   ' })).status).toBe(400);
    expect((await builder.post('/api/asset-folders', { name: 'x'.repeat(61) })).status).toBe(400);
    const dup = await admin.post('/api/asset-folders', { name: 'summer 2026' });
    expect(dup.status).toBe(400);
    expect(dup.body.message).toContain('already exists');
  });

  it('pictures can be uploaded into a folder, moved between folders and back to "No folder"', async () => {
    const a = (await builder.post('/api/asset-folders', { name: 'Logos' })).body;
    const b = (await builder.post('/api/asset-folders', { name: 'Banners' })).body;
    const up = await builder.upload(`/api/assets?folder=${a.id}`, 'logo.png', await mkPng(1));
    expect(up.body.folderId).toBe(a.id);
    const loose = await builder.upload('/api/assets', 'loose.png', await mkPng(2));
    expect(loose.body.folderId).toBeNull();
    expect((await builder.patch(`/api/assets/${up.body.id}/folder`, { folderId: b.id })).status).toBe(200);
    expect(((await builder.get('/api/assets')).body as { id: string; folderId: string | null }[]).find((x) => x.id === up.body.id)?.folderId).toBe(b.id);
    expect((await folders()).find((x) => x.id === b.id)?.count).toBe(1);
    expect((await admin.patch(`/api/assets/${up.body.id}/folder`, { folderId: null })).status).toBe(200);
    expect((await folders()).find((x) => x.id === b.id)?.count).toBe(0);
    // unknown folder or picture
    expect((await builder.patch(`/api/assets/${loose.body.id}/folder`, { folderId: '00000000-0000-4000-8000-00000000dead' })).status).toBe(404);
    expect((await builder.patch('/api/assets/00000000-0000-4000-8000-00000000dead/folder', { folderId: null })).status).toBe(404);
    expect((await builder.upload('/api/assets?folder=00000000-0000-4000-8000-00000000dead', 'x.png', await mkPng(3))).status).toBe(404);
  });

  it('renaming works, a name that is taken is refused; deleting a folder keeps its pictures', async () => {
    const f = (await builder.post('/api/asset-folders', { name: 'Old name' })).body;
    (await builder.post('/api/asset-folders', { name: 'Taken' }));
    expect((await builder.patch(`/api/asset-folders/${f.id}`, { name: 'Taken' })).status).toBe(400);
    expect((await builder.patch(`/api/asset-folders/${f.id}`, { name: 'New name' })).body.name).toBe('New name');
    const up = await builder.upload(`/api/assets?folder=${f.id}`, 'keep.png', await mkPng(4));
    expect((await builder.delete(`/api/asset-folders/${f.id}`)).status).toBe(204);
    expect((await builder.delete(`/api/asset-folders/${f.id}`)).status).toBe(404);
    const after = ((await builder.get('/api/assets')).body as { id: string; folderId: string | null }[]).find((x) => x.id === up.body.id);
    expect(after).toBeDefined();
    expect(after!.folderId).toBeNull();
    expect((await builder.get(`/media/${up.body.id}`)).status).toBe(200); // the picture itself still works
  });

  it('the built-in sample pictures are filed in their own folder, and a QA reviewer cannot touch folders', async () => {
    const sample = (await folders()).find((x) => x.name === 'Sample pictures');
    expect(sample?.count).toBeGreaterThanOrEqual(30);
    const qa = await t.sessionFor(await t.seedUser('qa_reviewer', { totp: true }));
    expect((await qa.get('/api/asset-folders')).status).toBe(403);
    expect((await qa.post('/api/asset-folders', { name: 'Nope' })).status).toBe(403);
    expect((await qa.delete(`/api/asset-folders/${sample!.id}`)).status).toBe(403);
  });
});
