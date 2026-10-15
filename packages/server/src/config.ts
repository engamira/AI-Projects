// Security-relevant constants in one place.
export const SESSION_IDLE_MS = 2 * 60 * 60 * 1000; // 2 hours without activity
export const SESSION_ABSOLUTE_MS = 12 * 60 * 60 * 1000; // 12 hours regardless of activity
export const PARTIAL_SESSION_MS = 10 * 60 * 1000; // password accepted, second factor pending
export const INVITE_TTL_MS = 72 * 60 * 60 * 1000; // 72 hours

export const MAX_FAILED_ATTEMPTS = 5;
export const LOCKOUT_MS = 15 * 60 * 1000;

export const RECOVERY_CODE_COUNT = 10;
export const TOTP_ISSUER = 'Campaign LEGO';

export type AppConfig = {
  baseUrl: string; // public origin of the app, e.g. https://example.onrender.com
  secretKey: Buffer; // 32 bytes; encrypts TOTP secrets at rest
  production: boolean;
  rateLimit: boolean;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const hex = env.APP_SECRET_KEY ?? '';
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error('APP_SECRET_KEY must be 64 hex characters (32 bytes)');
  }
  const production = env.NODE_ENV === 'production';
  return {
    baseUrl: (env.APP_BASE_URL ?? `http://localhost:${env.PORT ?? 3000}`).replace(/\/+$/, ''),
    secretKey: Buffer.from(hex, 'hex'),
    production,
    rateLimit: env.NODE_ENV !== 'test',
  };
}
