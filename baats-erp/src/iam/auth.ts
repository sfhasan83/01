import { UnauthenticatedError, ValidationError } from '../core/errors.ts';
import { one, type Ctx, type Db, type Tx } from '../core/db.ts';
import { newToken, newTotpSecret, sha256, verifyPassword, verifyTotp } from './crypto.ts';
import { userForApiKey } from './apikeys.ts';

const SESSION_HOURS = 8;
const MAX_FAILED_LOGINS = 5;
const LOCK_MINUTES = 15;

export interface Session { token: string; userId: string; tenantId: string; expiresAt: string }

async function audit(tx: Tx, action: string, userId: string | null, detail: object): Promise<void> {
  await tx.query(`SELECT audit.append('security', $1, 'iam.users', $2, NULL, $3)`, [action, userId, JSON.stringify(detail)]);
}

/**
 * Password login with optional TOTP second factor and account lockout.
 * Every outcome is written to the audit trail as a security event.
 * Session tokens are "<tenant id>.<random>"; only a hash is stored.
 */
export async function login(db: Db, input: { tenant: string; email: string; password: string; totp?: string }): Promise<Session> {
  const tenantId = await db.withTenant({ tenantId: '00000000-0000-0000-0000-000000000000', userId: null }, async (tx) =>
    (await one(tx, 'SELECT platform.tenant_id_by_code($1) AS id', [input.tenant]))?.id as string | null);
  if (!tenantId) throw new UnauthenticatedError('invalid credentials');

  type Outcome = { ok: true; session: Session } | { ok: false; message: string };
  const outcome = await db.withTenant<Outcome>({ tenantId, userId: null }, async (tx) => {
    const u = await one(tx, `SELECT id, password_hash, status, mfa_enabled, mfa_secret, failed_logins, locked_until
                               FROM iam.users WHERE lower(email) = lower($1) FOR NO KEY UPDATE`, [input.email]);
    const fail = async (reason: string, userId: string | null): Promise<Outcome> => {
      await audit(tx, 'login_failed', userId, { email: input.email.toLowerCase(), reason });
      return { ok: false, message: 'invalid credentials' };
    };
    if (!u || !u.password_hash || u.status !== 'active') return fail('unknown or inactive user', u?.id ?? null);
    if (u.locked_until && new Date(u.locked_until) > new Date()) {
      await audit(tx, 'login_blocked', u.id, { reason: 'account locked' });
      return { ok: false, message: 'account temporarily locked' };
    }
    const good = await verifyPassword(input.password, u.password_hash)
      && (!u.mfa_enabled || (input.totp !== undefined && verifyTotp(u.mfa_secret, input.totp)));
    if (!good) {
      const failed = u.failed_logins + 1;
      await tx.query(`UPDATE iam.users SET failed_logins = $2::int,
                        locked_until = CASE WHEN $2::int >= $3::int THEN now() + make_interval(mins => $4::int) END WHERE id = $1`,
        [u.id, failed, MAX_FAILED_LOGINS, LOCK_MINUTES]);
      return fail(u.mfa_enabled && !input.totp ? 'second factor required' : 'bad password or code', u.id);
    }
    await tx.query('UPDATE iam.users SET failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
    const secret = newToken();
    const token = `${tenantId}.${secret}`;
    const s = await one(tx, `INSERT INTO iam.sessions (tenant_id, user_id, token_hash, mfa_verified, expires_at)
      VALUES (app.tenant(), $1, $2, $3, now() + make_interval(hours => $4::int)) RETURNING expires_at`,
      [u.id, sha256(token), u.mfa_enabled, SESSION_HOURS]);
    await audit(tx, 'login', u.id, { mfa: u.mfa_enabled });
    return { ok: true, session: { token, userId: u.id, tenantId, expiresAt: s.expires_at.toISOString() } };
  });
  // The failed-attempt counter and audit entry must persist, so failure is returned, then thrown.
  if (!outcome.ok) throw new UnauthenticatedError(outcome.message);
  return outcome.session;
}

/** Resolve a bearer token to a context. Expired, revoked or disabled-user sessions fail. */
export async function authenticate(db: Db, token: string): Promise<Ctx> {
  const tenantId = token.split('.')[0];
  if (!/^[0-9a-f-]{36}$/.test(tenantId)) throw new UnauthenticatedError();
  const userId = await db.withTenant({ tenantId, userId: null }, async (tx) => {
    if (token.slice(tenantId.length + 1).startsWith('bk_')) return (await userForApiKey(tx, token)) ?? undefined;
    const s = await one(tx, `SELECT s.user_id FROM iam.sessions s JOIN iam.users u ON u.id = s.user_id
      WHERE s.token_hash = $1 AND s.revoked_at IS NULL AND s.expires_at > now() AND u.status = 'active'`, [sha256(token)]);
    return s?.user_id as string | undefined;
  });
  if (!userId) throw new UnauthenticatedError('session expired or revoked');
  return { tenantId, userId };
}

export async function logout(db: Db, token: string): Promise<void> {
  const ctx = await authenticate(db, token);
  await db.withTenant(ctx, async (tx) => {
    await tx.query('UPDATE iam.sessions SET revoked_at = now() WHERE token_hash = $1', [sha256(token)]);
    await audit(tx, 'logout', ctx.userId, {});
  });
}

/** Step 1 of MFA enrolment: store a pending secret and return it for the authenticator app. */
export async function beginMfaEnrolment(tx: Tx, ctx: Ctx, issuer = 'BAATS ERP') {
  const u = await one(tx, 'SELECT email, mfa_enabled FROM iam.users WHERE id = $1', [ctx.userId]);
  if (u.mfa_enabled) throw new ValidationError('MFA is already enabled');
  const secret = newTotpSecret();
  await tx.query('UPDATE iam.users SET mfa_secret = $2 WHERE id = $1', [ctx.userId, secret]);
  const label = encodeURIComponent(`${issuer}:${u.email}`);
  return { secret, otpauthUrl: `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}` };
}

/** Step 2: prove possession of the secret with a valid code; MFA is then enforced at login. */
export async function confirmMfaEnrolment(tx: Tx, ctx: Ctx, code: string): Promise<void> {
  const u = await one(tx, 'SELECT mfa_secret FROM iam.users WHERE id = $1', [ctx.userId]);
  if (!u?.mfa_secret || !verifyTotp(u.mfa_secret, code)) throw new ValidationError('invalid code');
  await tx.query('UPDATE iam.users SET mfa_enabled = true WHERE id = $1', [ctx.userId]);
  await audit(tx, 'mfa_enabled', ctx.userId, {});
}
