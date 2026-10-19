import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { hasCapability, type Capability } from '@cl/shared';
import type { AppConfig } from './config.js';
import type { Db } from './db.js';
import { cookieName, loadSession, type AuthContext } from './sessions.js';

/**
 * Every /api route must declare how it is protected via `config: { access }`:
 *  - 'public'       no session needed
 *  - 'partial'      session after the password step only (second factor pending)
 *  - 'any_session'  partial or full session
 *  - 'session'      fully signed-in user (password + second factor)
 *  - a Capability   fully signed-in user whose role grants that capability (or a list: any one of them)
 * Routes that declare nothing are refused (deny by default).
 */
export type Access = 'public' | 'partial' | 'any_session' | 'session' | Capability | readonly Capability[]; // a list means any one of them

declare module 'fastify' {
  interface FastifyContextConfig {
    access?: Access;
  }
  interface FastifyRequest {
    auth: AuthContext | null;
  }
}

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

function originAllowed(req: FastifyRequest, config: AppConfig): boolean {
  const origin = req.headers.origin;
  if (!origin) return true; // non-browser clients and same-origin GETs
  if (origin === config.baseUrl) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

export default fp(async function accessPlugin(app: FastifyInstance, opts: { db: Db; config: AppConfig }) {
  const { db, config } = opts;
  app.decorateRequest('auth', null);

  app.addHook('onRequest', async (req, reply) => {
    if (req.is404) return;
    if (!req.url.startsWith('/api/')) return; // health check and static files

    const access = req.routeOptions.config.access;
    if (!access) return reply.status(403).send({ error: 'route_not_declared' });

    if (MUTATING.has(req.method) && !originAllowed(req, config)) {
      return reply.status(403).send({ error: 'bad_origin' });
    }

    const token = req.cookies[cookieName(config)];
    req.auth = token ? await loadSession(db, token) : null;

    if (access === 'public') return;

    const auth = req.auth;
    if (!auth) return reply.status(401).send({ error: 'unauthenticated' });

    // CSRF: every state-changing request from a signed-in browser must echo the session's token.
    if (MUTATING.has(req.method) && req.headers['x-csrf-token'] !== auth.csrfToken) {
      return reply.status(403).send({ error: 'csrf' });
    }

    if (access === 'any_session') return;
    if (access === 'partial') {
      if (auth.stage !== 'password') return reply.status(403).send({ error: 'forbidden' });
      return;
    }
    if (auth.stage !== 'full') return reply.status(401).send({ error: 'unauthenticated' });
    if (access === 'session') return;
    const needed = typeof access === 'string' ? [access] : access;
    if (!needed.some((cap) => hasCapability(auth.user.role, cap))) return reply.status(403).send({ error: 'forbidden' });
  });
});
