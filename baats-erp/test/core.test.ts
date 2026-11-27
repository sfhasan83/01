import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { one } from '../src/core/db.ts';
import { ConflictError, ForbiddenError, UnauthenticatedError, ValidationError } from '../src/core/errors.ts';
import * as org from '../src/org/service.ts';
import * as iam from '../src/iam/service.ts';
import * as auth from '../src/iam/auth.ts';
import { decide } from '../src/iam/authz.ts';
import { totp } from '../src/iam/crypto.ts';
import { queryAudit, verifyChain } from '../src/audit/service.ts';
import { createTestDb, giveRole, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

let t: TestDb;
let a: Seed;
let b: Seed;

before(async () => {
  t = await createTestDb();
  a = await seedOrg(t.db);
  b = await seedOrg(t.db);
});
after(async () => { await t.drop(); });

describe('tenant isolation', () => {
  it('only shows rows of the current tenant', async () => {
    const seen = await t.db.withTenant(a.adminCtx, (tx) => tx.query('SELECT tenant_id FROM org.employees'));
    assert.equal(seen.rows.length, 7);
    assert.ok(seen.rows.every((r) => r.tenant_id === a.tenantId));
  });
  it('shows nothing without a tenant context', async () => {
    const c = await t.db.pool.connect();
    try {
      assert.equal((await c.query('SELECT * FROM org.units')).rows.length, 0);
      assert.equal((await c.query('SELECT * FROM platform.tenants')).rows.length, 0);
    } finally { c.release(); }
  });
  it('rejects writing rows into another tenant', async () => {
    await assert.rejects(t.db.withTenant(a.adminCtx, (tx) =>
      tx.query(`INSERT INTO org.designations (tenant_id, code, title) VALUES ($1, 'X', 'X')`, [b.tenantId])));
  });
  it('cannot reference another tenant’s records', async () => {
    // Tenant A tries to place an employee in tenant B's unit.
    await assert.rejects(t.db.withTenant(a.adminCtx, (tx) =>
      org.createEmployee(tx, a.adminCtx, { employeeNo: 'X1', firstName: 'X', lastName: 'Y', unitId: b.units.sales })), ForbiddenError);
    await assert.rejects(t.db.withTenant(a.adminCtx, (tx) =>
      tx.query(`INSERT INTO org.employees (tenant_id, employee_no, first_name, last_name, unit_id) VALUES (app.tenant(), 'X2', 'X', 'Y', $1)`, [b.units.sales])));
  });
  it('a session token only works for its own tenant', async () => {
    const s = await auth.login(t.db, { tenant: a.code, email: `admin@${a.code}.test`, password: PASSWORD });
    const forged = `${b.tenantId}.${s.token.split('.')[1]}`;
    await assert.rejects(auth.authenticate(t.db, forged), UnauthenticatedError);
  });
});

describe('organization hierarchy', () => {
  it('computes materialized paths', async () => {
    const units = await t.db.withTenant(a.adminCtx, (tx) => org.listUnits(tx, a.adminCtx));
    const finance = units.find((u) => u.code === 'DXB-FIN');
    assert.equal(finance.depth, 3);
    assert.deepEqual(units.map((u) => u.code).slice(0, 1), [a.code.toUpperCase()]);
  });
  it('enforces level order (a company cannot sit under a department)', async () => {
    await assert.rejects(t.db.withTenant(a.adminCtx, (tx) =>
      org.createUnit(tx, a.adminCtx, { typeCode: 'company', parentId: a.units.sales, code: 'BAD', name: 'Bad' })), ValidationError);
  });
  it('lets tenants add their own levels', async () => {
    await t.db.withTenant(a.adminCtx, async (tx) => {
      await org.createUnitType(tx, a.adminCtx, { code: 'squad', name: 'Squad', rank: 95 });
      const u = await org.createUnit(tx, a.adminCtx, { typeCode: 'squad', parentId: a.units.sales, code: 'SQ1', name: 'Squad 1' });
      assert.equal(u.depth, 4);
    });
  });
  it('moves a subtree and rejects cycles', async () => {
    await t.db.withTenant(a.adminCtx, async (tx) => {
      const ops = await org.createUnit(tx, a.adminCtx, { typeCode: 'division', parentId: a.units.dubai, code: 'OPS', name: 'Ops' });
      const team = await org.createUnit(tx, a.adminCtx, { typeCode: 'team', parentId: ops.id, code: 'OPS-T', name: 'Ops team' });
      await org.moveUnit(tx, a.adminCtx, ops.id, a.units.uk);
      const moved = await one(tx, 'SELECT path, depth FROM org.units WHERE id = $1', [team.id]);
      assert.ok(moved.path.startsWith(`/${a.units.root}/${a.units.uk}/${ops.id}/`));
      assert.equal(moved.depth, 3);
    });
    await assert.rejects(t.db.withTenant(a.adminCtx, (tx) => org.moveUnit(tx, a.adminCtx, a.units.uae, a.units.finance)), ValidationError);
  });
  it('rejects reporting-line cycles', async () => {
    await assert.rejects(t.db.withTenant(a.adminCtx, (tx) =>
      org.updateEmployee(tx, a.adminCtx, a.people.ceo.employeeId, { managerId: a.people.accountant.employeeId })), /cycle/);
  });
  it('walks the reporting line', async () => {
    const chain = await t.db.withTenant(a.adminCtx, (tx) => org.managerChain(tx, a.people.accountant.employeeId));
    assert.deepEqual(chain.map((c) => c.user_id), [a.people.finMgr.userId, a.people.cfo.userId, a.people.ceo.userId]);
  });
});

describe('access control', () => {
  before(async () => {
    // Sales head manages employees in Sales only; Finance manager reads parties in all of Dubai up to 50k.
    await giveRole(t.db, a, a.people.salesHead.userId, 'SALES_HR', { 'org.employee.read': {}, 'org.employee.manage': {} }, a.units.sales);
    await giveRole(t.db, a, a.people.finMgr.userId, 'FIN_LIMITED', { 'mdm.party.approve': { credit_limit: { lte: 50000 } } }, a.units.dubai);
  });

  it('scopes grants to an org subtree', async () => {
    const ctx = a.ctxOf(a.people.salesHead.userId);
    const staff = await t.db.withTenant(ctx, (tx) => org.listEmployees(tx, ctx));
    assert.deepEqual(staff.map((e) => e.employee_no).sort(), ['E005', 'E006']);
    await assert.rejects(t.db.withTenant(ctx, (tx) =>
      org.createEmployee(tx, ctx, { employeeNo: 'F9', firstName: 'X', lastName: 'Y', unitId: a.units.finance })), ForbiddenError);
    await t.db.withTenant(ctx, (tx) => org.createEmployee(tx, ctx, { employeeNo: 'S9', firstName: 'New', lastName: 'Rep', unitId: a.units.sales }));
  });

  it('applies attribute conditions (approval limits)', async () => {
    await t.db.withTenant(a.adminCtx, async (tx) => {
      const u = a.people.finMgr.userId;
      assert.equal((await decide(tx, u, 'mdm.party.approve', { unitId: a.units.sales, attrs: { credit_limit: 50000 } })).allowed, true);
      const over = await decide(tx, u, 'mdm.party.approve', { unitId: a.units.sales, attrs: { credit_limit: 50001 } });
      assert.equal(over.allowed, false);
      assert.match(over.reason, /conditions/);
      assert.equal((await decide(tx, u, 'mdm.party.approve', { unitId: a.units.uk, attrs: { credit_limit: 1 } })).allowed, false);
    });
  });

  it('honours validity windows on assignments', async () => {
    await t.db.withTenant(a.adminCtx, async (tx) => {
      const role = await iam.createRole(tx, a.adminCtx, { code: 'TEMP', name: 'Temp' });
      await iam.grantPermission(tx, a.adminCtx, role.id, 'audit.read');
      await iam.assignRole(tx, a.adminCtx, { userId: a.people.accountant.userId, roleId: role.id, scopeUnitId: a.units.root, validTo: '2020-01-01T00:00:00Z', validFrom: '2019-01-01T00:00:00Z' });
      assert.equal((await decide(tx, a.people.accountant.userId, 'audit.read')).allowed, false);
    });
  });

  it('enforces segregation of duties', async () => {
    const r = await t.db.withTenant(a.adminCtx, (tx) =>
      iam.createSodRule(tx, a.adminCtx, { name: 'Create vs approve partners', permissionA: 'mdm.party.manage', permissionB: 'mdm.party.approve' }));
    // The tenant administrator holds everything, so it is reported as an existing conflict.
    assert.deepEqual(r.existingViolations.map((v) => v.user_id), [a.adminUserId]);
    // finMgr already approves partners, so giving them partner creation must fail.
    await assert.rejects(giveRole(t.db, a, a.people.finMgr.userId, 'PARTY_CLERK', { 'mdm.party.manage': {} }, a.units.dubai), ConflictError);
    // And adding approve to a role a clerk holds must fail too.
    await giveRole(t.db, a, a.people.salesRep.userId, 'PARTY_CLERK', { 'mdm.party.manage': {} }, a.units.sales);
    await assert.rejects(t.db.withTenant(a.adminCtx, async (tx) => {
      const r = await one(tx, `SELECT id FROM iam.roles WHERE code = 'PARTY_CLERK'`);
      await iam.grantPermission(tx, a.adminCtx, r.id, 'mdm.party.approve');
    }), ConflictError);
  });

  it('prevents users from granting themselves roles', async () => {
    await t.db.withTenant(a.adminCtx, async (tx) => {
      const r = await one(tx, `SELECT id FROM iam.roles WHERE code = 'TENANT_ADMIN'`);
      await assert.rejects(iam.assignRole(tx, a.adminCtx, { userId: a.adminUserId, roleId: r.id, scopeUnitId: a.units.uk }), ValidationError);
    });
  });

  it('records access denials in the audit trail', async () => {
    const ctx = a.ctxOf(a.people.salesRep.userId);
    await assert.rejects(t.db.withTenant(ctx, (tx) => iam.listUsers(tx, ctx)), ForbiddenError);
    const denials = await t.db.withTenant(a.adminCtx, (tx) => queryAudit(tx, a.adminCtx, { category: 'security', actorUserId: ctx.userId! }));
    assert.equal(denials[0].action, 'access_denied');
    assert.equal(denials[0].entity_id, 'iam.user.read');
  });
});

describe('authentication', () => {
  it('logs in and authenticates the session', async () => {
    const s = await auth.login(t.db, { tenant: a.code, email: `CEO@${a.code}.test`, password: PASSWORD });
    const ctx = await auth.authenticate(t.db, s.token);
    assert.deepEqual(ctx, { tenantId: a.tenantId, userId: a.people.ceo.userId });
  });
  it('does not reveal whether a tenant or user exists', async () => {
    await assert.rejects(auth.login(t.db, { tenant: 'nope', email: 'x@y.z', password: PASSWORD }), /invalid credentials/);
    await assert.rejects(auth.login(t.db, { tenant: a.code, email: 'ghost@x.test', password: PASSWORD }), /invalid credentials/);
  });
  it('locks the account after repeated failures and audits each attempt', async () => {
    const email = `ukstaff@${a.code}.test`;
    for (let i = 0; i < 5; i++) await assert.rejects(auth.login(t.db, { tenant: a.code, email, password: 'Wrong-password-1' }));
    await assert.rejects(auth.login(t.db, { tenant: a.code, email, password: PASSWORD }), /locked/);
    const events = await t.db.withTenant(a.adminCtx, (tx) => queryAudit(tx, a.adminCtx, { category: 'security', entityId: a.people.ukStaff.userId }));
    assert.equal(events.filter((e) => e.action === 'login_failed').length, 5);
    assert.equal(events[0].action, 'login_blocked');
  });
  it('enforces TOTP once MFA is enrolled', async () => {
    const ctx = a.ctxOf(a.people.cfo.userId);
    const { secret } = await t.db.withTenant(ctx, (tx) => auth.beginMfaEnrolment(tx, ctx));
    await assert.rejects(t.db.withTenant(ctx, (tx) => auth.confirmMfaEnrolment(tx, ctx, '000000')), ValidationError);
    await t.db.withTenant(ctx, (tx) => auth.confirmMfaEnrolment(tx, ctx, totp(secret)));
    const email = `cfo@${a.code}.test`;
    await assert.rejects(auth.login(t.db, { tenant: a.code, email, password: PASSWORD }), UnauthenticatedError);
    const s = await auth.login(t.db, { tenant: a.code, email, password: PASSWORD, totp: totp(secret) });
    assert.ok(s.token);
  });
  it('revokes sessions immediately when a user is disabled', async () => {
    const s = await auth.login(t.db, { tenant: a.code, email: `accountant@${a.code}.test`, password: PASSWORD });
    await t.db.withTenant(a.adminCtx, (tx) => iam.setUserStatus(tx, a.adminCtx, a.people.accountant.userId, 'disabled'));
    await assert.rejects(auth.authenticate(t.db, s.token), UnauthenticatedError);
    await t.db.withTenant(a.adminCtx, (tx) => iam.setUserStatus(tx, a.adminCtx, a.people.accountant.userId, 'active'));
  });
  it('logout ends the session', async () => {
    const s = await auth.login(t.db, { tenant: a.code, email: `saleshead@${a.code}.test`, password: PASSWORD });
    await auth.logout(t.db, s.token);
    await assert.rejects(auth.authenticate(t.db, s.token), UnauthenticatedError);
  });
});

describe('audit trail', () => {
  it('captures data changes with before and after, without secrets', async () => {
    const rows = await t.db.withTenant(a.adminCtx, (tx) => queryAudit(tx, a.adminCtx, { entityType: 'iam.users', category: 'data' }));
    assert.ok(rows.length >= 8);
    assert.ok(rows.every((r) => !('password_hash' in (r.after ?? {})) && !('mfa_secret' in (r.after ?? {}))));
    const update = rows.find((r) => r.action === 'update' && r.after.status === 'disabled');
    assert.equal(update.before.status, 'active');
    assert.equal(update.actor_user_id, a.adminUserId);
  });
  it('is read-only to the application', async () => {
    await assert.rejects(t.db.withTenant(a.adminCtx, (tx) => tx.query(`DELETE FROM audit.entries`)), /permission denied/);
    await assert.rejects(t.db.withTenant(a.adminCtx, (tx) =>
      tx.query(`INSERT INTO audit.entries VALUES (app.tenant(), 999999, now(), NULL, 'data', 'x', 'x', NULL, NULL, NULL, '', '')`)), /permission denied/);
  });
  it('keeps a verifiable hash chain per tenant', async () => {
    const ra = await t.db.withTenant(a.adminCtx, (tx) => verifyChain(tx, a.adminCtx));
    const rb = await t.db.withTenant(b.adminCtx, (tx) => verifyChain(tx, b.adminCtx));
    assert.equal(ra.valid, true);
    assert.equal(rb.valid, true);
    assert.ok(ra.entries > 50);
  });
  it('detects tampering, even by a database superuser', async () => {
    const owner = new pg.Client({ connectionString: t.ownerUrl });
    await owner.connect();
    try {
      await owner.query('ALTER TABLE audit.entries DISABLE TRIGGER entries_immutable');
      await owner.query(`UPDATE audit.entries SET after = jsonb_set(after, '{name}', '"Hacked"') WHERE tenant_id = $1 AND seq = 3`, [b.tenantId]);
      await owner.query('ALTER TABLE audit.entries ENABLE TRIGGER entries_immutable');
    } finally { await owner.end(); }
    const r = await t.db.withTenant(b.adminCtx, (tx) => verifyChain(tx, b.adminCtx));
    assert.deepEqual(r, { entries: 2, valid: false, firstBrokenSeq: 3 });
  });
});

describe('concurrency', () => {
  it('signing in does not block a workflow task being assigned to the same user', async () => {
    // A login locks the user's row; it must not conflict with the key-share lock a foreign key check takes.
    const owner = new pg.Client({ connectionString: t.ownerUrl });
    await owner.connect();
    try {
      await t.db.withTenant(a.adminCtx, async (tx) => {
        await tx.query(`SELECT 1 FROM iam.users WHERE id = $1 FOR NO KEY UPDATE`, [a.adminUserId]);
        await owner.query('SET lock_timeout = 2000');
        await owner.query('BEGIN');
        await owner.query(`SELECT 1 FROM iam.users WHERE id = $1 FOR KEY SHARE`, [a.adminUserId]);
        await owner.query('ROLLBACK');
      });
    } finally { await owner.end(); }
  });

  it('runs a transaction again after a deadlock, and gives up after three tries', async () => {
    let n = 0;
    const r = await t.db.withTenant(a.adminCtx, async () => { n++; if (n < 3) throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); return 'ok'; });
    assert.deepEqual([r, n], ['ok', 3]);
    n = 0;
    await assert.rejects(t.db.withTenant(a.adminCtx, async () => { n++; throw Object.assign(new Error('deadlock detected'), { code: '40P01' }); }), /deadlock/);
    assert.equal(n, 3);
  });
});
