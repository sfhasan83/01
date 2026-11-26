import { ConflictError, NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { validateCondition, type Condition } from '../core/rules.ts';
import { authorize } from './authz.ts';
import { hashPassword, passwordProblems } from './crypto.ts';

export interface User {
  id: string; email: string; display_name: string; employee_id: string | null; status: string; mfa_enabled: boolean;
}
const USER_COLS = 'id, email, display_name, employee_id, status, mfa_enabled';

export async function createUser(tx: Tx, ctx: Ctx, input: { email: string; displayName: string; password?: string; employeeId?: string }): Promise<User> {
  await authorize(tx, ctx, 'iam.user.manage');
  return insertUser(tx, input);
}

/** Unchecked insert, used by onboarding before any roles exist. */
export async function insertUser(tx: Tx, input: { email: string; displayName: string; password?: string; employeeId?: string }): Promise<User> {
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(input.email)) throw new ValidationError('invalid email');
  let hash: string | null = null;
  if (input.password !== undefined) {
    const problems = passwordProblems(input.password);
    if (problems.length) throw new ValidationError(`password ${problems.join(', ')}`);
    hash = await hashPassword(input.password);
  }
  return (await one<User>(tx, `INSERT INTO iam.users (tenant_id, email, display_name, password_hash, employee_id)
    VALUES (app.tenant(), $1, $2, $3, $4) RETURNING ${USER_COLS}`,
    [input.email.toLowerCase(), input.displayName, hash, input.employeeId ?? null]))!;
}

export async function setUserStatus(tx: Tx, ctx: Ctx, userId: string, status: 'active' | 'disabled'): Promise<User> {
  await authorize(tx, ctx, 'iam.user.manage');
  const u = await one<User>(tx, `UPDATE iam.users SET status = $2 WHERE id = $1 RETURNING ${USER_COLS}`, [userId, status]);
  if (!u) throw new NotFoundError('user');
  // Revoking access must take effect at once: end every open session.
  if (status === 'disabled') await tx.query('UPDATE iam.sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL', [userId]);
  return u;
}

export async function listUsers(tx: Tx, ctx: Ctx): Promise<User[]> {
  await authorize(tx, ctx, 'iam.user.read');
  return many<User>(tx, `SELECT ${USER_COLS} FROM iam.users ORDER BY email`);
}

// --- Roles and grants -------------------------------------------------------

export async function createRole(tx: Tx, ctx: Ctx, input: { code: string; name: string }) {
  await authorize(tx, ctx, 'iam.role.manage');
  return one(tx, `INSERT INTO iam.roles (tenant_id, code, name) VALUES (app.tenant(), $1, $2) RETURNING *`, [input.code, input.name]);
}

export async function grantPermission(tx: Tx, ctx: Ctx, roleId: string, permission: string, conditions: Condition = {}) {
  await authorize(tx, ctx, 'iam.role.manage');
  const errs = validateCondition(conditions, 'conditions');
  if (errs.length) throw new ValidationError(errs.join('; '));
  const row = await one(tx, `INSERT INTO iam.role_permissions (tenant_id, role_id, permission_code, conditions)
    VALUES (app.tenant(), $1, $2, $3)
    ON CONFLICT (tenant_id, role_id, permission_code) DO UPDATE SET conditions = EXCLUDED.conditions
    RETURNING *`, [roleId, permission, JSON.stringify(conditions)]);
  await assertNoSodViolation(tx, { roleId, permission });
  return row;
}

export async function revokePermission(tx: Tx, ctx: Ctx, roleId: string, permission: string): Promise<void> {
  await authorize(tx, ctx, 'iam.role.manage');
  await tx.query('DELETE FROM iam.role_permissions WHERE role_id = $1 AND permission_code = $2', [roleId, permission]);
}

export async function listRoles(tx: Tx, ctx: Ctx) {
  await authorize(tx, ctx, 'iam.user.read');
  return many(tx, `SELECT r.*, coalesce(jsonb_agg(jsonb_build_object('permission', rp.permission_code, 'conditions', rp.conditions)
                   ORDER BY rp.permission_code) FILTER (WHERE rp.id IS NOT NULL), '[]') AS permissions
                     FROM iam.roles r LEFT JOIN iam.role_permissions rp ON rp.role_id = r.id
                    GROUP BY r.id ORDER BY r.code`);
}

export async function assignRole(tx: Tx, ctx: Ctx, input: {
  userId: string; roleId: string; scopeUnitId: string; includeDescendants?: boolean; validFrom?: string; validTo?: string;
}) {
  // Assigning a role over a unit requires authority over that unit.
  await authorize(tx, ctx, 'iam.assignment.manage', { unitId: input.scopeUnitId });
  if (ctx.userId === input.userId) throw new ValidationError('users cannot assign roles to themselves');
  return insertAssignment(tx, input);
}

export async function insertAssignment(tx: Tx, input: {
  userId: string; roleId: string; scopeUnitId: string; includeDescendants?: boolean; validFrom?: string; validTo?: string;
}) {
  const row = await one(tx, `INSERT INTO iam.role_assignments
      (tenant_id, user_id, role_id, scope_unit_id, include_descendants, valid_from, valid_to)
    VALUES (app.tenant(), $1, $2, $3, $4, coalesce($5::timestamptz, now()), $6) RETURNING *`,
    [input.userId, input.roleId, input.scopeUnitId, input.includeDescendants ?? true, input.validFrom ?? null, input.validTo ?? null]);
  await assertNoSodViolation(tx, { userId: input.userId, roleId: input.roleId });
  return row;
}

export async function removeAssignment(tx: Tx, ctx: Ctx, assignmentId: string): Promise<void> {
  const a = await one(tx, 'SELECT scope_unit_id FROM iam.role_assignments WHERE id = $1', [assignmentId]);
  if (!a) throw new NotFoundError('assignment');
  await authorize(tx, ctx, 'iam.assignment.manage', { unitId: a.scope_unit_id });
  await tx.query('DELETE FROM iam.role_assignments WHERE id = $1', [assignmentId]);
}

/** Permissions a user holds right now, with the scope of each grant. */
export async function effectivePermissions(tx: Tx, userId: string) {
  return many(tx, `SELECT DISTINCT rp.permission_code AS permission, r.code AS role, ra.scope_unit_id, u.name AS scope_unit,
                          ra.include_descendants, rp.conditions
                     FROM iam.role_assignments ra
                     JOIN iam.roles r ON r.id = ra.role_id
                     JOIN iam.role_permissions rp ON rp.role_id = r.id
                     JOIN org.units u ON u.id = ra.scope_unit_id
                    WHERE ra.user_id = $1 AND ra.valid_from <= now() AND (ra.valid_to IS NULL OR ra.valid_to > now())
                    ORDER BY 1, 2`, [userId]);
}

// --- Segregation of duties ----------------------------------------------------

export async function createSodRule(tx: Tx, ctx: Ctx, input: { name: string; permissionA: string; permissionB: string }) {
  await authorize(tx, ctx, 'iam.sod.manage');
  const rule = await one(tx, `INSERT INTO iam.sod_rules (tenant_id, name, permission_a, permission_b)
    VALUES (app.tenant(), $1, $2, $3) RETURNING *`, [input.name, input.permissionA, input.permissionB]);
  // Existing conflicts are reported for remediation; new ones are blocked from now on.
  return { rule, existingViolations: await sodViolations(tx, { permission: input.permissionA }) };
}

/**
 * Users who hold both permissions of a SoD rule. Filters: a user, or the holders
 * of a role; and only rules involving a given permission, or any permission of
 * the given role. Used to block the change that would create a new conflict.
 */
export async function sodViolations(tx: Tx, f: { userId?: string; roleId?: string; permission?: string }) {
  return many(tx, `
    WITH held AS (
      SELECT DISTINCT ra.user_id, rp.permission_code
        FROM iam.role_assignments ra JOIN iam.role_permissions rp ON rp.role_id = ra.role_id
       WHERE (ra.valid_to IS NULL OR ra.valid_to > now())
         AND ($1::uuid IS NULL OR ra.user_id = $1)
         AND ($2::uuid IS NULL OR ra.user_id IN (SELECT user_id FROM iam.role_assignments WHERE role_id = $2))),
    involved AS (
      SELECT $3::text AS p WHERE $3::text IS NOT NULL
      UNION SELECT permission_code FROM iam.role_permissions WHERE $3::text IS NULL AND role_id = $2)
    SELECT s.name AS rule, a.user_id, s.permission_a, s.permission_b
      FROM iam.sod_rules s
      JOIN held a ON a.permission_code = s.permission_a
      JOIN held b ON b.permission_code = s.permission_b AND b.user_id = a.user_id
     WHERE ($2::uuid IS NULL AND $3::text IS NULL)
        OR s.permission_a IN (SELECT p FROM involved) OR s.permission_b IN (SELECT p FROM involved)`,
    [f.userId ?? null, f.roleId ?? null, f.permission ?? null]);
}

async function assertNoSodViolation(tx: Tx, f: { userId?: string; roleId?: string; permission?: string }): Promise<void> {
  const v = await sodViolations(tx, f);
  if (v.length) throw new ConflictError(`segregation of duties: ${[...new Set(v.map((x) => x.rule))].join(', ')}`, v);
}

// --- Delegation of authority --------------------------------------------------

export async function createDelegation(tx: Tx, ctx: Ctx, input: {
  delegatorUserId?: string; delegateUserId: string; validFrom: string; validTo: string; reason?: string;
}) {
  const delegator = input.delegatorUserId ?? ctx.userId!;
  // Anyone may delegate their own authority; delegating someone else's needs a permission.
  if (delegator !== ctx.userId) await authorize(tx, ctx, 'iam.delegation.manage');
  const target = await one(tx, `SELECT status FROM iam.users WHERE id = $1`, [input.delegateUserId]);
  if (!target || target.status !== 'active') throw new ValidationError('delegate must be an active user');
  return one(tx, `INSERT INTO iam.delegations (tenant_id, delegator_user_id, delegate_user_id, valid_from, valid_to, reason)
    VALUES (app.tenant(), $1, $2, $3, $4, $5) RETURNING *`,
    [delegator, input.delegateUserId, input.validFrom, input.validTo, input.reason ?? null]);
}

/** The user who should act for `userId` at `at`, following at most one hop of delegation. */
export async function activeDelegate(tx: Tx, userId: string, at: Date): Promise<string | null> {
  const d = await one(tx, `SELECT delegate_user_id FROM iam.delegations
    WHERE delegator_user_id = $1 AND valid_from <= $2 AND valid_to > $2 ORDER BY valid_from DESC LIMIT 1`, [userId, at]);
  return d?.delegate_user_id ?? null;
}
