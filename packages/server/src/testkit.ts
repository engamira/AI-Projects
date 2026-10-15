// Test helpers. Every test file gets its own Postgres schema so runs never touch real data.
import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Role } from '@cl/shared';
import { buildApp } from './app.js';
import { loadConfig, type AppConfig } from './config.js';
import { encryptSecret, hashPassword } from './crypto.js';
import { createPool, DEFAULT_WORKSPACE_ID, type Db } from './db.js';
import { runMigrations } from './migrate.js';
import { createSession } from './sessions.js';
import { currentCode, newSecret } from './totp.js';

export const TEST_PASSWORD = 'correct horse battery staple';

export type Res = { status: number; body: any; headers: Record<string, unknown> };

export class Client {
  cookies = new Map<string, string>();
  csrf: string | undefined;
  constructor(private app: FastifyInstance) {}

  async request(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, body?: unknown, headers: Record<string, string> = {}): Promise<Res> {
    const h: Record<string, string> = { ...headers };
    if (this.cookies.size) h.cookie = [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
    if (this.csrf && method !== 'GET' && !('x-csrf-token' in h)) h['x-csrf-token'] = this.csrf;
    if (body !== undefined) h['content-type'] = 'application/json';
    const res = await this.app.inject({ method, url, headers: h, payload: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of res.cookies) {
      const gone = c.value === '' || c.maxAge === 0 || (c.expires && c.expires.getTime() < Date.now());
      if (gone) this.cookies.delete(c.name);
      else this.cookies.set(c.name, c.value);
    }
    let parsed: any = res.body;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      /* not JSON */
    }
    return { status: res.statusCode, body: parsed, headers: res.headers };
  }
  get = (url: string, headers?: Record<string, string>) => this.request('GET', url, undefined, headers);
  post = (url: string, body?: unknown, headers?: Record<string, string>) => this.request('POST', url, body, headers);
  patch = (url: string, body?: unknown) => this.request('PATCH', url, body);

  async refreshCsrf(): Promise<void> {
    this.csrf = (await this.get('/api/auth/me')).body.csrfToken;
  }
  get sessionToken(): string | undefined {
    return this.cookies.get('cl_session');
  }
}

export type SeededUser = { id: string; email: string; name: string; role: Role; password: string; totpSecret?: string };
export type RouteInfo = { method: string | string[]; url: string; access?: string };

export type TestApp = {
  app: FastifyInstance;
  db: Db;
  config: AppConfig;
  routes: RouteInfo[];
  client: () => Client;
  seedUser: (role: Role, opts?: { email?: string; totp?: boolean; status?: string }) => Promise<SeededUser>;
  /** A client holding a fully signed-in session for the user, created directly in the database. */
  sessionFor: (user: SeededUser, stage?: 'full' | 'password') => Promise<Client>;
  /** Signs in through the real login + second-factor endpoints. */
  login: (user: SeededUser) => Promise<Client>;
  close: () => Promise<void>;
};

export async function createTestApp(opts: { webDir?: string } = {}): Promise<TestApp> {
  const base = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!base) throw new Error('Set DATABASE_URL (or TEST_DATABASE_URL) to run the tests.');
  const url = base.replace('-pooler', ''); // SET search_path needs a direct (non-pooled) connection
  const schema = `test_${randomBytes(6).toString('hex')}`;

  const admin = createPool(url);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const db = createPool(url, { schema });
  await runMigrations(db);

  const config = loadConfig({ APP_SECRET_KEY: '11'.repeat(32), NODE_ENV: 'test', APP_BASE_URL: 'http://localhost:3000' });
  const routes: RouteInfo[] = [];
  const app = await buildApp({ db, config, webDir: opts.webDir, onRoute: (r) => routes.push(r) });
  await app.ready();

  let n = 0;
  const seedUser: TestApp['seedUser'] = async (role, opts = {}) => {
    n += 1;
    const email = opts.email ?? `${role.replace('_', '-')}${n}@example.test`;
    const name = `Test ${role} ${n}`;
    const secret = opts.totp ? newSecret() : undefined;
    const r = await db.query<{ id: string }>(
      `INSERT INTO app_user (workspace_id, email, name, role, status, password_hash, totp_secret_enc, totp_enabled_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [
        DEFAULT_WORKSPACE_ID, email, name, role, opts.status ?? 'active', await hashPassword(TEST_PASSWORD),
        secret ? encryptSecret(secret, config.secretKey) : null, secret ? new Date() : null,
      ],
    );
    return { id: r.rows[0]!.id, email, name, role, password: TEST_PASSWORD, totpSecret: secret };
  };

  const client = () => new Client(app);
  const sessionFor: TestApp['sessionFor'] = async (user, stage = 'full') => {
    const c = client();
    const s = await createSession(db, user.id, stage);
    c.cookies.set('cl_session', s.token);
    c.csrf = s.csrfToken;
    return c;
  };
  const login: TestApp['login'] = async (user) => {
    const c = client();
    const res = await c.post('/api/auth/login', { email: user.email, password: user.password });
    if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
    await c.refreshCsrf();
    if (res.body.next === 'verify_2fa') {
      const v = await c.post('/api/auth/2fa/verify', { code: currentCode(user.totpSecret!) });
      if (v.status !== 200) throw new Error(`2fa failed: ${v.status}`);
      await c.refreshCsrf();
    }
    return c;
  };

  return {
    app, db, config, routes, client, seedUser, sessionFor, login,
    close: async () => {
      await app.close();
      await db.end();
      await admin.query(`DROP SCHEMA ${schema} CASCADE`);
      await admin.end();
    },
  };
}
