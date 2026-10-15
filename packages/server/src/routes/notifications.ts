import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { NotificationDto, NotificationsResponse } from '@cl/shared';
import type { Db } from '../db.js';

const idParams = z.object({ id: z.string().uuid() });

export function notificationRoutes(app: FastifyInstance, db: Db): void {
  app.get('/api/notifications', { config: { access: 'session' } }, async (req): Promise<NotificationsResponse> => {
    const userId = req.auth!.user.id;
    const items = await db.query<{
      id: string; type: string; title: string; body: string; link: string | null; read_at: Date | null; created_at: Date;
    }>(
      `SELECT id, type, title, body, link, read_at, created_at FROM notification
        WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [userId],
    );
    const unread = await db.query<{ n: string }>('SELECT count(*) AS n FROM notification WHERE user_id = $1 AND read_at IS NULL', [userId]);
    return {
      unread: Number(unread.rows[0]!.n),
      items: items.rows.map(
        (n): NotificationDto => ({
          id: n.id,
          type: n.type,
          title: n.title,
          body: n.body,
          link: n.link,
          readAt: n.read_at?.toISOString() ?? null,
          createdAt: n.created_at.toISOString(),
        }),
      ),
    };
  });

  // Users can only mark their own notifications: the user_id condition is part of the query.
  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', { config: { access: 'session' } }, async (req) => {
    const { id } = idParams.parse(req.params);
    await db.query('UPDATE notification SET read_at = now() WHERE id = $1 AND user_id = $2 AND read_at IS NULL', [id, req.auth!.user.id]);
    return { ok: true };
  });

  app.post('/api/notifications/read-all', { config: { access: 'session' } }, async (req) => {
    await db.query('UPDATE notification SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.auth!.user.id]);
    return { ok: true };
  });
}
