import * as OTPAuth from 'otpauth';
import { TOTP_ISSUER } from './config.js';

const PERIOD = 30;

function build(secretBase32: string, label: string): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer: TOTP_ISSUER,
    label,
    algorithm: 'SHA1',
    digits: 6,
    period: PERIOD,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

export function newSecret(): string {
  return new OTPAuth.Secret({ size: 20 }).base32;
}

export function otpauthUrl(secretBase32: string, label: string): string {
  return build(secretBase32, label).toString();
}

/** Returns the matched time step (for replay protection), or null if the code is wrong. Allows ±1 step of clock drift. */
export function checkCode(secretBase32: string, code: string, label = 'user'): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const delta = build(secretBase32, label).validate({ token: code, window: 1 });
  if (delta === null) return null;
  return Math.floor(Date.now() / 1000 / PERIOD) + delta;
}

/** Code for the current time step plus an offset of whole steps (for tests; drift window is ±1). */
export function currentCode(secretBase32: string, stepOffset = 0): string {
  return build(secretBase32, 'test').generate({ timestamp: Date.now() + stepOffset * PERIOD * 1000 });
}
