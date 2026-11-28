import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance } from 'fastify';
import { buildServer } from '../src/api/server.ts';
import { createTestDb, type TestDb } from './helpers.ts';

const KEY = 'platform-admin-key-for-tests';
const PW = 'Correct-Horse-9-Battery';
let t: TestDb;
let app: FastifyInstance;

async function call(method: string, url: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  const r = await app.inject({
    method: method as 'GET', url, payload: body as object,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
  });
  return { status: r.statusCode, body: r.body ? r.json() : null };
}

before(async () => {
  t = await createTestDb();
  app = buildServer({ db: t.db, platformAdminKey: KEY });
});
after(async () => { await app.close(); await t.drop(); });

describe('HTTP API end to end', () => {
  let admin: string;
  let root: string;

  it('onboards a tenant only with the platform key', async () => {
    const body = { code: 'gulf-co', name: 'Gulf Co', baseCurrency: 'AED', countryCode: 'AE', admin: { email: 'admin@gulf.test', displayName: 'Admin', password: PW } };
    assert.equal((await call('POST', '/v1/platform/tenants', undefined, body)).status, 401);
    assert.equal((await call('POST', '/v1/platform/tenants', undefined, body, { 'x-platform-admin-key': 'wrong-key-wrong-key-wrong-key-xx' })).status, 401);
    const r = await call('POST', '/v1/platform/tenants', undefined, body, { 'x-platform-admin-key': KEY });
    assert.equal(r.status, 201);
    root = r.body.rootUnitId;
    assert.equal((await call('POST', '/v1/platform/tenants', undefined, body, { 'x-platform-admin-key': KEY })).status, 409);
  });

  it('requires a valid session', async () => {
    assert.equal((await call('GET', '/v1/me')).status, 401);
    assert.equal((await call('GET', '/v1/me', 'garbage')).status, 401);
    assert.equal((await call('POST', '/v1/auth/login', undefined, { tenant: 'gulf-co', email: 'admin@gulf.test', password: 'nope' })).status, 401);
    const r = await call('POST', '/v1/auth/login', undefined, { tenant: 'gulf-co', email: 'admin@gulf.test', password: PW });
    assert.equal(r.status, 200);
    admin = r.body.token;
  });

  it('runs a full master-data approval through the API', async () => {
    const company = await call('POST', '/v1/org/units', admin, { typeCode: 'company', parentId: root, code: 'GC-AE', name: 'Gulf Co UAE', countryCode: 'AE' });
    assert.equal(company.status, 201);
    const dept = await call('POST', '/v1/org/units', admin, { typeCode: 'department', parentId: company.body.id, code: 'GC-PROC', name: 'Procurement' });
    assert.equal(dept.status, 201);

    // A buyer who can create suppliers, and a steward who approves them.
    const buyer = await call('POST', '/v1/iam/users', admin, { email: 'buyer@gulf.test', displayName: 'Buyer', password: PW });
    const steward = await call('POST', '/v1/iam/users', admin, { email: 'steward@gulf.test', displayName: 'Steward', password: PW });
    const role = await call('POST', '/v1/iam/roles', admin, { code: 'BUYER', name: 'Buyer' });
    assert.equal((await call('PUT', `/v1/iam/roles/${role.body.id}/permissions/mdm.party.manage`, admin, {})).status, 200);
    assert.equal((await call('POST', '/v1/iam/assignments', admin, { userId: buyer.body.id, roleId: role.body.id, scopeUnitId: dept.body.id })).status, 201);
    const roles = (await call('GET', '/v1/iam/roles', admin)).body;
    const stewardRole = roles.find((r: { code: string }) => r.code === 'MDM_STEWARD');
    await call('PUT', `/v1/iam/roles/${stewardRole.id}/permissions/mdm.party.approve`, admin, { conditions: { credit_limit: { lte: 1000000 } } });
    assert.equal((await call('POST', '/v1/iam/assignments', admin, { userId: steward.body.id, roleId: stewardRole.id, scopeUnitId: company.body.id })).status, 201);

    const buyerTok = (await call('POST', '/v1/auth/login', undefined, { tenant: 'gulf-co', email: 'buyer@gulf.test', password: PW })).body.token;
    const stewardTok = (await call('POST', '/v1/auth/login', undefined, { tenant: 'gulf-co', email: 'steward@gulf.test', password: PW })).body.token;

    // Buyer cannot read users and cannot create suppliers outside Procurement.
    assert.equal((await call('GET', '/v1/iam/users', buyerTok)).status, 403);
    assert.equal((await call('POST', '/v1/mdm/parties', buyerTok, { code: 'S0', name: 'X', isSupplier: true, countryCode: 'AE', ownerUnitId: company.body.id })).status, 403);

    const party = await call('POST', '/v1/mdm/parties', buyerTok, { code: 'S1', name: 'Emirates Steel LLC', isSupplier: true, countryCode: 'AE', taxRegistrationNo: '100123456700003', ownerUnitId: dept.body.id });
    assert.equal(party.status, 201);
    assert.equal(party.body.party.status, 'draft');
    assert.equal(party.body.party.currency_code, 'AED', 'currency defaults from the country');
    const dup = await call('POST', '/v1/mdm/parties', buyerTok, { code: 'S2', name: 'EMIRATES STEEL L.L.C.', isSupplier: true, countryCode: 'AE', ownerUnitId: dept.body.id });
    assert.equal(dup.body.possibleDuplicates[0].code, 'S1');
    assert.equal((await call('POST', '/v1/mdm/parties', buyerTok, { code: 'S3', name: 'Other', isSupplier: true, countryCode: 'AE', taxRegistrationNo: '100123456700003', ownerUnitId: dept.body.id })).status, 409);

    const inst = await call('POST', `/v1/mdm/parties/${party.body.party.id}/submit`, buyerTok);
    assert.equal(inst.status, 200);
    assert.equal(inst.body.status, 'pending');

    const me = (await call('GET', '/v1/me', stewardTok)).body;
    assert.equal(me.inbox.length, 1);
    assert.equal((await call('POST', `/v1/wf/tasks/${me.inbox[0].task_id}/approve`, buyerTok, {})).status, 403);
    const done = await call('POST', `/v1/wf/tasks/${me.inbox[0].task_id}/approve`, stewardTok, { comment: 'Licence checked' });
    assert.equal(done.status, 200);
    assert.equal(done.body.status, 'approved');

    const active = await call('GET', '/v1/mdm/parties?status=active', admin);
    assert.equal(active.status, 200, JSON.stringify(active.body));
    assert.deepEqual(active.body.map((p: { code: string }) => p.code), ['S1']);
    const history = await call('GET', `/v1/wf/instances/${inst.body.id}`, buyerTok);
    assert.equal(history.body.history.at(-1).action, 'approved');
  });

  it('validates input', async () => {
    assert.equal((await call('POST', '/v1/org/units', admin, { typeCode: 'team' })).status, 400);
    assert.equal((await call('POST', '/v1/org/units', admin, { typeCode: 'team', parentId: 'not-a-uuid', code: 'x', name: 'x' })).status, 400);
    const bad = await call('POST', '/v1/wf/definitions', admin, { code: 'x', name: 'x', entityType: 'x', definition: { steps: [] } });
    assert.equal(bad.status, 422);
    assert.ok(bad.body.details.length);
  });

  it('explains access decisions', async () => {
    const r = await call('POST', '/v1/iam/check', admin, { permission: 'mdm.party.approve', unitId: root, attrs: { credit_limit: 5 } });
    assert.equal(r.body.allowed, true);
    assert.equal(r.body.via.role, 'TENANT_ADMIN');
  });

  it('exposes a verifiable audit trail and logs out', async () => {
    const v = await call('GET', '/v1/audit/verify', admin);
    assert.equal(v.body.valid, true);
    const denials = await call('GET', '/v1/audit/entries?category=security', admin);
    assert.ok(denials.body.some((e: { action: string }) => e.action === 'access_denied'));
    assert.equal((await call('POST', '/v1/auth/logout', admin)).status, 204);
    assert.equal((await call('GET', '/v1/me', admin)).status, 401);
  });
});
