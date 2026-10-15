import { DEFAULT_WORKSPACE_ID, type Queryable } from './db.js';

export type ActivityInput = {
  actorId: string | null;
  action: string;
  entityType?: string;
  entityId?: string;
  details?: Record<string, unknown>;
};

/** Appends to the append-only activity log. Never put secrets or tokens in details. */
export async function logActivity(q: Queryable, a: ActivityInput): Promise<void> {
  await q.query(
    `INSERT INTO activity_log (workspace_id, actor_user_id, action, entity_type, entity_id, details)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [DEFAULT_WORKSPACE_ID, a.actorId, a.action, a.entityType ?? null, a.entityId ?? null, JSON.stringify(a.details ?? {})],
  );
}

export type NotificationInput = { type: string; title: string; body?: string; link?: string };

export async function notifyUser(q: Queryable, userId: string, n: NotificationInput): Promise<void> {
  await q.query(
    `INSERT INTO notification (workspace_id, user_id, type, title, body, link) VALUES ($1, $2, $3, $4, $5, $6)`,
    [DEFAULT_WORKSPACE_ID, userId, n.type, n.title, n.body ?? '', n.link ?? null],
  );
}

export async function notifyAdmins(q: Queryable, n: NotificationInput, exceptUserId?: string): Promise<void> {
  await q.query(
    `INSERT INTO notification (workspace_id, user_id, type, title, body, link)
     SELECT workspace_id, id, $2, $3, $4, $5 FROM app_user
      WHERE workspace_id = $1 AND role = 'admin' AND status = 'active' AND ($6::uuid IS NULL OR id <> $6::uuid)`,
    [DEFAULT_WORKSPACE_ID, n.type, n.title, n.body ?? '', n.link ?? null, exceptUserId ?? null],
  );
}
