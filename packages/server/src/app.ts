import { timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import fastifyStatic from '@fastify/static';
import type { HealthResponse, ProbeResponse } from '@cl/shared';
import type { Db } from './db.js';
import { Sentry } from './sentry.js';
import { screenshotCheck, type ScreenshotCheck } from './screenshot.js';

export type AppOptions = {
  db?: Db;
  checkToken?: string;
  webDir?: string;
  screenshot?: () => Promise<ScreenshotCheck>;
};

function tokenOk(req: FastifyRequest, expected: string | undefined): boolean {
  if (!expected) return false; // endpoints are disabled unless a token is configured
  const given = String(req.headers.authorization ?? '').replace(/^Bearer /, '');
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function buildApp(opts: AppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: process.env.NODE_ENV !== 'test' });
  const shot = opts.screenshot ?? screenshotCheck;

  app.setErrorHandler((err: Error & { statusCode?: number; code?: string }, _req, reply) => {
    // Client mistakes (bad media type, malformed JSON, ...) keep their 4xx status and are not reported.
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      return void reply.status(err.statusCode).send({ error: err.code ?? 'bad_request' });
    }
    Sentry.captureException(err);
    app.log.error(err);
    void reply.status(500).send({ error: 'internal_error' });
  });

  app.get('/health', async (): Promise<HealthResponse> => {
    let database: HealthResponse['database'] = 'not_configured';
    if (opts.db) {
      try {
        await opts.db.query('SELECT 1');
        database = 'ok';
      } catch {
        database = 'error';
      }
    }
    return {
      status: database === 'error' ? 'degraded' : 'ok',
      database,
      time: new Date().toISOString(),
    };
  });

  app.post<{ Body: { note?: string } }>('/api/m0/probe', async (req, reply) => {
    if (!tokenOk(req, opts.checkToken)) return reply.status(401).send({ error: 'unauthorized' });
    if (!opts.db) return reply.status(503).send({ error: 'database_not_configured' });
    const note = String(req.body?.note ?? 'probe').slice(0, 200);
    const r = await opts.db.query<{ id: number; note: string; created_at: Date }>(
      'INSERT INTO m0_probe (note) VALUES ($1) RETURNING id, note, created_at',
      [note],
    );
    const row = r.rows[0]!;
    const out: ProbeResponse = { id: row.id, note: row.note, createdAt: row.created_at.toISOString() };
    return out;
  });

  app.get('/api/m0/probe', async (req, reply) => {
    if (!tokenOk(req, opts.checkToken)) return reply.status(401).send({ error: 'unauthorized' });
    if (!opts.db) return reply.status(503).send({ error: 'database_not_configured' });
    const r = await opts.db.query<{ id: number; note: string; created_at: Date }>(
      'SELECT id, note, created_at FROM m0_probe ORDER BY id',
    );
    return r.rows.map((x): ProbeResponse => ({ id: x.id, note: x.note, createdAt: x.created_at.toISOString() }));
  });

  app.get('/api/m0/screenshot', async (req, reply) => {
    if (!tokenOk(req, opts.checkToken)) return reply.status(401).send({ error: 'unauthorized' });
    return shot();
  });

  if (opts.webDir && existsSync(opts.webDir)) {
    await app.register(fastifyStatic, { root: opts.webDir });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/')) return reply.sendFile('index.html');
      return reply.status(404).send({ error: 'not_found' });
    });
  }

  return app;
}
