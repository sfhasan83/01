import { baseCurrencySet, useBaseCurrency } from '../core/money.ts';
import { ForbiddenError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { matches, type Condition } from '../core/rules.ts';

/**
 * Identity and access engine: role-based grants, scoped to a subtree of the
 * organization, narrowed by attribute conditions (ABAC).
 *
 * A resource is either tenant-wide (no unitId: needs a grant scoped at the root
 * unit) or belongs to an org unit (needs a grant whose scope covers that unit).
 */
export interface Resource {
  unitId?: string;
  attrs?: Record<string, unknown>;
}

export interface Decision {
  allowed: boolean;
  reason: string;
  via?: { role: string; scopeUnitId: string };
}

interface Grant {
  role_code: string;
  conditions: Condition;
  scope_unit_id: string;
  scope_path: string;
  scope_depth: number;
  include_descendants: boolean;
}

async function grantsFor(tx: Tx, userId: string, permission: string, at = new Date()): Promise<Grant[]> {
  return many<Grant>(tx, `
    SELECT r.code AS role_code, rp.conditions, ra.scope_unit_id, u.path AS scope_path, u.depth AS scope_depth,
           ra.include_descendants
      FROM iam.role_assignments ra
      JOIN iam.users us ON us.id = ra.user_id AND us.status = 'active'
      JOIN iam.roles r ON r.id = ra.role_id
      JOIN iam.role_permissions rp ON rp.role_id = ra.role_id AND rp.permission_code = $2
      JOIN org.units u ON u.id = ra.scope_unit_id
     WHERE ra.user_id = $1 AND ra.valid_from <= $3 AND (ra.valid_to IS NULL OR ra.valid_to > $3)`,
    [userId, permission, at]);
}

function covers(g: Grant, unit: { id: string; path: string } | null): boolean {
  if (!unit) return g.scope_depth === 0 && g.include_descendants;
  if (unit.id === g.scope_unit_id) return true;
  return g.include_descendants && unit.path.startsWith(g.scope_path);
}

export async function decide(tx: Tx, userId: string, permission: string, resource: Resource = {}, at = new Date()): Promise<Decision> {
  const grants = await grantsFor(tx, userId, permission, at);
  if (grants.length === 0) return { allowed: false, reason: 'no role grants this permission' };
  let unit: { id: string; path: string } | null = null;
  if (resource.unitId) {
    unit = (await one(tx, 'SELECT id, path FROM org.units WHERE id = $1', [resource.unitId])) ?? null;
    if (!unit) return { allowed: false, reason: 'unknown org unit' };
  }
  const inScope = grants.filter((g) => covers(g, unit));
  if (inScope.length === 0) return { allowed: false, reason: 'resource is outside the scope of your roles' };
  const ok = inScope.find((g) => matches(g.conditions, resource.attrs ?? {}));
  if (!ok) return { allowed: false, reason: 'conditions on your grant are not met (for example an approval limit)' };
  return { allowed: true, reason: 'granted', via: { role: ok.role_code, scopeUnitId: ok.scope_unit_id } };
}

/** Throw ForbiddenError unless the acting user holds the permission for the resource. */
export async function authorize(tx: Tx, ctx: Ctx, permission: string, resource: Resource = {}): Promise<void> {
  if (!ctx.userId) throw new ForbiddenError(permission, resource, 'no acting user');
  const d = await decide(tx, ctx.userId, permission, resource);
  if (!d.allowed) throw new ForbiddenError(permission, resource, d.reason);
  // Work on a company's books rounds money to its base currency (three decimals for
  // BHD, KWD and OMR) from the first check onwards, reports included.
  if (resource.unitId && !baseCurrencySet()) {
    const c = await tx.query('SELECT base_currency FROM fin.companies WHERE unit_id = $1', [resource.unitId]);
    if (c.rows[0]) useBaseCurrency(c.rows[0].base_currency);
  }
}

/**
 * SQL predicate limiting rows to units the user can see under a permission.
 * The caller appends `param` as positional parameter number `paramIndex`.
 */
export async function unitScope(tx: Tx, userId: string, permission: string, unitColumn: string, paramIndex: number):
  Promise<{ sql: string; param: string[] }> {
  const grants = await grantsFor(tx, userId, permission);
  // Each grant becomes "path%" (whole subtree) or "=id" (that unit only).
  const patterns = grants.map((g) => (g.include_descendants ? `${g.scope_path}%` : `=${g.scope_unit_id}`));
  return {
    sql: `EXISTS (SELECT 1 FROM org.units scope_unit, unnest($${paramIndex}::text[]) scope_pattern
                   WHERE scope_unit.id = ${unitColumn}
                     AND ((scope_pattern LIKE '=%' AND scope_unit.id::text = substr(scope_pattern, 2))
                       OR (scope_pattern NOT LIKE '=%' AND scope_unit.path LIKE scope_pattern)))`,
    param: patterns,
  };
}
