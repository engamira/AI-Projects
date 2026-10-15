import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { ROLES, ROLE_LABELS, type ActivityDto, type InviteResponse, type Role, type UserDto } from '@cl/shared';
import type { AppConfig } from '../config.js';
import { DEFAULT_WORKSPACE_ID, withTransaction, type Db, type Queryable } from '../db.js';
import { createInvitation, inviteUrl } from '../invites.js';
import { logActivity, notifyUser } from '../services.js';
import { revokeUserSessions } from '../sessions.js';

type Row = {
  id: string;
  email: string;
  name: string;
  role: Role;
  status: UserDto['status'];
  password_hash: string | null;
  totp_enabled_at: Date | null;
  last_login_at: Date | null;
  locked_until: Date | null;
  created_at: Date;
};
const COLS = 'id, email, name, role, status, password_hash, totp_enabled_at, last_login_at, locked_until, created_at';

function toDto(r: Row): UserDto {
  return {
    id: r.id,
    email: r.email,
    name: r.name,
    role: r.role,
    status: r.status,
    twoFactorEnabled: !!r.totp_enabled_at,
    lastLoginAt: r.last_login_at?.toISOString() ?? null,
    lockedUntil: r.locked_until && r.locked_until.getTime() > Date.now() ? r.locked_until.toISOString() : null,
    createdAt: r.created_at.toISOString(),
  };
}

const createBody = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  name: z.string().trim().min(1).max(100),
  role: z.enum(ROLES),
});
const patchBody = z.object({ name: z.string().trim().min(1).max(100).optional(), role: z.enum(ROLES).optional() });
const idParams = z.object({ id: z.string().uuid() });

/** Creates a user plus a one-time invitation link. Shared with the create-admin CLI. */
export async function createInvitedUser(
  q: Queryable,
  input: { email: string; name: string; role: Role },
  createdBy: string | null,
): Promise<{ user: Row; token: string; expiresAt: Date }> {
  const r = await q.query<Row>(
    `INSERT INTO app_user (workspace_id, email, name, role, created_by) VALUES ($1, $2, $3, $4, $5) RETURNING ${COLS}`,
    [DEFAULT_WORKSPACE_ID, input.email, input.name, input.role, createdBy],
  );
  const user = r.rows[0]!;
  const inv = await createInvitation(q, user.id, createdBy);
  return { user, token: inv.token, expiresAt: inv.expiresAt };
}

export function userRoutes(app: FastifyInstance, db: Db, config: AppConfig): void {
  const notFound = (reply: FastifyReply) => reply.status(404).send({ error: 'not_found' });

  async function getUser(q: Queryable, id: string): Promise<Row | undefined> {
    return (await q.query<Row>(`SELECT ${COLS} FROM app_user WHERE id = $1 AND workspace_id = $2`, [id, DEFAULT_WORKSPACE_ID])).rows[0];
  }

  /** True when removing this user's admin power would leave no active admin. */
  async function isLastActiveAdmin(q: Queryable, user: Row): Promise<boolean> {
    if (user.role !== 'admin' || user.status !== 'active') return false;
    const r = await q.query<{ n: string }>(
      `SELECT count(*) AS n FROM app_user WHERE workspace_id = $1 AND role = 'admin' AND status = 'active' AND id <> $2`,
      [DEFAULT_WORKSPACE_ID, user.id],
    );
    return Number(r.rows[0]!.n) === 0;
  }

  app.get('/api/users', { config: { access: 'users.manage' } }, async () => {
    const r = await db.query<Row>(`SELECT ${COLS} FROM app_user WHERE workspace_id = $1 ORDER BY created_at`, [DEFAULT_WORKSPACE_ID]);
    return r.rows.map(toDto);
  });

  app.post('/api/users', { config: { access: 'users.manage' } }, async (req, reply) => {
    const body = createBody.parse(req.body);
    try {
      const out = await withTransaction(db, async (q) => {
        const c = await createInvitedUser(q, body, req.auth!.user.id);
        await logActivity(q, {
          actorId: req.auth!.user.id,
          action: 'user.created',
          entityType: 'user',
          entityId: c.user.id,
          details: { email: body.email, role: body.role },
        });
        return c;
      });
      const res: InviteResponse = { user: toDto(out.user), inviteUrl: inviteUrl(config.baseUrl, out.token), expiresAt: out.expiresAt.toISOString() };
      return reply.status(201).send(res);
    } catch (err) {
      if ((err as { code?: string }).code === '23505') {
        return reply.status(409).send({ error: 'email_exists', message: 'A user with that email already exists.' });
      }
      throw err;
    }
  });

  app.patch<{ Params: { id: string } }>('/api/users/:id', { config: { access: 'users.manage' } }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const body = patchBody.parse(req.body);
    const actor = req.auth!.user;
    const user = await getUser(db, id);
    if (!user) return notFound(reply);

    const roleChanging = body.role !== undefined && body.role !== user.role;
    if (roleChanging) {
      if (id === actor.id) return reply.status(409).send({ error: 'self_change', message: 'You cannot change your own role.' });
      if (await isLastActiveAdmin(db, user)) {
        return reply.status(409).send({ error: 'last_admin', message: 'There must be at least one active Admin.' });
      }
    }
    await withTransaction(db, async (q) => {
      await q.query('UPDATE app_user SET name = COALESCE($2, name), role = COALESCE($3, role) WHERE id = $1', [id, body.name ?? null, body.role ?? null]);
      if (roleChanging) {
        await revokeUserSessions(q, id); // permissions changed: sign in again
        await logActivity(q, { actorId: actor.id, action: 'user.role_changed', entityType: 'user', entityId: id, details: { from: user.role, to: body.role } });
        await notifyUser(q, id, { type: 'user.role_changed', title: `Your role is now ${ROLE_LABELS[body.role!]}` });
      } else if (body.name && body.name !== user.name) {
        await logActivity(q, { actorId: actor.id, action: 'user.renamed', entityType: 'user', entityId: id });
      }
    });
    return toDto((await getUser(db, id))!);
  });

  app.post<{ Params: { id: string } }>('/api/users/:id/disable', { config: { access: 'users.manage' } }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const actor = req.auth!.user;
    const user = await getUser(db, id);
    if (!user) return notFound(reply);
    if (id === actor.id) return reply.status(409).send({ error: 'self_change', message: 'You cannot disable your own account.' });
    if (await isLastActiveAdmin(db, user)) {
      return reply.status(409).send({ error: 'last_admin', message: 'There must be at least one active Admin.' });
    }
    await withTransaction(db, async (q) => {
      await q.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [id]);
      await revokeUserSessions(q, id);
      await logActivity(q, { actorId: actor.id, action: 'user.disabled', entityType: 'user', entityId: id });
    });
    return toDto((await getUser(db, id))!);
  });

  app.post<{ Params: { id: string } }>('/api/users/:id/enable', { config: { access: 'users.manage' } }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const user = await getUser(db, id);
    if (!user) return notFound(reply);
    await withTransaction(db, async (q) => {
      await q.query(`UPDATE app_user SET status = CASE WHEN password_hash IS NULL THEN 'invited' ELSE 'active' END WHERE id = $1`, [id]);
      await logActivity(q, { actorId: req.auth!.user.id, action: 'user.enabled', entityType: 'user', entityId: id });
    });
    return toDto((await getUser(db, id))!);
  });

  // Issues a fresh one-time link: used for first-time setup and for password resets.
  app.post<{ Params: { id: string } }>('/api/users/:id/invite', { config: { access: 'users.manage' } }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const user = await getUser(db, id);
    if (!user) return notFound(reply);
    if (user.status === 'disabled') return reply.status(409).send({ error: 'disabled', message: 'Enable the user first.' });
    const inv = await withTransaction(db, async (q) => {
      const i = await createInvitation(q, id, req.auth!.user.id);
      await logActivity(q, { actorId: req.auth!.user.id, action: 'user.invite_issued', entityType: 'user', entityId: id });
      return i;
    });
    const res: InviteResponse = { user: toDto(user), inviteUrl: inviteUrl(config.baseUrl, inv.token), expiresAt: inv.expiresAt.toISOString() };
    return res;
  });

  app.post<{ Params: { id: string } }>('/api/users/:id/reset-2fa', { config: { access: 'users.manage' } }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    const user = await getUser(db, id);
    if (!user) return notFound(reply);
    await withTransaction(db, async (q) => {
      await q.query(`UPDATE app_user SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL WHERE id = $1`, [id]);
      await q.query('DELETE FROM recovery_code WHERE user_id = $1', [id]);
      await revokeUserSessions(q, id);
      await logActivity(q, { actorId: req.auth!.user.id, action: 'user.2fa_reset', entityType: 'user', entityId: id });
      await notifyUser(q, id, { type: 'user.2fa_reset', title: 'Your two-factor sign-in was reset', body: 'You will set it up again at your next sign-in.' });
    });
    return toDto((await getUser(db, id))!);
  });

  app.post<{ Params: { id: string } }>('/api/users/:id/unlock', { config: { access: 'users.manage' } }, async (req, reply) => {
    const { id } = idParams.parse(req.params);
    if (!(await getUser(db, id))) return notFound(reply);
    await withTransaction(db, async (q) => {
      await q.query('UPDATE app_user SET failed_attempts = 0, locked_until = NULL WHERE id = $1', [id]);
      await logActivity(q, { actorId: req.auth!.user.id, action: 'user.unlocked', entityType: 'user', entityId: id });
    });
    return toDto((await getUser(db, id))!);
  });

  app.get('/api/activity', { config: { access: 'activity.view' } }, async (): Promise<ActivityDto[]> => {
    const r = await db.query<{
      id: string; name: string | null; action: string; entity_type: string | null; entity_id: string | null;
      details: Record<string, unknown>; created_at: Date;
    }>(
      `SELECT a.id, u.name, a.action, a.entity_type, a.entity_id, a.details, a.created_at
         FROM activity_log a LEFT JOIN app_user u ON u.id = a.actor_user_id
        WHERE a.workspace_id = $1 ORDER BY a.id DESC LIMIT 200`,
      [DEFAULT_WORKSPACE_ID],
    );
    return r.rows.map((x) => ({
      id: String(x.id),
      actorName: x.name,
      action: x.action,
      entityType: x.entity_type,
      entityId: x.entity_id,
      details: x.details,
      createdAt: x.created_at.toISOString(),
    }));
  });
}
