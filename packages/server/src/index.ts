import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './app.js';
import { loadConfig } from './config.js';
import { createPool } from './db.js';
import { initSentry, Sentry } from './sentry.js';

const here = path.dirname(fileURLToPath(import.meta.url));
initSentry(process.env.SENTRY_DSN);

if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not set');
const config = loadConfig();
const db = createPool(process.env.DATABASE_URL);
const app = await buildApp({ db, config, webDir: path.resolve(here, '../../web/dist') });

const port = Number(process.env.PORT ?? 3000);
try {
  await app.listen({ port, host: '0.0.0.0' });
} catch (err) {
  Sentry.captureException(err);
  app.log.error(err);
  process.exit(1);
}

const stop = async () => {
  await app.close();
  await db.end();
  await Sentry.close(2000);
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
