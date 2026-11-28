import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import type { Ctx } from '../src/core/db.ts';
import * as setup from '../src/fin/setup.ts';
import * as mig from '../src/mig/import.ts';
import { buildServer, ROUTES } from '../src/api/server.ts';
import { createTestDb, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

/**
 * Security self-tests, run with every change and ahead of an outside
 * penetration test: tenant isolation is enforced by the database for every
 * table, every route needs a session unless it is meant to be public, one
 * organization cannot reach another's records through the API, and the
 * application's database role cannot step around any of it.
 */

let t: TestDb;
let a: Seed, b: Seed;
let owner: pg.Client;

before(async () => {
  t = await createTestDb();
  a = await seedOrg(t.db);
  b = await seedOrg(t.db);
  owner = new pg.Client({ connectionString: t.ownerUrl });
  await owner.connect();
});
after(async () => { await owner.end(); await t.drop(); });

describe('the database', () => {
  it('isolates tenants in every table that holds tenant data, with row level security that even the table owner cannot skip', async () => {
    const rows = (await owner.query(`
      SELECT n.nspname || '.' || c.relname AS t, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
             (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::int AS policies
        FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p') AND NOT c.relispartition
         AND EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid AND x.attname = 'tenant_id' AND NOT x.attisdropped)`)).rows;
    assert.ok(rows.length > 120, `${rows.length} tables`);
    const open = rows.filter((r) => !r.rls || !r.forced || r.policies === 0).map((r) => r.t);
    assert.deepEqual(open, []);
  });

  it('has no other tables the application can write, apart from the platform list of plans', async () => {
    const rows = (await owner.query(`
      SELECT n.nspname || '.' || c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind IN ('r','p') AND NOT c.relispartition AND n.nspname NOT IN ('pg_catalog','information_schema','ref','public')
         AND NOT EXISTS (SELECT 1 FROM pg_attribute x WHERE x.attrelid = c.oid AND x.attname = 'tenant_id' AND NOT x.attisdropped)
         AND (has_table_privilege('baats_app', c.oid, 'INSERT') OR has_table_privilege('baats_app', c.oid, 'UPDATE') OR has_table_privilege('baats_app', c.oid, 'DELETE'))
       ORDER BY 1`)).rows.map((r) => r.t);
    // platform.tenants is keyed by id and has its own policy (each tenant sees only itself).
    assert.deepEqual(rows, ['platform.plans', 'platform.tenants']);
    const tenants = (await owner.query(`SELECT relrowsecurity AND relforcerowsecurity AS ok FROM pg_class WHERE oid = 'platform.tenants'::regclass`)).rows[0];
    assert.equal(tenants.ok, true);
  });

  it('runs the application as a role that is not a superuser, owns nothing and cannot bypass row security', async () => {
    const r = (await owner.query(`SELECT rolsuper, rolbypassrls, rolcreaterole, rolcreatedb FROM pg_roles WHERE rolname = 'baats_app'`)).rows[0];
    assert.deepEqual(r, { rolsuper: false, rolbypassrls: false, rolcreaterole: false, rolcreatedb: false });
    const owned = (await owner.query(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_roles r ON r.oid = c.relowner WHERE r.rolname = 'baats_app'`)).rows[0].n;
    assert.equal(owned, 0);
  });

  it('pins the search path of every function that runs with its owner\'s rights', async () => {
    const loose = (await owner.query(`
      SELECT n.nspname || '.' || p.proname AS f FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
       WHERE p.prosecdef AND n.nspname NOT IN ('pg_catalog','information_schema')
         AND NOT EXISTS (SELECT 1 FROM unnest(coalesce(p.proconfig, '{}')) c WHERE c LIKE 'search_path=%')`)).rows.map((r) => r.f);
    assert.deepEqual(loose, []);
  });

  it('makes the audit trail append-only for the application', async () => {
    const r = (await owner.query(`SELECT has_table_privilege('baats_app', 'audit.entries', 'UPDATE') AS u, has_table_privilege('baats_app', 'audit.entries', 'DELETE') AS d`)).rows[0];
    assert.deepEqual(r, { u: false, d: false });
  });
});

describe('the API', () => {
  let app: ReturnType<typeof buildServer>;
  const fake = '00000000-0000-4000-8000-000000000000';
  before(async () => { app = buildServer({ db: t.db, platformAdminKey: 'key-key-key-key-key-key-key-key-1' }); await app.ready(); });

  it('answers 401 on every route that is not meant to be public, without a session or with a forged one', async () => {
    const routes = ROUTES.get(app)!;
    const closed = routes.filter((r) => !r.public && !r.url.startsWith('/m'));
    assert.ok(closed.length > 300, `${closed.length} routes`);
    const leaks: string[] = [];
    for (const r of closed) {
      const url = r.url.replace(/:[A-Za-z]+/g, fake).replace(/\*$/, 'x');
      for (const authorization of [undefined, 'Bearer forged-token', `Bearer ${a.code}.bk_${'0'.repeat(40)}`]) {
        const res = await app.inject({ method: r.method as any, url, headers: authorization ? { authorization } : {}, payload: ['POST', 'PUT', 'PATCH'].includes(r.method) ? {} : undefined });
        if (res.statusCode !== 401) leaks.push(`${r.method} ${r.url} -> ${res.statusCode}${authorization ? ' with ' + authorization.slice(0, 20) : ''}`);
      }
    }
    assert.deepEqual(leaks, []);
  });

  it('lists exactly the public routes it is meant to have', () => {
    const pub = [...new Set(ROUTES.get(app)!.filter((r) => r.public).map((r) => `${r.method} ${r.url}`))].sort();
    const mobile = (r: string) => /^GET \/m(\/|$)/.test(r);
    assert.deepEqual(pub.filter((r) => !mobile(r)), [
      'GET /health', 'GET /metrics', 'GET /v1/auth/sso/callback', 'GET /v1/auth/sso/providers', 'GET /v1/auth/sso/start',
      'GET /v1/platform/billing/invoices', 'GET /v1/platform/plans', 'GET /v1/platform/tenants',
      'PATCH /v1/platform/tenants/:id/subscription', 'POST /v1/auth/login', 'POST /v1/pay/stripe/notice',
      'POST /v1/platform/billing/run', 'POST /v1/platform/billing/sweep', 'POST /v1/platform/tenants', 'POST /v1/platform/tenants/:tenant/invoices/:id/settle',
      'PUT /v1/platform/plans/:code',
    ]);
    // BAATS Mobile's own files (the app shell; every request it makes needs a session).
    assert.ok(pub.filter(mobile).length >= 5);
  });

  it('keeps one organization out of another\'s records, even with the right ids', async () => {
    const actx: Ctx = a.adminCtx;
    const co = a.units.uae;
    await t.db.withTenant(actx, async (q) => {
      await setup.setupCompany(q, actx, { unitId: co, legalName: 'A UAE', openFrom: '2026-01-01' });
      await mig.runImport(q, actx, { kind: 'customers', companyId: co, csv: 'code,name\nSECRET,Secret customer\n', asOf: '2026-01-01' });
    });
    const party = await t.db.withTenant(actx, async (q) => (await q.query(`SELECT id FROM mdm.parties WHERE code = 'SECRET'`)).rows[0].id);
    const login = async (s: Seed) => (await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `admin@${s.code}.test`, password: PASSWORD } })).json().token;
    const hb = { authorization: `Bearer ${await login(b)}` };
    const ha = { authorization: `Bearer ${await login(a)}` };
    assert.ok((await app.inject({ method: 'GET', url: '/v1/mdm/parties', headers: ha })).json().some((p: any) => p.code === 'SECRET'));
    const probes = [
      ['PATCH', `/v1/mdm/parties/${party}`], ['POST', `/v1/mdm/parties/${party}/block`], ['GET', `/v1/fin/companies/${co}/invoices`],
      ['GET', `/v1/fin/companies/${co}/accounts`], ['PATCH', `/v1/org/units/${co}`], ['GET', `/v1/mig/companies/${co}/imports`],
    ];
    for (const [m, u] of probes) {
      const r = await app.inject({ method: m as any, url: u, headers: hb, payload: m === 'PATCH' ? { name: 'Taken over' } : m === 'POST' ? { blocked: true } : undefined });
      assert.ok([403, 404, 422].includes(r.statusCode), `${m} ${u} -> ${r.statusCode} ${r.body.slice(0, 120)}`);
      assert.doesNotMatch(r.body, /Secret customer/);
    }
    const list = (await app.inject({ method: 'GET', url: '/v1/mdm/parties', headers: hb })).json();
    assert.ok(!list.some((p: any) => p.code === 'SECRET'));
    assert.equal((await t.db.withTenant(actx, async (q) => (await q.query(`SELECT name FROM mdm.parties WHERE id = $1`, [party])).rows[0].name)), 'Secret customer');
  });
});
