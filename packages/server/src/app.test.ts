import { describe, expect, it } from 'vitest';
import { buildApp } from './app.js';

const okDb = { query: async () => ({ rows: [{ id: 1, note: 'x', created_at: new Date(0) }] }), end: async () => {} } as never;
const badDb = { query: async () => { throw new Error('down'); }, end: async () => {} } as never;

describe('GET /health', () => {
  it('reports not_configured without a database', async () => {
    const app = await buildApp();
    const res = await app.inject('/health');
    expect(res.json()).toMatchObject({ status: 'ok', database: 'not_configured' });
  });
  it('reports ok with a working database', async () => {
    const app = await buildApp({ db: okDb });
    expect((await app.inject('/health')).json()).toMatchObject({ status: 'ok', database: 'ok' });
  });
  it('reports degraded when the database fails', async () => {
    const app = await buildApp({ db: badDb });
    expect((await app.inject('/health')).json()).toMatchObject({ status: 'degraded', database: 'error' });
  });
});

describe('M0 check endpoints', () => {
  it('are disabled when no token is configured', async () => {
    const app = await buildApp({ db: okDb });
    expect((await app.inject('/api/m0/probe')).statusCode).toBe(401);
  });
  it('reject a wrong token and accept the right one', async () => {
    const app = await buildApp({ db: okDb, checkToken: 'secret-token' });
    expect((await app.inject({ url: '/api/m0/probe', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    const ok = await app.inject({ url: '/api/m0/probe', headers: { authorization: 'Bearer secret-token' } });
    expect(ok.statusCode).toBe(200);
  });
  it('screenshot endpoint requires the token', async () => {
    const app = await buildApp({ checkToken: 't', screenshot: async () => ({ bytes: 1, ms: 1, rssMB: 1, freeMemMB: 1 }) });
    expect((await app.inject('/api/m0/screenshot')).statusCode).toBe(401);
    const ok = await app.inject({ url: '/api/m0/screenshot', headers: { authorization: 'Bearer t' } });
    expect(ok.json()).toMatchObject({ bytes: 1 });
  });
});
