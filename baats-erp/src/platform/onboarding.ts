import { randomUUID } from 'node:crypto';
import { many, one, type Db } from '../core/db.ts';
import { insertAssignment, insertUser } from '../iam/service.ts';
import { DEFAULT_UNIT_TYPES } from '../org/service.ts';
import { insertDefinition } from '../workflow/engine.ts';
import { PARTY_WORKFLOW } from '../mdm/service.ts';

export interface OnboardInput {
  code: string;
  name: string;
  baseCurrency: string;
  countryCode: string;
  admin: { email: string; displayName: string; password: string };
}

/**
 * Automated onboarding of a new customer organization: tenant record, default
 * hierarchy levels, the root unit, a TENANT_ADMIN role holding every permission,
 * the first administrator, and a default approval workflow for partners.
 * All in one transaction; nothing is left half-created on failure.
 */
export async function onboardTenant(db: Db, input: OnboardInput) {
  const tenantId = randomUUID();
  return db.withTenant({ tenantId, userId: null }, async (tx) => {
    await tx.query(`INSERT INTO platform.tenants (id, code, name, base_currency) VALUES ($1, $2, $3, $4)`,
      [tenantId, input.code, input.name, input.baseCurrency]);
    for (const t of DEFAULT_UNIT_TYPES) {
      await tx.query(`INSERT INTO org.unit_types (tenant_id, code, name, rank, is_legal_entity) VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, t.code, t.name, t.rank, t.legal ?? false]);
    }
    const root = await one(tx, `INSERT INTO org.units (tenant_id, type_id, code, name, country_code, currency_code)
      SELECT $1, id, $2, $3, $4, $5 FROM org.unit_types WHERE code = 'group' RETURNING *`,
      [tenantId, input.code.toUpperCase(), input.name, input.countryCode, input.baseCurrency]);
    const role = await one(tx, `INSERT INTO iam.roles (tenant_id, code, name, is_system)
      VALUES ($1, 'TENANT_ADMIN', 'Tenant administrator', true) RETURNING *`, [tenantId]);
    const perms = await many(tx, 'SELECT code FROM ref.permissions');
    for (const p of perms) {
      await tx.query(`INSERT INTO iam.role_permissions (tenant_id, role_id, permission_code) VALUES ($1, $2, $3)`,
        [tenantId, role.id, p.code]);
    }
    const admin = await insertUser(tx, input.admin);
    await insertAssignment(tx, { userId: admin.id, roleId: role.id, scopeUnitId: root.id });
    // Default: partner activation needs one approval by anyone holding mdm.party.approve
    // over the owning unit. Tenants replace this with their own approval matrix.
    await tx.query(`INSERT INTO iam.roles (tenant_id, code, name, is_system) VALUES ($1, 'MDM_STEWARD', 'Master data steward', true)`, [tenantId]);
    await insertDefinition(tx, {
      code: PARTY_WORKFLOW, name: 'Customer and supplier activation', entityType: 'mdm.party',
      definition: { approvalPermission: 'mdm.party.approve', steps: [{ key: 'steward', name: 'Master data steward', approvers: [{ type: 'role', role: 'MDM_STEWARD' }, { type: 'role', role: 'TENANT_ADMIN' }] }] },
    });
    return { tenantId, rootUnitId: root.id, adminUserId: admin.id };
  });
}
