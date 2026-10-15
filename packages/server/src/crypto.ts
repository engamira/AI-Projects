import { createCipheriv, createDecipheriv, createHash, randomBytes, randomInt } from 'node:crypto';
import { hash, verify } from '@node-rs/argon2';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@cl/shared';

export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/** Tokens (sessions, invites, recovery codes) are stored only as SHA-256 hashes. */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// AES-256-GCM: output is base64(iv | tag | ciphertext).
export function encryptSecret(plain: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), enc]).toString('base64');
}

export function decryptSecret(payload: string, key: Buffer): string {
  const buf = Buffer.from(payload, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, 12));
  decipher.setAuthTag(buf.subarray(12, 28));
  return Buffer.concat([decipher.update(buf.subarray(28)), decipher.final()]).toString('utf8');
}

export function hashPassword(password: string): Promise<string> {
  return hash(password); // argon2id with library defaults
}

export async function verifyPassword(storedHash: string, password: string): Promise<boolean> {
  try {
    return await verify(storedHash, password);
  } catch {
    return false;
  }
}

// Used so that unknown emails cost the same time as wrong passwords.
let dummyHash: Promise<string> | undefined;
export async function burnPasswordCheck(password: string): Promise<void> {
  dummyHash ??= hashPassword('dummy-password-for-timing');
  await verifyPassword(await dummyHash, password);
}

const COMMON_PASSWORDS = new Set([
  'password1234', 'passwordpassword', '123456789012', 'qwertyuiop12', 'letmein12345', 'welcome12345', 'administrator',
]);

/** Returns an error message, or null when the password is acceptable. */
export function checkPasswordPolicy(password: string, email: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > PASSWORD_MAX_LENGTH) return `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`;
  const lower = password.toLowerCase();
  if (lower === email.toLowerCase() || email.toLowerCase().startsWith(lower)) return 'Password must not be your email address.';
  if (COMMON_PASSWORDS.has(lower)) return 'That password is too common.';
  if (/^(.)\1+$/.test(password)) return 'Password must not be a single repeated character.';
  return null;
}

// Recovery codes: 12 characters from an unambiguous alphabet (~60 bits), shown as xxxx-xxxx-xxxx.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function generateRecoveryCode(): string {
  const chars = Array.from({ length: 12 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  return [chars.slice(0, 4), chars.slice(4, 8), chars.slice(8)].map((g) => g.join('')).join('-');
}

export function normalizeRecoveryCode(input: string): string {
  return input.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}
