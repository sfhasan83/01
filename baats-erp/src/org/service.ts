import { NotFoundError, ValidationError } from '../core/errors.ts';
import { many, one, type Ctx, type Tx } from '../core/db.ts';
import { authorize, unitScope } from '../iam/authz.ts';

/**
 * Organization engine. The hierarchy (group, company, country, branch,
 * department, team, or whatever levels a tenant defines) is data: unit types
 * carry a rank, and a unit may only sit under a unit of a higher level.
 */

export const DEFAULT_UNIT_TYPES: Array<{ code: string; name: string; rank: number; legal?: boolean }> = [
  { code: 'group', name: 'Group', rank: 0, legal: true },
  { code: 'company', name: 'Company', rank: 10, legal: true },
  { code: 'country', name: 'Country', rank: 20 },
  { code: 'region', name: 'Region', rank: 30 },
  { code: 'branch', name: 'Branch', rank: 40 },
  { code: 'business_unit', name: 'Business unit', rank: 50 },
  { code: 'division', name: 'Division', rank: 60 },
  { code: 'department', name: 'Department', rank: 70 },
  { code: 'sub_department', name: 'Sub-department', rank: 80 },
  { code: 'team', name: 'Team', rank: 90 },
];

export async function createUnitType(tx: Tx, ctx: Ctx, input: { code: string; name: string; rank: number; isLegalEntity?: boolean }) {
  await authorize(tx, ctx, 'org.unit.manage');
  return one(tx, `INSERT INTO org.unit_types (tenant_id, code, name, rank, is_legal_entity)
    VALUES (app.tenant(), $1, $2, $3, $4) RETURNING *`, [input.code, input.name, input.rank, input.isLegalEntity ?? false]);
}

export async function listUnitTypes(tx: Tx) {
  return many(tx, 'SELECT * FROM org.unit_types ORDER BY rank');
}

export interface UnitInput {
  typeCode: string; parentId: string; code: string; name: string;
  countryCode?: string; currencyCode?: string; isCostCenter?: boolean; isProfitCenter?: boolean;
  attributes?: Record<string, unknown>;
}

export async function createUnit(tx: Tx, ctx: Ctx, input: UnitInput) {
  // Creating a unit is managing its parent.
  await authorize(tx, ctx, 'org.unit.manage', { unitId: input.parentId });
  const type = await one(tx, 'SELECT id FROM org.unit_types WHERE code = $1', [input.typeCode]);
  if (!type) throw new ValidationError(`unknown unit type ${input.typeCode}`);
  return one(tx, `INSERT INTO org.units (tenant_id, type_id, parent_id, code, name, country_code, currency_code,
                                         is_cost_center, is_profit_center, attributes)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [type.id, input.parentId, input.code, input.name, input.countryCode ?? null, input.currencyCode ?? null,
      input.isCostCenter ?? false, input.isProfitCenter ?? false, JSON.stringify(input.attributes ?? {})]);
}

/** Re-parent a unit; the database re-computes paths for the whole subtree and rejects cycles. */
export async function moveUnit(tx: Tx, ctx: Ctx, unitId: string, newParentId: string) {
  await authorize(tx, ctx, 'org.unit.manage', { unitId });
  await authorize(tx, ctx, 'org.unit.manage', { unitId: newParentId });
  const u = await one(tx, 'UPDATE org.units SET parent_id = $2 WHERE id = $1 RETURNING *', [unitId, newParentId]);
  if (!u) throw new NotFoundError('unit');
  return u;
}

export async function updateUnit(tx: Tx, ctx: Ctx, unitId: string, patch: { name?: string; headEmployeeId?: string | null; status?: string; isCostCenter?: boolean; isProfitCenter?: boolean }) {
  await authorize(tx, ctx, 'org.unit.manage', { unitId });
  const u = await one(tx, `UPDATE org.units SET
      name = coalesce($2, name),
      head_employee_id = CASE WHEN $3::boolean THEN $4::uuid ELSE head_employee_id END,
      status = coalesce($5, status),
      is_cost_center = coalesce($6, is_cost_center),
      is_profit_center = coalesce($7, is_profit_center)
    WHERE id = $1 RETURNING *`,
    [unitId, patch.name ?? null, 'headEmployeeId' in patch, patch.headEmployeeId ?? null, patch.status ?? null,
      patch.isCostCenter ?? null, patch.isProfitCenter ?? null]);
  if (!u) throw new NotFoundError('unit');
  return u;
}

/** Units the user can see, as a flat list in tree order (parents before children). */
export async function listUnits(tx: Tx, ctx: Ctx, rootId?: string) {
  const scope = await unitScope(tx, ctx.userId!, 'org.unit.read', 'u.id', 1);
  const params: unknown[] = [scope.param];
  let filter = '';
  if (rootId) {
    params.push(rootId);
    filter = `AND u.path LIKE (SELECT path FROM org.units WHERE id = $2) || '%'`;
  }
  return many(tx, `SELECT u.id, u.parent_id, u.code, u.name, t.code AS type, u.depth, u.country_code, u.currency_code,
                          u.is_cost_center, u.is_profit_center, u.head_employee_id, u.status
                     FROM org.units u JOIN org.unit_types t ON t.id = u.type_id
                    WHERE ${scope.sql} ${filter} ORDER BY u.path`, params);
}

export async function rootUnit(tx: Tx) {
  return one(tx, 'SELECT * FROM org.units WHERE parent_id IS NULL');
}

// --- Designations and employees ---------------------------------------------

export async function createDesignation(tx: Tx, ctx: Ctx, input: { code: string; title: string; grade?: string }) {
  await authorize(tx, ctx, 'org.unit.manage');
  return one(tx, `INSERT INTO org.designations (tenant_id, code, title, grade) VALUES (app.tenant(), $1, $2, $3) RETURNING *`,
    [input.code, input.title, input.grade ?? null]);
}

export interface EmployeeInput {
  employeeNo: string; firstName: string; lastName: string; email?: string; unitId: string;
  designationId?: string; managerId?: string; hireDate?: string; attributes?: Record<string, unknown>;
  /** ISO country code; decides social insurance (for example GOSI for Saudi nationals). */
  nationality?: string;
}

export async function createEmployee(tx: Tx, ctx: Ctx, input: EmployeeInput) {
  await authorize(tx, ctx, 'org.employee.manage', { unitId: input.unitId });
  return one(tx, `INSERT INTO org.employees (tenant_id, employee_no, first_name, last_name, email, unit_id,
                                             designation_id, manager_id, hire_date, attributes, nationality)
    VALUES (app.tenant(), $1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING *`,
    [input.employeeNo, input.firstName, input.lastName, input.email ?? null, input.unitId,
      input.designationId ?? null, input.managerId ?? null, input.hireDate ?? null, JSON.stringify(input.attributes ?? {}), input.nationality ?? null]);
}

export async function updateEmployee(tx: Tx, ctx: Ctx, id: string, patch: { unitId?: string; managerId?: string | null; designationId?: string; status?: string; nationality?: string }) {
  const e = await one(tx, 'SELECT unit_id FROM org.employees WHERE id = $1', [id]);
  if (!e) throw new NotFoundError('employee');
  await authorize(tx, ctx, 'org.employee.manage', { unitId: e.unit_id });
  if (patch.unitId) await authorize(tx, ctx, 'org.employee.manage', { unitId: patch.unitId });
  return one(tx, `UPDATE org.employees SET
      unit_id = coalesce($2, unit_id),
      manager_id = CASE WHEN $3::boolean THEN $4::uuid ELSE manager_id END,
      designation_id = coalesce($5, designation_id),
      status = coalesce($6, status),
      nationality = coalesce($7, nationality)
    WHERE id = $1 RETURNING *`,
    [id, patch.unitId ?? null, 'managerId' in patch, patch.managerId ?? null, patch.designationId ?? null, patch.status ?? null, patch.nationality ?? null]);
}

export async function listEmployees(tx: Tx, ctx: Ctx, opts: { unitId?: string; limit?: number; offset?: number } = {}) {
  const scope = await unitScope(tx, ctx.userId!, 'org.employee.read', 'e.unit_id', 1);
  const params: unknown[] = [scope.param, Math.min(opts.limit ?? 100, 500), opts.offset ?? 0];
  let filter = '';
  if (opts.unitId) {
    params.push(opts.unitId);
    filter = `AND e.unit_id IN (SELECT id FROM org.units WHERE path LIKE (SELECT path FROM org.units WHERE id = $4) || '%')`;
  }
  return many(tx, `SELECT e.*, d.title AS designation FROM org.employees e
                     LEFT JOIN org.designations d ON d.id = e.designation_id
                    WHERE ${scope.sql} ${filter} ORDER BY e.employee_no LIMIT $2 OFFSET $3`, params);
}

/** Reporting line upwards: [direct manager, their manager, ...]. */
export async function managerChain(tx: Tx, employeeId: string) {
  return many(tx, `WITH RECURSIVE chain AS (
      SELECT e.id, e.manager_id, 0 AS lvl FROM org.employees e WHERE e.id = $1
      UNION ALL
      SELECT m.id, m.manager_id, c.lvl + 1 FROM org.employees m JOIN chain c ON m.id = c.manager_id WHERE c.lvl < 50)
    SELECT e.id, e.employee_no, e.first_name, e.last_name, c.lvl AS level, u.id AS user_id
      FROM chain c JOIN org.employees e ON e.id = c.id LEFT JOIN iam.users u ON u.employee_id = e.id
     WHERE c.lvl > 0 ORDER BY c.lvl`, [employeeId]);
}

/** Org chart: direct reports of an employee (or the top of the tree when omitted). */
export async function directReports(tx: Tx, ctx: Ctx, managerId: string | null) {
  const scope = await unitScope(tx, ctx.userId!, 'org.employee.read', 'e.unit_id', 1);
  return many(tx, `SELECT e.id, e.employee_no, e.first_name, e.last_name, e.unit_id,
                          (SELECT count(*) FROM org.employees r WHERE r.manager_id = e.id)::int AS reports
                     FROM org.employees e
                    WHERE ${scope.sql} AND e.manager_id IS NOT DISTINCT FROM $2 ORDER BY e.last_name`, [scope.param, managerId]);
}
