import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type Client, type SeededUser, type TestApp } from './testkit.js';
import { currentCode } from './totp.js';

let t: TestApp;
let admin: SeededUser;
let adminClient: Client;
beforeAll(async () => {
  t = await createTestApp();
  admin = await t.seedUser('admin', { totp: true });
  adminClient = await t.sessionFor(admin);
});
afterAll(() => t.close());

const tokenOf = (url: string) => new URL(url).searchParams.get('token')!;

describe('Admin creates users and invitations', () => {
  it('invites a user, who sets a password, enrolls 2FA and signs in; the Admin is notified and everything is logged', async () => {
    const created = await adminClient.post('/api/users', { email: 'New.Builder@Example.test', name: 'New Builder', role: 'builder' });
    expect(created.status).toBe(201);
    expect(created.body.user).toMatchObject({ email: 'new.builder@example.test', role: 'builder', status: 'invited', twoFactorEnabled: false });
    const token = tokenOf(created.body.inviteUrl);

    // Invite is looked up without signing in; it reveals only email and name.
    const anon = t.client();
    expect((await anon.get(`/api/auth/invite/${token}`)).body).toEqual({ email: 'new.builder@example.test', name: 'New Builder' });
    expect((await anon.get('/api/auth/invite/not-a-real-token-0000000')).status).toBe(404);

    // Weak passwords are refused and do not use up the link.
    expect((await anon.post('/api/auth/invite/accept', { token, password: 'tooshort' })).status).toBe(400);
    expect((await anon.post('/api/auth/invite/accept', { token, password: 'a long enough password' })).status).toBe(200);
    // Single use
    expect((await anon.post('/api/auth/invite/accept', { token, password: 'another long password' })).status).toBe(404);

    const login = await anon.post('/api/auth/login', { email: 'new.builder@example.test', password: 'a long enough password' });
    expect(login.body.next).toBe('enroll_2fa');

    const notes = await adminClient.get('/api/notifications');
    expect(notes.body.unread).toBeGreaterThan(0);
    expect(notes.body.items.some((n: { title: string }) => n.title.includes('New Builder'))).toBe(true);

    const log = await adminClient.get('/api/activity');
    const actions = log.body.map((a: { action: string }) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['user.created', 'user.invite_accepted']));
  });

  it('refuses duplicate emails', async () => {
    const body = { email: 'dupe@example.test', name: 'Dupe', role: 'qa_reviewer' };
    expect((await adminClient.post('/api/users', body)).status).toBe(201);
    expect((await adminClient.post('/api/users', { ...body, email: 'DUPE@example.test' })).status).toBe(409);
  });

  it('validates input and role names', async () => {
    expect((await adminClient.post('/api/users', { email: 'bad', name: 'X', role: 'builder' })).status).toBe(400);
    expect((await adminClient.post('/api/users', { email: 'ok@example.test', name: 'X', role: 'superuser' })).status).toBe(400);
  });

  it('an expired invitation no longer works', async () => {
    const u = await adminClient.post('/api/users', { email: 'late@example.test', name: 'Late', role: 'builder' });
    await t.db.query(`UPDATE invitation SET expires_at = now() - interval '1 minute'`);
    const token = tokenOf(u.body.inviteUrl);
    expect((await t.client().get(`/api/auth/invite/${token}`)).status).toBe(404);
  });

  it('a reissued link replaces the old one and works for a password reset', async () => {
    const u = await t.seedUser('builder', { totp: true });
    const first = await adminClient.post(`/api/users/${u.id}/invite`);
    const second = await adminClient.post(`/api/users/${u.id}/invite`);
    expect((await t.client().get(`/api/auth/invite/${tokenOf(first.body.inviteUrl)}`)).status).toBe(404);

    const victimSession = await t.sessionFor(u);
    expect((await t.client().post('/api/auth/invite/accept', { token: tokenOf(second.body.inviteUrl), password: 'my new reset password' })).status).toBe(200);
    expect((await victimSession.get('/api/notifications')).status).toBe(401); // old sessions ended
    expect((await t.client().post('/api/auth/login', { email: u.email, password: 'my new reset password' })).body.next).toBe('verify_2fa'); // 2FA kept
  });

  it('stores invitation tokens only as hashes', async () => {
    const u = await adminClient.post('/api/users', { email: 'hash@example.test', name: 'Hash', role: 'builder' });
    const token = tokenOf(u.body.inviteUrl);
    const rows = (await t.db.query('SELECT token_hash FROM invitation')).rows.map((r) => r.token_hash);
    expect(rows).not.toContain(token);
  });
});

describe('Admin safety rules', () => {
  it('cannot change their own role or disable themselves', async () => {
    expect((await adminClient.patch(`/api/users/${admin.id}`, { role: 'builder' })).status).toBe(409);
    expect((await adminClient.post(`/api/users/${admin.id}/disable`)).status).toBe(409);
  });

  it('keeps at least one active Admin: a lone Admin cannot disable or demote themselves', async () => {
    const other = await t.seedUser('admin', { totp: true });
    expect((await adminClient.post(`/api/users/${other.id}/disable`)).status).toBe(200);
    // Only the signed-in Admin remains active now (plus any others from other tests are disabled below)
    const active = (await t.db.query(`SELECT id FROM app_user WHERE role = 'admin' AND status = 'active'`)).rows;
    for (const a of active.filter((r) => r.id !== admin.id)) await t.db.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [a.id]);
    expect((await adminClient.post(`/api/users/${admin.id}/disable`)).status).toBe(409);
    expect((await adminClient.patch(`/api/users/${admin.id}`, { role: 'builder' })).status).toBe(409);
  });

  it('changing a role ends that user\'s sessions and notifies them', async () => {
    const u = await t.seedUser('builder', { totp: true });
    const session = await t.sessionFor(u);
    expect((await adminClient.patch(`/api/users/${u.id}`, { role: 'qa_reviewer' })).status).toBe(200);
    expect((await session.get('/api/notifications')).status).toBe(401);
    const relog = await t.login(u);
    expect((await relog.get('/api/auth/me')).body.user.role).toBe('qa_reviewer');
    const notes = await relog.get('/api/notifications');
    expect(notes.body.items.some((n: { type: string }) => n.type === 'user.role_changed')).toBe(true);
    const log = (await adminClient.get('/api/activity')).body;
    expect(log.find((a: { action: string }) => a.action === 'user.role_changed')?.details).toMatchObject({ from: 'builder', to: 'qa_reviewer' });
  });

  it('resetting 2FA clears the authenticator and forces re-enrollment', async () => {
    const u = await t.seedUser('builder', { totp: true });
    const session = await t.sessionFor(u);
    const res = await adminClient.post(`/api/users/${u.id}/reset-2fa`);
    expect(res.body.twoFactorEnabled).toBe(false);
    expect((await session.get('/api/notifications')).status).toBe(401);
    const c = t.client();
    expect((await c.post('/api/auth/login', { email: u.email, password: u.password })).body.next).toBe('enroll_2fa');
    // old authenticator no longer works
    await c.refreshCsrf();
    expect((await c.post('/api/auth/2fa/verify', { code: currentCode(u.totpSecret!) })).status).toBe(409);
  });
});

describe('activity log and notifications', () => {
  it('the activity log cannot be edited or deleted, even by the application database user', async () => {
    await adminClient.post('/api/users', { email: 'log@example.test', name: 'Log', role: 'builder' });
    await expect(t.db.query(`UPDATE activity_log SET action = 'tampered'`)).rejects.toThrow(/append-only/);
    await expect(t.db.query(`DELETE FROM activity_log`)).rejects.toThrow(/append-only/);
  });

  it('never records secrets in activity details', async () => {
    const all = (await t.db.query('SELECT details::text AS d FROM activity_log')).rows.map((r) => r.d).join(' ');
    expect(all).not.toMatch(/token|password|secret|inviteUrl/i);
  });

  it('users only see and change their own notifications', async () => {
    const a = await t.seedUser('builder', { totp: true });
    const b = await t.seedUser('builder', { totp: true });
    await t.db.query(`INSERT INTO notification (workspace_id, user_id, type, title) VALUES ('00000000-0000-4000-8000-000000000001', $1, 'x', 'for A')`, [a.id]);
    const ca = await t.sessionFor(a);
    const cb = await t.sessionFor(b);
    const mine = await ca.get('/api/notifications');
    expect(mine.body.unread).toBe(1);
    const id = mine.body.items[0].id;
    expect((await cb.get('/api/notifications')).body.items).toHaveLength(0);
    await cb.post(`/api/notifications/${id}/read`); // someone else's: no effect
    expect((await ca.get('/api/notifications')).body.unread).toBe(1);
    await ca.post(`/api/notifications/${id}/read`);
    expect((await ca.get('/api/notifications')).body.unread).toBe(0);
  });
});
