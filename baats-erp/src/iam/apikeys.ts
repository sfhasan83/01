import { randomBytes } from 'node:crypto';
import { ConflictError, ForbiddenError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, decide } from './authz.ts';
import { sha256 } from './crypto.ts';

/**
 * API keys let another system call the BAATS API. A key acts as one user and
 * can do exactly what that user's roles allow, so give an integration its own
 * user with only the roles it needs. Keys look like "<tenant id>.bk_<random>",
 * are shown once when made, and only their hash is kept. They skip the
 * second factor, so they can be limited in time and revoked at any moment.
 */

export async function createApiKey(tx: Tx, ctx: Ctx, input: { name: string; userId?: string; expiresAt?: string }) {
  await authorize(tx, ctx, 'int.manage');
  const userId = input.userId ?? ctx.userId!;
  const u = await one(tx, 'SELECT id, email, status FROM iam.users WHERE id = $1', [userId]);
  if (!u) throw new NotFoundError('user');
  if (u.status !== 'active') throw new ValidationError('the user is not active');
  // Acting as someone else is managing that user.
  if (userId !== ctx.userId && !(await decide(tx, ctx.userId!, 'iam.user.manage')).allowed) {
    throw new ForbiddenError('iam.user.manage', {}, 'only a user administrator can make a key that acts as another user');
  }
  if (input.expiresAt && !(Date.parse(input.expiresAt) > Date.now())) throw new ValidationError('the expiry must be in the future');
  const tenant = (await one(tx, 'SELECT app.tenant() AS t')).t as string;
  const secret = `bk_${randomBytes(30).toString('base64url')}`;
  const key = `${tenant}.${secret}`;
  const row = await one(tx, `INSERT INTO iam.api_keys (tenant_id, name, user_id, prefix, key_hash, expires_at, created_by)
      VALUES (app.tenant(), $1, $2, $3, $4, $5, $6) RETURNING id, name, user_id, prefix, expires_at, created_at`,
    [input.name, userId, secret.slice(0, 10), sha256(key), input.expiresAt ?? null, ctx.userId]);
  return { ...row, user_email: u.email, key };
}

export async function listApiKeys(tx: Tx, ctx: Ctx) {
  await authorize(tx, ctx, 'int.manage');
  return many(tx, `SELECT k.id, k.name, k.prefix, u.email AS user_email, k.expires_at, k.last_used_at, k.revoked_at, k.created_at
                     FROM iam.api_keys k JOIN iam.users u ON u.id = k.user_id ORDER BY k.created_at DESC`);
}

export async function revokeApiKey(tx: Tx, ctx: Ctx, id: string) {
  await authorize(tx, ctx, 'int.manage');
  const k = await one(tx, 'SELECT revoked_at FROM iam.api_keys WHERE id = $1', [id]);
  if (!k) throw new NotFoundError('API key');
  if (k.revoked_at) throw new ConflictError('the key is already revoked');
  await tx.query('UPDATE iam.api_keys SET revoked_at = now() WHERE id = $1', [id]);
  return { revoked: true };
}

/** The user an API key acts for, or null when the key is unknown, revoked, expired or its user is not active. */
export async function userForApiKey(tx: Tx, key: string): Promise<string | null> {
  const k = await one(tx, `SELECT k.id, k.user_id, k.last_used_at FROM iam.api_keys k JOIN iam.users u ON u.id = k.user_id
      WHERE k.key_hash = $1 AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at > now()) AND u.status = 'active'`, [sha256(key)]);
  if (!k) return null;
  // Keep last-used roughly current without writing on every call.
  if (!k.last_used_at || Date.now() - new Date(k.last_used_at).getTime() > 60_000) {
    await tx.query('UPDATE iam.api_keys SET last_used_at = now() WHERE id = $1', [k.id]);
  }
  return k.user_id;
}
