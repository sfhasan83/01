import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { Db, one, type Ctx, type Tx } from '../src/core/db.ts';
import { migrate } from '../src/core/migrate.ts';
import { onboardTenant } from '../src/platform/onboarding.ts';
import * as iam from '../src/iam/service.ts';
import * as org from '../src/org/service.ts';

/**
 * Each test file gets its own fresh database, migrated as the owner, and a Db
 * connected as the non-owner runtime role so row-level security is enforced
 * exactly as in production. Needs TEST_ADMIN_DATABASE_URL (see scripts/test-db.sh).
 */
export const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres@localhost:5433/postgres';
const APP_PASSWORD = 'test-app-password';

export interface TestDb { db: Db; ownerUrl: string; name: string; drop: () => Promise<void> }

export async function createTestDb(): Promise<TestDb> {
  const name = `baats_test_${randomBytes(4).toString('hex')}`;
  const admin = new pg.Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  const ownerUrl = withDb(ADMIN_URL, name);
  await migrate(ownerUrl, APP_PASSWORD);
  const appUrl = new URL(ownerUrl);
  appUrl.username = 'baats_app';
  appUrl.password = APP_PASSWORD;
  const db = new Db({ connectionString: appUrl.toString(), max: 5 });
  return {
    db, ownerUrl, name,
    drop: async () => {
      await db.close();
      const c = new pg.Client({ connectionString: ADMIN_URL });
      await c.connect();
      await c.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await c.end();
    },
  };
}

function withDb(url: string, name: string): string {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
}

export const PASSWORD = 'Correct-Horse-9-Battery';

/**
 * A small but realistic organization:
 *
 *   Acme Group (group)
 *   ├── Acme UAE (company, AE)
 *   │   └── Dubai (branch)
 *   │       ├── Finance (department)
 *   │       └── Sales (department)
 *   └── Acme UK (company, GB)
 *
 * Employees: CEO <- CFO <- Finance manager <- Accountant; CEO <- Sales head <- Sales rep.
 * Each has a user account. admin is the tenant administrator.
 */
export async function seedOrg(db: Db, code = `acme-${randomBytes(3).toString('hex')}`) {
  const t = await onboardTenant(db, {
    code, name: 'Acme Group', baseCurrency: 'AED', countryCode: 'AE',
    admin: { email: `admin@${code}.test`, displayName: 'Admin', password: PASSWORD },
  });
  const adminCtx: Ctx = { tenantId: t.tenantId, userId: t.adminUserId };
  const ids = await db.withTenant(adminCtx, async (tx) => {
    const unit = (typeCode: string, parentId: string, c: string, name: string, extra: Partial<org.UnitInput> = {}) =>
      org.createUnit(tx, adminCtx, { typeCode, parentId, code: c, name, ...extra });
    const uae = await unit('company', t.rootUnitId, 'AE01', 'Acme UAE', { countryCode: 'AE', currencyCode: 'AED' });
    const uk = await unit('company', t.rootUnitId, 'GB01', 'Acme UK', { countryCode: 'GB', currencyCode: 'GBP' });
    const dubai = await unit('branch', uae.id, 'DXB', 'Dubai');
    const finance = await unit('department', dubai.id, 'DXB-FIN', 'Finance', { isCostCenter: true });
    const sales = await unit('department', dubai.id, 'DXB-SAL', 'Sales', { isProfitCenter: true });

    const person = async (no: string, first: string, unitId: string, managerId?: string) => {
      const e = await org.createEmployee(tx, adminCtx, { employeeNo: no, firstName: first, lastName: 'Test', unitId, managerId });
      const u = await iam.createUser(tx, adminCtx, { email: `${first.toLowerCase()}@${code}.test`, displayName: first, password: PASSWORD, employeeId: e.id });
      return { employeeId: e.id as string, userId: u.id };
    };
    const ceo = await person('E001', 'Ceo', t.rootUnitId);
    const cfo = await person('E002', 'Cfo', finance.id, ceo.employeeId);
    const finMgr = await person('E003', 'Finmgr', finance.id, cfo.employeeId);
    const accountant = await person('E004', 'Accountant', finance.id, finMgr.employeeId);
    const salesHead = await person('E005', 'Saleshead', sales.id, ceo.employeeId);
    const salesRep = await person('E006', 'Salesrep', sales.id, salesHead.employeeId);
    const ukStaff = await person('E007', 'Ukstaff', uk.id, ceo.employeeId);
    return {
      units: { root: t.rootUnitId as string, uae: uae.id as string, uk: uk.id as string, dubai: dubai.id as string, finance: finance.id as string, sales: sales.id as string },
      people: { ceo, cfo, finMgr, accountant, salesHead, salesRep, ukStaff },
    };
  });
  const ctxOf = (userId: string): Ctx => ({ tenantId: t.tenantId, userId });
  return { ...t, code, adminCtx, ctxOf, ...ids };
}

export type Seed = Awaited<ReturnType<typeof seedOrg>>;

/** Create a role with the given grants and assign it to a user over a unit. */
export async function giveRole(db: Db, s: Seed, userId: string, roleCode: string, perms: Record<string, Record<string, unknown>>, scopeUnitId: string, includeDescendants = true) {
  return db.withTenant(s.adminCtx, async (tx) => {
    let role = await one(tx, 'SELECT * FROM iam.roles WHERE code = $1', [roleCode]);
    if (!role) role = await iam.createRole(tx, s.adminCtx, { code: roleCode, name: roleCode });
    for (const [p, cond] of Object.entries(perms)) await iam.grantPermission(tx, s.adminCtx, role.id, p, cond);
    await iam.insertAssignment(tx, { userId, roleId: role.id, scopeUnitId, includeDescendants });
    return role.id as string;
  });
}

export function inTenant<T>(db: Db, ctx: Ctx, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.withTenant(ctx, fn);
}
