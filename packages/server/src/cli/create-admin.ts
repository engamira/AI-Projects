// One-time setup: creates the first Admin and prints a one-time link to set the password.
// Usage: npm run create-admin -- <email> "<Full name>" [--reissue]
import { loadConfig } from '../config.js';
import { createPool, DEFAULT_WORKSPACE_ID } from '../db.js';
import { createInvitation, inviteUrl } from '../invites.js';
import { runMigrations } from '../migrate.js';
import { createInvitedUser } from '../routes/users.js';
import { logActivity } from '../services.js';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const reissue = process.argv.includes('--reissue');
const [email, name] = [args[0]?.trim().toLowerCase(), args[1]?.trim()];

if (!email || !name || !process.env.DATABASE_URL) {
  console.error('Usage: npm run create-admin -- <email> "<Full name>" [--reissue]   (DATABASE_URL must be set)');
  process.exit(1);
}

const config = loadConfig();
const db = createPool(process.env.DATABASE_URL);
try {
  await runMigrations(db);
  const existing = await db.query<{ id: string; status: string; role: string }>(
    'SELECT id, status, role FROM app_user WHERE workspace_id = $1 AND email = $2',
    [DEFAULT_WORKSPACE_ID, email],
  );
  let token: string;
  if (existing.rows[0]) {
    const u = existing.rows[0];
    if (u.role !== 'admin') throw new Error(`${email} exists but is not an Admin.`);
    if (!reissue) {
      console.log(`${email} already exists (status: ${u.status}). Use --reissue to create a new setup/reset link.`);
      process.exit(0);
    }
    token = (await createInvitation(db, u.id, null)).token;
    await logActivity(db, { actorId: null, action: 'user.invite_issued', entityType: 'user', entityId: u.id, details: { via: 'cli' } });
  } else {
    const c = await createInvitedUser(db, { email, name, role: 'admin' }, null);
    token = c.token;
    await logActivity(db, { actorId: null, action: 'user.created', entityType: 'user', entityId: c.user.id, details: { via: 'cli', role: 'admin' } });
  }
  console.log(`\nOpen this one-time link (valid 72 hours) to set the password:\n\n  ${inviteUrl(config.baseUrl, token)}\n`);
} finally {
  await db.end();
}
