import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { many, one, type Ctx } from '../src/core/db.ts';
import { ForbiddenError, NotFoundError } from '../src/core/errors.ts';
import * as setup from '../src/fin/setup.ts';
import * as hr from '../src/hr/service.ts';
import * as exp from '../src/hr/expenses.ts';
import * as ess from '../src/ess/service.ts';
import * as wf from '../src/workflow/engine.ts';
import * as hooks from '../src/int/webhooks.ts';
import { buildServer } from '../src/api/server.ts';
import { createTestDb, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

/**
 * Phase 6c: expense claims, employee self-service for BAATS Mobile, API keys and webhooks.
 */

let t: TestDb;
let s: Seed;
let admin: Ctx, rep: Ctx, head: Ctx, accountant: Ctx;
let co: string;
const secretKey = randomBytes(32);
const hookOpts = { secretKey, allowPrivateUrls: true };

const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);
const balance = (codes: string[]) => tx(admin, async (q) =>
  Number((await one(q, `SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM fin.journal_lines l
     JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
    WHERE a.company_id = $1 AND a.code = ANY($2)`, [co, codes])).b));
const taskFor = async (ctx: Ctx, entityId: string) => (await tx(ctx, (q) => wf.inbox(q, ctx))).find((x: any) => x.entity_id === entityId)?.task_id;
// A one-pixel PNG, as a receipt.
const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
const lastWeek = () => new Date(Date.now() - 7 * 86_400_000).toISOString().slice(0, 10);

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  admin = s.adminCtx;
  rep = s.ctxOf(s.people.salesRep.userId);
  head = s.ctxOf(s.people.salesHead.userId);
  accountant = s.ctxOf(s.people.accountant.userId);
  co = s.units.uae;
  await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: co, legalName: 'Acme UAE LLC', openFrom: '2026-01-01' }));
  for (const p of [s.people.salesRep, s.people.salesHead, s.people.accountant]) {
    await tx(admin, (q) => hr.createContract(q, admin, { employeeId: p.employeeId, companyId: co, startDate: '2025-01-01', basic: 8000, housing: 2000 }));
  }
});
after(async () => { await t.drop(); });

describe('expense claims', () => {
  let claim: any;

  it('splits the VAT out of what the employee paid and sends the claim to the line manager', async () => {
    claim = await tx(rep, (q) => exp.createClaim(q, rep, { companyId: co, title: 'Client visit', submit: true, lines: [
      { date: lastWeek(), category: 'travel', description: 'Taxi to the client', amount: 105,
        receipt: { fileName: 'taxi.png', contentType: 'image/png', dataBase64: PNG } },
      { date: lastWeek(), category: 'fees', description: 'Visa fee', amount: 50, taxCode: 'EX' },
    ] }));
    assert.equal(claim.status, 'pending_approval');
    assert.match(claim.no, /^EC-\d{4}-00001$/);
    assert.deepEqual([claim.net_total, claim.tax_total, claim.gross_total], ['150.000', '5.000', '155.000']);
    assert.deepEqual(claim.lines.map((l: any) => [l.account_code, l.tax_code, l.net_amount, l.tax_amount]),
      [['5600', 'SR', '100.000', '5.000'], ['5400', 'EX', '50.000', '0.000']]);
    assert.ok(claim.lines[0].receipt_id);
    // The sales head is the rep's line manager.
    assert.ok(await taskFor(head, claim.id));
  });

  it('shows a claim and its receipts only to the employee, the approver and HR', async () => {
    const r = await tx(head, (q) => exp.receipt(q, head, claim.lines[0].receipt_id));
    assert.equal(r.contentType, 'image/png');
    assert.equal(r.content.toString('base64'), PNG);
    await assert.rejects(tx(accountant, (q) => exp.getClaim(q, accountant, claim.id)), ForbiddenError);
    await assert.rejects(tx(accountant, (q) => exp.receipt(q, accountant, claim.lines[0].receipt_id)), ForbiddenError);
    await assert.rejects(tx(rep, (q) => exp.listClaims(q, rep, co)), ForbiddenError);
    assert.equal((await tx(admin, (q) => exp.listClaims(q, admin, co))).length, 1);
  });

  it('posts the approved claim to the ledger with input VAT and owes it to the employee', async () => {
    await tx(head, async (q) => wf.act(q, head, (await taskFor(head, claim.id))!, 'approve'));
    const c = await tx(rep, (q) => exp.getClaim(q, rep, claim.id));
    assert.equal(c.status, 'approved');
    assert.ok(c.journal_no);
    assert.equal(await balance(['5600']), 100);
    assert.equal(await balance(['5400']), 50);
    assert.equal(await balance(['1200']), 5);
    assert.equal(await balance(['2230']), -155);
  });

  it('pays an approved claim from the bank, once, by someone who manages claims', async () => {
    await assert.rejects(tx(rep, (q) => exp.payClaim(q, rep, claim.id, { date: '2026-11-27' })), ForbiddenError);
    const paid = await tx(admin, (q) => exp.payClaim(q, admin, claim.id, { date: '2026-11-27' }));
    assert.equal(paid.status, 'paid');
    assert.equal(await balance(['2230']), 0);
    assert.equal(await balance(['1010']), -155);
    await assert.rejects(tx(admin, (q) => exp.payClaim(q, admin, claim.id, { date: '2026-11-27' })), /already paid/);
  });

  it('refuses claims that are not right', async () => {
    const line = { date: lastWeek(), category: 'meals', description: 'Lunch', amount: 40 };
    await assert.rejects(tx(rep, (q) => exp.createClaim(q, rep, { companyId: co, title: 'x', lines: [{ ...line, taxCode: 'RC' }] })), /reverse-charge/);
    await assert.rejects(tx(rep, (q) => exp.createClaim(q, rep, { companyId: co, title: 'x', lines: [{ ...line, category: 'yacht' }] })), /category/);
    await assert.rejects(tx(rep, (q) => exp.createClaim(q, rep, { companyId: co, title: 'x', lines: [{ ...line, date: '2999-01-01' }] })), /future/);
    const big = Buffer.alloc(760_000, 1).toString('base64');
    await assert.rejects(tx(rep, (q) => exp.createClaim(q, rep, { companyId: co, title: 'x',
      lines: [{ ...line, receipt: { fileName: 'a.jpg', contentType: 'image/jpeg', dataBase64: big } }] })), /750 KB/);
    await assert.rejects(tx(rep, (q) => exp.createClaim(q, rep, { companyId: co, title: 'x',
      lines: [{ ...line, receipt: { fileName: 'a.svg', contentType: 'image/svg+xml', dataBase64: PNG } }] })), /JPEG, PNG or WebP/);
    // Someone with no contract in the company cannot claim from it.
    const uk = s.ctxOf(s.people.ukStaff.userId);
    await assert.rejects(tx(uk, (q) => exp.createClaim(q, uk, { companyId: co, title: 'x', lines: [line] })), /no active contract/);
    // Claiming for someone else needs hr.expense.manage.
    await assert.rejects(tx(rep, (q) => exp.createClaim(q, rep, { companyId: co, employeeId: s.people.accountant.employeeId, title: 'x', lines: [line] })), ForbiddenError);
  });

  it('keeps drafts until they are sent, and lets the employee delete them', async () => {
    const d = await tx(rep, (q) => exp.createClaim(q, rep, { companyId: co, title: 'Stationery', lines: [{ date: lastWeek(), category: 'office', description: 'Pens', amount: 21 }] }));
    assert.equal(d.status, 'draft');
    assert.equal(d.no, null);
    await assert.rejects(tx(accountant, (q) => exp.deleteDraftClaim(q, accountant, d.id)), ForbiddenError);
    await tx(rep, (q) => exp.deleteDraftClaim(q, rep, d.id));
    await assert.rejects(tx(rep, (q) => exp.getClaim(q, rep, d.id)), NotFoundError);
  });

  it('marks a rejected claim and posts nothing', async () => {
    const c = await tx(rep, (q) => exp.createClaim(q, rep, { companyId: co, title: 'Dinner', submit: true, lines: [{ date: lastWeek(), category: 'meals', description: 'Team dinner', amount: 210 }] }));
    const before = await balance(['5900']);
    await tx(head, async (q) => wf.act(q, head, (await taskFor(head, c.id))!, 'reject', 'Team dinners are not claimable'));
    assert.equal((await tx(rep, (q) => exp.getClaim(q, rep, c.id))).status, 'rejected');
    assert.equal(await balance(['5900']), before);
  });
});

describe('self-service for BAATS Mobile', () => {
  it('shows me my record, my leave and what waits for me', async () => {
    const p = await tx(rep, (q) => ess.profile(q, rep));
    assert.equal(p.employee.employee_no, 'E006');
    assert.equal(p.employee.manager, 'Saleshead Test');
    assert.equal(p.contract.company, 'Acme UAE LLC');
    assert.ok(p.leave!.entitled > 0);
    assert.equal(p.approvals, 0);
    const o = await tx(rep, (q) => ess.expenseOptions(q, rep));
    assert.equal(o.currency, 'AED');
    assert.equal(o.defaultTaxCode, 'SR');
    assert.ok(!o.taxCodes.some((c: any) => c.category === 'reverse_charge'));
    const mine = await tx(rep, (q) => ess.expenses(q, rep));
    assert.deepEqual(mine.map((c: any) => c.status).sort(), ['paid', 'rejected']);
  });

  it('sends my leave request to my manager', async () => {
    const r = await tx(rep, (q) => ess.applyForLeave(q, rep, { leaveType: 'sick', dateFrom: '2026-12-01', dateTo: '2026-12-02' }));
    assert.equal(r.employee_id, s.people.salesRep.employeeId);
    assert.equal((await tx(head, (q) => ess.profile(q, head))).approvals, 1);
    const task = (await tx(head, (q) => wf.inbox(q, head))).find((x: any) => x.entity_id === r.id);
    assert.equal(task.payload.date_from, '2026-12-01');
    assert.equal((await tx(rep, (q) => ess.myLeave(q, rep)))[0].status, 'pending_approval');
  });

  it('shows my payslips once the payroll is posted, and nobody else\'s', async () => {
    let run = await tx(admin, (q) => hr.runPayroll(q, admin, { companyId: co, period: '2026-10' }));
    assert.equal((await tx(rep, (q) => ess.payslips(q, rep))).length, 0);
    run = await tx(admin, (q) => hr.postPayroll(q, admin, run.id));
    const mine = await tx(rep, (q) => ess.payslips(q, rep));
    assert.equal(mine.length, 1);
    assert.equal(Number(mine[0].net), 10000);
    const slip = await tx(rep, (q) => ess.payslip(q, rep, mine[0].id));
    assert.equal(slip.company, 'Acme UAE LLC');
    await assert.rejects(tx(accountant, (q) => ess.payslip(q, accountant, mine[0].id)), NotFoundError);
  });

  it('asks a user with no employee record to have it linked', async () => {
    await assert.rejects(tx(admin, (q) => ess.payslips(q, admin)), /not linked to an employee/);
    assert.equal((await tx(admin, (q) => ess.profile(q, admin))).employee, null);
  });
});

describe('API keys and the mobile app over HTTP', () => {
  let app: ReturnType<typeof buildServer>;
  let h: Record<string, string>;
  before(async () => {
    app = buildServer({ db: t.db, platformAdminKey: 'k', ai: { secretKey: secretKey.toString('base64'), allowPrivateUrls: false } });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `admin@${s.code}.test`, password: PASSWORD } });
    h = { authorization: `Bearer ${login.json().token}` };
  });
  after(async () => { await app.close(); });

  it('serves BAATS Mobile without a sign-in', async () => {
    const page = await app.inject({ method: 'GET', url: '/m/' });
    assert.equal(page.statusCode, 200);
    assert.match(page.headers['content-type'] as string, /text\/html/);
    assert.match(page.body, /BAATS Mobile/);
    assert.match(page.headers['content-security-policy'] as string, /frame-ancestors 'none'/);
    assert.equal((await app.inject({ method: 'GET', url: '/m' })).statusCode, 302);
    const manifest = (await app.inject({ method: 'GET', url: '/m/manifest.webmanifest' })).json();
    assert.equal(manifest.start_url, '/m/');
    assert.equal((await app.inject({ method: 'GET', url: '/m/icon-192.png' })).headers['content-type'], 'image/png');
    assert.equal((await app.inject({ method: 'GET', url: '/m/sw.js' })).headers['service-worker-allowed'], '/m/');
    // Everything else still needs a sign-in.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/ess/me' })).statusCode, 401);
  });

  it('lets another system act as a user with a key, until the key is revoked', async () => {
    const made = await app.inject({ method: 'POST', url: '/v1/int/api-keys', headers: h, payload: { name: 'Payroll bureau', userId: s.people.salesRep.userId } });
    assert.equal(made.statusCode, 201);
    const key = made.json().key as string;
    assert.match(key, /^[0-9a-f-]{36}\.bk_/);
    const kh = { authorization: `Bearer ${key}` };
    const me = await app.inject({ method: 'GET', url: '/v1/ess/me', headers: kh });
    assert.equal(me.json().employee.employee_no, 'E006');
    // The key can do only what its user can.
    assert.equal((await app.inject({ method: 'GET', url: `/v1/hr/companies/${co}/expenses`, headers: kh })).statusCode, 403);
    const list = (await app.inject({ method: 'GET', url: '/v1/int/api-keys', headers: h })).json();
    assert.equal(list[0].prefix, key.split('.')[1].slice(0, 10));
    assert.ok(!JSON.stringify(list).includes(key));
    assert.ok(list[0].last_used_at);
    await app.inject({ method: 'POST', url: `/v1/int/api-keys/${made.json().id}/revoke`, headers: h });
    assert.equal((await app.inject({ method: 'GET', url: '/v1/ess/me', headers: kh })).statusCode, 401);
    // A wrong key is refused the same way.
    assert.equal((await app.inject({ method: 'GET', url: '/v1/ess/me', headers: { authorization: `Bearer ${key.slice(0, -2)}xx` } })).statusCode, 401);
  });

  it('lets only integration managers make keys, and only user administrators make keys for others', async () => {
    const repLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `salesrep@${s.code}.test`, password: PASSWORD } });
    const rh = { authorization: `Bearer ${repLogin.json().token}` };
    assert.equal((await app.inject({ method: 'POST', url: '/v1/int/api-keys', headers: rh, payload: { name: 'mine' } })).statusCode, 403);
    assert.equal((await app.inject({ method: 'POST', url: '/v1/int/api-keys', headers: h, payload: { name: 'old', expiresAt: '2020-01-01T00:00:00Z' } })).statusCode, 422);
  });

  it('takes a claim with a receipt over HTTP and returns the receipt image', async () => {
    const repLogin = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `salesrep@${s.code}.test`, password: PASSWORD } });
    const rh = { authorization: `Bearer ${repLogin.json().token}` };
    // A phone photo of about 700 KB is bigger than the usual 1 MB request once encoded twice over; the claim route takes it.
    const photo = Buffer.alloc(700_000, 7).toString('base64');
    const r = await app.inject({ method: 'POST', url: '/v1/hr/expenses', headers: rh, payload: { companyId: co, title: 'Hotel', lines: [
      { date: lastWeek(), category: 'accommodation', description: 'Hotel night', amount: 420, receipt: { fileName: 'hotel.jpg', contentType: 'image/jpeg', dataBase64: photo } }] } });
    assert.equal(r.statusCode, 201, r.body);
    const img = await app.inject({ method: 'GET', url: `/v1/hr/receipts/${r.json().lines[0].receipt_id}`, headers: rh });
    assert.equal(img.statusCode, 200);
    assert.equal(img.headers['content-type'], 'image/jpeg');
    assert.equal(img.rawPayload.length, 700_000);
    assert.match(img.headers['content-security-policy'] as string, /sandbox/);
  });
});

describe('webhooks', () => {
  let hook: any;

  it('refuses addresses on the local network unless the server allows them', async () => {
    await assert.rejects(tx(admin, (q) => hooks.createWebhook(q, admin, { secretKey, allowPrivateUrls: false }, { name: 'x', url: 'https://127.0.0.1:9/x', events: ['invoice.posted'] })), /local|private/i);
    await assert.rejects(tx(admin, (q) => hooks.createWebhook(q, admin, { secretKey, allowPrivateUrls: false }, { name: 'x', url: 'https://10.1.2.3/x', events: ['invoice.posted'] })), /local|private/i);
    await assert.rejects(tx(admin, (q) => hooks.createWebhook(q, admin, hookOpts, { name: 'x', url: 'ftp://example.com/x', events: ['invoice.posted'] })), /http/);
    await assert.rejects(tx(admin, (q) => hooks.createWebhook(q, admin, hookOpts, { name: 'x', url: 'https://example.com/x', events: ['nonsense'] })), /nonsense/);
    await assert.rejects(tx(rep, (q) => hooks.createWebhook(q, rep, hookOpts, { name: 'x', url: 'https://example.com/x', events: ['invoice.posted'] })), ForbiddenError);
  });

  it('writes an event in the same transaction as the change, and none when it rolls back', async () => {
    hook = await tx(admin, (q) => hooks.createWebhook(q, admin, hookOpts, { name: 'Bureau', url: 'http://127.0.0.1:9/hook', events: ['expense.approved', 'expense.paid', 'leave.approved'] }));
    assert.match(hook.secret, /^whsec_/);
    // The secret is kept sealed, never in the clear.
    const sealed = await tx(admin, (q) => one(q, 'SELECT sealed FROM int.webhook_secrets WHERE webhook_id = $1', [hook.id]));
    assert.ok(!sealed.sealed.includes(hook.secret));
    await assert.rejects(tx(admin, async (q) => { await hooks.emit(q, 'expense.approved', co, { probe: 1 }); throw new Error('rolled back'); }), /rolled back/);
    assert.equal((await tx(admin, (q) => many(q, `SELECT 1 FROM int.events WHERE payload->>'probe' = '1'`))).length, 0);
    // An event nobody subscribes to is not queued.
    await tx(admin, (q) => hooks.emit(q, 'invoice.posted', co, { probe: 2 }));
    assert.equal((await tx(admin, (q) => hooks.listWebhooks(q, admin))).webhooks[0].pending, 0);
    // Approving the leave queues one delivery.
    const leave = (await tx(head, (q) => wf.inbox(q, head))).find((x: any) => x.entity_type === 'hr.leave');
    await tx(head, (q) => wf.act(q, head, leave.task_id, 'approve'));
    const list = await tx(admin, (q) => hooks.listDeliveries(q, admin, hook.id));
    assert.deepEqual(list.map((d: any) => [d.type, d.status]), [['leave.approved', 'pending']]);
  });

  it('signs each delivery so the receiver can check it came from BAATS', async () => {
    const seen: { url: string; init: any }[] = [];
    const fetchImpl = (async (url: string, init: any) => { seen.push({ url, init }); return new Response('ok', { status: 200 }); }) as unknown as typeof fetch;
    assert.equal(await hooks.dispatchTenant(t.db, s.tenantId, { ...hookOpts, fetchImpl }), 1);
    const { init } = seen[0];
    const body = JSON.parse(init.body);
    assert.equal(body.type, 'leave.approved');
    assert.equal(body.data.leave_type, 'sick');
    assert.equal(init.headers['x-baats-event'], 'leave.approved');
    const [tPart, vPart] = init.headers['x-baats-signature'].split(',');
    const ts = tPart.slice(2);
    assert.equal(vPart.slice(3), createHmac('sha256', hook.secret).update(`${ts}.${init.body}`).digest('hex'));
    assert.equal(init.redirect, 'manual');
    const d = (await tx(admin, (q) => hooks.listDeliveries(q, admin, hook.id)))[0];
    assert.deepEqual([d.status, d.attempts, d.last_status], ['delivered', 1, 200]);
    // Nothing is sent twice.
    assert.equal(await hooks.dispatchTenant(t.db, s.tenantId, { ...hookOpts, fetchImpl }), 0);
  });

  it('retries with growing waits and gives up after eight attempts', async () => {
    await tx(admin, (q) => hooks.pingWebhook(q, admin, hook.id));
    let now = Date.now();
    const fetchImpl = (async () => new Response('down', { status: 503 })) as unknown as typeof fetch;
    const waits: number[] = [];
    for (let i = 1; i <= hooks.MAX_ATTEMPTS; i++) {
      assert.equal(await hooks.dispatchTenant(t.db, s.tenantId, { ...hookOpts, fetchImpl, now: () => new Date(now) }), 1);
      const d = (await tx(admin, (q) => hooks.listDeliveries(q, admin, hook.id))).find((x: any) => x.type === 'ping');
      assert.equal(d.attempts, i);
      assert.equal(d.last_error, 'the receiver answered 503');
      if (i < hooks.MAX_ATTEMPTS) {
        assert.equal(d.status, 'pending');
        waits.push(new Date(d.next_attempt_at).getTime() - now);
        // Nothing is due before the wait is over.
        assert.equal(await hooks.dispatchTenant(t.db, s.tenantId, { ...hookOpts, fetchImpl, now: () => new Date(now + 1000) }), 0);
        now = new Date(d.next_attempt_at).getTime();
      } else assert.equal(d.status, 'failed');
    }
    assert.deepEqual(waits.map((w) => w / 60_000), [1, 2, 4, 8, 16, 32, 64]);
    // Sending it again by hand puts it back in the queue.
    const failed = (await tx(admin, (q) => hooks.listDeliveries(q, admin, hook.id))).find((x: any) => x.type === 'ping');
    await tx(admin, (q) => hooks.redeliver(q, admin, failed.id));
    const ok = (async () => new Response(null, { status: 204 })) as unknown as typeof fetch;
    assert.equal(await hooks.dispatchTenant(t.db, s.tenantId, { ...hookOpts, fetchImpl: ok }), 1);
    assert.equal((await tx(admin, (q) => hooks.listWebhooks(q, admin))).webhooks[0].failed, 0);
  });

  it('queues nothing for a switched-off webhook, and deletes a webhook with its history', async () => {
    await tx(admin, (q) => hooks.updateWebhook(q, admin, hookOpts, hook.id, { active: false }));
    const c = await tx(rep, (q) => exp.createClaim(q, rep, { companyId: co, title: 'Parking', submit: true, lines: [{ date: lastWeek(), category: 'fuel', description: 'Parking', amount: 21 }] }));
    await tx(head, async (q) => wf.act(q, head, (await taskFor(head, c.id))!, 'approve'));
    assert.ok(!(await tx(admin, (q) => hooks.listDeliveries(q, admin, hook.id))).some((d: any) => d.type === 'expense.approved'));
    await tx(admin, (q) => hooks.deleteWebhook(q, admin, hook.id));
    assert.equal((await tx(admin, (q) => hooks.listWebhooks(q, admin))).webhooks.length, 0);
  });
});
