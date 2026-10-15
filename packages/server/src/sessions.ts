import type { FastifyReply } from 'fastify';
import type { Role, SessionStage } from '@cl/shared';
import { PARTIAL_SESSION_MS, SESSION_ABSOLUTE_MS, SESSION_IDLE_MS, type AppConfig } from './config.js';
import { randomToken, sha256 } from './crypto.js';
import type { Queryable } from './db.js';

export type AuthContext = {
  sessionId: string;
  stage: 'password' | 'full';
  csrfToken: string;
  user: { id: string; email: string; name: string; role: Role; hasTotp: boolean };
};

export function cookieName(config: AppConfig): string {
  return config.production ? '__Host-cl_session' : 'cl_session';
}

export async function createSession(
  q: Queryable,
  userId: string,
  stage: 'password' | 'full',
): Promise<{ token: string; csrfToken: string; maxAgeMs: number }> {
  const token = randomToken();
  const csrfToken = randomToken(24);
  const maxAgeMs = stage === 'full' ? SESSION_ABSOLUTE_MS : PARTIAL_SESSION_MS;
  await q.query(
    `INSERT INTO auth_session (user_id, token_hash, stage, csrf_token, expires_at)
     VALUES ($1, $2, $3, $4, now() + ($5 || ' milliseconds')::interval)`,
    [userId, sha256(token), stage, csrfToken, String(maxAgeMs)],
  );
  return { token, csrfToken, maxAgeMs };
}

export function setSessionCookie(reply: FastifyReply, config: AppConfig, token: string, maxAgeMs: number): void {
  void reply.setCookie(cookieName(config), token, {
    httpOnly: true,
    secure: config.production,
    sameSite: 'lax',
    path: '/',
    maxAge: Math.floor(maxAgeMs / 1000),
  });
}

export function clearSessionCookie(reply: FastifyReply, config: AppConfig): void {
  void reply.clearCookie(cookieName(config), { path: '/' });
}

/** Deletes every session of a user, optionally keeping one. */
export async function revokeUserSessions(q: Queryable, userId: string, exceptSessionId?: string): Promise<void> {
  await q.query('DELETE FROM auth_session WHERE user_id = $1 AND ($2::uuid IS NULL OR id <> $2::uuid)', [
    userId,
    exceptSessionId ?? null,
  ]);
}

type SessionRow = {
  id: string;
  stage: 'password' | 'full';
  csrf_token: string;
  last_seen_at: Date;
  expires_at: Date;
  user_id: string;
  email: string;
  name: string;
  role: Role;
  status: string;
  has_totp: boolean;
};

/** Returns the live session for a cookie token, or null. Expired or orphaned sessions are deleted. */
export async function loadSession(q: Queryable, token: string): Promise<AuthContext | null> {
  const r = await q.query<SessionRow>(
    `SELECT s.id, s.stage, s.csrf_token, s.last_seen_at, s.expires_at,
            u.id AS user_id, u.email, u.name, u.role, u.status, (u.totp_enabled_at IS NOT NULL) AS has_totp
       FROM auth_session s JOIN app_user u ON u.id = s.user_id
      WHERE s.token_hash = $1`,
    [sha256(token)],
  );
  const row = r.rows[0];
  if (!row) return null;
  const now = Date.now();
  const idleExpired = row.stage === 'full' && now - row.last_seen_at.getTime() > SESSION_IDLE_MS;
  if (row.expires_at.getTime() <= now || idleExpired || row.status !== 'active') {
    await q.query('DELETE FROM auth_session WHERE id = $1', [row.id]);
    return null;
  }
  if (now - row.last_seen_at.getTime() > 60_000) {
    await q.query('UPDATE auth_session SET last_seen_at = now() WHERE id = $1', [row.id]);
  }
  return {
    sessionId: row.id,
    stage: row.stage,
    csrfToken: row.csrf_token,
    user: { id: row.user_id, email: row.email, name: row.name, role: row.role, hasTotp: row.has_totp },
  };
}

export function stageOf(auth: AuthContext | null): SessionStage {
  return auth ? auth.stage : 'none';
}
