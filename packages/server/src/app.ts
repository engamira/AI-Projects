import { existsSync } from 'node:fs';
import fastifyCookie from '@fastify/cookie';
import fastifyHelmet from '@fastify/helmet';
import fastifyRateLimit from '@fastify/rate-limit';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import type { HealthResponse } from '@cl/shared';
import accessPlugin from './access.js';
import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import { syncBlockDefinitions } from './blocklib.js';
import { authRoutes } from './routes/auth.js';
import { campaignRoutes } from './routes/campaigns.js';
import { notificationRoutes } from './routes/notifications.js';
import { userRoutes } from './routes/users.js';
import { Sentry } from './sentry.js';

export type AppOptions = {
  db: Db;
  config: AppConfig;
  webDir?: string;
  /** Tests use this to list every registered route and check its access declaration. */
  onRoute?: (route: { method: string | string[]; url: string; access?: string }) => void;
};

export async function buildApp({ db, config, webDir, onRoute }: AppOptions): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test', trustProxy: true });
  if (onRoute) {
    app.addHook('onRoute', (r) =>
      onRoute({ method: r.method, url: r.url, access: (r.config as { access?: string } | undefined)?.access }),
    );
  }

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    if (err instanceof ZodError) {
      return void reply.status(400).send({ error: 'invalid_request', message: err.issues[0]?.message ?? 'Invalid request.' });
    }
    // Client mistakes (bad media type, malformed JSON, rate limit, ...) keep their 4xx status and are not reported.
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return void reply.status(err.statusCode).send({ error: err.code ?? 'bad_request', message: err.message });
    }
    Sentry.captureException(err);
    app.log.error(err);
    void reply.status(500).send({ error: 'internal_error' });
  });

  await app.register(fastifyHelmet);
  await app.register(fastifyCookie);
  if (config.rateLimit) await app.register(fastifyRateLimit, { global: true, max: 300, timeWindow: '1 minute' });
  await app.register(accessPlugin, { db, config });

  app.get('/health', async (): Promise<HealthResponse> => {
    let database: HealthResponse['database'] = 'ok';
    try {
      await db.query('SELECT 1');
    } catch {
      database = 'error';
    }
    return { status: database === 'error' ? 'degraded' : 'ok', database, time: new Date().toISOString() };
  });

  await syncBlockDefinitions(db);
  authRoutes(app, db, config);
  userRoutes(app, db, config);
  notificationRoutes(app, db);
  campaignRoutes(app, db);

  if (webDir && existsSync(webDir)) {
    await app.register(fastifyStatic, { root: webDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: 'not_found' });
    });
  }

  return app;
}
