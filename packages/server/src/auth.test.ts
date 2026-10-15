import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sha256 } from './crypto.js';
import { createTestApp, TEST_PASSWORD, type TestApp } from './testkit.js';
import { currentCode } from './totp.js';

let t: TestApp;
beforeAll(async () => {
  t = await createTestApp();
});
afterAll(() => t.close());

describe('password step', () => {
  it('gives the same answer for a wrong password and an unknown email', async () => {
    const u = await t.seedUser('builder', { totp: true });
    const wrong = await t.client().post('/api/auth/login', { email: u.email, password: 'not the password' });
    const unknown = await t.client().post('/api/auth/login', { email: 'nobody@example.test', password: 'whatever it is' });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body).toEqual(unknown.body);
  });

  it('refuses invited and disabled accounts like any bad login', async () => {
    const invited = await t.seedUser('builder', { status: 'invited' });
    const disabled = await t.seedUser('builder', { status: 'disabled' });
    for (const u of [invited, disabled]) {
      expect((await t.client().post('/api/auth/login', { email: u.email, password: u.password })).status).toBe(401);
    }
  });

  it('locks the account after 5 failures, even for the right password, until an Admin unlocks it', async () => {
    const u = await t.seedUser('builder', { totp: true });
    const c = t.client();
    for (let i = 0; i < 5; i++) {
      expect((await c.post('/api/auth/login', { email: u.email, password: 'wrong wrong wrong' })).status).toBe(401);
    }
    expect((await c.post('/api/auth/login', { email: u.email, password: u.password })).status).toBe(429);

    const admin = await t.sessionFor(await t.seedUser('admin', { totp: true }));
    expect((await admin.post(`/api/users/${u.id}/unlock`)).status).toBe(200);
    expect((await c.post('/api/auth/login', { email: u.email, password: u.password })).status).toBe(200);
  });

  it('rejects malformed login bodies with 400', async () => {
    expect((await t.client().post('/api/auth/login', { email: 1 })).status).toBe(400);
  });
});

describe('second factor', () => {
  it('requires a valid code, rotates the session token, and accepts a code only once', async () => {
    const u = await t.seedUser('builder', { totp: true });
    const c = t.client();
    await c.post('/api/auth/login', { email: u.email, password: u.password });
    const partialToken = c.sessionToken;
    expect((await c.get('/api/auth/me')).body).toMatchObject({ stage: 'password', next: 'verify_2fa' });
    await c.refreshCsrf();

    expect((await c.post('/api/auth/2fa/verify', { code: '000000' })).status).toBe(401);
    const code = currentCode(u.totpSecret!);
    expect((await c.post('/api/auth/2fa/verify', { code })).status).toBe(200);
    expect(c.sessionToken).toBeTruthy();
    expect(c.sessionToken).not.toBe(partialToken); // no session fixation
    expect((await c.get('/api/auth/me')).body.stage).toBe('full');

    // The same code cannot be replayed on a new sign-in.
    const again = t.client();
    await again.post('/api/auth/login', { email: u.email, password: u.password });
    await again.refreshCsrf();
    expect((await again.post('/api/auth/2fa/verify', { code })).status).toBe(401);
    expect((await again.post('/api/auth/2fa/verify', { code: currentCode(u.totpSecret!, 1) })).status).toBe(200);
  });

  it('the old partial session token stops working after sign-in completes', async () => {
    const u = await t.seedUser('builder', { totp: true });
    const c = t.client();
    await c.post('/api/auth/login', { email: u.email, password: u.password });
    const oldToken = c.sessionToken!;
    await c.refreshCsrf();
    await c.post('/api/auth/2fa/verify', { code: currentCode(u.totpSecret!) });
    const replay = t.client();
    replay.cookies.set('cl_session', oldToken);
    expect((await replay.get('/api/auth/me')).body.stage).toBe('none');
  });

  it('locks after repeated wrong codes', async () => {
    const u = await t.seedUser('builder', { totp: true });
    const c = t.client();
    await c.post('/api/auth/login', { email: u.email, password: u.password });
    await c.refreshCsrf();
    for (let i = 0; i < 5; i++) expect((await c.post('/api/auth/2fa/verify', { code: '111111' })).status).toBe(401);
    expect((await c.post('/api/auth/2fa/verify', { code: currentCode(u.totpSecret!) })).status).toBe(429);
  });

  it('first sign-in enrolls an authenticator and issues 10 single-use recovery codes', async () => {
    const u = await t.seedUser('qa_reviewer'); // no 2FA yet
    const c = t.client();
    expect((await c.post('/api/auth/login', { email: u.email, password: u.password })).body.next).toBe('enroll_2fa');
    await c.refreshCsrf();

    // Cannot reach the app yet
    expect((await c.get('/api/notifications')).status).toBe(401);

    const start = await c.post('/api/auth/2fa/enroll/start');
    expect(start.status).toBe(200);
    expect(start.body.qrDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(start.body.otpauthUrl).toContain('otpauth://totp/');

    expect((await c.post('/api/auth/2fa/enroll/confirm', { code: '000000' })).status).toBe(401);
    const done = await c.post('/api/auth/2fa/enroll/confirm', { code: currentCode(start.body.secret) });
    expect(done.status).toBe(200);
    const codes: string[] = done.body.recoveryCodes;
    expect(codes).toHaveLength(10);
    expect(new Set(codes).size).toBe(10);
    await c.refreshCsrf();
    expect((await c.get('/api/notifications')).status).toBe(200);

    // The secret is stored encrypted, recovery codes only as hashes.
    const row = (await t.db.query('SELECT totp_secret_enc FROM app_user WHERE id = $1', [u.id])).rows[0];
    expect(row.totp_secret_enc).not.toContain(start.body.secret);
    const stored = (await t.db.query('SELECT code_hash FROM recovery_code WHERE user_id = $1', [u.id])).rows.map((r) => r.code_hash);
    expect(stored).toContain(sha256(codes[0]!.replace(/-/g, '')));
    expect(stored.join()).not.toContain(codes[0]!);

    // A recovery code signs in once, and only once.
    const r1 = t.client();
    await r1.post('/api/auth/login', { email: u.email, password: u.password });
    await r1.refreshCsrf();
    expect((await r1.post('/api/auth/2fa/verify', { recoveryCode: codes[0] })).status).toBe(200);
    const r2 = t.client();
    await r2.post('/api/auth/login', { email: u.email, password: u.password });
    await r2.refreshCsrf();
    expect((await r2.post('/api/auth/2fa/verify', { recoveryCode: codes[0] })).status).toBe(401);
    expect((await r2.post('/api/auth/2fa/verify', { recoveryCode: codes[1]!.toUpperCase() })).status).toBe(200);
  });
});

describe('sessions', () => {
  it('logout ends the session', async () => {
    const c = await t.login(await t.seedUser('builder', { totp: true }));
    expect((await c.post('/api/auth/logout')).status).toBe(200);
    expect((await c.get('/api/auth/me')).body.stage).toBe('none');
  });

  it('expires after 2 hours idle and after 12 hours in total', async () => {
    const u = await t.seedUser('builder', { totp: true });
    const idle = await t.sessionFor(u);
    await t.db.query(`UPDATE auth_session SET last_seen_at = now() - interval '3 hours' WHERE user_id = $1`, [u.id]);
    expect((await idle.get('/api/notifications')).status).toBe(401);

    const absolute = await t.sessionFor(u);
    await t.db.query(`UPDATE auth_session SET expires_at = now() - interval '1 minute' WHERE user_id = $1`, [u.id]);
    expect((await absolute.get('/api/notifications')).status).toBe(401);
  });

  it('a partial session expires after 10 minutes', async () => {
    const u = await t.seedUser('builder', { totp: true });
    const p = await t.sessionFor(u, 'password');
    const exp = (await t.db.query(`SELECT expires_at - created_at AS d FROM auth_session WHERE user_id = $1`, [u.id])).rows[0].d;
    expect(exp.minutes).toBe(10);
    expect((await p.get('/api/auth/me')).body.stage).toBe('password');
  });

  it('refuses state-changing requests without the CSRF token or from another origin', async () => {
    const c = await t.sessionFor(await t.seedUser('builder', { totp: true }));
    const saved = c.csrf;
    c.csrf = undefined;
    expect((await c.post('/api/notifications/read-all')).status).toBe(403);
    c.csrf = 'wrong-token';
    expect((await c.post('/api/notifications/read-all')).status).toBe(403);
    c.csrf = saved;
    expect((await c.post('/api/notifications/read-all', undefined, { origin: 'https://evil.example' })).status).toBe(403);
    expect((await c.post('/api/notifications/read-all')).status).toBe(200);
  });

  it('sets a hardened cookie', async () => {
    const u = await t.seedUser('builder', { totp: true });
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, password: u.password } });
    const cookie = res.cookies[0]!;
    expect(cookie.httpOnly).toBe(true);
    expect(cookie.sameSite).toBe('Lax');
    expect(cookie.path).toBe('/');
  });

  it('changing the password signs out other sessions and checks the current password', async () => {
    const u = await t.seedUser('builder', { totp: true });
    const a = await t.sessionFor(u);
    const b = await t.sessionFor(u);
    expect((await a.post('/api/auth/password', { currentPassword: 'wrong', newPassword: 'a brand new long password' })).status).toBe(401);
    expect((await a.post('/api/auth/password', { currentPassword: TEST_PASSWORD, newPassword: 'short' })).status).toBe(400);
    expect((await a.post('/api/auth/password', { currentPassword: TEST_PASSWORD, newPassword: 'a brand new long password' })).status).toBe(200);
    expect((await a.get('/api/notifications')).status).toBe(200);
    expect((await b.get('/api/notifications')).status).toBe(401);
    expect((await t.client().post('/api/auth/login', { email: u.email, password: 'a brand new long password' })).status).toBe(200);
  });
});

describe('security headers', () => {
  it('sends a content security policy and no framework banner', async () => {
    const res = await t.app.inject('/health');
    expect(res.headers['content-security-policy']).toContain("default-src 'self'");
    expect(res.headers['x-powered-by']).toBeUndefined();
  });
});
