import { NotFoundError, ValidationError, UnauthenticatedError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize } from './authz.ts';
import { hashPassword, passwordProblems, sha256, verifyPassword } from './crypto.ts';

/**
 * Where a user is signed in, signing out other devices, and passwords:
 * changing your own (which signs out everywhere else) and an administrator
 * setting a new one (which signs that user out everywhere).
 */

const audit = (tx: Tx, action: string, userId: string | null, detail: object) =>
  tx.query(`SELECT audit.append('security', $1, 'iam.users', $2, NULL, $3)`, [action, userId, JSON.stringify(detail)]);

export async function mySessions(tx: Tx, ctx: Ctx, token: string) {
  return many(tx, `SELECT id, created_at, expires_at, ip, user_agent, mfa_verified, token_hash = $2 AS current
                     FROM iam.sessions WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY created_at DESC`,
  [ctx.userId, sha256(token)]);
}

export async function revokeSession(tx: Tx, ctx: Ctx, id: string) {
  const r = await tx.query('UPDATE iam.sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL', [id, ctx.userId]);
  if (!r.rowCount) throw new NotFoundError('session');
  await audit(tx, 'session_revoked', ctx.userId, { session: id });
  return { revoked: 1 };
}

/** Sign out every other device; the one making the request stays signed in. */
export async function revokeOtherSessions(tx: Tx, ctx: Ctx, token: string) {
  const r = await tx.query(`UPDATE iam.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2`, [ctx.userId, sha256(token)]);
  await audit(tx, 'sessions_revoked', ctx.userId, { count: r.rowCount });
  return { revoked: r.rowCount ?? 0 };
}

export async function changePassword(tx: Tx, ctx: Ctx, token: string, input: { current: string; next: string }) {
  const u = await one(tx, 'SELECT password_hash FROM iam.users WHERE id = $1', [ctx.userId]);
  if (!u?.password_hash || !(await verifyPassword(input.current, u.password_hash))) {
    await audit(tx, 'password_change_failed', ctx.userId, {});
    throw new UnauthenticatedError('the current password is not right');
  }
  const problems = passwordProblems(input.next);
  if (problems.length) throw new ValidationError(`the new password ${problems.join(', ')}`);
  if (input.next === input.current) throw new ValidationError('the new password is the same as the current one');
  await tx.query('UPDATE iam.users SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1', [ctx.userId, await hashPassword(input.next)]);
  const r = await tx.query(`UPDATE iam.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL AND token_hash <> $2`, [ctx.userId, sha256(token)]);
  await audit(tx, 'password_changed', ctx.userId, { other_sessions_ended: r.rowCount });
  return { changed: true, otherSessionsEnded: r.rowCount ?? 0 };
}

/** An administrator sets a new password for someone, for example one who forgot theirs. Unlocks the account. */
export async function setPassword(tx: Tx, ctx: Ctx, userId: string, password: string) {
  await authorize(tx, ctx, 'iam.user.manage');
  const u = await one(tx, 'SELECT id FROM iam.users WHERE id = $1', [userId]);
  if (!u) throw new NotFoundError('user');
  const problems = passwordProblems(password);
  if (problems.length) throw new ValidationError(`password ${problems.join(', ')}`);
  await tx.query('UPDATE iam.users SET password_hash = $2, failed_logins = 0, locked_until = NULL WHERE id = $1', [userId, await hashPassword(password)]);
  const r = await tx.query('UPDATE iam.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  await audit(tx, 'password_set_by_admin', userId, { by: ctx.userId, sessions_ended: r.rowCount });
  return { set: true, sessionsEnded: r.rowCount ?? 0 };
}
