import { INVITE_TTL_MS } from './config.js';
import { randomToken, sha256 } from './crypto.js';
import type { Queryable } from './db.js';

/** Replaces any unused invitation for the user with a fresh one. The raw token is returned once. */
export async function createInvitation(
  q: Queryable,
  userId: string,
  createdBy: string | null,
): Promise<{ token: string; expiresAt: Date }> {
  await q.query('DELETE FROM invitation WHERE user_id = $1 AND used_at IS NULL', [userId]);
  const token = randomToken();
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);
  await q.query('INSERT INTO invitation (user_id, token_hash, expires_at, created_by) VALUES ($1, $2, $3, $4)', [
    userId,
    sha256(token),
    expiresAt,
    createdBy,
  ]);
  return { token, expiresAt };
}

export function inviteUrl(baseUrl: string, token: string): string {
  return `${baseUrl}/accept-invite?token=${encodeURIComponent(token)}`;
}
