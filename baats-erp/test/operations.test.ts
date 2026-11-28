import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { one, type Ctx } from '../src/core/db.ts';
import { ForbiddenError, ValidationError } from '../src/core/errors.ts';
import * as setup from '../src/fin/setup.ts';
import * as docs from '../src/fin/documents.ts';
import * as reports from '../src/fin/reports.ts';
import * as mdm from '../src/mdm/service.ts';
import * as wf from '../src/workflow/engine.ts';
import * as inv from '../src/inv/service.ts';
import * as pur from '../src/pur/service.ts';
import * as crm from '../src/crm/service.ts';
import * as sal from '../src/sal/service.ts';
import * as hr from '../src/hr/service.ts';
import { buildServer } from '../src/api/server.ts';
import { createTestDb, giveRole, PASSWORD, seedOrg, type Seed, type TestDb } from './helpers.ts';

let t: TestDb;
let s: Seed;
let co: string;
let admin: Ctx, buyer: Ctx, approver: Ctx, seller: Ctx;
let laptop: string, cable: string, consulting: string, main: string, store2: string, supplier: string;

const tx = <T>(ctx: Ctx, fn: (tx: any) => Promise<T>) => t.db.withTenant(ctx, fn);
const balance = (code: string) => tx(admin, async (q) =>
  Number((await one(q, `SELECT coalesce(sum(l.debit - l.credit), 0) AS b FROM fin.journal_lines l
     JOIN fin.journals j ON j.id = l.journal_id AND j.status = 'posted' JOIN fin.accounts a ON a.id = l.account_id
    WHERE a.company_id = $1 AND a.code = $2`, [co, code])).b));
const taskFor = async (ctx: Ctx, entityId: string) => (await tx(ctx, (q) => wf.inbox(q, ctx))).find((x) => x.entity_id === entityId)?.task_id;
const stockOf = async (itemId: string, warehouseId: string) =>
  (await tx(admin, (q) => inv.stockLevels(q, admin, co, warehouseId))).find((r) => r.item_id === itemId);

before(async () => {
  t = await createTestDb();
  s = await seedOrg(t.db);
  co = s.units.uae;
  admin = s.adminCtx;
  buyer = s.ctxOf(s.people.accountant.userId);
  approver = s.ctxOf(s.people.finMgr.userId);
  seller = s.ctxOf(s.people.salesRep.userId);
  await tx(admin, (q) => setup.setupCompany(q, admin, { unitId: co, legalName: 'Acme UAE LLC', openFrom: '2026-01-01' }));
  await giveRole(t.db, s, s.people.accountant.userId, 'BUYER', {
    'pur.order.manage': {}, 'pur.receive': {}, 'fin.invoice.manage': {}, 'fin.invoice.post': {}, 'fin.report.read': {}, 'inv.manage': {}, 'inv.read': {},
  }, co);
  await giveRole(t.db, s, s.people.finMgr.userId, 'PROCUREMENT_MANAGER', { 'pur.order.approve': { amount: { lte: 50000 } } }, co);
  await giveRole(t.db, s, s.people.salesRep.userId, 'SALES', {
    'crm.manage': {}, 'sal.order.manage': {}, 'sal.deliver': {}, 'mdm.party.manage': {},
  }, s.units.sales);
  await tx(admin, async (q) => {
    const ea = await mdm.createUom(q, admin, { code: 'EA', name: 'Each' });
    laptop = (await mdm.createItem(q, admin, { code: 'LAP-14', name: 'Laptop 14"', itemType: 'stock', baseUom: 'EA', attributes: { revenue_account: '4200' } })).id;
    cable = (await mdm.createItem(q, admin, { code: 'CBL-1', name: 'USB-C cable', itemType: 'stock', baseUom: 'EA' })).id;
    consulting = (await mdm.createItem(q, admin, { code: 'SVC-SETUP', name: 'Setup service', itemType: 'service', baseUom: 'EA' })).id;
    void ea;
    main = (await inv.createWarehouse(q, admin, { companyId: co, code: 'MAIN', name: 'Main warehouse', unitId: s.units.dubai })).id;
    store2 = (await inv.createWarehouse(q, admin, { companyId: co, code: 'JAFZA', name: 'Jebel Ali store' })).id;
    supplier = (await one(q, `INSERT INTO mdm.parties (tenant_id, code, name, normalized_name, is_supplier, country_code, currency_code, owner_unit_id, status)
      VALUES (app.tenant(), 'SUP-1', 'Gulf Tech Trading', 'gulf tech trading', true, 'AE', 'AED', $1, 'active') RETURNING id`, [co])).id;
  });
});
after(async () => { await t.drop(); });

describe('inventory', () => {
  it('values opening stock, adjustments and transfers at moving average and agrees with the ledger', async () => {
    await tx(buyer, (q) => inv.openingStock(q, buyer, { companyId: co, warehouseId: main, date: '2026-01-01',
      lines: [{ itemId: laptop, qty: 10, unitCost: 100 }, { itemId: cable, qty: 3, unitCost: 10 }] }));
    assert.equal(await balance('1300'), 1030);
    assert.equal(await balance('3200'), -1030);
    const adj = await tx(buyer, (q) => inv.adjustStock(q, buyer, { companyId: co, warehouseId: main, itemId: laptop, date: '2026-01-05', qty: -2, reason: 'Damaged' }));
    assert.equal(adj.value, -200);
    assert.equal(await balance('5070'), 200);
    await tx(buyer, (q) => inv.transferStock(q, buyer, { companyId: co, fromWarehouseId: main, toWarehouseId: store2, itemId: laptop, qty: 3, date: '2026-01-06' }));
    assert.equal((await stockOf(laptop, main)).qty, 5);
    assert.equal((await stockOf(laptop, store2)).value, 300);
    const v = await tx(buyer, (q) => inv.valuation(q, buyer, co));
    assert.equal(v.difference, 0);
    assert.equal(v.stockValue, 830);
  });
  it('never lets stock go negative or adjust a service item', async () => {
    await assert.rejects(tx(buyer, (q) => inv.adjustStock(q, buyer, { companyId: co, warehouseId: store2, itemId: laptop, date: '2026-01-07', qty: -4, reason: 'x' })), /not enough/);
    await assert.rejects(tx(buyer, (q) => inv.adjustStock(q, buyer, { companyId: co, warehouseId: main, itemId: consulting, date: '2026-01-07', qty: 1, unitCost: 1, reason: 'x' })), /not a stock item/);
  });
  it('keeps stock movements append-only', async () => {
    await assert.rejects(tx(admin, (q) => q.query('UPDATE inv.moves SET qty = 99')), /append-only/);
  });
});

describe('procure to pay', () => {
  let po: any;
  it('needs an approved purchase order, within the approver\'s limit', async () => {
    po = await tx(buyer, (q) => pur.createOrder(q, buyer, { companyId: co, supplierId: supplier, date: '2026-02-01', warehouseId: main,
      requestingUnitId: s.units.finance, lines: [
        { itemId: laptop, description: 'Laptop 14"', quantity: 10, unitPrice: 130, taxCode: 'SR' },
        { itemId: consulting, description: 'Imaging and setup', quantity: 1, unitPrice: 500, taxCode: 'SR', account: '5300' },
      ] }));
    assert.equal(Number(po.gross_total), 1890);
    await assert.rejects(tx(buyer, (q) => pur.receive(q, buyer, po.id, { date: '2026-02-03', lines: [{ orderLineId: po.lines[0].id, quantity: 1 }] })), /only approved/);
    await tx(buyer, (q) => pur.submitOrder(q, buyer, po.id));
    // The buyer cannot approve their own order (maker-checker).
    assert.equal(await taskFor(buyer, po.id), undefined);
    await tx(approver, async (q) => wf.act(q, approver, (await taskFor(approver, po.id))!, 'approve'));
    po = await tx(buyer, (q) => pur.getOrder(q, buyer, po.id));
    assert.equal(po.status, 'approved');
    assert.match(po.no, /^PO-2026-\d{5}$/);
  });
  it('blocks approval above the approver\'s limit', async () => {
    const big = await tx(buyer, (q) => pur.createOrder(q, buyer, { companyId: co, supplierId: supplier, date: '2026-02-01', warehouseId: main,
      lines: [{ itemId: laptop, description: 'Laptops', quantity: 500, unitPrice: 130, taxCode: 'SR' }] }));
    await tx(buyer, (q) => pur.submitOrder(q, buyer, big.id));
    await assert.rejects(tx(approver, async (q) => wf.act(q, approver, (await taskFor(approver, big.id))!, 'approve')), ForbiddenError);
  });
  it('receives goods into stock against GRNI', async () => {
    const grn = await tx(buyer, (q) => pur.receive(q, buyer, po.id, { date: '2026-02-05', deliveryNote: 'DN-778',
      lines: [{ orderLineId: po.lines[0].id, quantity: 6 }] }));
    assert.equal(grn.value, 780);
    assert.equal(await balance('2010'), -780);
    // 5 @ 100 + 6 @ 130 = 1280 for 11 units
    assert.equal((await stockOf(laptop, main)).value, 1280);
    await assert.rejects(tx(buyer, (q) => pur.receive(q, buyer, po.id, { date: '2026-02-06', lines: [{ orderLineId: po.lines[0].id, quantity: 5 }] })), /exceed/);
  });
  it('bills only what was received (three-way match) and clears GRNI', async () => {
    await assert.rejects(tx(buyer, (q) => pur.billOrder(q, buyer, po.id, { date: '2026-02-10', supplierRef: 'GT-1001',
      lines: [{ orderLineId: po.lines[0].id, quantity: 8 }] })), /three-way match/);
    await tx(buyer, (q) => pur.receive(q, buyer, po.id, { date: '2026-02-06', lines: [{ orderLineId: po.lines[1].id, quantity: 1 }] }));
    const bill = await tx(buyer, (q) => pur.billOrder(q, buyer, po.id, { date: '2026-02-10', supplierRef: 'GT-1001' }));
    assert.equal(Number(bill.net_total), 1280);
    await tx(buyer, (q) => docs.postInvoice(q, buyer, bill.id));
    assert.equal(await balance('2010'), 0);
    assert.equal(await balance('5300'), 500);
    assert.equal(await balance('2000'), -1344);
    assert.equal(await balance('1200'), 64);
    await assert.rejects(tx(buyer, (q) => pur.billOrder(q, buyer, po.id, { date: '2026-02-11', supplierRef: 'GT-1002' })), /nothing has been received/);
    const v = await tx(buyer, (q) => inv.valuation(q, buyer, co));
    assert.equal(v.difference, 0);
  });
});

describe('CRM and order to cash', () => {
  let customer: string, opp: any, order: any;
  it('turns a qualified lead into a customer and an opportunity', async () => {
    const lead = await tx(seller, (q) => crm.createLead(q, seller, { ownerUnitId: s.units.sales, name: 'Sara Khan', companyName: 'Marina Clinics',
      email: 'sara@example.com', countryCode: 'AE', source: 'Website' }));
    await tx(seller, (q) => crm.addActivity(q, seller, { entityType: 'lead', entityId: lead.id, kind: 'call', subject: 'Discovery call', done: true }));
    await tx(seller, (q) => crm.setLeadStatus(q, seller, lead.id, 'qualified'));
    const r = await tx(seller, (q) => crm.convertLead(q, seller, lead.id, { customerCode: 'CUS-MC',
      opportunity: { title: '12 laptops for clinics', amount: 2400, currency: 'AED', expectedClose: '2026-03-31' } }));
    customer = r.party.id;
    opp = r.opportunity;
    assert.equal(r.party.status, 'draft');
    await assert.rejects(tx(seller, (q) => crm.convertLead(q, seller, lead.id, { customerCode: 'X' })), /already converted/);
    // Another team cannot see this pipeline.
    const other = s.ctxOf(s.people.accountant.userId);
    await giveRole(t.db, s, s.people.accountant.userId, 'CRM_FIN', { 'crm.manage': {} }, s.units.finance);
    assert.equal((await tx(other, (q) => crm.pipeline(q, other))).opportunities.length, 0);
    assert.equal((await tx(seller, (q) => crm.pipeline(q, seller))).opportunities.length, 1);
  });
  it('confirms an order only for an approved customer within the credit limit', async () => {
    order = await tx(seller, (q) => sal.createQuotation(q, seller, { companyId: co, customerId: customer, date: '2026-03-01', warehouseId: main,
      sellingUnitId: s.units.sales, opportunityId: opp.id, lines: [
        { itemId: laptop, description: 'Laptop 14"', quantity: 4, unitPrice: 200, discount: 40, taxCode: 'SR' },
        { itemId: consulting, description: 'On-site setup', quantity: 1, unitPrice: 300, taxCode: 'SR', account: '4000' },
      ] }));
    assert.match(order.quote_no, /^QT-2026-/);
    assert.equal(Number(order.gross_total), 1113);
    await assert.rejects(tx(seller, (q) => sal.confirmOrder(q, seller, order.id)), /must be approved/);
    await tx(admin, (q) => q.query(`UPDATE mdm.parties SET status = 'active', credit_limit = 1000 WHERE id = $1`, [customer]));
    await assert.rejects(tx(seller, (q) => sal.confirmOrder(q, seller, order.id)), /credit limit exceeded/);
    await tx(admin, (q) => q.query(`UPDATE mdm.parties SET credit_limit = 5000 WHERE id = $1`, [customer]));
    order = await tx(seller, (q) => sal.confirmOrder(q, seller, order.id));
    assert.match(order.no, /^SO-2026-/);
    const o = (await tx(seller, (q) => crm.pipeline(q, seller))).opportunities[0];
    assert.equal(o.stage, 'won');
  });
  it('delivers at moving average cost and invoices what was delivered', async () => {
    const before5050 = await balance('5050');
    const d = await tx(seller, (q) => sal.deliver(q, seller, order.id, { date: '2026-03-03', lines: [{ orderLineId: order.lines[0].id, quantity: 3 }] }));
    // 11 units worth 1280: 3 cost 349.09
    assert.equal(d.cost, 349.09);
    assert.equal(round(await balance('5050') - before5050), 349.09);
    // Finance raises the invoice from the order.
    const draft = await tx(buyer, (q) => sal.invoiceOrder(q, buyer, order.id, { date: '2026-03-04' }));
    const full = await tx(admin, (q) => docs.getInvoice(q, admin, draft.id));
    assert.deepEqual(full.lines.map((l: any) => Number(l.quantity)), [3, 1]);
    assert.equal(Number(full.net_total), 870);   // 3 x 200 - 30 discount + 300 service
    await tx(buyer, (q) => docs.postInvoice(q, buyer, draft.id));
    assert.equal(await balance('4200'), -570);
    await assert.rejects(tx(seller, (q) => sal.deliver(q, seller, order.id, { date: '2026-03-05', lines: [{ orderLineId: order.lines[0].id, quantity: 2 }] })), /exceed/);
    await tx(seller, (q) => sal.deliver(q, seller, order.id, { date: '2026-03-05' }));
    const second = await tx(buyer, (q) => sal.invoiceOrder(q, buyer, order.id, { date: '2026-03-06' }));
    const sl = await tx(admin, (q) => docs.getInvoice(q, admin, second.id));
    assert.deepEqual(sl.lines.map((l: any) => Number(l.quantity)), [1]);
    assert.equal((await tx(admin, (q) => inv.valuation(q, admin, co))).difference, 0);
  });
});

describe('HR and payroll', () => {
  let kAcc: any, kRep: any, run: any;
  it('computes end-of-service gratuity as BAATS does', () => {
    assert.equal(hr.gratuity(10000, '2026-01-01', '2026-12-31'), 0);           // under a year
    assert.equal(hr.gratuity(9000, '2020-01-01', '2021-01-01'), round(9000 / 30 * 21 * (366 / 365.25)));
    assert.equal(hr.gratuity(3000, '2000-01-01', '2030-01-01'), 72000);        // capped at 24 months
  });
  it('holds contracts with WPS details', async () => {
    kAcc = await tx(admin, (q) => hr.createContract(q, admin, { employeeId: s.people.accountant.employeeId, companyId: co, startDate: '2020-01-01',
      basic: 10000, housing: 4000, transport: 1000, wpsPersonId: '10000000000001', bankRoutingCode: '803320101', iban: 'AE07 0331 2345 6789 0123 456' }));
    kRep = await tx(admin, (q) => hr.createContract(q, admin, { employeeId: s.people.salesRep.employeeId, companyId: co, startDate: '2026-01-15',
      basic: 6000, housing: 0 }));
    await assert.rejects(tx(admin, (q) => hr.createContract(q, admin, { employeeId: s.people.salesRep.employeeId, companyId: co, startDate: '2026-02-01', basic: 1 })), /already has an active contract/);
    await assert.rejects(tx(admin, (q) => hr.createContract(q, admin, { employeeId: s.people.cfo.employeeId, companyId: co, startDate: '2026-02-01', basic: 1, iban: 'GB00' })), /IBAN/);
  });
  it('routes leave to the line manager and checks the annual leave balance', async () => {
    await assert.rejects(tx(seller, (q) => hr.requestLeave(q, seller, { employeeId: s.people.salesRep.employeeId, leaveType: 'annual', dateFrom: '2026-03-01', dateTo: '2026-03-10' })), /not enough annual leave/);
    const r = await tx(seller, (q) => hr.requestLeave(q, seller, { employeeId: s.people.salesRep.employeeId, leaveType: 'unpaid', dateFrom: '2026-03-10', dateTo: '2026-03-12' }));
    const head = s.ctxOf(s.people.salesHead.userId);
    await tx(head, async (q) => wf.act(q, head, (await taskFor(head, r.id))!, 'approve'));
    const leave = await tx(admin, (q) => hr.listLeave(q, admin, co));
    assert.equal(leave[0].status, 'approved');
    await assert.rejects(tx(buyer, (q) => hr.requestLeave(q, buyer, { employeeId: s.people.salesRep.employeeId, leaveType: 'sick', dateFrom: '2026-04-01', dateTo: '2026-04-01' })), ForbiddenError);
  });
  it('runs payroll with pro-rating, unpaid leave, variable pay and deductions', async () => {
    run = await tx(admin, (q) => hr.runPayroll(q, admin, { companyId: co, period: '2026-03',
      inputs: [{ employeeId: s.people.accountant.employeeId, additions: 500, deductions: 1000 }] }));
    const acc = run.payslips.find((p: any) => p.employee_id === s.people.accountant.employeeId);
    const rep = run.payslips.find((p: any) => p.employee_id === s.people.salesRep.employeeId);
    assert.equal(Number(acc.gross), 15500);
    assert.equal(Number(acc.net), 14500);
    assert.equal(Number(rep.paid_days), 28);
    assert.equal(Number(rep.gross), round(6000 * 28 / 31));
    // Recalculating a draft replaces it.
    run = await tx(admin, (q) => hr.runPayroll(q, admin, { companyId: co, period: '2026-03',
      inputs: [{ employeeId: s.people.accountant.employeeId, additions: 500, deductions: 1000 }] }));
    await tx(admin, (q) => hr.postPayroll(q, admin, run.id));
    assert.equal(await balance('5000'), round(15500 + 6000 * 28 / 31));
    assert.equal(await balance('1260'), -1000);
    assert.equal(await balance('2500'), -hr.gratuity(10000, '2020-01-01', '2026-03-31'));
    await assert.rejects(tx(admin, (q) => hr.runPayroll(q, admin, { companyId: co, period: '2026-03' })), /already posted/);
  });
  it('pays salaries with a WPS file once every employee has WPS details', async () => {
    const pay = { date: '2026-04-01', employerId: '1234567890123', employerBankCode: '803320101' };
    await assert.rejects(tx(admin, (q) => hr.payPayroll(q, admin, run.id, pay)), /missing for E006/);
    await tx(admin, (q) => q.query(`UPDATE hr.contracts SET wps_person_id = '10000000000002', bank_routing_code = '803320101', iban = 'AE070331234567890123457' WHERE id = $1`, [kRep.id]));
    const r = await tx(admin, (q) => hr.payPayroll(q, admin, run.id, pay));
    const rows = r.content!.trim().split('\r\n');
    assert.equal(rows.length, 3);
    assert.match(rows[0], /^EDR,10000000000001,803320101,AE070331234567890123456,2026-03-01,2026-03-31,31,14000\.00,500\.00,0$/);
    assert.match(rows[2], /^SCR,1234567890123,803320101,\d{4}-\d{2}-\d{2},\d{4},032026,2,/);
    assert.equal(await balance('2210'), 0);
  });
  it('pays the final gratuity from the provision', async () => {
    const end = await tx(admin, (q) => hr.endContract(q, admin, kAcc.id, '2026-03-31'));
    const st = await tx(admin, (q) => hr.paySettlement(q, admin, kAcc.id, { date: '2026-04-05' }));
    assert.equal(st.amount, end.finalGratuity);
    assert.equal(await balance('2500'), 0);
  });
});

describe('whole books', () => {
  it('stay balanced after every module has posted', async () => {
    const tb = await tx(admin, (q) => reports.trialBalance(q, admin, co, '2026-12-31'));
    assert.equal(tb.balanced, true);
  });
  it('serves the operations API', async () => {
    const app = buildServer({ db: t.db, platformAdminKey: 'k' });
    const login = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: { tenant: s.code, email: `accountant@${s.code}.test`, password: PASSWORD } });
    const token = login.json().token;
    const r = await app.inject({ method: 'GET', url: `/v1/inv/companies/${co}/stock`, headers: { authorization: `Bearer ${token}` } });
    assert.equal(r.statusCode, 200);
    assert.ok(r.json().some((x: any) => x.item_code === 'LAP-14'));
    const bad = await app.inject({ method: 'POST', url: `/v1/pur/companies/${co}/orders`, headers: { authorization: `Bearer ${token}` }, payload: { supplierId: supplier } });
    assert.equal(bad.statusCode, 400);
    await app.close();
  });
});

function round(n: number) { return Math.round(n * 100) / 100; }
void ValidationError;
