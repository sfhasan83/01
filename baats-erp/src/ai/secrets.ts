import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { ValidationError } from '../core/errors.ts';

/**
 * Encryption for provider API keys at rest: AES-256-GCM with the server's secret
 * key (BAATS_SECRET_KEY, 32 bytes in base64 or hex). The Windows launcher makes
 * one on first start and keeps it in the local config.
 */
export function parseSecretKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const k = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, 'hex') : Buffer.from(raw, 'base64');
  if (k.length !== 32) throw new Error('BAATS_SECRET_KEY must be 32 bytes, in base64 or hex');
  return k;
}

export function seal(key: Buffer | null, plain: string): string {
  if (!key) throw new ValidationError('this server has no secret key (BAATS_SECRET_KEY), so it cannot store an API key');
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
}

export function open(key: Buffer | null, sealed: string): string {
  if (!key) throw new ValidationError('this server has no secret key (BAATS_SECRET_KEY), so it cannot read the stored API key');
  const b = Buffer.from(sealed, 'base64');
  const d = createDecipheriv('aes-256-gcm', key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  try {
    return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString('utf8');
  } catch {
    throw new ValidationError('the stored API key cannot be read with this server\'s secret key; enter the key again');
  }
}
