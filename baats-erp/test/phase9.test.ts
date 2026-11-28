import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { many, one, type Ctx } from '../src/core/db.ts';
import * as setup from '../src/fin/setup.ts';
import * as iam from '../src/iam/service.ts';
import * as mig from '../src/mig/import.ts';
import * as billing from '../src/platform/billing.ts';
import { onboardTenant } from '../src/platform/onboarding.ts';
import { backupDatabase, isEncrypted, readBackupHeader, verifyBackup } from '../src/platform/backup.ts';
import { buildServer } from '../src/api/server.ts';
import { ADMIN_URL, createTestDb, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

/**
 * Phase 7b: subscriptions and billing, read-only when inactive, monitoring,
 * encrypted backups and restore drills, imports of fixed assets and open orders.
 */

let t: TestDb;
let s: Seed;
let admin: Ctx;
let co: string;
const AS_OF = '2026-01-01';
const KEY = 'platform-key-for-tests-0123456789';
const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);
const imp = (kind: mig.ImportKind, csv: string, dryRun = false) => tx(admin, (q) => mig.runImport(q, admin, { kind, companyId: co, asOf: AS_OF, csv, dryRun }));
const urlFor = (name: string) => { const u = new URL(ADMIN_URL); u.pathname = `/${name}`; return u.toString(); };
const migrationsDir = new URL('../db/migrations/', import.meta.url).pathname;

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  admin = s.adminCtx;
  co = s.units.uae;
  await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: co, legalName: 'Acme UAE LLC', openFrom: AS_OF }));
});
after(async () => { await t.drop(); });

describe('subscriptions', () => {
  let app: ReturnType<typeof buildServer>;
  let trial: { tenantId: string; adminUserId: string; rootUnitId: string };
  let trialCtx: Ctx;
  const op = (method: string, url: string, payload?: unknown) => app.inject({ method: method as any, url, payload: payload as any, headers: { 'x-platform-admin-key': KEY } });
  const login = async () => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: 'trial-co', email: 'boss@trial.test', password: PASSWORD } })).json().token;
  before(async () => {
    app = buildServer({ db: t.db, platformAdminKey: KEY, metricsToken: 'metrics-token-0123456789' });
    trial = await onboardTenant(t.db, { code: 'trial-co', name: 'Trial Co', baseCurrency: 'AED', countryCode: 'AE', admin: { email: 'boss@trial.test', displayName: 'Boss', password: PASSWORD } });
    trialCtx = { tenantId: trial.tenantId, userId: trial.adminUserId };
  });

  it('starts a new organization on a 30-day trial with the trial limits', async () => {
    const st = await tx(trialCtx, (q) => billing.subscriptionState(q));
    assert.equal(st!.plan.code, 'TRIAL');
    assert.equal(st!.status, 'trial');
    assert.equal(st!.writable, true);
    assert.ok(Math.abs(Date.parse(st!.trialEndsAt!) - Date.now() - 30 * 86_400_000) < 60_000);
    // Five active users at most: the administrator and four more.
    for (let i = 1; i <= 4; i++) await tx(trialCtx, (q) => iam.createUser(q, trialCtx, { email: `u${i}@trial.test`, displayName: `U${i}`, password: PASSWORD }));
    await assert.rejects(tx(trialCtx, (q) => iam.createUser(q, trialCtx, { email: 'u5@trial.test', displayName: 'U5', password: PASSWORD })), /allows 5 active users/);
    // Disabling one frees a seat; enabling it again needs one.
    const u1 = await tx(trialCtx, (q) => one(q, `SELECT id FROM iam.users WHERE email = 'u1@trial.test'`));
    await tx(trialCtx, (q) => iam.setUserStatus(q, trialCtx, u1.id, 'disabled'));
    await tx(trialCtx, (q) => iam.createUser(q, trialCtx, { email: 'u5@trial.test', displayName: 'U5', password: PASSWORD }));
    await assert.rejects(tx(trialCtx, (q) => iam.setUserStatus(q, trialCtx, u1.id, 'active')), /allows 5 active users/);
    // The organization sees its own subscription; the existing ones are on the on-premises licence.
    const me = (await app.inject({ method: 'GET', url: '/v1/subscription', headers: { authorization: `Bearer ${await login()}` } })).json();
    assert.equal(me.plan.code, 'TRIAL');
    assert.equal(me.usage.users, 5);
    assert.ok(me.plans.some((p: any) => p.code === 'BUSINESS'));
    assert.equal((await tx(admin, (q) => billing.subscriptionState(q)))!.plan.code, 'ONPREM');
  });

  it('keeps the data readable but stops changes once the trial has ended', async () => {
    const token = await login();
    const h = { authorization: `Bearer ${token}` };
    assert.equal((await op('PATCH', `/v1/platform/tenants/${trial.tenantId}/subscription`, { trialEndsAt: '2026-01-31' })).statusCode, 200);
    const r = await app.inject({ method: 'POST', url: '/v1/org/units', headers: h, payload: { typeCode: 'department', parentId: trial.rootUnitId, code: 'X1', name: 'X' } });
    assert.equal(r.statusCode, 402);
    assert.match(r.json().message, /free trial ended on 2026-01-31/);
    assert.equal((await app.inject({ method: 'GET', url: '/v1/org/units', headers: h })).statusCode, 200);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/iam/check', headers: h, payload: { permission: 'org.unit.manage' } })).statusCode, 200);
    // Choosing a paid plan opens it again.
    const p = await op('PATCH', `/v1/platform/tenants/${trial.tenantId}/subscription`, { plan: 'STARTER' });
    assert.equal(p.json().status, 'active');
    assert.equal((await app.inject({ method: 'POST', url: '/v1/org/units', headers: h, payload: { typeCode: 'department', parentId: trial.rootUnitId, code: 'X1', name: 'X' } })).statusCode, 201);
  });

  it('bills each month once, follows unpaid invoices to suspension and back', async () => {
    const run = await op('POST', '/v1/platform/billing/run', { period: '2026-10' });
    assert.equal(run.statusCode, 200);
    const mine = run.json().invoices.filter((i: any) => i.tenant === 'trial-co');
    assert.equal(mine.length, 1);
    // STARTER: 750 a month with 10 users included; 5 are active, so no extra users.
    assert.equal(mine[0].total, 750);
    assert.equal(mine[0].extra_users, 0);
    assert.match(mine[0].no, /^BAATS-202610-\d{5}$/);
    // The on-premises tenant is never billed, and a month is billed once.
    assert.ok(!run.json().invoices.some((i: any) => i.tenant === s.code));
    assert.equal((await op('POST', '/v1/platform/billing/run', { period: '2026-10' })).json().invoices.length, 0);
    assert.equal((await op('POST', '/v1/platform/billing/run', { period: '2099-01' })).statusCode, 422);
    // Overdue: past due at once, suspended after the grace period.
    const due = mine[0].due_on.slice(0, 10);
    const later = (days: number) => new Date(Date.parse(due) + days * 86_400_000).toISOString().slice(0, 10);
    assert.deepEqual(await billing.sweepSubscriptions(t.db, later(1)), [{ tenant: 'trial-co', status: 'past_due' }]);
    assert.equal((await tx(trialCtx, (q) => billing.subscriptionState(q)))!.writable, true);
    assert.deepEqual(await billing.sweepSubscriptions(t.db, later(billing.GRACE_DAYS + 1)), [{ tenant: 'trial-co', status: 'suspended' }]);
    const st = (await tx(trialCtx, (q) => billing.subscriptionState(q)))!;
    assert.equal(st.writable, false);
    assert.match(st.reason!, /invoice from BAATS is unpaid/);
    const list = (await op('GET', '/v1/platform/tenants')).json();
    assert.equal(list.find((x: any) => x.code === 'trial-co').owed, 750);
    // Paid: active again.
    const paid = await op('POST', `/v1/platform/tenants/${trial.tenantId}/invoices/${mine[0].id}/settle`, { action: 'paid', reference: 'TT-123' });
    assert.equal(paid.statusCode, 200);
    assert.equal(paid.json().status, 'paid');
    assert.equal(paid.json().subscription.status, 'active');
    // An operator's suspension is not lifted by a payment.
    await op('PATCH', `/v1/platform/tenants/${trial.tenantId}/subscription`, { status: 'suspended' });
    assert.deepEqual(await billing.sweepSubscriptions(t.db, later(40)), []);
    assert.match((await tx(trialCtx, (q) => billing.subscriptionState(q)))!.reason!, /contact BAATS/);
    await op('PATCH', `/v1/platform/tenants/${trial.tenantId}/subscription`, { status: 'active' });
  });

  it('counts users above the plan, and lets the operator change plans within limits', async () => {
    const plan = await op('PUT', '/v1/platform/plans/TINY', { name: 'Tiny', monthlyPrice: 100, currency: 'AED', includedUsers: 2, extraUserPrice: 10, maxUsers: 10 });
    assert.equal(plan.statusCode, 200);
    assert.equal(plan.json().max_users, 10);
    assert.equal((await op('PATCH', `/v1/platform/tenants/${trial.tenantId}/subscription`, { plan: 'TINY' })).statusCode, 200);
    const inv = (await op('POST', '/v1/platform/billing/run', { period: '2026-11' })).json().invoices.find((i: any) => i.tenant === 'trial-co');
    assert.equal(inv.extra_users, 3);
    assert.equal(inv.total, 130);
    await op('PUT', '/v1/platform/plans/MICRO', { name: 'Micro', monthlyPrice: 10, currency: 'AED', includedUsers: 1, maxUsers: 2 });
    const r = await op('PATCH', `/v1/platform/tenants/${trial.tenantId}/subscription`, { plan: 'MICRO' });
    assert.equal(r.statusCode, 422);
    assert.match(r.json().message, /5 users are active but the Micro plan allows 2/);
  });

  it('needs the platform key for every operator route', async () => {
    for (const [m, u] of [['GET', '/v1/platform/plans'], ['GET', '/v1/platform/tenants'], ['POST', '/v1/platform/billing/run'], ['GET', '/v1/platform/billing/invoices'], ['POST', '/v1/platform/billing/sweep']]) {
      assert.equal((await app.inject({ method: m as any, url: u, payload: m === 'POST' ? { period: '2026-10' } : undefined })).statusCode, 401, u);
      assert.equal((await app.inject({ method: m as any, url: u, payload: m === 'POST' ? { period: '2026-10' } : undefined, headers: { 'x-platform-admin-key': 'wrong' } })).statusCode, 401, u);
    }
    // A tenant's own administrator cannot reach them with a session either.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/platform/tenants', headers: { authorization: `Bearer ${await login()}` } })).statusCode, 401);
  });

  it('serves metrics to the monitoring token only, and a deep health check', async () => {
    assert.equal((await app.inject({ method: 'GET', url: '/metrics' })).statusCode, 401);
    assert.equal((await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer nope' } })).statusCode, 401);
    const m = await app.inject({ method: 'GET', url: '/metrics', headers: { authorization: 'Bearer metrics-token-0123456789' } });
    assert.equal(m.statusCode, 200);
    assert.match(m.body, /baats_http_requests_total\{method="POST",route="\/v1\/org\/units",status="4xx"\} 1/);
    assert.match(m.body, /baats_http_request_duration_seconds_bucket\{method="GET",route="\/v1\/subscription",le="\+Inf"\} 1/);
    assert.match(m.body, /baats_db_up 1/);
    assert.deepEqual((await app.inject({ method: 'GET', url: '/health?deep=1' })).json(), { ok: true, database: 'up' });
  });
});

describe('encrypted backups and restore drills', () => {
  const dir = mkdtempSync(join(tmpdir(), 'baats-bk9-'));
  const PASS = 'correct horse battery staple';

  it('encrypts a backup so that it cannot be read without the passphrase', async () => {
    const file = join(dir, 'enc.baatsbak');
    const r = await backupDatabase(t.ownerUrl, file, 'test', { passphrase: PASS });
    assert.equal(r.encrypted, true);
    assert.equal(isEncrypted(file), true);
    const bytes = readFileSync(file);
    assert.equal(bytes.includes(Buffer.from('fin.journal_lines')), false);
    await assert.rejects(readBackupHeader(file), /encrypted; give its passphrase/);
    await assert.rejects(readBackupHeader(file, 'the wrong passphrase'), /passphrase is wrong/);
    assert.ok((await readBackupHeader(file, PASS)).migrations.includes('015_operations.sql'));
    await assert.rejects(backupDatabase(t.ownerUrl, join(dir, 'x'), 'test', { passphrase: 'short' }), /at least 12/);
  });

  it('proves a backup restores: every audit chain intact and every journal balanced, without touching the live database', async () => {
    const file = join(dir, 'enc.baatsbak');
    const r = await verifyBackup({ adminUrl: ADMIN_URL, urlFor, database: t.name, file, migrationsDir, passphrase: PASS });
    assert.equal(r.ok, true, JSON.stringify(r.problems));
    const me = r.tenants.find((x) => x.code === s.code)!;
    assert.ok(me.auditEntries > 50);
    assert.equal(me.auditChainOk, true);
    assert.equal(me.unbalancedJournals, 0);
    // The scratch database is gone again.
    const pg = (await import('pg')).default;
    const c = new pg.Client({ connectionString: ADMIN_URL }); await c.connect();
    assert.equal((await c.query(`SELECT count(*)::int AS n FROM pg_database WHERE datname LIKE $1`, [`${t.name}_drill_%`])).rows[0].n, 0);
    await c.end();
  });

  it('fails a drill on a backup that was changed', async () => {
    const file = join(dir, 'enc.baatsbak'), bad = join(dir, 'bad.baatsbak');
    const b = readFileSync(file); b[Math.floor(b.length / 2)] ^= 0xff; writeFileSync(bad, b);
    await assert.rejects(verifyBackup({ adminUrl: ADMIN_URL, urlFor, database: t.name, file: bad, migrationsDir, passphrase: PASS }));
  });
});

describe('importing fixed assets and open orders', () => {
  before(async () => {
    await imp('suppliers', 'code,name\nS100,Gulf Steel\n');
    await imp('customers', 'code,name\nC100,Marina Retail\n');
    await imp('items', 'code,name,type,warehouse,opening_qty,unit_cost\nDESK,Desk,stock,MAIN,10,200\nFIT,Fitting service,service,,,\n');
  });

  it('registers fixed assets with their depreciation to date, and checks them against the trial balance', async () => {
    const bad = await imp('fixed_assets', 'code,name,category,acquired_on,useful_life_months,cost,depreciation_to_date\nFA1,Truck,Vehicles,2024-01-01,60,100000,120000\nFA2,Server,IT,2027-01-01,36,9000,0\n', true);
    assert.deepEqual(bad.errors.map((e) => e.row), [2, 3]);
    const r = await imp('fixed_assets', 'code,name,category,acquired_on,useful_life_months,cost,depreciation_to_date,cost_center\nFA1,Truck,Vehicles,2024-01-01,60,100000,40000,DXB-FIN\nFA2,Server,IT,2025-07-01,36,9000,1500,\n');
    assert.equal(r.saved, true);
    assert.equal(r.created, 2);
    assert.equal((await imp('fixed_assets', 'code,name,category,acquired_on,useful_life_months,cost\nFA1,Truck,Vehicles,2024-01-01,60,100000\n')).skipped, 1);
    const a = await tx(admin, (q) => one(q, `SELECT opening_accumulated::float AS acc, unit_id FROM fin.assets WHERE code = 'FA1'`));
    assert.equal(a.acc, 40000);
    assert.equal(a.unit_id, s.units.finance);
    // The trial balance must agree with the register: 1500 is 109,000 and 1590 is 41,500.
    const wrong = await imp('opening_balances', 'account,debit,credit\n1300,2000,\n1500,100000,\n1590,,41500\n3000,,60500\n', true);
    assert.match(wrong.errors[0].message, /1500 is 100000 here but the imported fixed assets come to 109000/);
    const ok = await imp('opening_balances', 'account,debit,credit\n1300,2000,\n1500,109000,\n1590,,41500\n3000,,69500\n', true);
    assert.deepEqual(ok.errors, []);
  });

  it('brings in open purchase orders as approved, and open sales orders as confirmed', async () => {
    const po = await imp('open_purchase_orders', 'supplier_code,number,date,item_code,description,quantity_open,unit_price\nS100,OLD-PO-7,2025-12-10,DESK,Desks,5,190\nS100,OLD-PO-7,2025-12-10,,Delivery,1,300\nS100,OLD-PO-8,2025-12-20,,Consulting,2,1000\n');
    assert.deepEqual(po.errors, []);
    assert.equal(po.created, 2);
    const orders = await tx(admin, (q) => many(q, `SELECT o.no, o.status, o.notes, o.net_total::float AS net, (SELECT count(*)::int FROM pur.order_lines l WHERE l.order_id = o.id) AS lines
                                                    FROM pur.orders o WHERE o.notes LIKE 'Imported%' ORDER BY o.notes`));
    assert.deepEqual(orders.map((o) => [o.status, o.notes, o.net, o.lines]), [['approved', 'Imported open order OLD-PO-7', 1250, 2], ['approved', 'Imported open order OLD-PO-8', 2000, 1]]);
    assert.ok(orders.every((o) => /^PO-/.test(o.no)));
    assert.equal((await imp('open_purchase_orders', 'supplier_code,number,date,description,quantity_open,unit_price\nS100,OLD-PO-8,2025-12-20,Consulting,2,1000\n')).skipped, 1);
    const mixed = await imp('open_purchase_orders', 'supplier_code,number,date,description,quantity_open,unit_price\nS100,X1,2025-12-20,A,1,10\nS999,X1,2025-12-20,B,1,10\n', true);
    assert.match(mixed.errors[0].message, /order X1: supplier_code differs from row 2/);
    const so = await imp('open_sales_orders', 'customer_code,number,date,item_code,description,quantity_open,unit_price,discount\nC100,SO-OLD-1,2025-12-28,DESK,Desks,3,450,10\nC100,SO-OLD-1,2025-12-28,FIT,Fitting,3,50,\n');
    assert.deepEqual(so.errors, []);
    const o = await tx(admin, (q) => one(q, `SELECT status, no, net_total::float AS net FROM sal.orders WHERE notes = 'Imported open order SO-OLD-1'`));
    assert.equal(o.status, 'confirmed');
    assert.match(o.no, /^SO-/);
    assert.equal(o.net, 1490); // the discount is an amount off the line
  });
});
