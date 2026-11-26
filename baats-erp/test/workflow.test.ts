import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { one, type Ctx } from '../src/core/db.ts';
import { ConflictError, ForbiddenError, ValidationError } from '../src/core/errors.ts';
import * as mdm from '../src/mdm/service.ts';
import * as wf from '../src/workflow/engine.ts';
import * as iam from '../src/iam/service.ts';
import { createTestDb, giveRole, seedOrg, type Seed, type TestDb } from './helpers.ts';

let t: TestDb;
let s: Seed;
let rep: Ctx, head: Ctx, fin: Ctx, cfo: Ctx, ceo: Ctx, acct: Ctx;
let seq = 0;

/** The approval matrix used throughout: line manager endorses, then finance or the CFO by credit limit. */
const MATRIX: wf.WorkflowDef = {
  approvalPermission: 'mdm.party.approve',
  steps: [
    { key: 'manager', name: 'Line manager', approvers: [{ type: 'reporting_manager' }], endorseOnly: true,
      dueHours: 24, escalateTo: [{ type: 'reporting_manager', level: 2 }] },
    { key: 'finance', when: { credit_limit: { gt: 0, lte: 100000 } }, approvers: [{ type: 'role', role: 'FIN_MANAGER' }] },
    { key: 'cfo', when: { credit_limit: { gt: 100000 } }, approvers: [{ type: 'role', role: 'CFO' }] },
  ],
};

async function newParty(creditLimit: number, ctx = rep) {
  seq++;
  const { party } = await t.db.withTenant(ctx, (tx) => mdm.createParty(tx, ctx, {
    code: `C${seq}`, name: `Customer ${seq}`, isCustomer: true, countryCode: 'AE', creditLimit, ownerUnitId: s.units.sales,
  }));
  return party.id as string;
}
const submitParty = (id: string, ctx = rep) => t.db.withTenant(ctx, (tx) => mdm.submitParty(tx, ctx, id));
const inbox = (ctx: Ctx) => t.db.withTenant(ctx, (tx) => wf.inbox(tx, ctx));
async function taskFor(ctx: Ctx, instanceId: string): Promise<string> {
  const task = (await inbox(ctx)).find((x) => x.instance_id === instanceId);
  assert.ok(task, 'expected a task in the inbox');
  return task.task_id;
}
const approve = async (ctx: Ctx, instanceId: string, comment?: string) =>
  t.db.withTenant(ctx, async (tx) => wf.act(tx, ctx, await taskFor(ctx, instanceId), 'approve', comment));
const partyStatus = (id: string) => t.db.withTenant(s.adminCtx, async (tx) => (await one(tx, 'SELECT status FROM mdm.parties WHERE id = $1', [id])).status);
const publish = (code: string, definition: wf.WorkflowDef, entityType = 'mdm.party') =>
  t.db.withTenant(s.adminCtx, (tx) => wf.publishDefinition(tx, s.adminCtx, { code, name: code, entityType, definition }));

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  const p = s.people;
  [rep, head, fin, cfo, ceo, acct] = [p.salesRep, p.salesHead, p.finMgr, p.cfo, p.ceo, p.accountant].map((x) => s.ctxOf(x.userId));
  await giveRole(t.db, s, p.salesRep.userId, 'PARTY_CLERK', { 'mdm.party.manage': {}, 'mdm.party.read': {} }, s.units.sales);
  await giveRole(t.db, s, p.finMgr.userId, 'FIN_MANAGER', { 'mdm.party.approve': { credit_limit: { lte: 100000 } } }, s.units.dubai);
  await giveRole(t.db, s, p.cfo.userId, 'CFO', { 'mdm.party.approve': {} }, s.units.root);
  await publish(mdm.PARTY_WORKFLOW, MATRIX);
});
after(async () => { await t.drop(); });

describe('sequential and conditional routing', () => {
  it('a cash customer needs only the line manager', async () => {
    const id = await newParty(0);
    const inst = await submitParty(id);
    assert.equal(await partyStatus(id), 'pending_approval');
    await approve(head, inst.id);
    assert.equal(await partyStatus(id), 'active');
    const full = await t.db.withTenant(rep, (tx) => wf.getInstance(tx, rep, inst.id));
    assert.deepEqual(full.history.map((h) => h.action),
      ['submitted', 'step_started', 'approved_step', 'step_completed', 'step_skipped', 'step_skipped', 'approved']);
  });

  it('a 50k credit customer goes to the finance manager', async () => {
    const id = await newParty(50000);
    const inst = await submitParty(id);
    await approve(head, inst.id);
    assert.equal(await partyStatus(id), 'pending_approval');
    assert.equal((await inbox(cfo)).length, 0);
    await approve(fin, inst.id);
    assert.equal(await partyStatus(id), 'active');
  });

  it('a 500k credit customer skips finance and goes to the CFO', async () => {
    const id = await newParty(500000);
    const inst = await submitParty(id);
    await approve(head, inst.id);
    assert.equal((await inbox(fin)).filter((x) => x.instance_id === inst.id).length, 0);
    await approve(cfo, inst.id);
    assert.equal(await partyStatus(id), 'active');
  });
});

describe('controls', () => {
  it('enforces financial approval limits at the moment of approval', async () => {
    await publish('limit-check', { approvalPermission: 'mdm.party.approve', steps: [{ key: 'fin', approvers: [{ type: 'role', role: 'FIN_MANAGER' }] }] });
    const inst = await t.db.withTenant(rep, (tx) => wf.submit(tx, rep, {
      code: 'limit-check', entityType: 'mdm.party', entityId: 'manual-1', subjectUnitId: s.units.sales, payload: { credit_limit: 250000 } }));
    await assert.rejects(approve(fin, inst.id), (e: Error) => e instanceof ForbiddenError && /limit/.test(e.message));
  });

  it('maker-checker: the requester is never an approver', async () => {
    await publish('self-check', { steps: [{ key: 'cfo', approvers: [{ type: 'role', role: 'CFO' }] }] }, 'test.doc');
    await assert.rejects(t.db.withTenant(cfo, (tx) => wf.submit(tx, cfo, {
      code: 'self-check', entityType: 'test.doc', entityId: 'd1', subjectUnitId: s.units.finance })), /no eligible approver/);
  });

  it('only the assignee can act on a task', async () => {
    const id = await newParty(0);
    const inst = await submitParty(id);
    const taskId = await taskFor(head, inst.id);
    await assert.rejects(t.db.withTenant(fin, (tx) => wf.act(tx, fin, taskId, 'approve')), ForbiddenError);
    await assert.rejects(submitParty(id), ConflictError, 'cannot submit twice');
    await approve(head, inst.id);
    await assert.rejects(t.db.withTenant(head, (tx) => wf.act(tx, head, taskId, 'approve')), ConflictError, 'cannot act twice');
  });

  it('one person cannot approve two steps of the same request', async () => {
    // The CEO is both the escalation target and holds a role on the next step.
    await giveRole(t.db, s, s.people.ceo.userId, 'FIN_MANAGER', {}, s.units.root);
    const id = await newParty(1000);
    const inst = await submitParty(id);
    await t.db.withTenant(s.adminCtx, (tx) => wf.runEscalations(tx, new Date(Date.now() + 25 * 3_600_000)));
    await approve(ceo, inst.id);
    assert.equal((await inbox(ceo)).filter((x) => x.instance_id === inst.id).length, 0, 'ceo not assigned the finance step');
    await approve(fin, inst.id);
    assert.equal(await partyStatus(id), 'active');
  });

  it('rejection needs a reason, rejects the record, and allows resubmission', async () => {
    const id = await newParty(0);
    const inst = await submitParty(id);
    const taskId = await taskFor(head, inst.id);
    await assert.rejects(t.db.withTenant(head, (tx) => wf.act(tx, head, taskId, 'reject')), ValidationError);
    await t.db.withTenant(head, (tx) => wf.act(tx, head, taskId, 'reject', 'Trade licence missing'));
    assert.equal(await partyStatus(id), 'rejected');
    const again = await submitParty(id);
    assert.equal(again.status, 'pending');
  });

  it('the requester can withdraw a pending request', async () => {
    const id = await newParty(0);
    const inst = await submitParty(id);
    await assert.rejects(t.db.withTenant(head, (tx) => wf.cancel(tx, head, inst.id, 'no')), ForbiddenError);
    await t.db.withTenant(rep, (tx) => wf.cancel(tx, rep, inst.id, 'Customer withdrew'));
    assert.equal(await partyStatus(id), 'draft');
    assert.equal((await inbox(head)).filter((x) => x.instance_id === inst.id).length, 0);
  });
});

describe('parallel approval', () => {
  it('"all" waits for every approver', async () => {
    await publish('dual', { steps: [{ key: 'both', mode: 'all', approvers: [{ type: 'user', userId: s.people.finMgr.userId }, { type: 'user', userId: s.people.cfo.userId }] }] }, 'test.doc');
    const inst = await t.db.withTenant(rep, (tx) => wf.submit(tx, rep, { code: 'dual', entityType: 'test.doc', entityId: 'd2', subjectUnitId: s.units.sales }));
    assert.equal((await approve(fin, inst.id)).status, 'pending');
    assert.equal((await approve(cfo, inst.id)).status, 'approved');
  });

  it('a quorum completes the step and closes the remaining tasks', async () => {
    const users = [s.people.finMgr, s.people.cfo, s.people.ceo].map((p) => ({ type: 'user' as const, userId: p.userId }));
    await publish('board', { steps: [{ key: 'vote', mode: { quorum: 2 }, approvers: users }] }, 'test.doc');
    const inst = await t.db.withTenant(rep, (tx) => wf.submit(tx, rep, { code: 'board', entityType: 'test.doc', entityId: 'd3', subjectUnitId: s.units.sales }));
    await approve(fin, inst.id);
    const done = await approve(ceo, inst.id);
    assert.equal(done.status, 'approved');
    assert.equal((await inbox(cfo)).filter((x) => x.instance_id === inst.id).length, 0);
  });

  it('refuses a quorum larger than the eligible approvers', async () => {
    await publish('too-many', { steps: [{ key: 'v', mode: { quorum: 3 }, approvers: [{ type: 'role', role: 'CFO' }] }] }, 'test.doc');
    await assert.rejects(t.db.withTenant(rep, (tx) => wf.submit(tx, rep, { code: 'too-many', entityType: 'test.doc', entityId: 'd4', subjectUnitId: s.units.sales })), /needs 3 approvers/);
  });
});

describe('delegation and escalation', () => {
  it('routes to an active delegate, who approves with the delegator’s authority', async () => {
    const now = Date.now();
    await t.db.withTenant(fin, (tx) => iam.createDelegation(tx, fin, {
      delegateUserId: s.people.accountant.userId, validFrom: new Date(now - 60_000).toISOString(), validTo: new Date(now + 86_400_000).toISOString(), reason: 'Annual leave' }));
    const id = await newParty(20000);
    const inst = await submitParty(id);
    await approve(head, inst.id);
    const task = (await inbox(acct)).find((x) => x.instance_id === inst.id);
    assert.equal(task.on_behalf_of_user_id, s.people.finMgr.userId);
    await approve(acct, inst.id);
    assert.equal(await partyStatus(id), 'active');
    const full = await t.db.withTenant(rep, (tx) => wf.getInstance(tx, rep, inst.id));
    assert.deepEqual(full.history.find((h) => h.action === 'approved_step' && h.step_index === 1).detail, { onBehalfOf: s.people.finMgr.userId });
    // End the delegation for the remaining tests.
    await t.db.withTenant(s.adminCtx, (tx) => tx.query('DELETE FROM iam.delegations'));
  });

  it('escalates overdue tasks to the next level and leaves others alone', async () => {
    const id = await newParty(0);
    const inst = await submitParty(id);
    assert.equal(await t.db.withTenant(s.adminCtx, (tx) => wf.runEscalations(tx, new Date(Date.now() + 3_600_000))), 0);
    // Earlier tests left other requests pending, so count only this one's escalation.
    assert.ok(await t.db.withTenant(s.adminCtx, (tx) => wf.runEscalations(tx, new Date(Date.now() + 25 * 3_600_000))) >= 1);
    assert.equal((await inbox(head)).filter((x) => x.instance_id === inst.id).length, 0);
    const full = await t.db.withTenant(rep, (tx) => wf.getInstance(tx, rep, inst.id));
    assert.deepEqual(full.tasks.map((x) => [x.assignee_user_id, x.status]),
      [[s.people.salesHead.userId, 'escalated'], [s.people.ceo.userId, 'open']]);
    await approve(ceo, inst.id);
    assert.equal(await partyStatus(id), 'active');
  });
});

describe('definitions', () => {
  it('validates definitions before publishing', async () => {
    await assert.rejects(publish('broken', { steps: [{ key: 'x', approvers: [] }] }), ValidationError);
  });

  it('running requests keep the version they started on', async () => {
    const id = await newParty(0);
    const inst = await submitParty(id);
    // v-next: the CFO must also sign off every partner.
    await publish(mdm.PARTY_WORKFLOW, { ...MATRIX, steps: [...MATRIX.steps, { key: 'final', approvers: [{ type: 'role', role: 'CFO' }] }] });
    await approve(head, inst.id);
    assert.equal(await partyStatus(id), 'active', 'old version had no final step');
    const id2 = await newParty(0);
    const inst2 = await submitParty(id2);
    await approve(head, inst2.id);
    assert.equal(await partyStatus(id2), 'pending_approval');
    await approve(cfo, inst2.id);
    assert.equal(await partyStatus(id2), 'active');
  });

  it('every step is in the audit trail', async () => {
    const rows = await t.db.withTenant(s.adminCtx, async (tx) =>
      (await tx.query(`SELECT count(*)::int AS n FROM audit.entries WHERE entity_type = 'wf.tasks'`)).rows[0].n);
    assert.ok(rows > 20);
  });
});
