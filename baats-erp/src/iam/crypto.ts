import { createHash, createHmac, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (pw: string, salt: Buffer, len: number, opts: object) => Promise<Buffer>;
const SCRYPT = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32, SCRYPT);
  return ['scrypt', SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString('base64'), key.toString('base64')].join('$');
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const [alg, n, r, p, salt, key] = stored.split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(key, 'base64');
  const actual = await scryptAsync(password, Buffer.from(salt, 'base64'), expected.length,
    { N: Number(n), r: Number(r), p: Number(p), maxmem: SCRYPT.maxmem });
  return timingSafeEqual(expected, actual);
}

export function passwordProblems(password: string): string[] {
  const problems: string[] = [];
  if (password.length < 12) problems.push('must be at least 12 characters');
  if (!/[a-z]/.test(password) || !/[A-Z]/.test(password)) problems.push('must mix upper and lower case');
  if (!/[0-9]/.test(password)) problems.push('must contain a digit');
  return problems;
}

export function newToken(): string { return randomBytes(32).toString('base64url'); }
export function sha256(s: string): string { return createHash('sha256').update(s).digest('hex'); }

// --- TOTP (RFC 6238, SHA-1, 6 digits, 30 s) ---------------------------------
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Encode(buf: Buffer): string {
  let bits = 0, value = 0, out = '';
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff; bits += 8;
    while (bits >= 5) { out += B32[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(s: string): Buffer {
  let bits = 0, value = 0;
  const out: number[] = [];
  for (const ch of s.replace(/=+$/, '').toUpperCase()) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('invalid base32');
    value = ((value << 5) | idx) & 0xffff; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

export function newTotpSecret(): string { return base32Encode(randomBytes(20)); }

export function totp(secret: string, atMs = Date.now(), step = 30): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(atMs / 1000 / step)));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const off = h[h.length - 1] & 15;
  const code = (h.readUInt32BE(off) & 0x7fffffff) % 1_000_000;
  return code.toString().padStart(6, '0');
}

/** Accept the current code and one step either side for clock drift. */
export function verifyTotp(secret: string, code: string, atMs = Date.now()): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  return [-1, 0, 1].some((d) => timingSafeEqual(Buffer.from(totp(secret, atMs + d * 30_000)), Buffer.from(code)));
}
