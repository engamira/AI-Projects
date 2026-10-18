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
