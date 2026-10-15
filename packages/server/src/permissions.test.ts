import fastifyCookie from '@fastify/cookie';
import Fastify from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import accessPlugin from './access.js';
import { CAPABILITIES, ROLES, ROLE_CAPABILITIES, hasCapability, type Capability, type Role } from '@cl/shared';
import { createTestApp, type TestApp } from './testkit.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

const ZERO_UUID = '00000000-0000-4000-8000-00000000dead';
const fill = (url: string) => url.replace(':id', ZERO_UUID).replace(':token', 'x'.repeat(24));
const apiRoutes = () =>
  t.routes
    .filter((r) => r.url.startsWith('/api/'))
    .flatMap((r) => (Array.isArray(r.method) ? r.method : [r.method]).map((m) => ({ ...r, method: m })))
    .filter((r) => r.method !== 'HEAD' && r.method !== 'OPTIONS');

describe('role definitions match the agreed specification', () => {
  const caps = (role: Role) => new Set(ROLE_CAPABILITIES[role]);
  it('Builder can edit, submit, test send and send, but never review or approve', () => {
    for (const c of ['campaign.edit', 'campaign.submit', 'campaign.test_send', 'campaign.send'] as const) expect(caps('builder').has(c)).toBe(true);
    for (const c of ['qa.review', 'qa.approve', 'users.manage'] as const) expect(caps('builder').has(c)).toBe(false);
  });
  it('QA reviewer can review and approve, but cannot edit, submit or send', () => {
    expect([...caps('qa_reviewer')].sort()).toEqual(['qa.approve', 'qa.review']);
  });
  it('Admin manages the workspace and can send, but has no review/approval or normal editing capability', () => {
    for (const c of ['users.manage', 'campaign.send', 'html.custom', 'brand.manage', 'rules.manage'] as const) expect(caps('admin').has(c)).toBe(true);
    for (const c of ['qa.review', 'qa.approve', 'campaign.edit', 'campaign.submit'] as const) expect(caps('admin').has(c)).toBe(false);
  });
  it('every capability is granted to at least one role', () => {
    for (const c of CAPABILITIES) expect(ROLES.some((r) => hasCapability(r, c))).toBe(true);
  });
});

describe('route protection', () => {
  it('every /api route declares its access level (deny by default otherwise)', () => {
    const undeclared = apiRoutes().filter((r) => !r.access).map((r) => `${r.method} ${r.url}`);
    expect(undeclared).toEqual([]);
  });

  it('an undeclared /api route is refused', async () => {
    const probe = Fastify();
    await probe.register(fastifyCookie);
    await probe.register(accessPlugin, { db: t.db, config: t.config });
    probe.get('/api/__undeclared', async () => ({ leaked: true })); // no config.access
    probe.get('/api/__declared', { config: { access: 'public' } }, async () => ({ ok: true }));
    await probe.ready();
    const refused = await probe.inject('/api/__undeclared');
    expect(refused.statusCode).toBe(403);
    expect(refused.body).not.toContain('leaked');
    expect((await probe.inject('/api/__declared')).statusCode).toBe(200);
    await probe.close();
  });

  it('unauthenticated requests are refused on every non-public route', async () => {
    for (const r of apiRoutes().filter((x) => x.access && x.access !== 'public')) {
      const res = await t.client().request(r.method as 'GET', fill(r.url), r.method === 'GET' ? undefined : {});
      expect(res.status, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('each role can reach exactly the routes its capabilities allow (including direct API calls)', async () => {
    const sessions = new Map<Role, Awaited<ReturnType<TestApp['sessionFor']>>>();
    for (const role of ROLES) sessions.set(role, await t.sessionFor(await t.seedUser(role, { totp: true })));

    const guarded = apiRoutes().filter(
      (r) => r.access && r.access !== 'public' && r.access !== 'partial' && r.access !== 'any_session',
    );
    expect(guarded.length).toBeGreaterThan(5);
    for (const r of guarded) {
      for (const role of ROLES) {
        const allowed = r.access === 'session' || hasCapability(role, r.access as Capability);
        const res = await sessions.get(role)!.request(r.method as 'GET', fill(r.url), r.method === 'GET' ? undefined : {});
        const label = `${role} ${r.method} ${r.url}`;
        if (allowed) expect([401, 403], label).not.toContain(res.status);
        else expect(res.status, label).toBe(403);
      }
    }
  });

  it('Admin cannot use a QA-only capability (no admin bypass)', async () => {
    const admin = await t.sessionFor(await t.seedUser('admin', { totp: true }));
    expect(hasCapability('admin', 'qa.approve')).toBe(false);
    // The users API is admin-only: builders and QA reviewers are refused
    for (const role of ['builder', 'qa_reviewer'] as const) {
      const c = await t.sessionFor(await t.seedUser(role, { totp: true }));
      expect((await c.get('/api/users')).status).toBe(403);
      expect((await c.get('/api/activity')).status).toBe(403);
    }
    expect((await admin.get('/api/users')).status).toBe(200);
  });

  it('a session that has only passed the password step cannot reach protected routes', async () => {
    const u = await t.seedUser('admin', { totp: true });
    const partial = await t.sessionFor(u, 'password');
    for (const r of apiRoutes().filter((x) => x.access && !['public', 'partial', 'any_session'].includes(x.access))) {
      const res = await partial.request(r.method as 'GET', fill(r.url), r.method === 'GET' ? undefined : {});
      expect(res.status, `${r.method} ${r.url}`).toBe(401);
    }
  });

  it('partial-only routes refuse fully signed-in sessions', async () => {
    const full = await t.sessionFor(await t.seedUser('builder', { totp: true }));
    const res = await full.post('/api/auth/2fa/verify', { code: '123456' });
    expect(res.status).toBe(403);
  });

  it('disabling a user ends their session immediately', async () => {
    const admin = await t.sessionFor(await t.seedUser('admin', { totp: true }));
    const victim = await t.seedUser('builder', { totp: true });
    const c = await t.sessionFor(victim);
    expect((await c.get('/api/notifications')).status).toBe(200);
    expect((await admin.post(`/api/users/${victim.id}/disable`)).status).toBe(200);
    expect((await c.get('/api/notifications')).status).toBe(401);
  });
});
