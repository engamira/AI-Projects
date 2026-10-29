import type { FastifyInstance, FastifyReply } from 'fastify';
import QRCode from 'qrcode';
import { z } from 'zod';
import {
  ROLE_CAPABILITIES,
  type EnrollConfirmResponse,
  type EnrollStartResponse,
  type InviteLookupResponse,
  type LoginResponse,
  type MeResponse,
  type Role,
} from '@cl/shared';
import { LOCKOUT_MS, MAX_FAILED_ATTEMPTS, RECOVERY_CODE_COUNT, type AppConfig } from '../config.js';
import {
  burnPasswordCheck,
  checkPasswordPolicy,
  decryptSecret,
  encryptSecret,
  generateRecoveryCode,
  hashPassword,
  normalizeRecoveryCode,
  sha256,
  verifyPassword,
} from '../crypto.js';
import { DEFAULT_WORKSPACE_ID, withTransaction, type Db, type Queryable } from '../db.js';
import {
  clearSessionCookie,
  createSession,
  revokeUserSessions,
  setSessionCookie,
} from '../sessions.js';
import { logActivity, notifyAdmins } from '../services.js';
import { checkCode, newSecret, otpauthUrl } from '../totp.js';

type UserRow = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: string;
  password_hash: string | null;
  totp_secret_enc: string | null;
  totp_enabled_at: Date | null;
  totp_last_step: string | null;
  locked_until: Date | null;
};

const USER_COLS = `id, email, name, role, status, password_hash, totp_secret_enc, totp_enabled_at, totp_last_step, locked_until`;
const RATE = { max: 10, timeWindow: '1 minute' };

const loginBody = z.object({ email: z.string().trim().min(3).max(254), password: z.string().min(1).max(256) });
const codeBody = z
  .object({ code: z.string().trim().max(10).optional(), recoveryCode: z.string().trim().max(40).optional() })
  .refine((b) => b.code || b.recoveryCode, { message: 'Enter a code.' });
const confirmBody = z.object({ code: z.string().trim().max(10) });
const acceptBody = z.object({ token: z.string().min(10).max(200), password: z.string().max(256) });
const passwordBody = z.object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) });

const isLocked = (u: UserRow) => !!u.locked_until && u.locked_until.getTime() > Date.now();

export function authRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  /** Counts a failed password/second-factor attempt and locks the account after too many. */
  async function registerFailure(userId: string): Promise<void> {
    const r = await db.query<{ locked_until: Date | null }>(
      `UPDATE app_user SET
         locked_until    = CASE WHEN failed_attempts + 1 >= $2 THEN now() + ($3 || ' milliseconds')::interval ELSE locked_until END,
         failed_attempts = CASE WHEN failed_attempts + 1 >= $2 THEN 0 ELSE failed_attempts + 1 END
       WHERE id = $1 RETURNING locked_until`,
      [userId, MAX_FAILED_ATTEMPTS, String(LOCKOUT_MS)],
    );
    const lockedUntil = r.rows[0]?.locked_until;
    if (lockedUntil && lockedUntil.getTime() > Date.now()) {
      await logActivity(db, { actorId: null, action: 'auth.account_locked', entityType: 'user', entityId: userId });
    }
  }

  /** Replaces the partial session with a fresh full one (new token: no session fixation). */
  async function completeLogin(reply: FastifyReply, userId: string, oldSessionId: string, q: Queryable = db) {
    await q.query('DELETE FROM auth_session WHERE id = $1', [oldSessionId]);
    const s = await createSession(q, userId, 'full');
    await q.query('UPDATE app_user SET last_login_at = now(), failed_attempts = 0, locked_until = NULL WHERE id = $1', [userId]);
    await logActivity(q, { actorId: userId, action: 'auth.login', entityType: 'user', entityId: userId });
    setSessionCookie(reply, config, s.token, s.maxAgeMs);
  }

  const lockedReply = (reply: FastifyReply) =>
    reply.status(429).send({ error: 'account_locked', message: 'Too many failed attempts. Try again in 15 minutes.' });

  // ---- who am I ----
  app.get('/api/auth/me', { config: { access: 'public' } }, async (req): Promise<MeResponse> => {
    const a = req.auth;
    const off = config.twoStep ? {} : { twoStepOff: true };
    if (!a) return { stage: 'none', ...off };
    const user = {
      id: a.user.id,
      email: a.user.email,
      name: a.user.name,
      role: a.user.role,
      capabilities: [...ROLE_CAPABILITIES[a.user.role]],
    };
    if (a.stage === 'password') {
      return { stage: 'password', csrfToken: a.csrfToken, user, next: a.user.hasTotp ? 'verify_2fa' : 'enroll_2fa', ...off };
    }
    return { stage: 'full', csrfToken: a.csrfToken, user, ...off };
  });

  // ---- step 1: password ----
  app.post('/api/auth/login', { config: { access: 'public', rateLimit: RATE } }, async (req, reply) => {
    const body = loginBody.parse(req.body);
    const email = body.email.toLowerCase();
    const r = await db.query<UserRow>(`SELECT ${USER_COLS} FROM app_user WHERE workspace_id = $1 AND email = $2`, [
      DEFAULT_WORKSPACE_ID,
      email,
    ]);
    const user = r.rows[0];
    const invalid = () => reply.status(401).send({ error: 'invalid_credentials', message: 'Invalid email or password.' });

    if (!user || user.status !== 'active' || !user.password_hash) {
      await burnPasswordCheck(body.password);
      return invalid();
    }
    if (isLocked(user)) return lockedReply(reply);
    if (!(await verifyPassword(user.password_hash, body.password))) {
      await registerFailure(user.id);
      return invalid();
    }

    if (!config.twoStep) {
      // TESTING ONLY (TWO_STEP_LOGIN=off): the password alone signs in. Every sign-in is recorded as such.
      await db.query(`DELETE FROM auth_session WHERE user_id = $1 AND stage = 'password'`, [user.id]);
      const full = await createSession(db, user.id, 'full');
      await db.query('UPDATE app_user SET last_login_at = now(), failed_attempts = 0, locked_until = NULL WHERE id = $1', [user.id]);
      await logActivity(db, { actorId: user.id, action: 'auth.login', entityType: 'user', entityId: user.id, details: { twoStep: false } });
      setSessionCookie(reply, config, full.token, full.maxAgeMs);
      const done: LoginResponse = { next: 'done' };
      return done;
    }

    // Any older sessions of this browser/user at the partial stage are replaced.
    await db.query(`DELETE FROM auth_session WHERE user_id = $1 AND stage = 'password'`, [user.id]);
    const s = await createSession(db, user.id, 'password');
    setSessionCookie(reply, config, s.token, s.maxAgeMs);
    const out: LoginResponse = { next: user.totp_enabled_at ? 'verify_2fa' : 'enroll_2fa' };
    return out;
  });

  // ---- step 2a: first-time authenticator setup ----
  app.post('/api/auth/2fa/enroll/start', { config: { access: 'partial', rateLimit: RATE } }, async (req, reply) => {
    const a = req.auth!;
    if (a.user.hasTotp) return reply.status(409).send({ error: 'already_enrolled' });
    const secret = newSecret();
    await db.query('UPDATE auth_session SET pending_totp_secret_enc = $2 WHERE id = $1', [
      a.sessionId,
      encryptSecret(secret, config.secretKey),
    ]);
    const url = otpauthUrl(secret, a.user.email);
    const out: EnrollStartResponse = { otpauthUrl: url, qrDataUrl: await QRCode.toDataURL(url, { margin: 1, width: 220 }), secret };
    return out;
  });

  app.post('/api/auth/2fa/enroll/confirm', { config: { access: 'partial', rateLimit: RATE } }, async (req, reply) => {
    const a = req.auth!;
    const { code } = confirmBody.parse(req.body);
    const u = (await db.query<UserRow>(`SELECT ${USER_COLS} FROM app_user WHERE id = $1`, [a.user.id])).rows[0]!;
    if (isLocked(u)) return lockedReply(reply);
    if (u.totp_enabled_at) return reply.status(409).send({ error: 'already_enrolled' });

    const pending = (
      await db.query<{ pending_totp_secret_enc: string | null }>('SELECT pending_totp_secret_enc FROM auth_session WHERE id = $1', [a.sessionId])
    ).rows[0]?.pending_totp_secret_enc;
    if (!pending) return reply.status(400).send({ error: 'enroll_not_started', message: 'Start setup again.' });

    const secret = decryptSecret(pending, config.secretKey);
    const step = checkCode(secret, code, a.user.email);
    if (step === null) {
      await registerFailure(u.id);
      return reply.status(401).send({ error: 'invalid_code', message: 'That code is not correct. Check the time on your phone and try again.' });
    }

    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    await withTransaction(db, async (q) => {
      await q.query('UPDATE app_user SET totp_secret_enc = $2, totp_enabled_at = now(), totp_last_step = $3 WHERE id = $1', [
        u.id,
        encryptSecret(secret, config.secretKey),
        step,
      ]);
      await q.query('DELETE FROM recovery_code WHERE user_id = $1', [u.id]);
      for (const c of codes) {
        await q.query('INSERT INTO recovery_code (user_id, code_hash) VALUES ($1, $2)', [u.id, sha256(normalizeRecoveryCode(c))]);
      }
      await logActivity(q, { actorId: u.id, action: 'auth.2fa_enrolled', entityType: 'user', entityId: u.id });
      await completeLogin(reply, u.id, a.sessionId, q);
    });
    const out: EnrollConfirmResponse = { recoveryCodes: codes };
    return out;
  });

  // ---- step 2b: returning users ----
  app.post('/api/auth/2fa/verify', { config: { access: 'partial', rateLimit: RATE } }, async (req, reply) => {
    const a = req.auth!;
    const body = codeBody.parse(req.body);
    const u = (await db.query<UserRow>(`SELECT ${USER_COLS} FROM app_user WHERE id = $1`, [a.user.id])).rows[0]!;
    if (!u.totp_secret_enc || !u.totp_enabled_at) return reply.status(409).send({ error: 'not_enrolled' });
    if (isLocked(u)) return lockedReply(reply);

    let ok = false;
    if (body.code) {
      const step = checkCode(decryptSecret(u.totp_secret_enc, config.secretKey), body.code, u.email);
      // A time step can be used once: replaying a just-used code is refused.
      if (step !== null && (u.totp_last_step === null || BigInt(step) > BigInt(u.totp_last_step))) {
        const upd = await db.query(
          'UPDATE app_user SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)',
          [u.id, step],
        );
        ok = upd.rowCount === 1;
      }
    } else if (body.recoveryCode) {
      const upd = await db.query(
        'UPDATE recovery_code SET used_at = now() WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL',
        [u.id, sha256(normalizeRecoveryCode(body.recoveryCode))],
      );
      ok = upd.rowCount === 1;
      if (ok) await logActivity(db, { actorId: u.id, action: 'auth.recovery_code_used', entityType: 'user', entityId: u.id });
    }

    if (!ok) {
      await registerFailure(u.id);
      return reply.status(401).send({ error: 'invalid_code', message: 'That code is not correct.' });
    }
    await completeLogin(reply, u.id, a.sessionId);
    return { ok: true };
  });

  app.post('/api/auth/logout', { config: { access: 'any_session' } }, async (req, reply) => {
    await db.query('DELETE FROM auth_session WHERE id = $1', [req.auth!.sessionId]);
    clearSessionCookie(reply, config);
    return { ok: true };
  });

  // ---- invitations (also used for password resets) ----
  app.get<{ Params: { token: string } }>(
    '/api/auth/invite/:token',
    { config: { access: 'public', rateLimit: RATE } },
    async (req, reply) => {
      const r = await db.query<{ email: string; name: string }>(
        `SELECT u.email, u.name FROM invitation i JOIN app_user u ON u.id = i.user_id
          WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now() AND u.status <> 'disabled'`,
        [sha256(req.params.token)],
      );
      if (!r.rows[0]) return reply.status(404).send({ error: 'invalid_invite', message: 'This link is invalid or has expired.' });
      const out: InviteLookupResponse = r.rows[0];
      return out;
    },
  );

  app.post('/api/auth/invite/accept', { config: { access: 'public', rateLimit: RATE } }, async (req, reply) => {
    const body = acceptBody.parse(req.body);
    const inv = (
      await db.query<{ id: string; user_id: string; email: string; name: string; status: string }>(
        `SELECT i.id, u.id AS user_id, u.email, u.name, u.status FROM invitation i JOIN app_user u ON u.id = i.user_id
          WHERE i.token_hash = $1 AND i.used_at IS NULL AND i.expires_at > now() AND u.status <> 'disabled'`,
        [sha256(body.token)],
      )
    ).rows[0];
    if (!inv) return reply.status(404).send({ error: 'invalid_invite', message: 'This link is invalid or has expired.' });

    const problem = checkPasswordPolicy(body.password, inv.email);
    if (problem) return reply.status(400).send({ error: 'weak_password', message: problem });

    const passwordHash = await hashPassword(body.password);
    const first = inv.status === 'invited';
    await withTransaction(db, async (q) => {
      const used = await q.query('UPDATE invitation SET used_at = now() WHERE id = $1 AND used_at IS NULL', [inv.id]);
      if (used.rowCount !== 1) throw Object.assign(new Error('invite already used'), { statusCode: 409 });
      await q.query(
        `UPDATE app_user SET password_hash = $2, status = 'active', failed_attempts = 0, locked_until = NULL WHERE id = $1`,
        [inv.user_id, passwordHash],
      );
      await revokeUserSessions(q, inv.user_id);
      await logActivity(q, {
        actorId: inv.user_id,
        action: first ? 'user.invite_accepted' : 'user.password_reset',
        entityType: 'user',
        entityId: inv.user_id,
      });
      if (first) {
        await notifyAdmins(q, { type: 'user.joined', title: `${inv.name} set up their account`, body: inv.email, link: '/admin/users' }, inv.user_id);
      }
    });
    return { ok: true };
  });

  // ---- change own password ----
  app.post('/api/auth/password', { config: { access: 'session', rateLimit: RATE } }, async (req, reply) => {
    const a = req.auth!;
    const body = passwordBody.parse(req.body);
    const u = (await db.query<UserRow>(`SELECT ${USER_COLS} FROM app_user WHERE id = $1`, [a.user.id])).rows[0]!;
    if (isLocked(u)) return lockedReply(reply);
    if (!u.password_hash || !(await verifyPassword(u.password_hash, body.currentPassword))) {
      await registerFailure(u.id);
      return reply.status(401).send({ error: 'invalid_credentials', message: 'Current password is not correct.' });
    }
    const problem = checkPasswordPolicy(body.newPassword, u.email);
    if (problem) return reply.status(400).send({ error: 'weak_password', message: problem });

    await withTransaction(db, async (q) => {
      await q.query('UPDATE app_user SET password_hash = $2 WHERE id = $1', [u.id, await hashPassword(body.newPassword)]);
      await revokeUserSessions(q, u.id, a.sessionId); // other devices must sign in again
      await logActivity(q, { actorId: u.id, action: 'auth.password_changed', entityType: 'user', entityId: u.id });
    });
    return { ok: true };
  });
}
